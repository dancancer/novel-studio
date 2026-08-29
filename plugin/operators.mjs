/**
 * novel-studio / operators
 * ------------------------------------------------------------------
 * 24 个 novel_* 工具的实现层：把设计文档的 Phase 0-5 与双闭环
 * （Book Loop / Agent Loop）落成可编排的机械步骤。
 *
 * - 存储/门禁/诊断/HR 均为确定性逻辑（store/gates/diagnosis/hr/reports）
 * - 需要"思考"的步骤（调研、设定、剧情、正文、审查、读者、诊断、成长、验收）
 *   派发角色子代理（agents.mjs），模型跟随面板选择
 * - 子代理只有只读工具；所有写回由本层代做 —— 符合"规划与执行分离"
 */

import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  initProject, getProject, saveProject, setWorkflowState, slugify, nowIso,
  writeArtifact, approveArtifact, getArtifacts, readArtifact,
  writeState, readState, loadContracts, addChapterContracts,
  setChapterState, listChapterStates,
  addIssue, listIssues, getIssue, updateIssue,
  recordGate, listGates, projectSnapshot,
  loadStoryState, loadCharacterState, loadTimeline, loadForeshadowing,
  writeTextAtomic, writeJsonAtomic, readJsonOr,
  normalizeChapterId, manuscriptPathFor, resolveManuscriptPath, resolveStaleNode,
} from './store.mjs'
import {
  runGate, renderGateResult, GATE_CONFIGS, getGateRequirements, normalizeGateDimension,
  REVIEWER_DIMENSIONS,
} from './gates.mjs'
import { routeByPattern, applyDiagnosis, renderRootCauses } from './diagnosis.mjs'
import { loadProfile, defaultProfile, recordFailure, loadCandidates, saveCandidate, hrValidate } from './hr.mjs'
import { buildCycleReport } from './reports.mjs'
import { ROLE_PERSONAS, spawnRoleAgent, spawnParallel, listRoles } from './agents.mjs'
import { defineTool } from '@deepseek-ai/dsh-tools'

/* ================================================================== 小工具 */

