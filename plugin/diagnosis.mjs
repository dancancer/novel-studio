/**
 * novel-studio / diagnosis
 * ------------------------------------------------------------------
 * 根因诊断与返工路由（设计文档 §13 典型返工路由表、§14 影响分析）。
 *
 * Reader / Reviewer 提供"症状"，Diagnosis 负责：
 *   1. 症状 → 根因分类 + 责任归属（按角色加权）
 *   2. rollback_to（回滚到能够解决根因的最浅层级）
 *   3. impact_range（依赖图下游影响范围）
 *
 * 纯 ESM，零依赖，直接可测。
 */

import { dependencyImpact, markDependentsStale, loadContracts, saveContracts, getProject, saveProject, setWorkflowState } from './store.mjs'

/** 设计文档 §13：问题模式 → 优先返工层 */
export const REWORK_ROUTES = [
  { patterns: ['fact_error', '事实错误', '史实', '数据错误', '资料'], layer: 'research', layerLabel: 'Research（事实层）' },
  { patterns: ['world_logic', '世界逻辑', '世界观冲突', 'canon'], layer: 'world_bible', layerLabel: 'World Bible（世界观层）' },
  { patterns: ['character_motive', '动机不成立', '人设崩', '人物动机', '性格不一致'], layer: 'character_arc', layerLabel: 'Character Arc（人物成长弧层）' },
  { patterns: ['power', '战力', '数值崩坏', '经济崩', '等级'], layer: 'system_rules', layerLabel: 'System Rules（数值体系层）' },
  { patterns: ['master_structure', '全书结构', '主线断裂', '大纲'], layer: 'master_plot', layerLabel: 'Master Plot（全书大纲层）' },
  { patterns: ['volume_pacing', '卷节奏', '卷内', '整卷'], layer: 'volume_plan', layerLabel: 'Volume Plan（卷规划层）' },
  { patterns: ['chapter_conflict', '单章冲突', '章节冲突弱', '本章'], layer: 'chapter_contract', layerLabel: 'Chapter Contract（章契约层）' },
  { patterns: ['prose', '文笔', '对话生硬', '生硬', '台词', '描写'], layer: 'writer', layerLabel: 'Writer（写手层）' },
  { patterns: ['payoff', '爽点不成立', '爽点', '高潮', 'hook'], layer: 'plot_payoff', layerLabel: 'Plot + Payoff（剧情+爽点层）' },
  { patterns: ['reader_unhappy', '读者不喜欢', '无感', '没看头'], layer: 'reader_diagnosis', layerLabel: 'Reader Diagnosis（读者体验层）' },
]

/** 返工层 → 依赖图节点（用于影响分析） */
const LAYER_TO_NODE = {
  research: 'research',
  world_bible: '02_world_bible',
  character_arc: 'characters',
  system_rules: '03_system_rules',
  master_plot: '04_master_plot',
  volume_plan: 'volumes',
  chapter_contract: 'chapters',
  writer: 'manuscript',
  plot_payoff: 'chapters',
  reader_diagnosis: 'reader',
}

const LAYER_ORDER = [
  'research', 'world_bible', 'character_arc', 'system_rules', 'master_plot',
  'volume_plan', 'chapter_contract', 'writer',
]

/**
 * 规则路由：按问题模式给出候选返工层（供 LLM 诊断参考，也作 fallback）。
 */
export function routeByPattern(issue) {
  if (!issue) return null
  const haystack = [issue.dimension, issue.issue_id || '', issue.evidence || '', issue.recommended_action || '', issue.category || '']
    .join(' ').toLowerCase()
  for (const route of REWORK_ROUTES) {
    if (route.patterns.some(p => haystack.includes(p.toLowerCase()))) {
      return { layer: route.layer, layerLabel: route.layerLabel, matchedBy: route.patterns[0] }
    }
  }
  return null
}

/**
 * 依据诊断结果执行影响分析与状态重置：
 *   - 依赖图：从返工层节点向下游打 STALE
 *   - 章节：影响范围内的章节回到对应可返工状态
 *
 * @param {string} projectDir
 * @param {object} diagnosis { issueIds, rootCauses, rollback_to, impact_range, note }
 * @returns {object} 返工指令
 */
