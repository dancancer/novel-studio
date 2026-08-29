/**
 * novel-studio / reports
 * ------------------------------------------------------------------
 * Planner 周期汇报与 KPI（设计文档 §20、§21）。
 * 纯 ESM，零依赖。
 */

import {
  computeKPIs, getProject, listIssues, listGates, loadContracts,
  listChapterStates, readJsonOr,
} from './store.mjs'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'

/**
 * 生成一个生产周期的 Planner 汇报（设计 §21 模板）。
 * @param {string} projectDir
 * @param {object} opts { cycle?, batch?: [from,to] }
 */
export function buildCycleReport(projectDir, opts = {}) {
  const project = getProject(projectDir)
  const kpi = computeKPIs(projectDir)
  const chapters = listChapterStates(projectDir)
  const issues = listIssues(projectDir).filter(isOpenIssue)
  const gates = listGates(projectDir)
  const cycle = opts.cycle || project.cycle.current
  const batch = opts.batch || currentBatchRange(project)

  // 本轮完成统计
  const inBatch = chapters.filter(c => {
    const n = Number(c.chapter)
    return n >= batch[0] && n <= batch[1]
  })
  const accepted = inBatch.filter(c => c.status === 'ACCEPTED')
  const oncePass = inBatch.filter(c =>
    c.status === 'ACCEPTED' && !(loadChapterHistory(projectDir, c.chapter) || []).some(h => h.to === 'REWORK'),
  )
  const inFlight = inBatch.filter(c => !['ACCEPTED', 'PLANNED', 'REWORK'].includes(c.status)) // QA/READER_TEST/DIAGNOSIS/WRITING
  const totalChapters = project.brief.volumeCount * project.brief.chaptersPerVolume
  const expectedBatchEnd = Math.min(batch[1], totalChapters)
  const expectedBatchSize = Math.max(0, expectedBatchEnd - batch[0] + 1)
  const batchComplete = expectedBatchSize > 0 && accepted.length === expectedBatchSize
  const nextBatchStart = batch[1] + 1
  const nextBatchEnd = Math.min(
    batch[1] + (project.brief.chaptersPerBatch || 10),
    totalChapters,
  )
  const nextBatchLine = !batchComplete
    ? `- 当前批次尚未完成（ACCEPTED ${accepted.length}/${expectedBatchSize}），先完成第 ${batch[0]}-${expectedBatchEnd} 章`
    : (nextBatchStart <= totalChapters
        ? `- 第 ${nextBatchStart}-${nextBatchEnd} 章`
        : '- 当前规划范围已全部完成')

  // 主要问题：高严重度 issue
  const topIssues = issues
    .filter(i => ['blocking', 'high'].includes(i.severity))
    .slice(-8)
  const canonConflicts = issues.filter(i => i.dimension === 'canon' && ['high', 'blocking'].includes(i.severity)).length
  const characterDrift = issues.filter(i => i.dimension === 'continuity').length

  // 未决风险：伏笔即将到期、STALE 节点
  const fsh = readJsonOr(join(projectDir, 'state', 'foreshadowing.json'), { items: [] })
  const riskyFsh = fsh.items.filter(i =>
    ['open', 'pending'].includes(i.status) && Number(i.dueBy || 99999) <= project.cycle.chapterCursor + 5)

  const graph = readJsonOr(join(projectDir, 'state', 'dependency_graph.json'), { nodes: {} })
  const staleNodes = Object.entries(graph.nodes).filter(([, n]) => n.status === 'STALE').map(([id]) => id)

  const agentProfiles = listAgentProfiles(projectDir)
  const reader = normalizeReaderSummary(kpi.work.reader) || loadLatestReaderSummary(projectDir)

  const lines = [
    `# 生产周期汇报 Cycle ${cycle}（第 ${batch[0]}-${batch[1]} 章）`,
    '',
    '## 本轮完成',
    `- 生产范围：Chapter ${batch[0]}-${batch[1]}（共 ${inBatch.length} 章）`,
    `- ${oncePass.length} 章一次通过，${Math.max(0, accepted.length - oncePass.length)} 章返工后通过`,
    `- 生产中（QA/READER_TEST）：${inFlight.length} 章；待写（PLANNED/REWORK）：${inBatch.filter(c => ['PLANNED', 'REWORK'].includes(c.status)).length} 章`,
    '',
    '## 作品（关键指标）',
    `- 一次通过率：${kpi.work.oncePassRate === null ? '—' : (kpi.work.oncePassRate * 100).toFixed(0) + '%'}`,
    `- 平均返工次数/章：${kpi.work.avgReworksPerChapter}`,
    `- 伏笔回收率：${kpi.work.foreshadowRecoveryRate === null ? '—' : (kpi.work.foreshadowRecoveryRate * 100).toFixed(0) + '%'}`,
    `- Canon 冲突数：${canonConflicts}；人物漂移问题数：${characterDrift}`,
    `- 最近 Reader Gate：${reader ? `${reader.label} — ${reader.pass ? 'PASS' : 'FAIL'}（综合 ${reader.score}）` : '（尚未运行）'}`,
    '',
    '## 主要问题',
    topIssues.length
      ? topIssues.map(i => `- [${i.issue_id}] ${i.severity} / ${i.dimension}：${(i.evidence || '').slice(0, 120)}`).join('\n')
      : '- （无高严重度问题）',
    '',
    '## 返工',
    `- 上次诊断后影响节点：${staleNodes.join(', ') || '（无 STALE）'}`,
    `- 未关闭 Issue：${issues.length}；Gate 运行：${gates.length} 次`,
    '',
    '## Agent',
    agentProfiles.length
      ? agentProfiles.map(formatAgentProfile).join('\n')
      : '- （尚无 Agent 档案——成长循环尚未启动）',
    '',
    '## 风险',
    riskyFsh.length
      ? riskyFsh.map(i => `- **F-${i.id}** 需在 Chapter ${i.dueBy} 前回收（${i.summary}）`).join('\n')
      : '- 无近期到期伏笔',
    staleNodes.length ? `- 依赖图 STALE 节点待处置（KEEP/PATCH/REGENERATE/RE-REVIEW）：${staleNodes.join(', ')}` : '',
    '',
    '## 下一轮',
    nextBatchLine,
    '',
    `> 由 novel-studio 自动汇总生成 · ${new Date().toISOString()}`,
    '',
  ]
  return lines.filter(l => l !== '' || lines.indexOf(l) === 0).join('\n') + '\n'
}