/** 把项目当前快照提交到 git（版本管理：迭代历史 = git log）。项目不是 git 仓库或 git 不可用时静默跳过。 */
function gitCommit(projectDir, message) {
  try {
    if (!existsSync(join(projectDir, '.git'))) return
    execFileSync('git', ['-C', projectDir, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', projectDir, 'commit', '-m', String(message).slice(0, 120)], { stdio: 'ignore' })
  } catch { /* git 不可用/无仓库/无变更时静默 */ }
}

function readText(p) {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}

function requireProject(projectDir) {
  if (!projectDir) throw new Error('novel-studio: 缺少 projectDir（绝对路径）')
  if (!existsSync(join(projectDir, 'library', 'project.json'))) {
    throw new Error(`novel-studio: 不是有效项目目录: ${projectDir}（先运行 novel_init）`)
  }
  return projectDir
}

function renderToolText(blocks) {
  return [{ type: 'text', text: blocks.join('\n') }]
}

function roleSpec(projectDir, spec) {
  return { ...spec, profile: spec.profile || loadProfile(projectDir, spec.role) || defaultProfile(spec.role) }
}

function spawnProjectRole(ctx, exec, projectDir, spec) {
  return spawnRoleAgent(ctx, exec, roleSpec(projectDir, spec))
}

async function attemptProjectRole(ctx, exec, projectDir, spec) {
  try {
    return await spawnProjectRole(ctx, exec, projectDir, spec)
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

function spawnProjectParallel(limit, ctx, exec, projectDir, jobs) {
  return spawnParallel(limit, ctx, exec, jobs.map(job => roleSpec(projectDir, job)))
}

function resolveRevalidatedChapterIssues(projectDir, chapter, note, { includeReaderLab = false } = {}) {
  const chapterId = normalizeChapterId(chapter)
  for (const issue of listIssues(projectDir)) {
    if (normalizeIssueChapter(issue.chapter) !== chapterId) continue
    if (!includeReaderLab && issue.source === 'reader-lab') continue
    const status = String(issue.status || 'open').toLowerCase()
    const stageOwnedOpen = status === 'open' && (
      (includeReaderLab && issue.source === 'reader-lab')
      || (!includeReaderLab && ['review-pool', 'writer-runtime'].includes(issue.source))
    )
    if (!stageOwnedOpen && !['diagnosed', 'in_rework'].includes(status)) continue
    updateIssue(projectDir, issue.issue_id, { status: 'resolved', resolution: note, resolved_at: nowIso() })
  }
}

function normalizeIssueChapter(chapter) {
  if (chapter === undefined || chapter === null || String(chapter).includes(',')) return null
  try { return normalizeChapterId(chapter) } catch { return null }
}

function issueChapterSpans(chapter) {
  if (chapter === undefined || chapter === null) return []
  const spans = []
  for (const token of String(chapter).split(',').map(value => value.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*[-–—]\s*(\d+)$/)
    const start = Number(range ? range[1] : token)
    const end = Number(range ? range[2] : token)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return []
    spans.push([start, end])
  }
  return spans
}

function issueChapterOverlaps(chapter, chapterIds) {
  const numbers = [...chapterIds].map(Number).filter(Number.isSafeInteger)
  return issueChapterSpans(chapter).some(([start, end]) => numbers.some(number => number >= start && number <= end))
}

function impactRangeFromIssues(issues) {
  const spans = issues.flatMap(issue => issueChapterSpans(issue.chapter))
  return spans.length
    ? [Math.min(...spans.map(([start]) => start)), Math.max(...spans.map(([, end]) => end))]
    : null
}

const LEAF_REWORK_LAYERS = new Set(['chapter_contract', 'writer', 'plot_payoff', 'reader_diagnosis'])

function normalizeImpactRange(range) {
  const start = Number(Array.isArray(range) ? range[0] : range?.start)
  const end = Number(Array.isArray(range) ? range[1] : range?.end)
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start
    ? [start, end]
    : null
}

function intersectImpactRanges(left, right) {
  const a = normalizeImpactRange(left)
  const b = normalizeImpactRange(right)
  if (!a || !b) return null
  const overlap = [Math.max(a[0], b[0]), Math.min(a[1], b[1])]
  return overlap[0] <= overlap[1] ? overlap : null
}

function plannedProjectRange(projectDir) {
  const brief = getProject(projectDir).brief || {}
  const volumeCount = Math.max(1, Number(brief.volumeCount) || 1)
  const chaptersPerVolume = Math.max(1, Number(brief.chaptersPerVolume) || 40)
  return [1, volumeCount * chaptersPerVolume]
}

function constrainImpactRangeToExistingChapters(projectDir, range, label = '诊断', { allowPlannedRange = false } = {}) {
  const normalized = normalizeImpactRange(range)
  if (!normalized) throw new Error(`novel-studio: ${label}缺少有效的章节影响范围`)
  const [start, end] = normalized
  const existing = listChapterStates(projectDir)
    .map(row => Number(row.chapter))
    .filter(Number.isSafeInteger)
    .sort((a, b) => a - b)
  if (!existing.length && allowPlannedRange) {
    const planned = intersectImpactRanges(normalized, plannedProjectRange(projectDir))
    if (planned) return planned
  }
  const impacted = existing.filter(chapter => chapter >= start && chapter <= end)
  if (!impacted.length) {
    throw new Error(`novel-studio: ${label}影响范围第 ${start}-${end} 章与现有章节无交集，拒绝执行返工`)
  }
  return [impacted[0], impacted[impacted.length - 1]]
}

function resolveDiagnosisImpactRange(projectDir, { rollback, proposedRange, issueRange, label = '诊断' }) {
  const leaf = LEAF_REWORK_LAYERS.has(rollback)
  const proposed = normalizeImpactRange(proposedRange)
  const evidence = normalizeImpactRange(issueRange)
  let requested
  if (leaf && evidence) {
    // 叶子层只能在所选 Issue 的证据范围内缩小，不允许模型无依据扩大正文返工。
    requested = proposed ? (intersectImpactRanges(proposed, evidence) || evidence) : evidence
  } else {
    requested = proposed || evidence || plannedProjectRange(projectDir)
  }
  return constrainImpactRangeToExistingChapters(projectDir, requested, label, { allowPlannedRange: !leaf })
}

function readMarkdownDirectory(dir, maxChars = 12000) {
  const parts = []
  let used = 0
  for (const file of readdirNames(dir).filter(name => name.endsWith('.md')).sort()) {
    const text = readText(join(dir, file))
    if (!text) continue
    const remaining = maxChars - used
    if (remaining <= 0) break
    const chunk = text.slice(0, remaining)
    parts.push(`<!-- ${file} -->\n${chunk}`)
    used += chunk.length
  }
  return parts.join('\n\n')
}

function extractMarkdownSection(content, query) {
  if (!query) return content
  const lines = String(content).split('\n')
  const needle = String(query).trim().toLowerCase()
  const start = lines.findIndex(line => /^#{1,6}\s+/.test(line) && line.toLowerCase().includes(needle))
  if (start < 0) return ''
  const level = lines[start].match(/^#+/)[0].length
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    const heading = lines[index].match(/^(#{1,6})\s+/)
    if (heading && heading[1].length <= level) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function staleNodeIds(projectDir) {
  const graph = readJsonOr(join(projectDir, 'state', 'dependency_graph.json'), { nodes: {} })
  return Object.entries(graph.nodes || {})
    .filter(([, node]) => node?.status === 'STALE')
    .map(([id]) => id)
}

function latestArtifactRecord(projectDir, id) {
  return getArtifacts(projectDir)
    .filter(artifact => artifact.id === id)
    .sort((a, b) => Number(b.version) - Number(a.version))[0]
}

function latestEvidenceCompleteGate(projectDir, gateType) {
  const latest = listGates(projectDir).filter(row => row.gate === gateType).slice(-1)[0]
  return latest?.protocolVersion === 'fail-closed-v2' && latest.evidenceComplete === true ? latest : null
}

function assertWriterProductionReady(projectDir, workflowState) {
  if (!['WRITING', 'REWORK'].includes(workflowState)) {
    throw new Error(`novel-studio: 当前工作流为 ${workflowState}，只有 WRITING/REWORK 可进入 Writer`)
  }
  const requiredArtifacts = ['01_market_strategy', 'research', '02_world_bible', '03_system_rules', 'characters', '04_master_plot']
  const inactive = requiredArtifacts.filter(id => latestArtifactRecord(projectDir, id)?.status !== 'ACTIVE')
  if (inactive.length) throw new Error(`novel-studio: 生产资产未 ACTIVE：${inactive.join(', ')}`)
  const stale = staleNodeIds(projectDir).filter(id => ['research', '02_world_bible', '03_system_rules', 'characters', '04_master_plot', 'volumes', 'chapters'].includes(id))
  if (stale.length) throw new Error(`novel-studio: 关键依赖仍为 STALE：${stale.join(', ')}；必须先重建或复审`)
  const planningGate = latestEvidenceCompleteGate(projectDir, 'planning')
  const plotGate = latestEvidenceCompleteGate(projectDir, 'plot')
  if (!planningGate?.pass) throw new Error('novel-studio: 缺少当前协议且证据完整的 Planning Gate PASS')
  if (!plotGate?.pass) throw new Error('novel-studio: 缺少当前协议且证据完整的 Plot Gate PASS')
}

/* ================================================================== Context Builder（设计 §10） */

function readArtifactText(projectDir, id, version) {
  try {
    return readArtifact(projectDir, { id, version }).content || ''
  } catch {
    return ''
  }
}

/** 为 Writer 构造最小充分上下文 */
function buildWriterContext(projectDir, chapter) {
  const book = loadContracts(projectDir)
  const chapterId = normalizeChapterId(chapter)
  const contract = book.chapters[chapterId]
  if (!contract) throw new Error(`novel-studio: 章节 ${chapterId} 无契约（先运行 novel_phase_plot）`)
  const project = getProject(projectDir)
  const brief = project.brief
  const world = readText(join(projectDir, '02_world_bible.md')).slice(0, 12000)
  const systems = readText(join(projectDir, '03_system_rules.md')).slice(0, 8000)
  const master = readText(join(projectDir, '04_master_plot.md')).slice(0, 8000)
  const volumeNo = contract.volume || 1
  const volume = readText(join(projectDir, 'plot', 'volumes', `volume-${String(volumeNo).padStart(2, '0')}.md`)).slice(0, 6000)
  const chars = loadCharacterState(projectDir)
  const story = loadStoryState(projectDir)
  const fsh = loadForeshadowing(projectDir)
  const timeline = loadTimeline(projectDir)

  const involved = (contract.characters || []).map(id => {
    const c = chars.characters[id]
    return c ? `${id}（${c.name}）: ${JSON.stringify(c.current || c)}` : `${id}（未登记！）`
  }).join('\n    ')

  const pendingFsh = fsh.items
    .filter(i => ['open', 'pending'].includes(i.status))
    .map(i => `  - ${i.id}: ${i.summary}（埋于 ${i.plantedAt}，计划回收 ≤${i.dueBy ?? '?'}）`)
    .join('\n')

  const recents = recentChapterSummaries(projectDir, chapterId)

  const styleNotes = readText(join(projectDir, '00_project_brief.md')).slice(0, 4000)
  const reworkFeedback = listIssues(projectDir)
    .filter(issue => normalizeIssueChapter(issue.chapter) === chapterId)
    .filter(issue => !['closed', 'resolved', 'fixed', 'done', 'dismissed'].includes(String(issue.status || 'open').toLowerCase()))
    .slice(-8)
    .map(issue => `- [${issue.issue_id}] ${issue.dimension}/${issue.severity}: ${(issue.evidence || issue.actual || '').slice(0, 400)}${issue.recommended_action ? `；建议：${issue.recommended_action}` : ''}`)
    .join('\n')

  const ctx = [
    '## 1. 全局 Canon（世界观 Bible，摘要）',
    world || '（尚无 —— 请在任务中提示问题）',
    '',
    '## 2. 数值/时间规则（摘要）',
    systems || '（无）',
    '',
    '## 3. 全书大纲（相关部分）',
    master.slice(0, 4000),
    '',
    '## 4. 当前卷目标',
    volume || '（无卷规划）',
    '',
    '## 5. 本章 Chapter Contract',
    JSON.stringify(contract, null, 2),
    '',
    '## 6. 出场人物当前状态',
    involved || '（无）',
    '',
    '## 7. 故事当前位置',
    `章节 ${story.current.chapter}｜地点 ${story.current.location}｜时间 ${story.current.time}`,
    `摘要：${story.current.summary || '（无）'}`,
    '',
    '## 8. 最近章节摘要（续写参考）',
    recents || '（本卷开头）',
    '',
    '## 9. 待回收伏笔（dueBy 邻近优先）',
    pendingFsh || '（无）',
    '',
    '## 10. 本章未关闭问题（返工时必须逐项处理）',
    reworkFeedback || '（无）',
    '',
    '## 11. 风格规范与禁止事项',
    `目标读者：${brief.audience || '未定义'}；平台：${brief.platform || '未定义'}`,
    `禁止事项：${(brief.forbiddenItems || []).join('；') || '无'}`,
    `用户硬约束：${(brief.hardConstraints || []).join('；') || '无'}`,
    styleNotes ? `平台/风格参考（简报片段）：\n${styleNotes.slice(0, 1500)}` : '',
  ].join('\n\n')
  return { ctx, contract, project, story }
}

const WRITER_STATE_FILES = {
  story: 'state/story_state.json',
  character: 'state/character_state.json',
  timeline: 'state/timeline.json',
  foreshadowing: 'state/foreshadowing.json',
}

function writerBaselinePath(projectDir, chapter) {
  return join(projectDir, 'state', 'chapter_snapshots', `${normalizeChapterId(chapter)}.json`)
}

function persistWriterBaseline(projectDir, chapter) {
  const states = Object.fromEntries(Object.entries(WRITER_STATE_FILES).map(([kind, relativePath]) => [
    kind,
    readJsonOr(join(projectDir, relativePath), {}),
  ]))
  writeJsonAtomic(writerBaselinePath(projectDir, chapter), { chapter: normalizeChapterId(chapter), states, at: nowIso() })
}

function hasWriterOutputFromChapter(projectDir, chapter) {
  const earliest = Number(chapter)
  const chapters = listChapterStates(projectDir).filter(row => Number(row.chapter) >= earliest)
  if (chapters.some(row => existsSync(resolveManuscriptPath(projectDir, row.chapter)))) return true
  const story = loadStoryState(projectDir)
  if ((story.notes || []).some(row => Number(row.chapter) >= earliest)) return true
  if (Number(story.current?.chapter) >= earliest) return true
  const timeline = loadTimeline(projectDir)
  if ((timeline.events || []).some(row => Number(row.chapter) >= earliest)) return true
  const foreshadowing = loadForeshadowing(projectDir)
  if ((foreshadowing.items || []).some(row => Number(row.plantedAt) >= earliest || Number(row.paidOffAt) >= earliest)) return true
  const characters = loadCharacterState(projectDir).characters || {}
  return Object.values(characters).some(row => Number(row.lastSeenChapter) >= earliest)
}

function restoreWriterBaseline(projectDir, chapter) {
  const snapshot = readJsonOr(writerBaselinePath(projectDir, chapter), null)
  if (!snapshot?.states) {
    if (!hasWriterOutputFromChapter(projectDir, chapter)) return false
    throw new Error(`novel-studio: 第 ${normalizeChapterId(chapter)} 章缺少 Writer 前置状态快照，无法安全返工；请先恢复或迁移快照`)
  }
  const missing = Object.keys(WRITER_STATE_FILES).filter(kind => !Object.hasOwn(snapshot.states, kind))
  if (missing.length) {
    throw new Error(`novel-studio: 第 ${normalizeChapterId(chapter)} 章 Writer 前置状态快照不完整（缺少 ${missing.join(', ')}），无法安全返工`)
  }
  for (const [kind, relativePath] of Object.entries(WRITER_STATE_FILES)) {
    writeJsonAtomic(join(projectDir, relativePath), snapshot.states[kind])
  }
  return true
}

/** 某章之前的最近 N 章出口摘要（来自 story_state 或手稿首行） */
function recentChapterSummaries(projectDir, chapter) {
  const n = Number(chapter)
  const out = []
  const notes = loadStoryState(projectDir).notes || []
  for (let i = Math.max(1, n - 3); i < n; i++) {
    const note = [...notes].reverse().find(row => Number(row.chapter) === i && row.note)
    if (note) {
      out.push(`第${i}章：${String(note.note).replace(/\s+/g, ' ').slice(0, 300)}`)
      continue
    }
    const md = readText(resolveManuscriptPath(projectDir, i) || '')
    const head = md.replace(/\s+/g, ' ').slice(0, 300)
    if (head) out.push(`第${i}章：${head}…`)
  }
  return out.slice(-3).join('\n')
}

/* ================================================================== 阶段实现 */

/** Phase 1 Step1-2：市场需求 + 深度研究 */
async function phaseResearch(ctx, exec, projectDir) {
  const project = getProject(projectDir)
  setWorkflowState(project, 'RESEARCHING', '进入研究阶段')
  saveProject(projectDir, project)

  const briefMd = readText(join(projectDir, '00_project_brief.md'))
  const banner = `【AI 小说工作室 · 深度研究任务】\n\n项目目录：${projectDir}\n\n作为市场需求分析专家，请先通过只读工具 novel_artifact_read / novel_state_read 阅读项目简报与已有状态，然后完成任务并返回结构化结果。\n\n================ 项目简报 ================\n${briefMd}`

  const results = await spawnProjectParallel(2, ctx, exec, projectDir, [
    {
      role: 'deep-researcher',
      label: '市场需求分析',
      prompt: banner + `\n\n请输出《01_market_strategy.md》全文（含市场定位/竞争格局/差异化卖点/目标读者画像/策略）。\n返回结构化对象：market（分析文本）、differentials、reader_persona、strategy、assumptions。`,
    },
    {
      role: 'research-assistant',
      label: '深度资料研究',
      prompt: banner + `\n\n请围绕题材做深度研究，输出证据索引（每条目标注 Fact/Inference/Creative Assumption 与置信度）。\n返回结构化对象：evidence（条目数组）、topics（专题清单）。`,
    },
  ])

  const [market, research] = results
  if (!market?.structured || !research?.structured) {
    const details = results.map(r => `${r.label}: ${r.ok ? '✓' : `✗ ${r.error || '无结构化输出'}`}`).join('\n')
    throw new Error(`novel-studio: 研究阶段产出不完整\n${details}`)
  }

  const marketSources = Array.isArray(market.structured.sources) ? market.structured.sources : []
  const validMarketSources = marketSources.filter(source => isHttpUrl(source?.url))
  if (!validMarketSources.length) {
    throw new Error('novel-studio: 市场研究缺少可验证的 HTTP(S) 来源；未写入研究资产')
  }
  const evidence = Array.isArray(research.structured.evidence) ? research.structured.evidence : []
  const unverifiedFacts = evidence.filter(item => item?.kind === 'Fact' && !isHttpUrl(item.sourceUrl))
  if (unverifiedFacts.length) {
    const ids = unverifiedFacts.map(item => item.id || '未命名 Fact').join(', ')
    throw new Error(`novel-studio: Fact 缺少可验证来源（${ids}）；未写入研究资产`)
  }

  // 写 01_market_strategy.md
  const strategyMd = market.structured.strategy
    ? [markdownTitle('01_market_strategy', '市场需求与差异化策略'),
      '## 市场定位与竞争格局', market.structured.market || '',
      '## 差异化卖点', (market.structured.differentials || []).map(d => `- ${d}`).join('\n'),
      '## 目标读者画像', (market.structured.reader_persona || []).map(p => `- ${p.segment}（${Math.round((p.ratio || 0) * 100)}%）：${p.traits || ''}`).join('\n'),
      '## 连载与商业化策略', market.structured.strategy,
      '## 创作假设（Creative Assumption）', (market.structured.assumptions || []).map(a => `- ${a}`).join('\n'),
      '## 来源', validMarketSources.map(source => `- [${source.title || source.url}](${source.url})`).join('\n'),
    ].join('\n\n')
    : market.structured.market || ''
  writeArtifact(projectDir, { id: '01_market_strategy', title: '市场需求与差异化策略', content: strategyMd, owner: 'deep-researcher', changeReason: 'Phase1 Step1 市场需求分析' })

  // 写 research/evidence_index.md
  const evidenceMd = [
    markdownTitle('research', '证据索引 evidence_index'),
    ...evidence.map(e => {
      const source = isHttpUrl(e.sourceUrl)
        ? `\n- 来源：[${e.sourceTitle || e.sourceUrl}](${e.sourceUrl})`
        : ''
      return `### [${e.kind}] ${e.id || ''}（置信度：${e.confidence || '?'}）\n\n${e.claim || ''}\n\n- 计划用途：${e.usedIn || '—'}${source}`
    }),
    '## 专题清单',
    (research.structured.topics || []).map(t => `- ${t}`).join('\n'),
  ].join('\n\n')
  writeArtifact(projectDir, { id: 'research', title: '证据索引', content: evidenceMd, owner: 'research-assistant', changeReason: 'Phase1 Step2 深度资料研究' })

  const pResearch = getProject(projectDir)
  setWorkflowState(pResearch, 'PLANNING', '研究完成，进入设定规划')
  saveProject(projectDir, pResearch)
  gitCommit(projectDir, `research: 完成研究（证据 ${evidence.length} 条）`)
  return {
    action: 'research',
    artifacts: ['01_market_strategy', 'research'],
    evidenceCount: evidence.length,
    sourceCount: validMarketSources.length + evidence.filter(item => isHttpUrl(item.sourceUrl)).length,
    topics: research.structured.topics || [],
    next: '运行 novel_phase_setting（世界观/人物/数值），随后由 novel_gate_run(planning) 把关',
  }
}

/** Phase 1 Step3-5：世界观 + 人物 + 数值 */
async function phaseSetting(ctx, exec, projectDir) {
  const project = getProject(projectDir)
  setWorkflowState(project, 'PLANNING', '设定阶段进行中')
  saveProject(projectDir, project)

  const briefMd = readText(join(projectDir, '00_project_brief.md'))
  const market = readArtifactText(projectDir, '01_market_strategy')
  const evidence = readArtifactText(projectDir, 'research')

  // 修订模式：把上一版设定资产 + 上轮 Planning Gate 的 issue 反馈注入上下文，
  // 让三路子代理在既有底座上对齐修订，而不是每次推倒重造（避免跨资产命名/数值漂移）
  const prevWorld = readArtifactText(projectDir, '02_world_bible')
  const prevChrs = readText(join(projectDir, 'characters', ''))
  const prevSystems = readArtifactText(projectDir, '03_system_rules')
  const prevIssues = (() => {
    try {
      const dir = join(projectDir, 'issues')
      if (!existsSync(dir)) return []
      return readdirNames(dir)
        .filter(f => /^ISSUE-\d+\.json$/.test(f))
        .slice(-12)
        .map(f => readJsonOr(join(dir, f), null))
        .filter(Boolean)
        .map(i => `- [${i.severity}] ${i.dimension}：${(i.evidence || '').slice(0, 200)}`)
        .join('\n')
    } catch { return '' }
  })()
  const revisionCtx = [
    '',
    '==== 上一版设定要点（修订对齐，不得推倒重造） ====',
    prevWorld ? `[02_world_bible 现有 Canon Rules 摘要]\n${prevWorld.split('\n').filter(l => l.startsWith('CR-')).slice(0, 12).join('\n')}` : '（无上一版）',
    prevSystems ? `[03_system_rules 现有刻度摘要]\n${prevSystems.split('\n').filter(l => /S0-|L1 |L2 |L3 |主刻度|境界序列/.test(l)).slice(0, 10).join('\n')}` : '（无上一版）',
    '==== 上轮 Planning Gate 问题反馈（必须逐条吸收） ====',
    prevIssues || '（无历史反馈）',
    '硬性要求：境界体系与跨资产命名以 02 之 Canon Rules 为唯一权威；03 数值刻度必须与 02 的 Canon Rules 完全一致（同名同轨）；characters 境界词必须与 02/03 一致。',
  ].join('\n\n')

  const banner = `【AI 小说工作室 · 设定任务】\n\n项目目录：${projectDir}\n\n请通过只读工具阅读相关资产（简报/市场策略/证据索引），再完成任务。\n\n==== 简报 ====\n${briefMd.slice(0, 4000)}\n\n==== 市场策略要点 ====\n${market.slice(0, 3000)}\n\n==== 证据索引要点 ====\n${evidence.slice(0, 3000)}${revisionCtx}`

  const results = await spawnProjectParallel(3, ctx, exec, projectDir, [
    {
      role: 'world-architect',
      label: '世界观架构',
      prompt: banner + `\n\n输出：canon_rules（不可违反规则清单，必须自洽）+ world_bible（02_world_bible.md 全文：世界规则/历史/地理/阵营/社会/经济/技术能力体系/Canon Rules 清单）。`,
    },
    {
      role: 'character-growth-expert',
      label: '人物设定',
      prompt: banner + `\n\n输出：characters（档案数组，含 id/name/role/motive/arc/initial_state）+ character_state（人物状态初始值，形如 { characters: { id: { name, state, current, relations, arcs } } }，id 必须与 characters 数组一致）。`,
    },
    {
      role: 'numeric-expert',
      label: '数值体系',
      prompt: banner + `\n\n输出：system_rules（03_system_rules.md 全文：战力/经济/等级/资源/时间轴/移动时间，每条规则附验算例子）+ red_lines。`,
    },
  ])

  const [world, characters, numbers] = results
  if (!world?.structured || !characters?.structured || !numbers?.structured) {
    throw new Error('novel-studio: 设定阶段产出不完整，请重试。\n' +
      results.map(r => `${r.label}: ${r.ok ? '✓' : `✗ ${r.error || '无结构化输出'}`}`).join('\n'))
  }
  const semanticErrors = []
  if (!String(world.structured.world_bible || '').trim()) semanticErrors.push('world_bible 为空')
  if (!(world.structured.canon_rules || []).some(rule => String(rule).trim())) semanticErrors.push('canon_rules 为空')
  if (!(characters.structured.characters || []).some(character => character?.id && character?.name)) semanticErrors.push('characters 为空或缺少 id/name')
  if (!String(numbers.structured.system_rules || '').trim()) semanticErrors.push('system_rules 为空')
  if (!(numbers.structured.red_lines || []).some(rule => String(rule).trim())) semanticErrors.push('red_lines 为空')
  if (semanticErrors.length) {
    throw new Error(`novel-studio: 设定阶段语义产出不完整：${semanticErrors.join('；')}；未写入设定资产`)
  }

  // 先在内存中装配全部设定候选；Planning Reviewer 输出通过结构校验前不落盘，
  // 避免非法评分让旧 ACTIVE 版本被提前 supersede。
  const canonList = (world.structured.canon_rules || []).map((c, i) => `${i + 1}. ${c}`).join('\n')
  const worldMd = [
    markdownTitle('02_world_bible', '世界观圣经'),
    '## Canon Rules（不可违反规则）',
    canonList || '- （未提供）',
    '',
    world.structured.world_bible || '',
  ].join('\n')

  // 4) 装配人物档案 + 人物状态候选
  const charState = { characters: {} }
  const charDocs = []
  for (const c of (characters.structured.characters || [])) {
    if (!c.id) continue
    charDocs.push({ id: slugify(c.id), md: `# ${c.name || c.id}（${c.id}）\n\n- 角色定位：${c.role || ''}\n- 核心动机：${c.motive || ''}\n- 成长弧：${(c.arc || []).map(a => `\n  - ${a}`).join('')}\n- 初始状态：${c.initial_state || ''}\n- 压力测试点：${(c.pressurePoints || []).map(p => `\n  - ${p}`).join('')}\n` })
    charState.characters[c.id] = {
      name: c.name,
      role: c.role,
      state: 'initial',
      current: { state: c.initial_state || '', detail: '' },
      relations: (c.relations || {}),
      arcs: c.arc ? { main: { steps: c.arc, progress: 0 } } : {},
    }
  }
  const charStateInput = characters.structured.character_state
  const mergedCharState = { characters: charState.characters }
  if (charStateInput && charStateInput.characters) {
    for (const [id, v] of Object.entries(charStateInput.characters)) {
      if (mergedCharState.characters[id]) {
        mergedCharState.characters[id] = { ...mergedCharState.characters[id], ...v, name: v.name || mergedCharState.characters[id].name }
      } else {
        mergedCharState.characters[id] = { name: v.name || id, ...v, current: v.current || {}, relations: v.relations || {}, arcs: v.arcs || {} }
      }
    }
  }
  const charactersMd = [
    markdownTitle('characters', '人物设定与初始状态'),
    '## 人物档案',
    ...charDocs.map(d => `[${d.id}](characters/${d.id}.md)\n\n${d.md}`),
    '## 初始状态（character_state）',
    '```json',
    JSON.stringify(mergedCharState, null, 2),
    '```',
  ].join('\n\n')

  // 5) 装配数值/时间体系候选
  const systemsMd = [
    markdownTitle('03_system_rules', '数值/时间体系规则'),
    numbers.structured.system_rules || '',
    '',
    '## 数值红线（验算）',
    (numbers.structured.red_lines || []).map(r => `- ${r}`).join('\n'),
  ].join('\n')

  // == Planning Gate：由 planner 角色评审全部规划资产 ==
  const planningRequirements = getGateRequirements('planning')
  const planningScoreDimensions = planningRequirements.requiredScoreDimensions
  const planningIssueDimensions = [...new Set([...planningScoreDimensions, ...planningRequirements.vetoOnlyDimensions])]
  const planReview = await attemptProjectRole(ctx, exec, projectDir, {
    role: 'planner',
    label: '规划资产评审（Planning Gate）',
    prompt: [
      '【Planning Gate 评审任务】',
      `项目目录：${projectDir}`,
      '请只读以下规划资产后，按 Planning Gate 维度（world 世界观/plot 情节/character 人物/numbers 数值/research 深度研究/planner 整体规划/other 其他）逐维评分（0-100）并给出问题清单。',
      '特别检查一票否决项：世界观核心逻辑冲突、主角核心动机不成立、主线无法闭环、用户硬约束违反、关键事实基础错误。',
      '',
      '==== 世界观 ====',
      worldMd.slice(0, 6000),
      '==== 数值 ====',
      systemsMd.slice(0, 4000),
      '==== 人物 ====',
      JSON.stringify(mergedCharState).slice(0, 4000),
      '',
      '返回：{ issues: [{ dimension, severity(blocking/high/medium/low), score, evidence, veto }], scores: { dimension: 0-100 } }',
    ].join('\n'),
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['issues', 'scores'],
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['dimension', 'severity', 'evidence'],
            properties: {
              dimension: { type: 'string', enum: planningIssueDimensions },
              severity: { type: 'string', enum: ['blocking', 'high', 'medium', 'low'] },
              score: { type: 'number' },
              veto: { type: 'boolean' },
              evidence: { type: 'string' },
              recommended_action: { type: 'string' },
            },
          },
        },
        scores: { type: 'object', additionalProperties: true },
      },
    },
  })

  if (planReview?.structured) {
    const invalidScores = []
    const scores = planReview.structured.scores
    if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
      invalidScores.push('scores 必须是对象')
    } else {
      for (const [dimension, score] of Object.entries(scores)) {
        if (!Number.isFinite(score) || score < 0 || score > 100) {
          invalidScores.push(`scores.${dimension}=${JSON.stringify(score)}`)
        }
      }
    }
    for (const [index, issue] of (planReview.structured.issues || []).entries()) {
      if (issue?.score !== undefined && (!Number.isFinite(issue.score) || issue.score < 0 || issue.score > 100)) {
        invalidScores.push(`issues[${index}].score=${JSON.stringify(issue.score)}`)
      }
    }
    if (invalidScores.length) {
      throw new Error(`novel-studio: Planning Gate 分数非法：${invalidScores.join('；')}；未写入设定资产`)
    }
  }

  // Reviewer 输出已通过结构校验，现在才提交设定候选。
  writeArtifact(projectDir, {
    id: '02_world_bible', title: '世界观圣经', content: worldMd,
    owner: 'world-architect', changeReason: 'Phase1 Step3 世界观设计',
  })
  writeState(projectDir, 'character', mergedCharState, { reason: 'Phase1 Step4 人物设定' })
  for (const doc of charDocs) writeTextAtomic(join(projectDir, 'characters', `${doc.id}.md`), doc.md)
  writeArtifact(projectDir, {
    id: 'characters', title: '人物设定与状态', content: charactersMd,
    owner: 'character-growth-expert', changeReason: 'Phase1 Step4 人物设定',
  })
  writeArtifact(projectDir, {
    id: '03_system_rules', title: '数值/时间体系规则', content: systemsMd,
    owner: 'numeric-expert', changeReason: 'Phase1 Step5 数值体系设计',
  })

  let gate = null
  const issues4gate = []
  // Planning Gate 权重面内合法维度；LLM 输出不规范时归一化到 other，避免 runGate 硬报错
  const PLANNING_SCORE_DIMS = new Set(planningScoreDimensions)
  const PLANNING_ISSUE_DIMS = new Set(planningIssueDimensions)
  const normIssueDim = d => (d && PLANNING_ISSUE_DIMS.has(d) ? d : 'other')
  const normScoreDim = d => (d && PLANNING_SCORE_DIMS.has(d) ? d : 'other')
  if (!planReview?.structured) {
    const row = addIssue(projectDir, {
      dimension: 'planner',
      severity: 'high',
      evidence: planReview?.error || 'Planning Gate 评审没有结构化输出',
      expected: '完整的逐维评分与问题清单',
      actual: '评审输出缺失',
      possible_source: 'planner',
      source: 'planning-gate-review',
      status: 'open',
    })
    issues4gate.push({ issue_id: row.issue_id, dimension: 'planner', severity: 'high', evidence: row.evidence })
  } else {
    for (const it of planReview.structured.issues) {
      const dim = normIssueDim(it.dimension)
      const row = addIssue(projectDir, {
        dimension: dim,
        severity: it.severity,
        score: it.score,
        veto: it.veto,
        evidence: it.evidence,
        expected: it.expected,
        actual: it.actual,
        recommended_action: it.recommended_action,
        possible_source: 'planning',
        source: 'planning-gate-review',
      })
      issues4gate.push({ issue_id: row.issue_id, dimension: dim, severity: it.severity, score: it.score, veto: it.veto, evidence: it.evidence, recommended_action: it.recommended_action })
    }
    // 显式分数覆盖默认扣分
    const scores = planReview.structured.scores || {}
    for (const [dim, score] of Object.entries(scores)) {
      const d = normScoreDim(dim)
      issues4gate.push({ issue_id: `score-${d}`, dimension: d, severity: 'low', score })
    }
  }
  gate = runGate('planning', issues4gate)
  recordGate(projectDir, {
    gate: 'planning',
    target: 'planning-assets',
    pass: gate.pass,
    score: gate.score,
    verdict: gate.decision,
    issues: issues4gate.filter(row => !String(row.issue_id).startsWith('score-')).map(row => row.issue_id),
    evidenceComplete: gate.completeness.complete,
  })

  const p2 = getProject(projectDir)
  if (gate.pass) {
    for (const id of ['01_market_strategy', 'research', '02_world_bible', '03_system_rules', 'characters']) {
      approveArtifact(projectDir, { id, approvedBy: 'planner', activate: true, note: 'Planning Gate PASS' })
    }
    for (const node of ['research', '02_world_bible', '03_system_rules', 'characters']) {
      try { resolveStaleNode(projectDir, node, { disposition: 'RE-REVIEW', note: 'Planning Gate PASS' }) } catch { /* 节点未被标记 STALE */ }
    }
    setWorkflowState(p2, 'PLANNING_REVIEW', 'Planning Gate PASS')
    saveProject(projectDir, p2)
  } else {
    setWorkflowState(p2, 'PLANNING', 'Planning Gate FAIL，待修订')
    saveProject(projectDir, p2)
  }

  gitCommit(projectDir, `setting: 世界观/人物/数值 v${Math.max(...getArtifacts(projectDir).filter(a => a.id === '02_world_bible').map(a => a.version))}，Planning Gate ${gate.pass ? 'PASS' : 'FAIL'}（${gate.score}）`)

  return {
    action: 'setting',
    artifacts: ['02_world_bible', '03_system_rules', 'characters'],
    planningGate: gate,
    next: gate.pass ? '运行 novel_phase_plot 进入剧情工程' : '按 Gate 问题修订设定（见 issue 列表）后重跑 novel_phase_setting 或 novel_gate_run(planning)',
  }
}

/** Phase 2：剧情工程（全书大纲 → 卷纲 → 章纲契约）+ Plot Gate */
async function phasePlot(ctx, exec, projectDir, opts = {}) {
  const project = getProject(projectDir)
  const briefMd = readText(join(projectDir, '00_project_brief.md'))
  const world = readArtifactText(projectDir, '02_world_bible')
  const chars = readMarkdownDirectory(join(projectDir, 'characters')) || JSON.stringify(loadCharacterState(projectDir))
  const systems = readArtifactText(projectDir, '03_system_rules')
  for (const flag of ['regenerateMaster', 'reviewExisting']) {
    if (opts[flag] !== undefined && typeof opts[flag] !== 'boolean') {
      throw new Error(`novel-studio: ${flag} 必须是布尔值`)
    }
  }
  const vols = Number(opts.volumes ?? project.brief.volumeCount ?? 3)
  if (!Number.isSafeInteger(vols) || vols < 1) {
    throw new Error('novel-studio: volumes 必须是正整数')
  }
  const batchSize = Math.max(1, Number(project.brief.chaptersPerBatch) || 10)
  const totalChapters = Math.max(1, vols * (Number(project.brief.chaptersPerVolume) || 40))
  let requestedRange = null
  if (opts.range !== undefined) {
    if (!Array.isArray(opts.range) || opts.range.length !== 2) {
      throw new Error(`novel-studio: Plot range 必须是 1-${totalChapters} 内的有效 [start, end]`)
    }
    requestedRange = opts.range.map(Number)
    if (!requestedRange.every(Number.isSafeInteger) || requestedRange[0] < 1 || requestedRange[1] < requestedRange[0] || requestedRange[1] > totalChapters) {
      throw new Error(`novel-studio: Plot range 必须是 1-${totalChapters} 内的有效 [start, end]`)
    }
  }
  const startChapter = requestedRange ? requestedRange[0] : Number(project.cycle.chapterCursor || 0) + 1
  if (startChapter > totalChapters) {
    throw new Error(`novel-studio: 全部 ${totalChapters} 章契约均已规划，无需继续生成`)
  }
  const endChapter = requestedRange ? requestedRange[1] : Math.min(totalChapters, startChapter + batchSize - 1)
  const reworkingContracts = Boolean(requestedRange)
  const reviewExisting = opts.reviewExisting === true
  const initialPlanning = !reviewExisting && (Number(project.cycle.chapterCursor || 0) === 0 || opts.regenerateMaster === true)
  const currentMaster = readArtifactText(projectDir, '04_master_plot')

  let data = null
  if (reviewExisting) {
    if (!currentMaster) throw new Error('novel-studio: 没有可重新评审的现有总纲')
    const existing = loadContracts(projectDir)
    const contracts = []
    for (let chapter = startChapter; chapter <= endChapter; chapter++) {
      const row = existing.chapters[normalizeChapterId(chapter)]
      if (!row) throw new Error(`novel-studio: 现有契约缺少第 ${chapter} 章，不能只做重新评审`)
      contracts.push(row)
    }
    const volumeNumbers = [...new Set(contracts.map(row => Number(row.volume) || 1))]
    data = {
      master_plot: currentMaster,
      volumes: volumeNumbers.map(volume => ({
        volume,
        plan: readText(join(projectDir, 'plot', 'volumes', `volume-${String(volume).padStart(2, '0')}.md`)),
      })),
      contracts,
    }
  }

  // 纯参数、范围和只读资产前置条件全部通过后，才公开阶段迁移。
  setWorkflowState(project, 'PLOT_ENGINEERING', '进入剧情工程')
  saveProject(projectDir, project)

  let plotTask = null
  if (!reviewExisting) {
    plotTask = await spawnProjectRole(ctx, exec, projectDir, {
      role: 'plot-architect',
      label: initialPlanning ? '全书剧情规划' : `第${startChapter}-${endChapter}章章节剧情规划`,
      prompt: [
        '【剧情工程任务】',
        `项目目录：${projectDir}`,
        `规划范围：全书 ${vols} 卷；本轮只生成第 ${startChapter}-${endChapter} 章契约。`,
        initialPlanning
          ? '1) 产出 04_master_plot.md 全文：主线/支线/人物线/成长线/感情线/世界事件线/伏笔线 + 全书节奏结构。'
          : '1) 既有 04_master_plot 已审批，本轮不得重写；返回原总纲摘要用于结构化协议即可。',
        initialPlanning
          ? '2) 产出全部卷级规划（volume_goal/initial_state/main_conflict/midpoint/climax/character_change/world_change/setup/payoff/end_hook）。'
          : '2) 依据既有总纲与卷纲滚动细化，不得改变已审批 Canon。',
        `3) 精确产出第 ${startChapter}-${endChapter} 章契约（chapter/pov/location/time/characters/entry_state/chapter_goal/conflict/turning_point/payoff/emotional_curve/information_revealed/foreshadowing[plant→dueBy]/end_hook/exit_state/forbidden_changes）。`,
        '层级铁律：Book → Arc → Volume → Chapter Group → Chapter → Scene，禁止跳级；每章必须回答"本章为什么必须存在"。',
        '',
        '==== 简报 ====',
        briefMd.slice(0, 3000),
        '==== 世界观 ====',
        world.slice(0, 8000),
        '==== 人物 ====',
        chars.slice(0, 4000),
        '==== 数值/时间 ====',
        systems.slice(0, 3000),
        ...(!initialPlanning ? ['==== 已审批总纲 ====', currentMaster.slice(0, 8000)] : []),
      ].join('\n'),
      outputSchema: ROLE_PERSONAS['plot-architect'].outputSchema,
    })
    data = plotTask?.structured
  }

  if (!data || !data.master_plot || !Array.isArray(data.volumes) || !Array.isArray(data.contracts)) {
    throw new Error(`novel-studio: 剧情规划产出不完整（${plotTask?.error || '无结构化输出'}）——请重试 novel_phase_plot`)
  }

  const plotSemanticErrors = []
  if (typeof data.master_plot !== 'string' || !data.master_plot.trim()) plotSemanticErrors.push('master_plot 为空或类型非法')
  // reviewExisting 读取的是可能来自旧版本的已持久化数据；这里仅拦截新子代理候选的语义空值。
  if (!reviewExisting) {
    if (!data.volumes.length) {
      plotSemanticErrors.push('volumes 为空')
    } else {
      for (const [index, volume] of data.volumes.entries()) {
        if (!volume || !Number.isSafeInteger(volume.volume) || volume.volume < 1 || typeof volume.plan !== 'string' || !volume.plan.trim()) {
          plotSemanticErrors.push(`volumes[${index}] 缺少有效 volume/plan`)
        }
      }
      const volumeIds = data.volumes.map(volume => volume?.volume).filter(Number.isSafeInteger)
      const duplicateVolumes = volumeIds.filter((volume, index) => volumeIds.indexOf(volume) !== index)
      const unexpectedVolumes = volumeIds.filter(volume => volume < 1 || volume > vols)
      if (duplicateVolumes.length) plotSemanticErrors.push(`volumes 重复：${[...new Set(duplicateVolumes)].join(', ')}`)
      if (unexpectedVolumes.length) plotSemanticErrors.push(`volumes 越界：${[...new Set(unexpectedVolumes)].join(', ')}`)
      if (initialPlanning) {
        const missingVolumes = Array.from({ length: vols }, (_, index) => index + 1).filter(volume => !volumeIds.includes(volume))
        if (missingVolumes.length) plotSemanticErrors.push(`初次规划缺少卷纲：${missingVolumes.join(', ')}`)
      }
    }
    const contractTextFields = [
      'pov', 'location', 'time', 'entry_state', 'chapter_goal', 'conflict', 'turning_point',
      'payoff', 'emotional_curve', 'information_revealed', 'end_hook', 'exit_state',
    ]
    for (const [index, contract] of data.contracts.entries()) {
      const missingFields = contractTextFields.filter(field => typeof contract?.[field] !== 'string' || !contract[field].trim())
      const missingArrays = ['characters', 'foreshadowing', 'forbidden_changes']
        .filter(field => !Array.isArray(contract?.[field]))
      const chapter = Number(contract?.chapter)
      if (!Number.isSafeInteger(chapter) || chapter < 1) missingFields.unshift('chapter')
      missingFields.push(...missingArrays)
      if (missingFields.length) plotSemanticErrors.push(`contracts[${index}] 缺少 ${missingFields.join(', ')}`)
    }
  }
  if (plotSemanticErrors.length) {
    throw new Error(`novel-studio: 剧情规划语义产出不完整：${plotSemanticErrors.join('；')}；未进入 Plot Gate，未写入剧情候选`)
  }

  const expectedIds = []
  for (let chapter = startChapter; chapter <= endChapter; chapter++) expectedIds.push(normalizeChapterId(chapter))
  const actualIds = data.contracts.map(row => normalizeChapterId(row.chapter))
  const duplicateIds = actualIds.filter((id, index) => actualIds.indexOf(id) !== index)
  const missingIds = expectedIds.filter(id => !actualIds.includes(id))
  const unexpectedIds = actualIds.filter(id => !expectedIds.includes(id))
  if (duplicateIds.length || missingIds.length || unexpectedIds.length) {
    throw new Error([
      `novel-studio: 剧情规划没有精确覆盖第 ${startChapter}-${endChapter} 章`,
      duplicateIds.length ? `重复：${[...new Set(duplicateIds)].join(', ')}` : '',
      missingIds.length ? `缺失：${missingIds.join(', ')}` : '',
      unexpectedIds.length ? `越界：${unexpectedIds.join(', ')}` : '',
    ].filter(Boolean).join('；'))
  }
  const knownCharacters = loadCharacterState(projectDir).characters || {}
  for (const contract of data.contracts) {
    const missingCharacters = (contract.characters || []).filter(id => id !== 'narrator' && !knownCharacters[id])
    if (missingCharacters.length) {
      throw new Error(`novel-studio: 第 ${normalizeChapterId(contract.chapter)} 章契约引用未知人物 ${missingCharacters.join(',')}（Gate 前校验未通过）`)
    }
  }
  if (!reviewExisting && !reworkingContracts) {
    const existingContracts = loadContracts(projectDir).chapters
    const conflicts = actualIds.filter(id => existingContracts[id])
    if (conflicts.length) throw new Error(`novel-studio: 章节契约已存在，拒绝覆盖：${conflicts.join(', ')}`)
  }

  const pPlot = getProject(projectDir)
  setWorkflowState(pPlot, 'PLOT_REVIEW', `第${startChapter}-${endChapter}章候选进入 Plot Gate`)
  saveProject(projectDir, pPlot)

  const plotDimensions = new Set(getGateRequirements('plot').requiredScoreDimensions)
  const plotReview = await attemptProjectRole(ctx, exec, projectDir, {
    role: 'planner',
    label: `剧情 Plot Gate 评审（第${startChapter}-${endChapter}章）`,
    prompt: [
      '【Plot Gate 评审任务】',
      `项目目录：${projectDir}｜候选范围：第 ${startChapter}-${endChapter} 章`,
      '按 structure/hook/payoff/emotion/character_growth/info_release/foreshadow/pacing 八个维度逐维评分 0-100。',
      '检查一票否决：主线结构断裂、伏笔矛盾、人物成长弧冲突；问题必须给出具体证据。',
      '返回 { issues: [{dimension,severity,score?,veto?,evidence,recommended_action}], scores: {dimension: score} }。',
      '==== 总纲 ====',
      String(initialPlanning ? data.master_plot : currentMaster).slice(0, 8000),
      '==== 卷纲 ====',
      JSON.stringify(data.volumes).slice(0, 6000),
      '==== 本批契约 ====',
      JSON.stringify(data.contracts, null, 2).slice(0, 16000),
    ].join('\n'),
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['issues', 'scores'],
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['dimension', 'severity', 'evidence'],
            properties: {
              dimension: { type: 'string', enum: [...plotDimensions] },
              severity: { type: 'string', enum: ['blocking', 'high', 'medium', 'low'] },
              score: { type: 'number', minimum: 0, maximum: 100 },
              veto: { type: 'boolean' },
              evidence: { type: 'string' },
              recommended_action: { type: 'string' },
            },
          },
        },
        scores: { type: 'object', additionalProperties: true },
      },
    },
  })

  if (plotReview?.structured) {
    const malformed = []
    const review = plotReview.structured
    const allowedIssueKeys = new Set(['dimension', 'severity', 'score', 'veto', 'evidence', 'recommended_action'])
    if (!Array.isArray(review.issues)) {
      malformed.push('issues 必须是数组')
    } else {
      for (const [index, issue] of review.issues.entries()) {
        if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
          malformed.push(`issues[${index}] 必须是对象`)
          continue
        }
        const extraKeys = Object.keys(issue).filter(key => !allowedIssueKeys.has(key))
        if (extraKeys.length) malformed.push(`issues[${index}] 包含未知字段 ${extraKeys.join(', ')}`)
        if (!plotDimensions.has(issue.dimension)) malformed.push(`issues[${index}].dimension=${JSON.stringify(issue.dimension)}`)
        if (!['blocking', 'high', 'medium', 'low'].includes(issue.severity)) malformed.push(`issues[${index}].severity=${JSON.stringify(issue.severity)}`)
        if (typeof issue.evidence !== 'string' || !issue.evidence.trim()) malformed.push(`issues[${index}].evidence 为空或类型非法`)
        if (issue.score !== undefined && (!Number.isFinite(issue.score) || issue.score < 0 || issue.score > 100)) {
          malformed.push(`issues[${index}].score=${JSON.stringify(issue.score)}`)
        }
        if (issue.veto !== undefined && typeof issue.veto !== 'boolean') malformed.push(`issues[${index}].veto 必须是布尔值`)
        if (issue.recommended_action !== undefined && typeof issue.recommended_action !== 'string') {
          malformed.push(`issues[${index}].recommended_action 必须是字符串`)
        }
      }
    }
    if (!review.scores || typeof review.scores !== 'object' || Array.isArray(review.scores)) {
      malformed.push('scores 必须是对象')
    } else {
      for (const [dimension, score] of Object.entries(review.scores)) {
        if (!plotDimensions.has(dimension)) malformed.push(`scores 包含未知维度 ${JSON.stringify(dimension)}`)
        if (!Number.isFinite(score) || score < 0 || score > 100) malformed.push(`scores.${dimension}=${JSON.stringify(score)}`)
      }
    }
    if (malformed.length) {
      throw new Error(`novel-studio: Plot Gate 评审输出非法：${malformed.join('；')}；未写入剧情候选`)
    }
  }

  const gateInputs = []
  const persistedIssueIds = []
  for (const issue of (plotReview?.structured?.issues || [])) {
    const dimension = plotDimensions.has(issue.dimension) ? issue.dimension : 'structure'
    const row = addIssue(projectDir, {
      ...issue,
      dimension,
      severity: issue.severity || 'high',
      possible_source: issue.possible_source || 'plot-architect',
      source: 'plot-gate-review',
      chapter: `${normalizeChapterId(startChapter)}-${normalizeChapterId(endChapter)}`,
      status: 'open',
    })
    persistedIssueIds.push(row.issue_id)
    gateInputs.push({ ...issue, issue_id: row.issue_id, dimension, severity: row.severity })
  }
  for (const [dimension, score] of Object.entries(plotReview?.structured?.scores || {})) {
    if (plotDimensions.has(dimension) && Number.isFinite(score) && score >= 0 && score <= 100) {
      gateInputs.push({ issue_id: `score-${startChapter}-${dimension}`, dimension, severity: 'low', score })
    }
  }
  if (!plotReview?.structured) {
    const row = addIssue(projectDir, {
      dimension: 'structure', severity: 'high', status: 'open', source: 'plot-gate-review',
      evidence: plotReview?.error || 'Plot Gate 评审没有结构化输出',
      expected: '八维完整评分', actual: '评审输出缺失', possible_source: 'planner',
    })
    persistedIssueIds.push(row.issue_id)
    gateInputs.push({ issue_id: row.issue_id, dimension: 'structure', severity: 'high', evidence: row.evidence })
  }
  const gate = runGate('plot', gateInputs)
  recordGate(projectDir, {
    gate: 'plot', target: `chapters ${startChapter}-${endChapter}`, pass: gate.pass,
    score: gate.score, verdict: gate.decision, issues: persistedIssueIds,
    evidenceComplete: gate.completeness.complete,
  })

  writeJsonAtomic(join(projectDir, 'reviews', `plot-${normalizeChapterId(startChapter)}-${normalizeChapterId(endChapter)}.json`), {
    range: [startChapter, endChapter], at: nowIso(), gate, issueIds: persistedIssueIds,
    candidate: { master_plot: initialPlanning ? data.master_plot : undefined, volumes: data.volumes, contracts: data.contracts },
  })

  let masterWritten = false
  if (initialPlanning) {
    writeArtifact(projectDir, {
      id: '04_master_plot', title: '全书剧情总纲', content: data.master_plot,
      owner: 'plot-architect', changeReason: `Phase2 全书规划，第${startChapter}-${endChapter}章候选`,
    })
    masterWritten = true
  }

  if (gate.pass) {
    if (masterWritten) approveArtifact(projectDir, { id: '04_master_plot', approvedBy: 'planner', activate: true, note: 'Plot Gate PASS' })
    if (!reviewExisting) {
      for (const v of data.volumes || []) {
        const text = typeof v.plan === 'string' ? v.plan : JSON.stringify(v, null, 2)
        writeTextAtomic(join(projectDir, 'plot', 'volumes', `volume-${String(v.volume).padStart(2, '0')}.md`), text)
      }
      addChapterContracts(projectDir, data.contracts, { owner: 'plot-architect', overwrite: reworkingContracts })
    }
    for (const node of ['04_master_plot', 'volumes', 'chapters']) {
      try { resolveStaleNode(projectDir, node, { disposition: 'RE-REVIEW', note: `Plot Gate PASS，第${startChapter}-${endChapter}章` }) } catch { /* 非 STALE */ }
    }
    const current = getProject(projectDir)
    setWorkflowState(current, 'WRITING', `Plot Gate PASS，第${startChapter}-${endChapter}章可生产`)
    saveProject(projectDir, current)
  }

  gitCommit(projectDir, `plot: Plot Gate ${gate.pass ? 'PASS' : 'FAIL'}，第${startChapter}-${endChapter}章（${gate.score ?? 'incomplete'}）`)
  return {
    action: 'plot',
    volumes: (data.volumes || []).map(v => v.volume),
    contracts: (data.contracts || []).map(c => c.chapter),
    plotGate: gate,
    issueIds: persistedIssueIds,
    next: gate.pass ? '运行 novel_writer_write_batch 生产本批正文' : '按 Plot Gate 问题修订后重跑 novel_phase_plot；失败候选不会推进章节游标',
  }
}

