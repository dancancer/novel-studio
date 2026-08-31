import { join } from 'node:path'
import {
  getArtifacts, getProject, listChapterStates, listGates, listIssues,
  normalizeChapterId, nowIso, readJsonOr, resolveStaleNode, saveProject,
  setChapterState, setWorkflowState, writeJsonAtomic,
} from './store.mjs'
import { phaseResearch, phaseSetting, phasePlot } from './operator-planning.mjs'
import { phaseWriteBatch } from './operator-production.mjs'
import { phaseReview, phaseReaderLab } from './operator-quality.mjs'
import { phaseCycleClose, phaseDiagnose, phaseReport, phaseRework } from './operator-governance.mjs'
import {
  issueChapterOverlaps, normalizeIssueChapter, readdirNames, staleNodeIds,
} from './operator-common.mjs'

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
export async function autopilotNext(ctx, exec, projectDir) {
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