function isOpenIssue(issue) {
  const status = String(issue?.status || 'open').trim().toLowerCase().replaceAll('_', '-')
  return !['closed', 'resolved', 'fixed', 'done', 'dismissed', 'wontfix', "won't-fix"].includes(status)
}

function loadLatestReaderSummary(projectDir) {
  const dir = join(projectDir, 'reader_lab', 'reports')
  if (!existsSync(dir)) return null
  const latest = readdirSync(dir).filter(f => f.endsWith('.json')).sort().pop()
  if (!latest) return null
  return normalizeReaderSummary(readJsonOr(join(dir, latest), null))
}

function normalizeReaderSummary(readerReport) {
  const summary = readerReport?.summary || readerReport
  if (!summary || typeof summary !== 'object' || !summary.label) return null
  return summary
}

function loadChapterHistory(projectDir, chapter) {
  const book = loadContracts(projectDir)
  const row = book.chapters[String(chapter)]
  return row ? (row.history || []) : []
}

function currentBatchRange(project) {
  const per = project.brief.chaptersPerBatch || 10
  const cur = project.cycle.current || 1
  const start = (cur - 1) * per + 1
  return [start, start + per - 1]
}

function listAgentProfiles(projectDir) {
  const dir = join(projectDir, 'agents')
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const p = readJsonOr(join(dir, f), null)
    if (p) out.push({
      agent: p.agent,
      version: p.version,
      accepted: p.acceptedCases,
      rejected: p.rejectedCases,
      promotedImprovements: Array.isArray(p.promotedImprovements) ? p.promotedImprovements : [],
    })
  }
  return out.sort((a, b) => a.agent.localeCompare(b.agent))
}

function formatAgentProfile(profile) {
  const improvements = profile.promotedImprovements
    .slice(-3)
    .map(i => `${i.kind}·${i.title || i.candidateId}`)
  const promoted = improvements.length ? `，已晋升改进: ${improvements.join(', ')}` : ''
  return `- ${profile.agent} v${profile.version}：${profile.accepted || 0} 次通过 / ${profile.rejected || 0} 次驳回${promoted}`
}

/** 系统 KPI（设计 §20 系统级）：跨项目不够，这里算出已产生的可统计度量 */
export function computeSystemKPIs(projectDirs) {
  const rows = (projectDirs || []).map(dir => {
    const k = computeKPIs(dir)
    const issues = listIssues(dir).filter(isOpenIssue)
    return {
      project: getProject(dir).meta.projectId,
      ...k.work,
      canonConflicts: issues.filter(i => i.dimension === 'canon' && ['high', 'blocking'].includes(i.severity)).length,
      characterDrift: issues.filter(i => i.dimension === 'continuity').length,
      reader: normalizeReaderSummary(k.work.reader) || loadLatestReaderSummary(dir),
      issues: issues.length,
    }
  })
  return { projects: rows }
}