/** Phase 3：Writer 批量写正文（含状态写回） */
async function phaseWriteBatch(ctx, exec, projectDir, opts) {
  const project = getProject(projectDir)
  assertWriterProductionReady(projectDir, project.workflow.state)
  const range = opts.range || []
  let targets = (opts.chapters || []).map(normalizeChapterId)
  if (range?.length === 2) {
    const [a, b] = [Number(range[0]), Number(range[1])]
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) {
      throw new Error('novel-studio: range 必须是有效的 [start, end] 正整数区间')
    }
    for (let n = a; n <= b; n++) targets.push(normalizeChapterId(n))
  }
  targets = [...new Set(targets)].sort((a, b) => Number(a) - Number(b))
  if (!targets.length) {
    // 默认取下一批 PLANNED
    const states = listChapterStates(projectDir)
    const batchSize = project.brief.chaptersPerBatch || 10
    targets = states
      .filter(s => s.status === 'PLANNED')
      .slice(0, batchSize)
      .map(s => normalizeChapterId(s.chapter))
  }
  if (!targets.length) throw new Error('novel-studio: 没有可写章节（PLANNED），先运行 novel_phase_plot 或 novel_rework_execute 生成契约')

  let book = loadContracts(projectDir)
  // 任何快照恢复或状态迁移前，先验完用户传入的全部目标。
  for (const chapter of targets) {
    const row = book.chapters[chapter]
    if (!row) throw new Error(`novel-studio: 章节 ${chapter} 无契约（先运行 novel_phase_plot）`)
    if (!['PLANNED', 'REWORK'].includes(row.status)) {
      throw new Error(`novel-studio: 章节 ${chapter} 当前为 ${row.status}，只有 PLANNED/REWORK 可进入写作`)
    }
  }

  const requestedRework = targets.filter(chapter => book.chapters[chapter]?.status === 'REWORK')
  if (requestedRework.length) {
    const earliest = Math.min(...requestedRework.map(Number))
    const downstream = book.order.filter(chapter => Number(chapter) >= earliest && book.chapters[chapter]?.status !== 'PLANNED')
    const replayableStates = new Set(['WRITING', 'QA', 'READER_TEST', 'ACCEPTED', 'DIAGNOSIS', 'REWORK'])
    for (const chapter of downstream) {
      const status = book.chapters[chapter]?.status
      if (!replayableStates.has(status)) {
        throw new Error(`novel-studio: 章节 ${chapter} 当前为 ${status || '无状态'}，无法安全重放 Writer 状态`)
      }
    }
    targets = [...new Set([...targets, ...downstream])].sort((a, b) => Number(a) - Number(b))
    restoreWriterBaseline(projectDir, normalizeChapterId(earliest))
    for (const chapter of downstream) {
      if (book.chapters[chapter].status !== 'REWORK') {
        setChapterState(projectDir, chapter, 'REWORK', `第 ${normalizeChapterId(earliest)} 章返工，需顺序重放后续状态`)
      }
    }
    book = loadContracts(projectDir)
  }

  const writingProject = getProject(projectDir)
  setWorkflowState(writingProject, 'WRITING', `写第 ${targets[0]}-${targets[targets.length - 1]} 章`)
  saveProject(projectDir, writingProject)

  const written = []
  const problems = []
  for (const ch of targets) {
    try {
      const entry = await writeOneChapter(ctx, exec, projectDir, ch)
      written.push(ch)
      problems.push(...(entry.problems || []).map(p => `第${ch}章: ${p}`))
    } catch (error) {
      const failedProject = getProject(projectDir)
      setWorkflowState(failedProject, 'REWORK', `第${ch}章写作失败，等待返工`)
      saveProject(projectDir, failedProject)
      throw new Error(`novel-studio: 第 ${ch} 章写作失败：${String(error?.message || error)}`, { cause: error })
    }
  }

  const p2 = getProject(projectDir)
  setWorkflowState(p2, 'CONTENT_REVIEW', '本批正文完成，等待专业审查')
  saveProject(projectDir, p2)
  try { resolveStaleNode(projectDir, 'manuscript', { disposition: 'REGENERATE', note: `Writer 完成第 ${targets.join(', ')} 章` }) } catch { /* 非 STALE */ }
  return { action: 'write', chapters: written, problems, next: '运行 novel_review_run 进行专业审查（Chapter Gate）' }
}

