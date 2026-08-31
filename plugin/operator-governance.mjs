import { join } from 'node:path'
import {
  getIssue, getProject, loadContracts, normalizeChapterId, nowIso, readJsonOr,
  saveProject, setChapterState, setWorkflowState, slugify, updateIssue,
  writeJsonAtomic, writeTextAtomic,
} from './store.mjs'
import { routeByPattern, applyDiagnosis } from './diagnosis.mjs'
import { loadProfile, defaultProfile, recordFailure, loadCandidates, saveCandidate, hrValidate } from './hr.mjs'
import { buildCycleReport } from './reports.mjs'
import { ROLE_PERSONAS } from './agents.mjs'
import {
  bumpHint, gitCommit, impactRangeFromIssues, resolveDiagnosisImpactRange, spawnProjectRole,
} from './operator-common.mjs'

/** 根因诊断（设计 §13） */
export async function phaseDiagnose(ctx, exec, projectDir, opts = {}) {
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

export const AGENT_KEYS = new Set(Object.keys(ROLE_PERSONAS))

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
export function phaseRework(projectDir, opts = {}) {
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
export async function phaseLearning(ctx, exec, projectDir, opts = {}) {
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

export async function phaseHR(ctx, exec, projectDir, opts = {}) {
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
export function phaseReport(projectDir, opts = {}) {
  const project = getProject(projectDir)
  const cycle = opts.cycle || project.cycle.current
  const report = buildCycleReport(projectDir, { cycle })
  return { action: 'report', cycle, report }
}

export function phaseCycleClose(projectDir) {
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