export function applyDiagnosis(projectDir, diagnosis) {
  const layer = diagnosis.rollback_to || 'chapter_contract'
  const node = LAYER_TO_NODE[layer]
  if (!node) throw new Error(`novel-studio: 未知返工层 ${layer}`)

  const impact = dependencyImpact(projectDir, node)
  const stale = markDependentsStale(projectDir, node, `诊断返工：${layer}（${diagnosis.note || diagnosis.reason || ''}）`, {})

  // 章节状态重置：impact 涉及 chapters/manuscript 时
  const book = loadContracts(projectDir)
  const chapterNumbers = Object.keys(book.chapters).sort((a, b) => Number(a) - Number(b))
  const range = diagnosis.impact_range || inferRange(projectDir, layer)
  const [r0, r1] = range ? [Number(range[0] ?? range.start ?? 0), Number(range[1] ?? range.end ?? 9999)] : [0, 9999]

  const resetChapters = []
  const affectsContracts = node === 'chapters' || impact.includes('chapters')
  // reader_diagnosis 是分析层而非可编辑资产；分析完成后必须把失败章节交回 Writer，
  // 否则章节会停在 DIAGNOSIS，Autopilot 只会重复执行同一份诊断。
  const affectsManuscript = layer === 'reader_diagnosis' || node === 'manuscript' || impact.includes('manuscript')
  for (const n of chapterNumbers) {
    const num = Number(n)
    if (num < r0 || num > r1) continue
    const row = book.chapters[n]
    if (!affectsContracts && !affectsManuscript) continue
    const from = row.status
    let to = null
    if (from === 'ACCEPTED') to = 'DIAGNOSIS'
    else if (from === 'DIAGNOSIS') to = 'REWORK'
    else if (['WRITING', 'QA', 'READER_TEST'].includes(from)) to = 'REWORK'
    else if (from === 'PLANNED' && affectsContracts) to = 'REWORK'
    if (!to) continue
    row.status = to
    row.history = row.history || []
    row.history.push({ at: new Date().toISOString(), from, to, reason: `诊断返工：${layer}` })
    resetChapters.push(n)
  }
  saveContracts(projectDir, book)
  const project = getProject(projectDir)
  project.chapterStatus = project.chapterStatus || {}
  for (const n of chapterNumbers) project.chapterStatus[n] = book.chapters[n].status
  setWorkflowState(project, 'REWORK', `诊断返工：${layer}`)
  saveProject(projectDir, project)

  return {
    diagnosis,
    staleNodes: stale,
    impactNodes: impact,
    resetChapters,
    reworkInstructions: [
      `优先返工层：${layer}`,
      `影响范围：${range ? `第 ${r0}–${r1} 章` : '未指定范围（默认全量检查）'}`,
      ...resetChapters.map(n => `章节 ${n} → ${book.chapters[n].status}`),
      `依赖图中 ${stale.length} 个下游节点已标 STALE：${stale.join(', ') || '（无）'}`,
      '下一步：Planner 决定每个 STALE 节点的处置 KEEP / PATCH / REGENERATE / RE-REVIEW。',
    ],
  }
}

/** 范围推断：在具体证据缺失时使用（按返工层） */
function inferRange(projectDir, layer) {
  const book = loadContracts(projectDir)
  const chapters = Object.values(book.chapters).map(c => Number(c.chapter)).sort((a, b) => a - b)
  if (!chapters.length) return null
  const last = chapters[chapters.length - 1]
  switch (layer) {
    case 'research':
    case 'world_bible':
    case 'character_arc':
    case 'system_rules':
    case 'master_plot':
      return [chapters[0], last]
    case 'volume_plan': {
      // 最近一卷的范围（粗略：最近 30% 章节）
      const from = chapters[Math.max(0, Math.floor(chapters.length * 0.7))]
      return [from, last]
    }
    case 'writer':
    case 'chapter_contract':
    case 'plot_payoff':
      return [Math.max(chapters[0], last - 6), last]
    default:
      return [chapters[0], last]
  }
}

/** 责任归属权重 → 人类可读 */
export function renderRootCauses(rootCauses) {
  return Object.entries(rootCauses || {})
    .sort((a, b) => b[1] - a[1])
    .map(([role, w]) => `  - ${role}: ${(w * 100).toFixed(0)}%`)
    .join('\n')
}