/** 写单章：Context Builder → Writer 子代理 → 校验 → 手稿落盘 → 状态写回 → QA */
async function writeOneChapter(ctx, exec, projectDir, ch) {
  const chapterId = normalizeChapterId(ch)
  persistWriterBaseline(projectDir, chapterId)
  setChapterState(projectDir, chapterId, 'WRITING', 'Writer 已领取 Chapter Contract')
  const rollbackFiles = [
    'library/project.json',
    'state/story_state.json',
    'state/character_state.json',
    'state/timeline.json',
    'state/foreshadowing.json',
  ]
  const snapshots = new Map(rollbackFiles.map(rel => [rel, readText(join(projectDir, rel))]))
  const manuscriptPath = manuscriptPathFor(projectDir, chapterId)
  const previousManuscript = existsSync(manuscriptPath) ? readText(manuscriptPath) : null

  try {
    const { ctx: writerCtx, contract } = buildWriterContext(projectDir, chapterId)
    const out = await spawnProjectRole(ctx, exec, projectDir, {
      role: 'writer',
      label: `写第${chapterId}章`,
      prompt: [
        '【Chapter Contract 生产任务】',
        `项目目录：${projectDir}｜本章契约号：${chapterId}`,
        '请用只读工具 novel_chapter_read / novel_artifact_read / novel_state_read 核实以下上下文（以下为装配好的 Context Builder 快照，与其冲突时以快照+只读核实为准）：',
        '',
        writerCtx,
        '',
        '要求：',
        '- 严格履行 contract 的 entry_state → chapter_goal → conflict → turning_point → payoff → exit_state；兑现 emotional_curve 与 end_hook。',
        '- forbidden_changes 与用户硬约束是法律条文：一个字符都不能违反。',
        '- 发现契约与 Canon 冲突：不自行圆场，写进 problems。',
        '- 字数：约 2000-3000 字（按平台习惯），场景承载信息与情绪。',
        '- 返回 manuscript（正文，不含章节号标题）与 stateChanges（人物/伏笔/时间轴/开放线程）。',
      ].join('\n'),
    })

    if (!out.structured?.manuscript || !String(out.structured.manuscript).trim()) {
      throw new Error(`第${chapterId}章无正文输出（${out.error || '结构化缺失'}）`)
    }
    const stateChanges = out.structured.stateChanges || {}
    const ms = String(out.structured.manuscript).replace(/\n{3,}/g, '\n\n').trim()

    applyWriterStateChanges(projectDir, chapterId, stateChanges)
    syncContractForeshadowing(projectDir, contract, chapterId)
    writeTextAtomic(manuscriptPath,
      `# 第 ${Number(chapterId)} 章${contract.title ? '：' + contract.title : ''}\n\n> POV: ${contract.pov || ''} ｜ 地点: ${contract.location || ''} ｜ 时间: ${contract.time || ''}\n\n${ms}\n`)
    setChapterState(projectDir, chapterId, 'QA', '正文完成，等待审查')

    return { ok: true, chapter: chapterId, problems: out.structured.problems || [], notes: stateChanges }
  } catch (error) {
    for (const [rel, content] of snapshots) {
      if (content) writeTextAtomic(join(projectDir, rel), content)
    }
    if (previousManuscript !== null) writeTextAtomic(manuscriptPath, previousManuscript)
    else rmSync(manuscriptPath, { force: true })
    setChapterState(projectDir, chapterId, 'REWORK', `Writer 失败：${String(error?.message || error).slice(0, 200)}`)
    addIssue(projectDir, {
      dimension: 'prose', severity: 'high', chapter: chapterId, status: 'open',
      evidence: String(error?.message || error), expected: 'Writer 输出完整正文并完成状态申报',
      actual: '写作任务失败，已回滚状态与手稿', possible_source: 'writer', source: 'writer-runtime',
      recommended_action: '检查子代理输出与 Chapter Contract 后重跑该章',
    })
    throw error
  }
}

function applyWriterStateChanges(projectDir, ch, changes) {
  // 1) story
  if (changes.story) {
    const story = loadStoryState(projectDir)
    const merged = {
      current: {
        chapter: Number(ch),
        location: changes.story.current?.location || story.current.location || '',
        time: changes.story.current?.time || story.current.time || '',
        summary: changes.story.current?.summary || `第${ch}章完成`,
      },
      worldState: { ...(story.worldState || {}), ...(changes.story.worldState || {}) },
      openThreads: changes.openThreads && changes.openThreads.length
        ? [...(story.openThreads || []), ...changes.openThreads.map(t => ({ id: `T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, summary: t, status: 'open' }))]
        : story.openThreads,
      notes: [...(story.notes || []), { chapter: Number(ch), at: nowIso(), note: changes.story.current?.summary || '' }].slice(-50),
    }
    writeState(projectDir, 'story', merged, { reason: `Writer 第${ch}章状态申报` })
  }

  // 2) characters
  if (Array.isArray(changes.characters)) {
    const cs = loadCharacterState(projectDir)
    for (const u of changes.characters) {
      if (!cs.characters[u.id]) {
        // 不存在的 id：记录为问题（写入 notes 会抛出；这里静默收集到 story notes）
        continue
      }
      cs.characters[u.id].state = u.state || cs.characters[u.id].state
      cs.characters[u.id].current = { ...(cs.characters[u.id].current || {}), state: u.state || cs.characters[u.id].current?.state || '', detail: u.detail || '' }
      cs.characters[u.id].lastSeenChapter = Number(ch)
    }
    writeState(projectDir, 'character', cs, { reason: `Writer 第${ch}章人物状态` })
  }

  // 3) foreshadowing
  if (Array.isArray(changes.foreshadowing)) {
    const fsh = loadForeshadowing(projectDir)
    for (const f of changes.foreshadowing) {
      const action = f.action || 'none'
      if (action === 'plant') {
        fsh.items.push({
          id: `F${String(fsh.nextId).padStart(4, '0')}`,
          summary: f.summary || '',
          plantedAt: Number(ch),
          dueBy: f.dueBy ?? Number(ch) + 20,
          status: 'open',
        })
        fsh.nextId += 1
      } else if (action === 'payoff') {
        const target = fsh.items.find(i => ['open', 'pending'].includes(i.status) && (!f.targetId || i.id === f.targetId) && (!f.summary || i.summary.includes(String(f.summary).slice(0, 12)) || String(f.summary).includes(i.summary.slice(0, 12))))
        if (target) {
          target.status = 'paid_off'
          target.paidOffAt = Number(ch)
        }
      }
    }
    writeState(projectDir, 'foreshadowing', fsh, { reason: `Writer 第${ch}章伏笔登记` })
  }

  // 4) timeline
  if (Array.isArray(changes.timeline)) {
    const tl = loadTimeline(projectDir)
    for (const e of changes.timeline) {
      if (e && e.event) tl.events.push({ chapter: Number(ch), at: nowIso(), time: e.time || '', location: e.location || '', event: e.event })
    }
    writeState(projectDir, 'timeline', tl, { reason: `Writer 第${ch}章时间轴` })
  }
}

/** 契约里声明的伏笔 plan/payoff 与伏笔库对齐（防止契约与正文脱节） */
function syncContractForeshadowing(projectDir, contract, ch) {
  const fsh = loadForeshadowing(projectDir)
  let changed = false
  for (const f of contract.foreshadowing || []) {
    if (!f || !f.action || f.action === 'none') continue
    if (f.action === 'plant') {
      if (!fsh.items.some(i => i.plantedAt === Number(ch) && i.summary.includes(String(f.summary || '').slice(0, 10)))) {
        fsh.items.push({
          id: `F${String(fsh.nextId).padStart(4, '0')}`,
          summary: f.summary || '(契约伏笔)',
          plantedAt: Number(ch),
          dueBy: f.dueBy ?? Number(ch) + 20,
          status: 'pending',
          source: 'contract',
        })
        fsh.nextId += 1
        changed = true
      }
    } else if (f.action === 'payoff') {
      const target = fsh.items.find(i => ['open', 'pending'].includes(i.status) && ((i.summary || '').includes(String(f.summary || '').slice(0, 10)) || String(f.summary || '').includes((i.summary || '').slice(0, 10))))
      if (target && target.status !== 'paid_off') {
        target.status = 'paid_off'
        target.paidOffAt = Number(ch)
        changed = true
      }
    }
  }
  if (changed) writeState(projectDir, 'foreshadowing', fsh, { reason: `契约-库对齐 第${ch}章` })
}

/** Phase 4：Reviewer Pool 专业审查 + Chapter Gate */
async function phaseReview(ctx, exec, projectDir, opts = {}) {
  const project = getProject(projectDir)
  const inFlight = listChapterStates(projectDir).filter(s => s.status === 'QA').map(s => Number(s.chapter))
  const chapters = (opts.chapters || []).map(Number).length ? [...new Set(opts.chapters.map(Number))] : inFlight
  if (!chapters.length) throw new Error('novel-studio: 没有待审查章节（QA）')
  const book = loadContracts(projectDir)
  for (const chapter of chapters) {
    const row = book.chapters[normalizeChapterId(chapter)]
    if (!row || row.status !== 'QA') {
      throw new Error(`novel-studio: 第 ${chapter} 章当前为 ${row?.status || '无契约'}，只有 QA 章节可审查`)
    }
  }

  setWorkflowState(project, 'CONTENT_REVIEW', '专业审查进行中')
  saveProject(projectDir, project)

  const chaptersText = `本章范围：${chapters.join(', ')}`
  const base = ['【专业审查任务】', `项目目录：${projectDir}`, chaptersText,
    '请用只读工具 novel_chapter_read 逐章读取（契约+正文+状态），按你的审查维度输出结构化问题。',
    '每条问题：{ issue_id(以你的前缀开头), chapter(必填且只能是本批章节), severity(blocking/high/medium/low), dimension, veto?(明确命中一票否决时为 true), evidence(引用原文), expected, actual, possible_source, recommended_action }。',
    'blocking 仅用于：违反 Canon/契约核心目标/连续性硬断裂。',
    '若偏离 Chapter Contract 核心目标，issue 的 dimension 必须填写 contract，以触发一票否决。',
    '同时给出 dimensionScores（本批各维度 0-100 评分）；若各章分数不同，另给 chapterScores: { 章节号: { 维度: 分数 } }。'].join('\n')

  const dims = {
    '剧情/情绪审查': ['plot', 'structure', 'hook', 'payoff', 'emotion', 'pacing', 'info_release'],
    '人设一致性审查': ['character'],
    '世界观/规则审查': ['world', 'canon', 'numbers'],
    '连续性审查': ['continuity'],
    '文笔/对话/事实审查': ['prose', 'dialogue', 'style', 'fact'],
    '伏笔审查': ['foreshadow'],
  }
  const reviewerDimensionSet = new Set(REVIEWER_DIMENSIONS)
  const jobs = Object.entries(dims).map(([label, dimensions]) => ({
    role: label.includes('连续性') ? 'continuity-checker' : 'reviewer',
    label,
    prompt: base + `\n\n你的审查维度：${dimensions.join(', ')}。issue 前缀：${label.slice(0, 4)}-R${Math.abs(hash(label)) % 9 + 1}-。`,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['issues', 'dimensionScores'],
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['chapter', 'severity', 'dimension', 'evidence'],
            properties: {
              chapter: { type: 'number' },
              severity: { type: 'string', enum: ['blocking', 'high', 'medium', 'low'] },
              dimension: { type: 'string', enum: REVIEWER_DIMENSIONS },
              veto: { type: 'boolean' },
              evidence: { type: 'string' },
            },
          },
        },
        dimensionScores: { type: 'object', additionalProperties: true },
        chapterScores: { type: 'object', additionalProperties: true },
      },
    },
  }))

  const results = await spawnProjectParallel(3, ctx, exec, projectDir, jobs)

  const allIssues = []
  const perChapterScores = {}
  const unknownScoreIssues = new Set()
  for (const r of results) {
    const structured = r.structured
    if (!r.ok || !structured) {
      for (const ch of chapters) {
        const row = addIssue(projectDir, {
          dimension: 'review_integrity', severity: 'blocking', veto: true,
          chapter: normalizeChapterId(ch), status: 'open',
          evidence: `${r.label} 审查失败：${r.error || '结构化输出缺失'}`, expected: '有效审查报告', actual: '子代理失败',
          possible_source: 'reviewer', source: 'review-pool',
        })
        allIssues.push(row)
      }
      continue
    }
    const expectedDimensions = [...new Set((dims[r.label] || []).map(dimension => normalizeGateDimension('chapter', dimension)))]
    for (const ch of chapters) {
      const raw = structured.chapterScores?.[ch]
        || structured.chapterScores?.[normalizeChapterId(ch)]
        || structured.dimensionScores
        || {}
      const supplied = new Set(Object.keys(raw).map(dimension => normalizeGateDimension('chapter', dimension)))
      const missing = expectedDimensions.filter(dimension => !supplied.has(dimension))
      if (!missing.length) continue
      const row = addIssue(projectDir, {
        dimension: 'review_integrity', severity: 'blocking', veto: true,
        chapter: normalizeChapterId(ch), status: 'open',
        evidence: `${r.label} 缺评分：${missing.join(', ')}`,
        expected: `覆盖职责评分 ${expectedDimensions.join(', ')}`, actual: Object.keys(raw).join(', ') || '无评分',
        possible_source: 'reviewer', source: 'review-pool',
      })
      allIssues.push(row)
    }
    for (const it of (structured?.issues || [])) {
      const issueChapter = Number(it.chapter)
      const targetChapters = chapters.includes(issueChapter) ? [issueChapter] : chapters
      const sourceDimension = it.dimension || 'prose'
      const knownDimension = reviewerDimensionSet.has(sourceDimension)
      const dimension = knownDimension ? normalizeGateDimension('chapter', sourceDimension) : 'review_integrity'
      for (const targetChapter of targetChapters) {
        const row = addIssue(projectDir, {
          dimension,
          reviewDimension: sourceDimension,
          severity: knownDimension ? (it.severity || 'high') : 'blocking',
          veto: knownDimension ? it.veto === true : true,
          evidence: knownDimension
            ? it.evidence
            : `${r.label} 返回未知审查维度 ${JSON.stringify(sourceDimension)}：${it.evidence || '无证据'}`,
          expected: knownDimension ? it.expected : `dimension 必须是 ${REVIEWER_DIMENSIONS.join(', ')}`,
          actual: knownDimension ? it.actual : String(sourceDimension),
          possible_source: it.possible_source || r.label,
          recommended_action: it.recommended_action,
          chapter: normalizeChapterId(targetChapter),
          status: 'open',
          source: 'review-pool',
        })
        allIssues.push(row)
      }
    }
    // 优先使用逐章分；旧格式 dimensionScores 作为本批共同分数兼容。
    for (const ch of chapters) {
      perChapterScores[ch] = perChapterScores[ch] || {}
      const raw = structured?.chapterScores?.[ch]
        || structured?.chapterScores?.[normalizeChapterId(ch)]
        || structured?.dimensionScores
        || {}
      for (const [sourceDimension, score] of Object.entries(raw)) {
        if (!reviewerDimensionSet.has(sourceDimension)) {
          const key = `${r.label}:${ch}:${sourceDimension}`
          if (!unknownScoreIssues.has(key)) {
            unknownScoreIssues.add(key)
            const row = addIssue(projectDir, {
              dimension: 'review_integrity', severity: 'blocking', veto: true,
              chapter: normalizeChapterId(ch), status: 'open',
              evidence: `${r.label} 返回未知评分维度 ${JSON.stringify(sourceDimension)}`,
              expected: `dimensionScores 只能使用 ${REVIEWER_DIMENSIONS.join(', ')}`,
              actual: String(sourceDimension), possible_source: 'reviewer', source: 'review-pool',
            })
            allIssues.push(row)
          }
          continue
        }
        const dimension = normalizeGateDimension('chapter', sourceDimension)
        if (!Number.isFinite(score) || score < 0 || score > 100) continue
        const previous = perChapterScores[ch][dimension]
        perChapterScores[ch][dimension] = previous === undefined ? score : Math.min(previous, score)
      }
    }
  }

  // 审查产物落盘 + Chapter Gate
  const gateResults = {}
  for (const ch of chapters) {
    const scores = perChapterScores[ch] || {}
    const gateIssues = []
    for (const [dim, score] of Object.entries(scores)) {
      gateIssues.push({ issue_id: `score-${ch}-${dim}`, dimension: dim, severity: 'low', score })
    }
    const chIssues = allIssues.filter(i => Number(i.chapter) === Number(ch))
    for (const it of chIssues) {
      gateIssues.push({ issue_id: it.issue_id, dimension: it.dimension, severity: it.severity, veto: it.veto === true, evidence: it.evidence, recommended_action: it.recommended_action })
    }
    const gate = runGate('chapter', gateIssues)
    if (!gate.completeness.complete) {
      const row = addIssue(projectDir, {
        dimension: 'prose', severity: 'high', chapter: normalizeChapterId(ch), status: 'open',
        evidence: `Chapter Gate 输入不完整，缺评分：${gate.completeness.missingScoreDimensions.join(', ') || '无'}`,
        expected: '六个 Chapter Gate 维度均有显式评分', actual: Object.keys(scores).join(', ') || '无评分',
        possible_source: 'reviewer', source: 'review-pool',
      })
      chIssues.push(row)
      allIssues.push(row)
    } else if (!gate.pass && !gate.vetoes.length && !chIssues.some(issue => ['blocking', 'high'].includes(issue.severity))) {
      const lowest = Object.entries(gate.breakdown).sort((a, b) => a[1].score - b[1].score)[0]
      const row = addIssue(projectDir, {
        dimension: lowest?.[0] || 'prose', severity: 'high', chapter: normalizeChapterId(ch), status: 'open',
        evidence: `Chapter Gate 综合得分 ${gate.score} 低于 ${gate.threshold}，最低维度 ${lowest?.[0] || 'prose'}=${lowest?.[1]?.score ?? '?'}`,
        expected: `综合得分 >= ${gate.threshold}`, actual: String(gate.score),
        possible_source: 'reviewer', source: 'review-pool',
      })
      chIssues.push(row)
      allIssues.push(row)
    }
    writeJsonAtomic(join(projectDir, 'reviews', `chapter-${String(ch).padStart(3, '0')}`, 'review.json'), {
      chapter: ch,
      at: nowIso(),
      pool: results.map(r => ({ label: r.label, ok: r.ok && Boolean(r.structured) })),
      dimensionScores: scores,
      issues: chIssues.map(i => i.issue_id),
    })
    recordGate(projectDir, {
      gate: 'chapter', target: `chapter-${normalizeChapterId(ch)}`, pass: gate.pass,
      score: gate.score, verdict: gate.decision, issues: chIssues.map(issue => issue.issue_id),
      evidenceComplete: gate.completeness.complete,
    })
    gateResults[ch] = gate
    if (gate.pass) {
      setChapterState(projectDir, ch, 'READER_TEST', `Chapter Gate PASS ${gate.score}`)
      resolveRevalidatedChapterIssues(projectDir, ch, `Chapter Gate PASS ${gate.score}`)
    } else {
      setChapterState(projectDir, ch, 'DIAGNOSIS', `Chapter Gate FAIL ${gate.score}`)
    }
  }

  const p2 = getProject(projectDir)
  const allPassed = Object.values(gateResults).every(g => g.pass)
  setWorkflowState(p2, allPassed ? 'READER_TEST' : 'DIAGNOSIS', allPassed ? '审查完成，进入 Reader Lab' : 'Chapter Gate 失败，进入诊断')
  p2.counters.reviews = (p2.counters.reviews || 0) + chapters.length
  saveProject(projectDir, p2)
  const summary = Object.entries(gateResults).map(([ch, g]) => `第${ch}章: ${g.pass ? 'PASS' : 'FAIL'}（${g.score}）`).join('；')
  return {
    action: 'review',
    gateSummary: summary,
    issues: allIssues.map(i => i.issue_id),
    next: allPassed ? '运行 novel_reader_lab_run 做读者验证' : '运行 novel_diagnose 定位根因后 novel_rework_execute 返工',
  }
}

/** Phase 5：Reader Lab（设计 §12） */
async function phaseReaderLab(ctx, exec, projectDir, opts = {}) {
  const project = getProject(projectDir)
  const chapters = (opts.chapters || []).length
    ? [...new Set(opts.chapters.map(Number))]
    : listChapterStates(projectDir).filter(s => s.status === 'READER_TEST').map(s => Number(s.chapter))
  if (!chapters.length) throw new Error('novel-studio: 没有待读者验证的章节（READER_TEST）')
  const book = loadContracts(projectDir)
  for (const chapter of chapters) {
    const row = book.chapters[normalizeChapterId(chapter)]
    if (!row || row.status !== 'READER_TEST') {
      throw new Error(`novel-studio: 第 ${chapter} 章当前为 ${row?.status || '无契约'}，只有 READER_TEST 章节可验证`)
    }
  }

  const mix = opts.personaMix || [
    { segment: '学生党', ratio: 0.40, traits: '碎片时间多、喜欢快节奏爽点、群像热闹、更新快' },
    { segment: '上班族', ratio: 0.35, traits: '通勤/睡前阅读、需要情绪出口、讨厌注水、追更粘性中等' },
    { segment: '核心类型读者', ratio: 0.20, traits: '题材深度用户、熟悉套路、对创新点和硬伤敏感' },
    { segment: '资深读者', ratio: 0.05, traits: '书龄长、口味刁、重文笔与逻辑、敢于弃书' },
  ]
  if (!mix.length || mix.some(row => !row.segment || !Number.isFinite(row.ratio) || row.ratio <= 0)) {
    throw new Error('novel-studio: personaMix 必须包含 segment 与正数 ratio')
  }
  const density = Number(opts.readersPerChapter ?? 3)
  const capacity = Number(opts.instanceCount ?? 60)
  if (!Number.isSafeInteger(density) || density < 1) throw new Error('novel-studio: readersPerChapter 必须是正整数')
  const requiredCapacity = chapters.length * density
  if (!Number.isSafeInteger(capacity) || capacity < requiredCapacity) {
    throw new Error(`novel-studio: Reader Lab 容量 instanceCount 至少为 chapters × readersPerChapter = ${requiredCapacity}，当前 ${capacity}`)
  }
  const instances = []
  const rng = mulberry32(hash(project.meta.projectId + ':' + chapters.join('-')))
  for (let round = 0; round < density && instances.length < capacity; round++) {
    for (const ch of chapters) {
      if (instances.length >= capacity) break
      const pick = weightedPick(mix, rng())
      instances.push({
        id: `R-${ch}-${round + 1}`,
        chapter: ch,
        ...pick,
      })
    }
  }

  writeJsonAtomic(join(projectDir, 'reader_lab', 'personas.json'), { mix, at: nowIso() })

  const jobs = instances.map(inst => ({
    role: 'reader-instance',
    label: `读者 ${inst.id}`,
    prompt: [
      '【模拟读者试读任务】',
      `项目目录：${projectDir}`,
      `你要试读第 ${inst.chapter} 章，personaId：${inst.id}。`,
      `你的人物设定：${inst.segment}——${inst.traits}`,
      '请用只读工具 novel_chapter_read 读取该章（契约+正文+相关状态），然后完整体验并诚实作答：',
      'completion(完读率0-100)/nextChapterWillingness(下一章意愿0-100)/skipRate(跳读率0-100)/dropPoint(弃书点或null)/pacing/emotionHit/characterAffinity/payoffDelivery(均为0-100)/foreshadowRecall(记住的悬念)/bestMoments/worstMoments(引用原文)/redLineHit(是否踩到你的雷点)/redLineNote/comment(书评区口吻短评)。',
      '特别交代：如果你中途弃书，completion 应低于 100 并给出 dropPoint；不要因为"这是 AI 写的"而放水。',
    ].join('\n'),
  }))

  const results = await spawnProjectParallel(5, ctx, exec, projectDir, jobs)
  const records = []
  const seenPersonaIds = new Set()
  const metrics = { completion: [], next_chapter: [], skip: [], pacing: [], emotion: [], affinity: [], payoff: [] }
  const earlyIssueIds = new Map(chapters.map(ch => [ch, []]))
  for (const r of results) {
    const structured = r.structured
    const expectedInst = instances.find(instance => r.label === `读者 ${instance.id}`)
    const personaMatches = structured?.personaId === expectedInst?.id
    const duplicate = personaMatches && seenPersonaIds.has(structured.personaId)
    if (!structured || !expectedInst || !personaMatches || duplicate) {
      const fallbackInst = expectedInst
      if (fallbackInst) {
        const row = addIssue(projectDir, {
          dimension: 'completion', severity: 'high', chapter: normalizeChapterId(fallbackInst.chapter), status: 'open',
          evidence: `${r.label} 未返回有效样本：${r.error || (!personaMatches ? `personaId 应为 ${fallbackInst.id}，实际 ${structured?.personaId || '缺失'}` : duplicate ? 'personaId 重复' : '结构化输出缺失')}`,
          expected: '完整 Reader 指标', actual: '无有效数据', possible_source: 'reader-instance', source: 'reader-lab',
        })
        earlyIssueIds.get(fallbackInst.chapter).push(row.issue_id)
      }
      continue
    }
    const inst = expectedInst
    const numericFields = ['completion', 'nextChapterWillingness', 'skipRate', 'pacing', 'emotionHit', 'characterAffinity', 'payoffDelivery']
    const invalid = numericFields.filter(field => !Number.isFinite(Number(structured[field])) || Number(structured[field]) < 0 || Number(structured[field]) > 100)
    if (typeof structured.redLineHit !== 'boolean') invalid.push('redLineHit')
    if (invalid.length) {
      const row = addIssue(projectDir, {
        dimension: 'completion', severity: 'high', chapter: normalizeChapterId(inst.chapter), status: 'open',
        evidence: `${inst.id} 指标非法：${invalid.join(', ')}`, expected: '所有 Reader 指标为 0-100 有限数',
        actual: JSON.stringify(Object.fromEntries(invalid.map(field => [field, structured[field]]))),
        possible_source: 'reader-instance', source: 'reader-lab',
      })
      earlyIssueIds.get(inst.chapter).push(row.issue_id)
      continue
    }
    const rec = { personaId: structured.personaId || inst.id, chapter: inst.chapter, segment: inst.segment, ...structured }
    seenPersonaIds.add(rec.personaId)
    records.push(rec)
    writeJsonAtomic(join(projectDir, 'reader_lab', 'instances', `${rec.personaId}.json`), { ...rec, at: nowIso() })
    metrics.completion.push(Number(structured.completion ?? 0))
    metrics.next_chapter.push(Number(structured.nextChapterWillingness ?? 0))
    metrics.skip.push(Number(structured.skipRate ?? 0))
    metrics.pacing.push(Number(structured.pacing ?? 0))
    metrics.emotion.push(Number(structured.emotionHit ?? 0))
    metrics.affinity.push(Number(structured.characterAffinity ?? 0))
    metrics.payoff.push(Number(structured.payoffDelivery ?? 0))
  }

  const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 0
  const dropPoints = records.filter(r => r.dropPoint).map(r => `第${r.chapter}章(${r.personaId}): ${r.dropPoint}`)
  const chapterGates = {}
  const issueIds = []
  for (const chapter of chapters) {
    const chapterRecords = records.filter(record => Number(record.chapter) === chapter)
    const values = key => chapterRecords.map(record => Number(record[key]))
    const chapterMetrics = {
      completion: avg(values('completion')),
      next_chapter: avg(values('nextChapterWillingness')),
      retention: +((avg(values('completion')) + avg(values('nextChapterWillingness'))) / 2).toFixed(1),
      payoff_delivery: avg(values('payoffDelivery')),
      emotion_hit: avg(values('emotionHit')),
      character_affinity: avg(values('characterAffinity')),
      pacing: avg(values('pacing')),
    }
    const gateIssues = chapterRecords.length
      ? Object.entries(chapterMetrics).map(([dimension, score]) => ({
          issue_id: `m-${normalizeChapterId(chapter)}-${dimension}`, dimension, severity: 'low', score,
        }))
      : []
    const chapterIssueIds = [...earlyIssueIds.get(chapter)]
    const expectedSamples = instances.filter(instance => Number(instance.chapter) === chapter).length
    if (chapterRecords.length !== expectedSamples) {
      const row = addIssue(projectDir, {
        dimension: 'sample_integrity', severity: 'blocking', veto: true,
        chapter: normalizeChapterId(chapter), status: 'open',
        evidence: `计划 ${expectedSamples} 个 Reader 样本，仅 ${chapterRecords.length} 个有效`,
        expected: `${expectedSamples} 个完整有效样本`, actual: `${chapterRecords.length} 个有效样本`,
        possible_source: 'reader-instance', source: 'reader-lab',
        recommended_action: '修复失败 Reader 实例后完整重跑本章 Reader Gate',
      })
      chapterIssueIds.push(row.issue_id)
      gateIssues.push({
        issue_id: row.issue_id, dimension: 'sample_integrity', severity: 'blocking',
        veto: true, evidence: row.evidence,
      })
    }
    const redLineHits = chapterRecords.filter(record => record.redLineHit)
    const redLineRatio = chapterRecords.length ? redLineHits.length / chapterRecords.length : 0
    if (redLineRatio > 0.25) {
      const row = addIssue(projectDir, {
        dimension: 'red_line', severity: 'blocking', veto: true, chapter: normalizeChapterId(chapter), status: 'open',
        evidence: `${redLineHits.length}/${chapterRecords.length} 名读者触发弃书红线`,
        expected: '关键红线触发率不超过 25%', actual: `${Math.round(redLineRatio * 100)}%`,
        possible_source: 'reader-instance', source: 'reader-lab',
      })
      chapterIssueIds.push(row.issue_id)
      gateIssues.push({ issue_id: row.issue_id, dimension: 'red_line', severity: 'blocking', veto: true, evidence: row.evidence })
    }
    const perSegment = {}
    for (const record of chapterRecords) {
      const segment = perSegment[record.segment] || (perSegment[record.segment] = { next: [] })
      segment.next.push(Number(record.nextChapterWillingness))
    }
    for (const [segment, valuesBySegment] of Object.entries(perSegment)) {
      if (valuesBySegment.next.length < 2 || avg(valuesBySegment.next) >= 35) continue
      const row = addIssue(projectDir, {
        dimension: 'persona_collapse', severity: 'blocking', veto: true, chapter: normalizeChapterId(chapter), status: 'open',
        evidence: `${segment} 分群下一章意愿 < 35（${avg(valuesBySegment.next)}）`,
        expected: '目标 Persona 不崩塌', actual: `${segment} 追读意愿显著不足`,
        possible_source: 'reader-instance', source: 'reader-lab',
      })
      chapterIssueIds.push(row.issue_id)
      gateIssues.push({ issue_id: row.issue_id, dimension: 'persona_collapse', severity: 'blocking', veto: true, evidence: row.evidence })
    }

    const criticalMetrics = chapterRecords.length ? {
      completion: chapterMetrics.completion,
      next_chapter: chapterMetrics.next_chapter,
      payoff_delivery: chapterMetrics.payoff_delivery,
    } : {}
    const gate = runGate('reader', gateIssues, { criticalMetrics })
    for (const failure of gate.metricFailures) {
      const row = addIssue(projectDir, {
        dimension: failure.metric, severity: 'high', chapter: normalizeChapterId(chapter), status: 'open',
        evidence: `${failure.metric}=${failure.value}，低于下限 ${failure.minimum}`,
        expected: `>= ${failure.minimum}`, actual: String(failure.value),
        possible_source: 'reader-instance', source: 'reader-lab', recommended_action: '进入 Reader Diagnosis 定位弃读原因',
      })
      chapterIssueIds.push(row.issue_id)
    }
    if (!gate.completeness.complete) {
      const row = addIssue(projectDir, {
        dimension: 'completion', severity: 'high', chapter: normalizeChapterId(chapter), status: 'open',
        evidence: `Reader Gate 输入不完整：缺评分 ${gate.completeness.missingScoreDimensions.join(', ') || '无'}；缺指标 ${gate.completeness.missingCriticalMetrics.join(', ') || '无'}`,
        expected: '至少一名有效读者且所有指标完整', actual: `${chapterRecords.length} 个有效样本`,
        possible_source: 'reader-instance', source: 'reader-lab',
      })
      chapterIssueIds.push(row.issue_id)
    } else if (!gate.pass && !gate.metricFailures.length && !gate.vetoes.length) {
      const lowest = Object.entries(gate.breakdown).sort((a, b) => a[1].score - b[1].score)[0]
      const row = addIssue(projectDir, {
        dimension: lowest?.[0] || 'pacing', severity: 'high', chapter: normalizeChapterId(chapter), status: 'open',
        evidence: `Reader Gate 综合得分 ${gate.score} 低于 ${gate.threshold}，最低维度 ${lowest?.[0] || 'pacing'}=${lowest?.[1]?.score ?? '?'}`,
        expected: `综合得分 >= ${gate.threshold}`, actual: String(gate.score),
        possible_source: 'reader-instance', source: 'reader-lab',
      })
      chapterIssueIds.push(row.issue_id)
    }
    issueIds.push(...chapterIssueIds)
    chapterGates[normalizeChapterId(chapter)] = gate
    recordGate(projectDir, {
      gate: 'reader', target: `chapter-${normalizeChapterId(chapter)}`, pass: gate.pass,
      score: gate.score, verdict: gate.decision, issues: chapterIssueIds,
      evidenceComplete: gate.completeness.complete,
    })
    setChapterState(projectDir, chapter, gate.pass ? 'ACCEPTED' : 'DIAGNOSIS', `Reader Gate ${gate.decision}${gate.score === null ? '' : ` ${gate.score}`}`)
    if (gate.pass) resolveRevalidatedChapterIssues(projectDir, chapter, `Reader Gate PASS ${gate.score}`, { includeReaderLab: true })
  }

  const gateList = Object.values(chapterGates)
  const allPassed = gateList.every(gate => gate.pass)
  const representative = gateList.find(gate => !gate.pass) || gateList[0]
  const finiteScores = gateList.map(row => row.score).filter(Number.isFinite)
  const gate = {
    ...representative,
    pass: allPassed,
    score: finiteScores.length ? avg(finiteScores) : null,
    decision: allPassed ? 'PASS' : representative.decision,
    chapterGates,
  }
  const redLineHits = records.filter(record => record.redLineHit)
  const redLineRatio = records.length ? redLineHits.length / records.length : 0
  const globalSegments = {}
  for (const record of records) {
    const segment = globalSegments[record.segment] || (globalSegments[record.segment] = { n: 0, next: [], completion: [] })
    segment.n += 1
    segment.next.push(Number(record.nextChapterWillingness))
    segment.completion.push(Number(record.completion))
  }

  const summary = {
    label: `Reader Lab 第${chapters.join('-')}章`,
    pass: gate.pass,
    score: gate.score,
    instances: records.length,
    metrics: {
      completion: avg(metrics.completion),
      next_chapter: avg(metrics.next_chapter),
      skip_rate: avg(metrics.skip),
      pacing: avg(metrics.pacing),
      emotion_hit: avg(metrics.emotion),
      character_affinity: avg(metrics.affinity),
      payoff_delivery: avg(metrics.payoff),
    },
    segments: Object.fromEntries(Object.entries(globalSegments).map(([s, v]) => [s, { n: v.n, next_chapter: avg(v.next), completion: avg(v.completion) }])),
    redLineRatio: +redLineRatio.toFixed(2),
    redLines: redLineHits.map(r => r.redLineNote || r.comment).slice(0, 5),
    dropPoints: dropPoints.slice(0, 8),
    gate,
    issueIds,
  }
  writeJsonAtomic(join(projectDir, 'reader_lab', 'reports', `reader-${nowIso().slice(0, 10)}-${Date.now()}.json`), summary)

  const p2 = getProject(projectDir)
  if (allPassed) {
    setWorkflowState(p2, 'WRITING', `第${chapters.join('-')}章 Reader Gate PASS`)
    p2.counters.batches = (p2.counters.batches || 0) + 1
    try { resolveStaleNode(projectDir, 'reader', { disposition: 'RE-REVIEW', note: `Reader Gate PASS，第${chapters.join('-')}章` }) } catch { /* 非 STALE */ }
  } else {
    setWorkflowState(p2, 'DIAGNOSIS', `第${chapters.join('-')}章 Reader Gate FAIL`)
  }
  saveProject(projectDir, p2)

  return {
    action: 'reader',
    gate,
    instances: records.length,
    issueIds,
    next: allPassed ? '本批完成 —— 运行 novel_report 查看汇报，或继续规划下一批' : `运行 novel_diagnose（issueIds: ${issueIds.join(', ')}）后返工`,
  }
}

/** 根因诊断（设计 §13） */
async function phaseDiagnose(ctx, exec, projectDir, opts = {}) {
  const project = getProject(projectDir)
  const requestedIssueIds = [...new Set((opts.issueIds || []).filter(Boolean))]
  const issues = requestedIssueIds.map(id => getIssue(projectDir, id)).filter(issue => issue && !['closed', 'resolved'].includes(String(issue.status || 'open').toLowerCase()))
  if (!issues.length) {
    throw new Error('novel-studio: 没有要诊断的 issue（请传 issueIds，可从 novel_status / novel_review_run 结果取得）')
  }
  const issueIds = issues.map(issue => issue.issue_id)

  const issuesText = issues.map(i =>
    `- [${i.issue_id}] severity=${i.severity} dimension=${i.dimension} source=${i.source || '?'}\n  证据：${(i.evidence || '').slice(0, 400)}\n  期望：${i.expected || ''}\n  实际：${i.actual || ''}\n  建议：${i.recommended_action || ''}`).join('\n')

  const diag = await spawnProjectRole(ctx, exec, projectDir, {
    role: 'diagnosis-analyst',
    label: `根因诊断 ×${issues.length}`,
    prompt: [
      '【根因诊断任务】',
      `项目目录：${projectDir}`,
      '以下是症状（Issue 单），请定位根因与返工层级：',
      '',
      issuesText,
      '',
      '输出：rootCauses（角色责任权重，总和 1.0）、rollback_to（枚举值）、impactSuggestion（[startChapter, endChapter]）、rationale（推理）。',
      '回滚原则：回滚到能够解决根因的最浅层级。',
    ].join('\n'),
    outputSchema: ROLE_PERSONAS['diagnosis-analyst'].outputSchema,
  })

  const structured = diag?.structured
  const fallback = issues.map(routeByPattern).find(Boolean)
  const rollback = structured?.rollback_to || fallback?.layer || 'chapter_contract'
  const rootCauses = structured?.rootCauses || fallbackRootCauses(rollback)
  const issueRange = impactRangeFromIssues(issues)
  const impactRange = resolveDiagnosisImpactRange(projectDir, {
    rollback,
    proposedRange: structured?.impactSuggestion,
    issueRange,
  })

  const dId = `DG-${slugify(project.meta.projectId).slice(0, 12)}-${Date.now()}`
  writeJsonAtomic(join(projectDir, 'issues', `diagnosis-${dId}.json`), {
    id: dId,
    issueIds,
    rootCauses,
    rollback_to: rollback,
    impactRange,
    rationale: structured?.rationale || `规则路由 fallback：${fallback?.layerLabel || 'chapter_contract'}`,
    at: nowIso(),
    by: 'diagnosis-analyst',
  })
  for (const issue of issues) {
    updateIssue(projectDir, issue.issue_id, { status: 'diagnosed', diagnosis_id: dId })
  }

  // Agent 成长数据：blocking 级失败记入对应 Agent 档案（Book Loop -> Agent Loop 的连接）
  for (const i of issues) {
    if (['blocking', 'high'].includes(i.severity)) {
      const agentKey = agentFromDimension(i.dimension) || i.possible_source || 'writer'
      if (AGENT_KEYS.has(agentKey)) {
        recordFailure(projectDir, agentKey, {
          type: `blocking/${i.dimension}`,
          issueId: i.issue_id,
          evidence: (i.evidence || '').slice(0, 300),
          diagnosis: dId,
          suggestedFix: i.recommended_action,
        })
      }
    }
  }

  const pDiag = getProject(projectDir)
  setWorkflowState(pDiag, 'DIAGNOSIS', `诊断 ${dId}`)
  saveProject(projectDir, pDiag)

  return {
    action: 'diagnose',
    diagnosisId: dId,
    issueIds,
    rootCauses,
    rollback_to: rollback,
    impactRange,
    roleRoute: fallback,
    next: '运行 novel_rework_execute 执行返工（回滚状态 + 标记 STALE）',
  }
}

const AGENT_KEYS = new Set(Object.keys(ROLE_PERSONAS))

function agentFromDimension(dim) {
  const map = {
    plot: 'plot-architect', structure: 'plot-architect', hook: 'hook-designer', payoff: 'hook-designer',
    emotion: 'hook-designer', pacing: 'plot-architect', info_release: 'plot-architect', foreshadow: 'plot-architect',
    character: 'character-growth-expert', world: 'world-architect', canon: 'world-architect',
    numbers: 'numeric-expert', continuity: 'continuity-checker', prose: 'writer', dialogue: 'writer',
    style: 'writer', fact: 'research-assistant', reader: 'reader-instance',
    completion: 'reader-instance', next_chapter: 'reader-instance', retention: 'reader-instance',
    payoff_delivery: 'hook-designer', emotion_hit: 'hook-designer', character_affinity: 'character-growth-expert',
    red_line: 'reader-instance', persona_collapse: 'planner',
  }
  return map[dim] || null
}

function fallbackRootCauses(layer) {
  const map = {
    research: { 'research-assistant': 0.6, 'deep-researcher': 0.4 },
    world_bible: { 'world-architect': 0.7, 'plot-architect': 0.3 },
    character_arc: { 'character-growth-expert': 0.7, writer: 0.3 },
    system_rules: { 'numeric-expert': 0.8, 'world-architect': 0.2 },
    master_plot: { 'plot-architect': 0.8, planner: 0.2 },
    volume_plan: { 'plot-architect': 0.6, 'hook-designer': 0.4 },
    chapter_contract: { 'plot-architect': 0.5, 'hook-designer': 0.3, writer: 0.2 },
    writer: { writer: 0.8, 'hook-designer': 0.2 },
    plot_payoff: { 'hook-designer': 0.6, 'plot-architect': 0.4 },
    reader_diagnosis: { planner: 0.5, 'hook-designer': 0.3, 'plot-architect': 0.2 },
  }
  return map[layer] || { 'plot-architect': 0.4, writer: 0.6 }
}

/** 执行返工（设计 §13/§14） */
function phaseRework(projectDir, opts = {}) {
  const diagnosisId = opts.diagnosisId
  let diagnosis = null
  if (diagnosisId) {
    const p = join(projectDir, 'issues', `diagnosis-${diagnosisId}.json`)
    diagnosis = readJsonOr(p, null)
    if (!diagnosis) throw new Error(`novel-studio: 无此诊断 ${diagnosisId}`)
  }
  if (!diagnosis && !diagnosisId) {
    diagnosis = latestDiagnosis(projectDir)
  }
  if (!diagnosis) throw new Error('novel-studio: 没有可执行的诊断（先运行 novel_diagnose）')

  const diagnosisIssues = (diagnosis.issueIds || []).map(issueId => getIssue(projectDir, issueId)).filter(Boolean)
  const impactRange = resolveDiagnosisImpactRange(projectDir, {
    rollback: diagnosis.rollback_to || 'chapter_contract',
    proposedRange: diagnosis.impactRange,
    issueRange: impactRangeFromIssues(diagnosisIssues),
    label: `诊断 ${diagnosis.id || diagnosisId || ''}`.trim(),
  })
  diagnosis = { ...diagnosis, impactRange }

  const applied = applyDiagnosis(projectDir, {
    issueIds: diagnosis.issueIds || [],
    rootCauses: diagnosis.rootCauses,
    rollback_to: diagnosis.rollback_to,
    impact_range: diagnosis.impactRange,
    note: diagnosis.rationale || '',
  })
  for (const chapter of applied.resetChapters || []) {
    const row = loadContracts(projectDir).chapters[normalizeChapterId(chapter)]
    if (row?.status === 'DIAGNOSIS') {
      setChapterState(projectDir, chapter, 'REWORK', `诊断 ${diagnosis.id || diagnosisId} 已应用`)
    }
  }
  for (const issueId of diagnosis.issueIds || []) {
    if (getIssue(projectDir, issueId)) {
      updateIssue(projectDir, issueId, {
        status: 'in_rework',
        rework_diagnosis_id: diagnosis.id || diagnosisId,
        rework_started_at: nowIso(),
      })
    }
  }
  const persistedDiagnosis = {
    ...diagnosis,
    reworkProgress: 'ready',
    reworkAppliedAt: nowIso(),
  }
  if (persistedDiagnosis.id) {
    writeJsonAtomic(join(projectDir, 'issues', `diagnosis-${persistedDiagnosis.id}.json`), persistedDiagnosis)
  }
  return {
    action: 'rework',
    diagnosisId: diagnosis.id || diagnosisId,
    ...applied,
    next: `重跑对应阶段：${diagnosis.rollback_to === 'writer' ? 'novel_writer_write_batch（受影响章节）' : 'novel_phase_plot / novel_phase_setting / novel_phase_research 后重新审批 + 再验证'}`,
  }
}

/** Agent 成长：Learning 候选（设计 §15） */
async function phaseLearning(ctx, exec, projectDir, opts = {}) {
  const agent = opts.agentId
  if (!agent || !AGENT_KEYS.has(agent)) {
    throw new Error(`novel-studio: 需要合法 agentId（可用：${[...AGENT_KEYS].join(', ')}）`)
  }
  const profile = loadProfile(projectDir, agent) || defaultProfile(agent)
  const failures = opts.failureIds?.length
    ? (profile.recentFailures || []).filter(f => (opts.failureIds || []).includes(f.id))
    : profile.recentFailures || []
  if (!failures.length) throw new Error(`novel-studio: Agent ${agent} 没有失败记录（先让 novel_diagnose 记录 blocking 失败）`)

  const out = await spawnProjectRole(ctx, exec, projectDir, {
    role: 'learning-analyst',
    label: `${agent} 能力改进`,
    prompt: [
      '【Agent 成长任务】',
      `项目目录：${projectDir}｜目标 Agent：${agent}（当前版本 v${profile.version}）`,
      '',
      '==== Capability Profile ====',
      JSON.stringify({ capability: profile.capability, skills: profile.skills, recentFailures: failures.map(f => ({ id: f.id, type: f.type, evidence: f.evidence, suggestedFix: f.suggestedFix })) }, null, 2),
      '',
      '请产出 1-3 个改进候选（kind: prompt/skill/memory/sop/fewshot），每个候选必须包含 fixes（修复的失败）、regressionCases（回归用例，含 caseId/prompt/expected，pass=false）、reportedRisks、generality。',
    ].join('\n'),
    outputSchema: ROLE_PERSONAS['learning-analyst'].outputSchema,
  })

  const candidates = (out?.structured?.candidates || []).map((c, i) => ({
    ...c,
    id: `${agent}-c${Date.now()}-${i + 1}`,
    agent,
    targetVersion: bumpHint(profile.version),
    createdAt: nowIso(),
    status: 'CANDIDATE', // 未经 HR 验收，绝不进入生产
  }))
  if (!candidates.length) throw new Error(`novel-studio: Learning Agent 未生成任何候选，${agent} 不进入 HR_VALIDATION`)
  for (const c of candidates) saveCandidate(projectDir, c)

  const pLearn = getProject(projectDir)
  setWorkflowState(pLearn, 'HR_VALIDATION', `${agent} 生成 ${candidates.length} 个成长候选`)
  saveProject(projectDir, pLearn)
  return {
    action: 'learning',
    agent,
    candidates: candidates.map(c => ({ id: c.id, kind: c.kind, title: c.title })),
    next: `运行 novel_hr_validate（agentId=${agent}）走 Shadow → Regression → 验收`,
  }
}

/** HR 验收（设计 §16） */
async function executeShadowRegression(ctx, exec, projectDir, agent, candidate) {
  const definitions = Array.isArray(candidate.regressionCases) ? candidate.regressionCases : []
  const baseProfile = loadProfile(projectDir, agent) || defaultProfile(agent)
  const shadowProfile = {
    ...baseProfile,
    promotedImprovements: [
      ...(baseProfile.promotedImprovements || []),
      {
        kind: candidate.kind,
        title: candidate.title || '',
        content: candidate.content,
        candidateId: candidate.id,
        promotedAt: 'SHADOW_ONLY',
      },
    ],
  }
  const results = []
  for (const definition of definitions) {
    try {
      const target = await spawnProjectRole(ctx, exec, projectDir, {
        role: agent,
        profile: shadowProfile,
        label: `${agent} Shadow 回归 ${definition.caseId}`,
        prompt: [
          '【Shadow Regression】',
          `候选：${candidate.id}（仅本次影子运行，不得写入生产）`,
          `用例：${definition.caseId}`,
          `输入：${definition.prompt}`,
          `预期：${definition.expected}`,
          '完成该用例并给出可供验收官判断的完整输出。',
        ].join('\n'),
      })
      const targetOutput = target.text || JSON.stringify(target.structured || {})
      const judge = await spawnProjectRole(ctx, exec, projectDir, {
        role: 'hr-reviewer',
        label: `HR 回归判定 ${definition.caseId}`,
        prompt: [
          '【回归用例独立判定】',
          `caseId: ${definition.caseId}`,
          `输入：${definition.prompt}`,
          `预期：${definition.expected}`,
          '==== Shadow 输出 ====',
          targetOutput.slice(0, 12000),
          '只根据预期与实际输出判定 passed；证据必须指出实际输出中支持结论的内容。',
        ].join('\n'),
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['passed', 'evidence', 'actual'],
          properties: {
            passed: { type: 'boolean' },
            evidence: { type: 'string' },
            actual: { type: 'string' },
          },
        },
      })
      const assessment = judge?.structured
      results.push({
        caseId: definition.caseId,
        executed: true,
        assertion: {
          passed: assessment?.passed === true,
          expected: definition.expected,
          actual: assessment?.actual || targetOutput.slice(0, 1000),
        },
        evidence: {
          source: 'novel-studio-shadow',
          targetRunId: String(target.runId || ''),
          judgeRunId: String(judge.runId || ''),
          detail: assessment?.evidence || 'HR 判定输出缺失，按失败处理',
          output: targetOutput.slice(0, 3000),
        },
      })
    } catch (error) {
      results.push({
        caseId: definition.caseId,
        executed: true,
        assertion: { passed: false, expected: definition.expected, actual: 'Shadow 执行失败' },
        evidence: { source: 'novel-studio-shadow', error: String(error?.message || error) },
      })
    }
  }
  return results
}

async function phaseHR(ctx, exec, projectDir, opts = {}) {
  const agent = opts.agentId
  if (!agent || !AGENT_KEYS.has(agent)) throw new Error(`novel-studio: 需要合法 agentId（可用：${[...AGENT_KEYS].join(', ')}）`)
  const candidates = loadCandidates(projectDir).filter(c => c.agent === agent && c.status === 'CANDIDATE')
  const candidate = (opts.candidateId && candidates.find(c => c.id === opts.candidateId)) || candidates[candidates.length - 1]
  if (!candidate) throw new Error(`novel-studio: Agent ${agent} 没有待验收候选（先运行 novel_learning_improve）`)

  const regressionResults = (opts.regressionResults || opts.regressionCases || []).length
    ? (opts.regressionResults || opts.regressionCases)
    : await executeShadowRegression(ctx, exec, projectDir, agent, candidate)
  // 判定本体是规则（确定性）；自然语言期望先由独立 HR 子代理逐条判定并留下输出证据。
  const verdict = hrValidate(projectDir, { agent, candidate, regressionResults })
  const review = opts.withLLMReview && verdict.verdict === 'PROMOTE'
    ? await spawnProjectRole(ctx, exec, projectDir, {
      role: 'hr-reviewer',
      label: `${agent} HR 验收`,
      prompt: [
        '【HR 验收复核】',
        `Agent: ${agent} 候选: ${candidate.id}（${candidate.kind}）标题：${candidate.title}`, '',
        '候选内容：', candidate.content || '',
        '回归集：', JSON.stringify(regressionResults, null, 2),
        '规则引擎结论：', verdict.reasons.map(r => `[${r.type}] ${r.detail}`).join('\n'),
        '请复核并输出验收结论（PROMOTE/REJECT）与逐条检查。',
      ].join('\n'),
      outputSchema: ROLE_PERSONAS['hr-reviewer'].outputSchema,
    })
    : null

  candidate.status = verdict.verdict === 'PROMOTE' ? 'PROMOTED' : 'REJECTED'
  candidate.hrVerdict = verdict.verdict
  candidate.hrChecks = review?.structured?.checks || null
  candidate.regressionResults = regressionResults
  candidate.evaluatedAt = nowIso()
  saveCandidate(projectDir, candidate)

  const profile = loadProfile(projectDir, agent)
  return {
    action: 'hr',
    agent,
    verdict: verdict.verdict,
    version: profile?.version,
    reasons: verdict.reasons,
    llmReview: review?.structured?.verdict || null,
    next: verdict.verdict === 'PROMOTE'
      ? `${agent} 已晋升 v${profile.version}。可在后续生产中验证改进。`
      : '驳回：按 reasons 补证据（回归用例/风险/泛化说明）后重跑 novel_learning_improve 或 novel_hr_validate',
  }
}

/** Planner 汇报（设计 §21） */
function phaseReport(projectDir, opts = {}) {
  const project = getProject(projectDir)
  const cycle = opts.cycle || project.cycle.current
  const report = buildCycleReport(projectDir, { cycle })
  return { action: 'report', cycle, report }
}

function phaseCycleClose(projectDir) {
  const project = getProject(projectDir)
  const cycle = project.cycle.current
  const batchSize = Number(project.brief.chaptersPerBatch) || 10
  const totalChapters = (Number(project.brief.volumeCount) || 1) * (Number(project.brief.chaptersPerVolume) || 40)
  const start = (cycle - 1) * batchSize + 1
  if (start > totalChapters) throw new Error('novel-studio: 所有规划周期均已关闭')
  const end = Math.min(totalChapters, start + batchSize - 1)
  const book = loadContracts(projectDir)
  const pending = []
  for (let chapter = start; chapter <= end; chapter++) {
    const row = book.chapters[normalizeChapterId(chapter)]
    if (!row || row.status !== 'ACCEPTED') pending.push(`${normalizeChapterId(chapter)}:${row?.status || 'MISSING'}`)
  }
  if (pending.length) {
    throw new Error(`novel-studio: Cycle ${cycle} 尚不能关闭，未 ACCEPTED：${pending.join(', ')}`)
  }
  const report = buildCycleReport(projectDir, { cycle, batch: [start, end] })
  const reportPath = join(projectDir, 'reports', `cycle-${String(cycle).padStart(2, '0')}.md`)
  writeTextAtomic(reportPath, report)
  const cycles = readJsonOr(join(projectDir, 'library', 'cycles.json'), { cycles: [] })
  cycles.cycles.push({ cycle, batch: [start, end], closedAt: nowIso(), report: `reports/cycle-${String(cycle).padStart(2, '0')}.md` })
  writeJsonAtomic(join(projectDir, 'library', 'cycles.json'), cycles)
  project.cycle.current += 1
  saveProject(projectDir, project)
  gitCommit(projectDir, `cycle: 关闭 Cycle ${cycle}（第${start}-${end}章）`)
  return { action: 'cycle-close', cycle, batch: [start, end], report, reportPath }
}

function saveDiagnosisProgress(projectDir, diagnosis, progress) {
  if (!diagnosis?.id) return diagnosis
  const next = { ...diagnosis, reworkProgress: progress, reworkProgressAt: nowIso() }
  writeJsonAtomic(join(projectDir, 'issues', `diagnosis-${diagnosis.id}.json`), next)
  return next
}

async function continueRework(ctx, exec, projectDir, diagnosis, affected) {
  const rollback = diagnosis?.rollback_to || 'writer'
  const progress = diagnosis?.reworkProgress || 'ready'
  const range = affected.length ? [Math.min(...affected), Math.max(...affected)] : undefined

  if (rollback === 'research' && progress === 'ready') {
    const result = await phaseResearch(ctx, exec, projectDir)
    saveDiagnosisProgress(projectDir, diagnosis, 'research_done')
    return { ...result, reworkProgress: 'research_done' }
  }
  if (['research_done'].includes(progress)
    || (['world_bible', 'character_arc', 'system_rules'].includes(rollback) && progress === 'ready')) {
    const result = await phaseSetting(ctx, exec, projectDir)
    if (result.planningGate?.pass) saveDiagnosisProgress(projectDir, diagnosis, 'setting_done')
    return { ...result, reworkProgress: result.planningGate?.pass ? 'setting_done' : progress }
  }
  const needsPlot = progress === 'setting_done'
    || (['master_plot', 'volume_plan', 'chapter_contract', 'plot_payoff'].includes(rollback) && progress === 'ready')
  if (needsPlot) {
    const result = await phasePlot(ctx, exec, projectDir, {
      ...(range ? { range } : {}),
      regenerateMaster: ['research', 'world_bible', 'character_arc', 'system_rules', 'master_plot'].includes(rollback),
    })
    if (result.plotGate?.pass) saveDiagnosisProgress(projectDir, diagnosis, 'plot_done')
    return { ...result, reworkProgress: result.plotGate?.pass ? 'plot_done' : progress }
  }
  if (!affected.length) {
    throw new Error(`novel-studio: 诊断 ${diagnosis?.id || '未知'} 已进入 ${progress}，但没有可返工章节`)
  }
  const result = await phaseWriteBatch(ctx, exec, projectDir, { chapters: affected })
  saveDiagnosisProgress(projectDir, diagnosis, 'rewrite_done')
  return { ...result, reworkProgress: 'rewrite_done' }
}

/* ================================================================== Autopilot（Planner 调度） */

/** 自动推进一个阶段。返回本次动作 + 摘要 + 下一步建议。 */
async function autopilotNext(ctx, exec, projectDir) {
  const project = getProject(projectDir)
  const artifacts = getArtifacts(projectDir)
  const latestArtifact = id => artifacts
    .filter(artifact => artifact.id === id)
    .sort((a, b) => Number(b.version) - Number(a.version))[0]
  const isActive = id => latestArtifact(id)?.status === 'ACTIVE'
  const hasArtifact = id => artifacts.some(a => a.id === id)
  const state = project.workflow.state
  const chapters = listChapterStates(projectDir)
  const planned = chapters.filter(c => c.status === 'PLANNED')
  const inWriting = chapters.filter(c => c.status === 'WRITING')
  const inQA = chapters.filter(c => c.status === 'QA')
  const inReader = chapters.filter(c => c.status === 'READER_TEST')
  const inDiag = chapters.filter(c => c.status === 'DIAGNOSIS')
  const inRework = chapters.filter(c => c.status === 'REWORK')

  const openSeriousIssues = listIssues(projectDir).filter(issue => {
    const status = String(issue.status || 'open').toLowerCase()
    return !['closed', 'resolved', 'fixed', 'done', 'dismissed'].includes(status)
      && ['blocking', 'high'].includes(issue.severity)
  })

  // 先清理已在生产线上的工作，绝不能因为还有 PLANNED 就越过 Diagnosis/Rework/QA/Reader。
  if (inDiag.length || state === 'DIAGNOSIS') {
    const chapterIds = new Set(inDiag.map(row => normalizeChapterId(row.chapter)))
    const relevant = openSeriousIssues.filter(issue => {
      const issueChapter = normalizeIssueChapter(issue.chapter)
      return chapterIds.size ? issueChapterOverlaps(issue.chapter, chapterIds) : issueChapter === null
    })
    const ids = relevant.map(issue => issue.issue_id)
    const diagnosis = latestDiagnosis(projectDir, ids)
    if (diagnosis && relevant.some(issue => ['diagnosed', 'in_rework'].includes(String(issue.status || '').toLowerCase()))) {
      return { ran: true, ...phaseRework(projectDir, { diagnosisId: diagnosis.id }) }
    }
    if (ids.length) return { ran: true, ...(await phaseDiagnose(ctx, exec, projectDir, { issueIds: ids })) }
    throw new Error('novel-studio: 章节处于 DIAGNOSIS，但没有未关闭的高严重度 Issue；请用 novel_status 核对状态')
  }
  if (inWriting.length) {
    for (const row of inWriting) setChapterState(projectDir, row.chapter, 'REWORK', 'Autopilot 恢复中断的 Writer 任务')
    const recovered = inWriting.map(row => normalizeChapterId(row.chapter))
    const recoveredProject = getProject(projectDir)
    setWorkflowState(recoveredProject, 'REWORK', `恢复中断章节：${recovered.join(', ')}`)
    saveProject(projectDir, recoveredProject)
    return { ran: true, action: 'recover', chapters: recovered, next: '再次运行 novel_autopilot 重写恢复章节' }
  }
  if (inRework.length || state === 'REWORK') {
    const affected = inRework.map(row => Number(row.chapter))
    const affectedIds = new Set(inRework.map(row => normalizeChapterId(row.chapter)))
    const reworkIssues = openSeriousIssues.filter(issue => (
      String(issue.status || '').toLowerCase() === 'in_rework'
      && issueChapterOverlaps(issue.chapter, affectedIds)
    ))
    const diagnosis = reworkIssues.length
      ? latestDiagnosis(projectDir, reworkIssues.map(issue => issue.issue_id))
      : null
    if (affected.length) return { ran: true, ...(await continueRework(ctx, exec, projectDir, diagnosis, affected)) }
  }

  // 新项目按依赖顺序建设资产。
  if (state === 'INIT' || state === 'RESEARCHING' || !hasArtifact('01_market_strategy')) {
    return { ran: true, ...(await phaseResearch(ctx, exec, projectDir)) }
  }
  if (state === 'PLANNING' || !isActive('02_world_bible') || !isActive('03_system_rules') || !isActive('characters')) {
    return { ran: true, ...(await phaseSetting(ctx, exec, projectDir)) }
  }

  // ACTIVE 只表示版本获批；依赖图仍为 STALE 时，必须先重建/复审，不能消费旧下游。
  let stale = new Set(staleNodeIds(projectDir))
  if (stale.has('research')) return { ran: true, ...(await phaseResearch(ctx, exec, projectDir)) }
  if (['02_world_bible', '03_system_rules', 'characters'].some(node => stale.has(node))) {
    return { ran: true, ...(await phaseSetting(ctx, exec, projectDir)) }
  }
  if (['04_master_plot', 'volumes', 'chapters'].some(node => stale.has(node))) {
    const existingNumbers = chapters.map(row => Number(row.chapter)).filter(Number.isSafeInteger)
    return {
      ran: true,
      ...(await phasePlot(ctx, exec, projectDir, {
        ...(existingNumbers.length ? { range: [Math.min(...existingNumbers), Math.max(...existingNumbers)] } : {}),
        regenerateMaster: true,
      })),
    }
  }
  if (stale.has('manuscript')) {
    const produced = chapters.filter(row => row.status !== 'PLANNED')
    if (produced.length) {
      for (const row of produced) {
        if (row.status !== 'REWORK') setChapterState(projectDir, row.chapter, 'REWORK', '上游依赖更新，正文必须重写')
      }
      const current = getProject(projectDir)
      setWorkflowState(current, 'REWORK', `依赖图要求重写第 ${produced.map(row => row.chapter).join(', ')} 章`)
      saveProject(projectDir, current)
      return {
        ran: true,
        action: 'stale-rework',
        chapters: produced.map(row => normalizeChapterId(row.chapter)),
        next: '再次运行 novel_autopilot，按顺序重写受影响章节',
      }
    }
    resolveStaleNode(projectDir, 'manuscript', { disposition: 'KEEP', note: '尚无正文，无需返工' })
    stale = new Set(staleNodeIds(projectDir))
  }
  if (stale.has('reader') && !inReader.length) {
    const accepted = chapters.filter(row => row.status === 'ACCEPTED')
    if (accepted.length) {
      for (const row of accepted) setChapterState(projectDir, row.chapter, 'READER_TEST', '上游正文变化，Reader 结果需重新验证')
      const current = getProject(projectDir)
      setWorkflowState(current, 'READER_TEST', `重新验证第 ${accepted.map(row => row.chapter).join(', ')} 章`)
      saveProject(projectDir, current)
      return { ran: true, action: 'stale-reader', chapters: accepted.map(row => normalizeChapterId(row.chapter)), next: '再次运行 novel_autopilot 执行 Reader Lab' }
    }
  }

  if (inQA.length) {
    return { ran: true, ...(await phaseReview(ctx, exec, projectDir, { chapters: inQA.map(row => Number(row.chapter)) })) }
  }
  if (inReader.length) {
    return { ran: true, ...(await phaseReaderLab(ctx, exec, projectDir, { chapters: inReader.map(row => Number(row.chapter)) })) }
  }

  const plotGates = listGates(projectDir).filter(row => row.gate === 'plot')
  const latestPlotGate = plotGates[plotGates.length - 1]
  const validPlotPass = latestPlotGate?.pass === true
    && latestPlotGate.evidenceComplete === true
    && latestPlotGate.protocolVersion === 'fail-closed-v2'
  if (state === 'PLOT_REVIEW' && !validPlotPass && planned.length && isActive('04_master_plot')) {
    const numbers = planned.map(row => Number(row.chapter))
    return {
      ran: true,
      ...(await phasePlot(ctx, exec, projectDir, {
        range: [Math.min(...numbers), Math.max(...numbers)],
        reviewExisting: true,
      })),
    }
  }
  if (!isActive('04_master_plot') || (state === 'PLOT_REVIEW' && !validPlotPass)) {
    return { ran: true, ...(await phasePlot(ctx, exec, projectDir)) }
  }
  if (planned.length) {
    if (state !== 'WRITING') {
      const current = getProject(projectDir)
      setWorkflowState(current, 'WRITING', state === 'PLOT_REVIEW' && validPlotPass ? '恢复已通过的 Plot Gate' : '按章节实际状态恢复 Writer 阶段')
      saveProject(projectDir, current)
    }
    return { ran: true, ...(await phaseWriteBatch(ctx, exec, projectDir, { chapters: planned.slice(0, project.brief.chaptersPerBatch).map(c => c.chapter) })) }
  }

  const cycle = project.cycle.current
  const batchSize = Number(project.brief.chaptersPerBatch) || 10
  const batchStart = (cycle - 1) * batchSize + 1
  const batchEnd = batchStart + batchSize - 1
  const currentBatch = chapters.filter(row => Number(row.chapter) >= batchStart && Number(row.chapter) <= batchEnd)
  if (currentBatch.length && currentBatch.every(row => row.status === 'ACCEPTED')) {
    return { ran: true, ...phaseCycleClose(projectDir) }
  }

  const totalChapters = (Number(project.brief.volumeCount) || 1) * (Number(project.brief.chaptersPerVolume) || 40)
  if (Number(project.cycle.chapterCursor || 0) < totalChapters) {
    return { ran: true, ...(await phasePlot(ctx, exec, projectDir)) }
  }

  if (chapters.length && chapters.every(row => row.status === 'ACCEPTED')) {
    const complete = getProject(projectDir)
    setWorkflowState(complete, 'COMPLETE', '全部规划章节已通过 Reader Gate')
    saveProject(projectDir, complete)
    return { ran: true, action: 'complete', report: phaseReport(projectDir).report, next: '项目生产已完成' }
  }
  throw new Error('novel-studio: Autopilot 无法确定安全的下一步，请运行 novel_status 检查章节与 Gate 状态')
}

function latestDiagnosis(projectDir, relevantIssueIds = []) {
  const dir = join(projectDir, 'issues')
  const wanted = new Set(relevantIssueIds)
  const rows = readdirNames(dir)
    .filter(file => file.startsWith('diagnosis-') && file.endsWith('.json'))
    .map(file => readJsonOr(join(dir, file), null))
    .filter(Boolean)
    .filter(row => !wanted.size || (row.issueIds || []).some(issueId => wanted.has(issueId)))
    .sort((a, b) => {
      const timeDiff = Date.parse(a.at || 0) - Date.parse(b.at || 0)
      return timeDiff || String(a.id || '').localeCompare(String(b.id || ''))
    })
  return rows[rows.length - 1] || null
}

/* ================================================================== 工具注册 */

function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function weightedPick(items, r) {
  const total = items.reduce((s, i) => s + (i.ratio || 0), 0)
  let x = r * total
  for (const it of items) {
    x -= it.ratio || 0
    if (x <= 0) return it
  }
  return items[items.length - 1] || { segment: '读者', traits: '' }
}

function markdownTitle(id, label) {
  return `# ${label}\n\n> artifact: \`${id}\` ｜ 由 AI 小说工作室自动生成\n`
}

function bumpHint(v) {
  const parts = String(v || '1.0').split('.').map(Number)
  parts[parts.length - 1] += 1
  return parts.join('.')
}

function readdirNames(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const GATE_KEYS = Object.keys(GATE_CONFIGS)
const projectMutationQueues = new Map()
const MUTATION_LOCK_ROOT = join(tmpdir(), 'novel-studio-mutation-locks')
const READ_ONLY_TOOLS = new Set([
  'novel_status', 'novel_artifact_list', 'novel_artifact_read', 'novel_state_read',
  'novel_chapter_read', 'novel_report', 'novel_projects',
])

function positiveEnvNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function mutationLockOptions() {
  return {
    timeoutMs: positiveEnvNumber('NOVEL_STUDIO_LOCK_TIMEOUT_MS', 300_000),
    retryMs: positiveEnvNumber('NOVEL_STUDIO_LOCK_RETRY_MS', 50),
    heartbeatMs: positiveEnvNumber('NOVEL_STUDIO_LOCK_HEARTBEAT_MS', 2_000),
    orphanGraceMs: positiveEnvNumber('NOVEL_STUDIO_LOCK_ORPHAN_GRACE_MS', 10_000),
    staleHeartbeatMs: positiveEnvNumber('NOVEL_STUDIO_LOCK_STALE_HEARTBEAT_MS', 30_000),
  }
}

function mutationLockPaths(key) {
  const digest = createHash('sha256').update(key).digest('hex')
  const lockDir = join(MUTATION_LOCK_ROOT, digest)
  return { lockDir, ownerPath: join(lockDir, 'owner.json'), reapDir: `${lockDir}.reap` }
}

function readLockOwner(ownerPath) {
  try { return JSON.parse(readFileSync(ownerPath, 'utf8')) } catch { return null }
}

function lockPathAgeMs(path) {
  try { return Math.max(0, Date.now() - statSync(path).mtimeMs) } catch { return 0 }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    return null
  }
}

function ownerIsAbandoned(owner, path, options) {
  const fallbackAge = lockPathAgeMs(path)
  if (!owner) return fallbackAge > options.orphanGraceMs
  if (owner.host !== hostname()) {
    const heartbeatAt = Date.parse(owner.heartbeatAt || owner.acquiredAt || '')
    const heartbeatAge = Number.isFinite(heartbeatAt) ? Date.now() - heartbeatAt : fallbackAge
    return heartbeatAge > options.staleHeartbeatMs
  }
  const alive = processIsAlive(Number(owner.pid))
  if (alive !== null) return !alive
  const heartbeatAt = Date.parse(owner.heartbeatAt || owner.acquiredAt || '')
  const heartbeatAge = Number.isFinite(heartbeatAt) ? Date.now() - heartbeatAt : fallbackAge
  return heartbeatAge > options.staleHeartbeatMs
}

function writeLockOwner(lockDir, owner) {
  const ownerPath = join(lockDir, 'owner.json')
  const temporary = join(lockDir, `.owner-${owner.token}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, ownerPath)
}

function removeOwnedLock(lockDir, token) {
  const owner = readLockOwner(join(lockDir, 'owner.json'))
  if (owner?.token !== token) return false
  rmSync(lockDir, { recursive: true, force: true })
  return true
}

function recoverAbandonedReaper(reapDir, options) {
  const owner = readLockOwner(join(reapDir, 'owner.json'))
  if (!ownerIsAbandoned(owner, reapDir, options)) return false
  if (!owner && lockPathAgeMs(reapDir) <= options.orphanGraceMs) return false
  const quarantine = `${reapDir}.abandoned-${process.pid}-${randomUUID()}`
  try {
    renameSync(reapDir, quarantine)
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) return false
    throw error
  }
  rmSync(quarantine, { recursive: true, force: true })
  return true
}

function tryRecoverAbandonedLock(paths, options) {
  const observed = readLockOwner(paths.ownerPath)
  if (!ownerIsAbandoned(observed, paths.lockDir, options)) return false
  if (!observed && lockPathAgeMs(paths.lockDir) <= options.orphanGraceMs) return false

  const reaper = {
    token: randomUUID(), pid: process.pid, host: hostname(),
    acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  }
  try {
    mkdirSync(paths.reapDir, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    recoverAbandonedReaper(paths.reapDir, options)
    return false
  }

  try {
    writeLockOwner(paths.reapDir, reaper)
    const owner = readLockOwner(paths.ownerPath)
    if (!ownerIsAbandoned(owner, paths.lockDir, options)) return false
    if (!owner && lockPathAgeMs(paths.lockDir) <= options.orphanGraceMs) return false

    // 持有独立 reaper 锁后再复核并删除，避免多个等待者同时清理同一遗留锁。
    const confirmed = readLockOwner(paths.ownerPath)
    if (owner?.token && confirmed?.token !== owner.token) return false
    if (!ownerIsAbandoned(confirmed, paths.lockDir, options)) return false
    rmSync(paths.lockDir, { recursive: true, force: true })
    return true
  } finally {
    removeOwnedLock(paths.reapDir, reaper.token)
  }
}

function waitForMutationLock(ms) {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

async function acquireCrossProcessMutationLock(key) {
  mkdirSync(MUTATION_LOCK_ROOT, { recursive: true, mode: 0o700 })
  const options = mutationLockOptions()
  const paths = mutationLockPaths(key)
  const startedAt = Date.now()
  const owner = {
    token: randomUUID(), pid: process.pid, host: hostname(), key,
    acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  }

  while (true) {
    let created = false
    try {
      mkdirSync(paths.lockDir, { mode: 0o700 })
      created = true
      writeLockOwner(paths.lockDir, owner)
      const heartbeat = setInterval(() => {
        const current = readLockOwner(paths.ownerPath)
        if (current?.token !== owner.token) return
        owner.heartbeatAt = new Date().toISOString()
        try { writeLockOwner(paths.lockDir, owner) } catch { /* 锁已释放或被人工移除 */ }
      }, options.heartbeatMs)
      heartbeat.unref?.()

      return () => {
        clearInterval(heartbeat)
        removeOwnedLock(paths.lockDir, owner.token)
      }
    } catch (error) {
      if (created) {
        rmSync(paths.lockDir, { recursive: true, force: true })
        throw error
      }
      if (error?.code !== 'EEXIST') {
        throw error
      }
    }

    if (tryRecoverAbandonedLock(paths, options)) continue
    const waitedMs = Date.now() - startedAt
    if (waitedMs >= options.timeoutMs) {
      const holder = readLockOwner(paths.ownerPath)
      const holderText = holder?.pid ? `；当前持有者 pid=${holder.pid}` : ''
      throw new Error(`novel-studio: 等待项目跨进程写锁超时（${options.timeoutMs}ms）：${key}${holderText}。另一个进程可能仍在执行长任务，请稍后重试`)
    }
    await waitForMutationLock(Math.min(options.retryMs, options.timeoutMs - waitedMs))
  }
}

export async function withProjectMutationLock(key, task) {
  const previous = projectMutationQueues.get(key) || Promise.resolve()
  const current = previous.catch(() => undefined).then(async () => {
    const release = await acquireCrossProcessMutationLock(key)
    try { return await task() } finally { release() }
  })
  projectMutationQueues.set(key, current)
  try {
    return await current
  } finally {
    if (projectMutationQueues.get(key) === current) projectMutationQueues.delete(key)
  }
}

export function canonicalMutationKey(path) {
  const absolute = resolve(String(path))
  const suffix = []
  let existing = absolute
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return absolute
    suffix.unshift(basename(existing))
    existing = parent
  }
  try { return resolve(realpathSync(existing), ...suffix) } catch { return absolute }
}

/** 注册全部 novel_* 工具 */
export function registerNovelTools(ctx) {
  // 值 schema DSL 不支持 required（仅参数层支持）：输出 schema 统一剥离 required
  const stripRequired = (schema) => JSON.parse(JSON.stringify(schema, (key, value) => key === 'required' ? undefined : value))
  const register = (def) => {
    const execute = READ_ONLY_TOOLS.has(def.name)
      ? def.execute
      : (args, exec) => {
          const key = args?.projectDir
            || (def.name === 'novel_init' ? join(String(args.rootDir), slugify(args.projectId)) : def.name)
          return withProjectMutationLock(canonicalMutationKey(key), () => def.execute(args, exec))
        }
    return ctx.tools.register(defineTool({
      ...def,
      execute,
      output: def.output ? { ...def.output, schema: stripRequired(def.output.schema) } : undefined,
    }))
  }

  /* ---------- 项目与产物 ---------- */
  register({
    name: 'novel_init',
    description: 'AI 小说工作室 Phase 0：初始化一个小说项目（创建项目树/简报/状态存储/依赖图）。返回项目目录与当前状态。',
    parameters: {
      rootDir: { type: 'string', required: true, description: '项目根目录（绝对路径），项目将创建为 <rootDir>/<projectId>' },
      projectId: { type: 'string', required: true, description: '项目 ID（自动 slug 化）' },
      title: { type: 'string', description: '作品名' },
      genre: { type: 'string', description: '题材/类型（如 都市异能/历史架空/玄幻升级）' },
      audience: { type: 'string', description: '目标读者' },
      platform: { type: 'string', description: '发布平台' },
      targetWords: { type: 'number', description: '目标总字数，默认 1000000' },
      volumeCount: { type: 'number', description: '卷数，默认 3' },
      chaptersPerVolume: { type: 'number', description: '每卷章数，默认 40' },
      chaptersPerBatch: { type: 'number', description: '每批生产章数（滚动批次），默认 10' },
      businessGoals: { type: 'array', items: { type: 'string' }, description: '商业目标' },
      referenceWorks: { type: 'array', items: { type: 'string' }, description: '参考作品' },
      forbiddenItems: { type: 'array', items: { type: 'string' }, description: '禁止事项' },
      hardConstraints: { type: 'array', items: { type: 'string' }, description: '用户硬约束（Gate 一票否决项）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['projectId', 'projectDir', 'state'], properties: { projectId: { type: 'string' }, projectDir: { type: 'string' }, state: { type: 'string' } } },
      render: (_a, v) => renderToolText([`✅ 项目已创建：**${v.projectId}**\n\n项目目录：\`${v.projectDir}\`\n工作流状态：\`${v.state}\`\n\n下一步：运行 \`novel_autopilot\` 或 \`novel_phase_research\` 开始创作。`]),
    },
    execute: async (args, exec) => {
      const { projectId, projectDir, project } = initProject({ projectId: args.projectId, rootDir: args.rootDir, brief: args })
      // 版本管理：项目目录即 git 仓库（迭代历史 = git log / git diff）
      try {
        if (!existsSync(join(projectDir, '.git'))) {
          execFileSync('git', ['-C', projectDir, 'init', '-q'], { stdio: 'ignore' })
        }
        gitCommit(projectDir, 'init: 项目创建（00_project_brief）')
      } catch { /* git 不可用时静默 */ }
      return { projectId, projectDir, state: project.workflow.state }
    },
  })

  register({
    name: 'novel_status',
    description: 'AI 小说工作室：查看项目全景状态（工作流状态机/Artifact 生命周期/章节状态/STALE 节点/KPI/问题单）。',
    parameters: {
      projectDir: { type: 'string', required: true, description: '项目目录（绝对路径）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([statusText(v)]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      return projectSnapshot(dir)
    },
  })

  register({
    name: 'novel_artifact_write',
    description: 'AI 小说工作室：写入/更新一个 Artifact（DRAFT）。同一 id 再次写入会版本 +1 并把旧版本标记 SUPERSEDED，同时按依赖图把下游标为 STALE。',
    parameters: {
      projectDir: { type: 'string', required: true, description: '项目目录' },
      artifactId: { type: 'string', required: true, description: 'Artifact id（00_project_brief / 01_market_strategy / 02_world_bible / 03_system_rules / 04_master_plot / research / characters / volume/<NN> / chapter/<NNN>）' },
      content: { type: 'string', required: true, description: 'Artifact 正文（Markdown 或 JSON 文本）' },
      title: { type: 'string', description: '显示标题' },
      owner: { type: 'string', description: '负责人角色，默认 planner' },
      changeReason: { type: 'string', description: '变更原因' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, version: { type: 'number' }, status: { type: 'string' }, supersedes: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] } } },
      render: (_a, v) => renderToolText([`📝 ${v.id} v${v.version}（${v.status}）已写入${v.supersedes ? `，旧版本 v${v.supersedes.version} → SUPERSEDED` : ''}`]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      return writeArtifact(dir, {
        id: args.artifactId,
        content: args.content,
        title: args.title,
        owner: args.owner,
        changeReason: args.changeReason,
      })
    },
  })

  register({
    name: 'novel_artifact_approve',
    description: 'AI 小说工作室：审批 Artifact（DRAFT/REVIEW → APPROVED，再传 activate 转 ACTIVE 供生产消费）。审批通过会按依赖图把下游节点标记 STALE（待复审）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      artifactId: { type: 'string', required: true },
      version: { type: 'number', description: '读取指定不可变版本；缺省为最新' },
      section: { type: 'string', description: '只返回标题中包含该文本的 Markdown 小节' },
      maxChars: { type: 'number', description: '正文最大字符数，默认完整返回' },
      version: { type: 'number', description: '版本号，默认最新' },
      approvedBy: { type: 'string', required: true, description: '审批人（如 planner）' },
      activate: { type: 'boolean', description: '是否直接激活（ACTIVE），默认 false' },
      note: { type: 'string', description: '审批备注' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([`✅ 审批通过：${v.id} v${v.version} → ${v.status}（审批人：${v.approvedBy || ''}）`, ...(v.pendingDependencies?.length ? [`⚠️ 依赖未就绪：${v.pendingDependencies.join(', ')}`] : [])]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      return approveArtifact(dir, {
        id: args.artifactId,
        version: args.version,
        approvedBy: args.approvedBy,
        activate: args.activate,
        note: args.note,
      })
    },
  })

  register({
    name: 'novel_artifact_list',
    description: 'AI 小说工作室：列出项目全部 Artifact 元数据（id/版本/状态/负责人/审批/依赖）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      status: { type: 'string', enum: ['DRAFT', 'REVIEW', 'APPROVED', 'ACTIVE', 'SUPERSEDED', 'STALE'], description: '按状态过滤' },
    },
    output: {
      schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
      render: (_a, v) => renderToolText(['| id | v | 状态 | 负责人 | 审批 | 依赖 |', '|---|---|---|---|---|---|', ...v.map(a => `| ${a.id} | ${a.version} | ${a.status} | ${a.owner} | ${a.approvedBy || '—'} | ${(a.dependencies || []).join(',') || '—'} |`)]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      const rows = getArtifacts(dir)
      return args.status ? rows.filter(a => a.status === args.status || (args.status === 'STALE' && a.stale)) : rows
    },
  })

  register({
    name: 'novel_artifact_read',
    description: 'AI 小说工作室：读取 Artifact 元数据与正文（供任何角色核实 Canon）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      artifactId: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([`# ${v.meta?.id} v${v.meta?.version} [${v.meta?.status}]`, '', v.content ? String(v.content).slice(0, 6000) : '（无正文）']),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      const artifact = readArtifact(dir, { id: args.artifactId, version: args.version })
      const selected = extractMarkdownSection(artifact.content, args.section)
      if (args.section && !selected) throw new Error(`novel-studio: artifact ${args.artifactId} 中找不到小节 ${args.section}`)
      const maxChars = args.maxChars === undefined ? null : Number(args.maxChars)
      if (maxChars !== null && (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 200000)) {
        throw new Error('novel-studio: maxChars 必须是 1-200000 的整数')
      }
      return {
        meta: artifact.meta,
        content: maxChars === null ? selected : selected.slice(0, maxChars),
        truncated: maxChars !== null && selected.length > maxChars,
        totalChars: selected.length,
      }
    },
  })

  register({
    name: 'novel_state_read',
    description: 'AI 小说工作室：读取状态存储（story 故事状态 / character 人物状态 / timeline 时间轴 / foreshadowing 伏笔 / dependency 依赖图）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      kind: { type: 'string', required: true, enum: ['story', 'character', 'timeline', 'foreshadowing', 'dependency'] },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([`\`\`\`json\n${JSON.stringify(v, null, 2).slice(0, 8000)}\n\`\`\``]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      return readState(dir, args.kind)
    },
  })

  register({
    name: 'novel_state_write',
    description: 'AI 小说工作室：整体写入状态存储（带结构/引用校验）。写入前请先 novel_state_read 读取当前值再合并修改。',
    parameters: {
      projectDir: { type: 'string', required: true },
      kind: { type: 'string', required: true, enum: ['story', 'character', 'timeline', 'foreshadowing', 'dependency'] },
      data: { type: 'object', required: true, additionalProperties: true, description: '完整新状态对象' },
      reason: { type: 'string', description: '变更原因（审计）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string' }, updatedAt: { type: 'string' } } },
      render: (_a, v) => renderToolText([`💾 ${v.kind} 已写入（${v.updatedAt}）`]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      const res = writeState(dir, args.kind, args.data, { reason: args.reason })
      return { kind: res.kind, updatedAt: res.updatedAt }
    },
  })

  register({
    name: 'novel_chapter_read',
    description: 'AI 小说工作室：读取一章的完整生产上下文（契约 + 正文 + 相关状态）。Writer/Reviewer/Reader 角色用。',
    parameters: {
      projectDir: { type: 'string', required: true },
      chapter: { type: 'number', required: true, description: '章节号' },
      include: { type: 'array', items: { type: 'string' }, description: 'include: contract/manuscript/state/context，默认全部' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([`# 第 ${v.chapter} 章 ${v.contract?.title || ''} [${v.contract?.status}]`, '', `POV: ${v.contract?.pov || ''} ｜ ${v.contract?.location || ''} ｜ ${v.contract?.time || ''}`, '', '## 契约', '```json', JSON.stringify(v.contract, null, 1).slice(0, 4000), '```', '', '## 正文', String(v.manuscript || '（未写）').slice(0, 8000)]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      const ch = normalizeChapterId(args.chapter)
      const book = loadContracts(dir)
      const contract = book.chapters[ch]
      if (!contract) throw new Error(`novel-studio: 章节 ${ch} 无契约（先 novel_phase_plot）`)
      const include = args.include || ['contract', 'manuscript', 'state']
      const out = { chapter: Number(ch), contract }
      if (include.includes('manuscript')) {
        const md = readText(resolveManuscriptPath(dir, ch) || '')
        if (md) out.manuscript = md
      }
      if (include.includes('state')) {
        out.storyState = loadStoryState(dir)
        const cs = loadCharacterState(dir)
        out.characters = Object.fromEntries((contract.characters || []).filter(id => cs.characters[id]).map(id => [id, cs.characters[id]]))
        out.foreshadowing = loadForeshadowing(dir).items.filter(i => Number(i.plantedAt) === Number(ch) || Number(i.paidOffAt) === Number(ch))
        out.timeline = loadTimeline(dir).events.filter(e => Number(e.chapter) === Number(ch))
      }
      if (include.includes('context') && args.include) {
        out.writerContext = buildWriterContext(dir, ch).ctx
      }
      return out
    },
  })

  /* ---------- Gate ---------- */
  register({
    name: 'novel_gate_run',
    description: 'AI 小说工作室：运行一个 Gate（planning/plot/chapter/reader/release）。PASS = 无硬约束违反 AND 加权得分 >= 阈值 AND 关键指标 >= 下限。',
    parameters: {
      projectDir: { type: 'string', required: true },
      gate: { type: 'string', required: true, enum: GATE_KEYS },
      target: { type: 'string', description: 'Gate 目标，例如 planning-assets / chapters 1-10 / chapter-001' },
      issues: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { issue_id: { type: 'string' }, dimension: { type: 'string' }, severity: { type: 'string', enum: ['blocking', 'high', 'medium', 'low'] }, score: { type: 'number', description: '该维度得分 0-100（缺省按 severity 扣分）' }, veto: { type: 'boolean' }, evidence: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, recommended_action: { type: 'string' } } }, description: '问题清单（来自 Reviewer/Reader/Planner 评审）' },
      criticalMetrics: { type: 'object', additionalProperties: true, description: '关键指标（reader: completion/next_chapter/payoff_delivery 等，0-100）' },
      threshold: { type: 'number', description: '覆盖默认通过线' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([renderGateResult(v)]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      const result = runGate(args.gate, args.issues || [], { criticalMetrics: args.criticalMetrics, threshold: args.threshold })
      recordGate(dir, {
        gate: args.gate, target: args.target || 'manual', pass: result.pass, score: result.score,
        verdict: result.decision, issues: (args.issues || []).map(issue => issue.issue_id).filter(Boolean),
        evidenceComplete: result.completeness.complete,
      })
      const project = getProject(dir)
      if (args.gate === 'plot') {
        if (result.pass) {
          const latest = getArtifacts(dir).filter(row => row.id === '04_master_plot').sort((a, b) => b.version - a.version)[0]
          if (latest && latest.status !== 'ACTIVE') approveArtifact(dir, { id: '04_master_plot', version: latest.version, approvedBy: 'planner', activate: true, note: 'Manual Plot Gate PASS' })
          setWorkflowState(project, 'WRITING', 'Manual Plot Gate PASS')
        } else setWorkflowState(project, 'PLOT_REVIEW', `Manual Plot Gate ${result.decision}`)
        saveProject(dir, project)
      } else if (args.gate === 'planning') {
        setWorkflowState(project, result.pass ? 'PLANNING_REVIEW' : 'PLANNING', `Manual Planning Gate ${result.decision}`)
        saveProject(dir, project)
      }
      return result
    },
  })

  /* ---------- 阶段 ---------- */
  register({
    name: 'novel_phase_research',
    description: 'AI 小说工作室 Phase 1 Step1-2：市场需求分析（deep-researcher）+ 深度资料研究（research-assistant，Fact/Inference/Assumption 分级）。产出 01_market_strategy.md 与 research/evidence_index.md。',
    parameters: {
      projectDir: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseResearch(ctx, exec, requireProject(args.projectDir)),
  })

  register({
    name: 'novel_phase_setting',
    description: 'AI 小说工作室 Phase 1 Step3-5：世界观架构 + 人物设定与成长 + 数值体系（三路并行），随后自动运行 Planning Gate（含一票否决检查）。PASS 则规划资产转 ACTIVE。',
    parameters: {
      projectDir: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseSetting(ctx, exec, requireProject(args.projectDir)),
  })

  register({
    name: 'novel_phase_plot',
    description: 'AI 小说工作室 Phase 2：剧情工程与自动 Plot Gate。首次生成总纲/卷纲/首批契约，之后按章节游标滚动生成下一批；Gate 失败不推进游标。',
    parameters: {
      projectDir: { type: 'string', required: true },
      volumes: { type: 'number', description: '规划卷数（默认取简报）' },
      range: { type: 'array', items: { type: 'number' }, description: '返工时指定需重建的 [start,end] 契约区间' },
      regenerateMaster: { type: 'boolean', description: '返工是否同时重建全书总纲' },
      reviewExisting: { type: 'boolean', description: '只用当前总纲/卷纲/契约重新执行 Plot Gate，不生成或覆盖剧情资产' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phasePlot(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_writer_write_batch',
    description: 'AI 小说工作室 Phase 3：Writer 按 Chapter Contract 生产正文（Context Builder 装配最小充分上下文），自动完成状态写回（人物/伏笔/时间轴）并把章节转 QA。',
    parameters: {
      projectDir: { type: 'string', required: true },
      chapters: { type: 'array', items: { type: 'number' }, description: '指定章节号；缺省取下一批 PLANNED' },
      range: { type: 'array', items: { type: 'number' }, description: '或传 [start, end] 区间' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseWriteBatch(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_review_run',
    description: 'AI 小说工作室 Phase 4：Reviewer Pool（剧情/人设/世界观/数值/连续性/文笔/伏笔 六路并行）专业审查 + 每章 Chapter Gate。PASS → READER_TEST；FAIL → DIAGNOSIS。',
    parameters: {
      projectDir: { type: 'string', required: true },
      chapters: { type: 'array', items: { type: 'number' }, description: '缺省取所有 QA 章节' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseReview(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_reader_lab_run',
    description: 'AI 小说工作室 Phase 5：Reader Lab（按 Persona 池抽样模拟读者，默认 学生40%/上班族35%/核心20%/资深5%）+ Reader Gate（完读率/下一章意愿/留存/跳读/弃书点/爽点兑现/情绪命中/人物喜爱/伏笔记忆；目标 Persona 崩塌与关键红线一票否决）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      chapters: { type: 'array', items: { type: 'number' }, description: '缺省取 READER_TEST 章节' },
      readersPerChapter: { type: 'number', description: '每章读者数，默认 3' },
      instanceCount: { type: 'number', description: '读者实例总数上限，默认 60（S2 建议 20-50 起步，可扩到 1000）' },
      personaMix: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { segment: { type: 'string' }, ratio: { type: 'number' }, traits: { type: 'string' } } }, description: 'Persona 池覆盖' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseReaderLab(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_diagnose',
    description: 'AI 小说工作室：根因诊断（症状 → 根因分类 + 责任权重 + 返工层 + 影响范围）。blocking 级失败自动记入对应 Agent 档案（连接 Agent Loop）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      issueIds: { type: 'array', items: { type: 'string' }, required: true, description: 'issue id 列表（ISSUE-xxxx）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseDiagnose(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_rework_execute',
    description: 'AI 小说工作室：执行返工（按诊断的返工层回滚状态、依赖图下游标 STALE、影响范围内章节归位）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      diagnosisId: { type: 'string', description: '诊断 id（缺省取最近一次）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, _exec) => phaseRework(requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_learning_improve',
    description: 'AI 小说工作室 Agent Loop：Learning Agent 根据失败记录产出能力改进候选（prompt/skill/memory/sop/fewshot + 回归用例）。候选不会直接生效。',
    parameters: {
      projectDir: { type: 'string', required: true },
      agentId: { type: 'string', required: true, enum: [...AGENT_KEYS], description: '目标 Agent' },
      failureIds: { type: 'array', items: { type: 'string' }, description: '指定失败记录 id（缺省全部近期失败）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseLearning(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_hr_validate',
    description: 'AI 小说工作室 Agent Loop：HR 验收（规则引擎：当前问题改善 + 回归全过 + 无新高风险 + 可泛化）。PROMOTE 晋升 Agent 版本；REJECT 驳回并给原因。',
    parameters: {
      projectDir: { type: 'string', required: true },
      agentId: { type: 'string', required: true, enum: [...AGENT_KEYS] },
      candidateId: { type: 'string', description: '候选 id（缺省取最新）' },
      regressionResults: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { caseId: { type: 'string' }, executed: { type: 'boolean' }, assertion: { type: 'object', additionalProperties: true }, evidence: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] } } }, description: '外部 runner 已执行的回归证据；缺省由工作室自动跑 Shadow + HR 逐条判定' },
      withLLMReview: { type: 'boolean', description: '是否让 hr-reviewer 子代理复核（默认 false，规则为准）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseHR(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_report',
    description: 'AI 小说工作室：只读生成当前生产周期的 Planner 汇报快照；不会推进周期或生产批次。',
    parameters: {
      projectDir: { type: 'string', required: true },
      cycle: { type: 'number', description: '周期号（缺省当前）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([v.report]) },
    execute: async (args, _exec) => phaseReport(requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_cycle_close',
    description: 'AI 小说工作室：在当前批次全部 ACCEPTED 后显式关闭周期，持久化报告并推进 cycle。',
    parameters: {
      projectDir: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([v.report]) },
    execute: async (args, _exec) => phaseCycleClose(requireProject(args.projectDir)),
  })

  register({
    name: 'novel_autopilot',
    description: 'AI 小说工作室：Planner 自动调度 —— 按项目状态机自动推进下一个阶段（研究→设定→剧情→写作→审查→读者验证→诊断/返工→汇报）。适合持续滚动生产。',
    parameters: {
      projectDir: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => autopilotNext(ctx, exec, requireProject(args.projectDir)),
  })

  register({
    name: 'novel_projects',
    description: 'AI 小说工作室：扫描根目录下的全部项目（novel_init 创建的项目）。',
    parameters: {
      rootDir: { type: 'string', required: true, description: '扫描的根目录' },
    },
    output: { schema: { type: 'array', items: { type: 'object', additionalProperties: true } }, render: (_a, v) => renderToolText(v.length ? ['| 项目 | 标题 | 状态 | 目录 |', '|---|---|---|---|', ...v.map(p => `| ${p.projectId} | ${p.title} | ${p.state} | ${p.dir} |`)] : ['（无项目）']) },
    execute: async (args, _exec) => {
      const { readdirSync } = await import('node:fs')
      const entries = existsSync(args.rootDir) ? readdirSync(args.rootDir) : []
      const out = []
      for (const e of entries) {
        const dir = join(args.rootDir, e)
        if (!existsSync(join(dir, 'library', 'project.json'))) continue
        const p = readJsonOr(join(dir, 'library', 'project.json'), null)
        if (p) out.push({ projectId: p.meta.projectId, title: p.meta.title, state: p.workflow.state, dir })
      }
      return out
    },
  })
}

/* ================================================================== 渲染 */

function phaseResultText(v) {
  const lines = []
  if (v.next) lines.push(`**下一步**：${v.next}`)
  const gate = v.gate || v.plotGate || v.planningGate
  if (gate) lines.push('', renderGateResult(gate))
  if (v.verdict) {
    lines.push('', `**HR 验收**：${v.verdict === 'PROMOTE' ? '✅ 晋升' : '❌ 驳回'}${v.version ? ` → v${v.version}` : ''}`, ...v.reasons.map(r => `- [${r.type}] ${r.detail}`))
  }
  if (v.reworkInstructions) {
    lines.push('', '**返工指令**：', ...v.reworkInstructions.map(l => `- ${l}`))
  }
  if (v.rootCauses) {
    lines.push('', '**根因归属**：', renderRootCauses(v.rootCauses))
  }
  for (const k of ['gateSummary', 'evidenceCount', 'topics', 'volumes', 'contracts', 'chapters', 'instances', 'problems', 'candidates', 'agent']) {
    if (v[k] !== undefined) lines.push(`- ${k}: ${Array.isArray(v[k]) ? v[k].join(', ') || '（空）' : v[k]}`)
  }
  return lines.join('\n')
}

function statusText(snapshot) {
  const p = snapshot
  const lines = [
    `# ${p.project.title}（${p.project.projectId}）`,
    '',
    `**工作流状态**：\`${p.workflow.state}\`｜周期 ${p.cycle.current}｜生产批次 ${p.counters.batches}`,
    `累计：Issue ${p.counters.issues}，Gate ${p.counters.gates}，返工 ${p.counters.reworks}`,
    '',
    '## Artifacts',
    '| id | v | 状态 | 审批 |', '|---|---|---|---|',
    ...p.artifacts.map(a => `| ${a.id} | ${a.version} | ${a.status} | ${a.approvedBy || '—'} |`),
    '',
    `## 章节状态（${p.chapters.length}）`,
    ...Object.entries(groupBy(p.chapters, c => c.status)).map(([st, list]) => `- **${st}**：${list.map(c => c.chapter).join(', ')}`),
    '',
    p.staleNodes.length ? `## ⚠️ STALE 节点\n${p.staleNodes.map(n => `- ${n.id}: ${n.reason}`).join('\n')}` : '## STALE：无',
    '',
    `## 未关闭 Issue（${(p.openIssues || []).length}）`,
    ...((p.openIssues || []).length
      ? p.openIssues.slice(-12).map(issue => `- [${issue.issue_id}] ${issue.severity || 'unknown'} / ${issue.dimension || 'unknown'}${issue.chapter ? ` / 第${issue.chapter}章` : ''}：${String(issue.evidence || '').slice(0, 120)}`)
      : ['- 无']),
    '',
    '## KPI',
    `- 一次通过率 ${fmtPct(p.kpi.work.oncePassRate)}｜平均返工/章 ${p.kpi.work.avgReworksPerChapter}`,
    `- 伏笔回收率 ${fmtPct(p.kpi.work.foreshadowRecoveryRate)}｜近期到期伏笔 ${p.kpi.work.pendingForeshadowingDueSoon}`,
    `- Canon 冲突 ${p.kpi.work.canonConflicts}｜人物漂移 ${p.kpi.work.characterDrift}`,
    `- 最近 Reader：${p.kpi.work.reader ? `${p.kpi.work.reader.label} ${p.kpi.work.reader.pass ? 'PASS' : 'FAIL'}（${p.kpi.work.reader.score}）` : '未运行'}`,
  ]
  return lines.join('\n')
}

function groupBy(arr, keyFn) {
  const out = {}
  for (const it of arr) {
    const k = keyFn(it)
    ;(out[k] = out[k] || []).push(it)
  }
  return out
}

function fmtPct(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`
}
