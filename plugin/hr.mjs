/**
 * novel-studio / hr
 * ------------------------------------------------------------------
 * HR Agent（设计文档 §15 Agent 成长、§16 HR Agent）。
 *
 * - 每个 Agent 维护 Capability Profile（版本、能力、失败、已晋升改进、成绩）
 * - 成长链：失败 → Learning 候选 → Shadow Test → Regression Test → HR 验收 → 晋升/驳回
 * - 生产版本不能被 Learning Agent 直接覆盖：候选不落地到 profile，HR 验收通过才晋升
 *
 * 纯 ESM，零依赖，直接可测。
 */

import { join } from 'node:path'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs'

/** Agent 身份（设计文档 §4 部门表） */
export const AGENT_ROLES = [
  'planner', 'deep-researcher', 'research-assistant', 'world-architect',
  'character-growth-expert', 'numeric-expert', 'plot-architect', 'hook-designer',
  'writer', 'continuity-checker', 'reviewer', 'reader-instance',
  'diagnosis-analyst', 'learning-analyst', 'hr-reviewer',
]

/** 新 Agent 默认档案 */
export function defaultProfile(agent, { version = '1.0' } = {}) {
  return {
    agent,
    role: '',
    version,
    capability: {},
    recentFailures: [],
    promotedImprovements: [],
    skills: [],
    SOPs: [],
    acceptedCases: 0,
    rejectedCases: 0,
    kpis: { successRate: null, oncePassRate: null, avgSevereIssues: null, cost: null, latency: null, regressionScore: null, readerSatisfaction: null },
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export function profilePath(projectDir, agent) {
  return join(projectDir, 'agents', `${agent}.json`)
}

export function loadProfile(projectDir, agent) {
  const p = profilePath(projectDir, agent)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function saveProfile(projectDir, profile) {
  profile.updatedAt = new Date().toISOString()
  writeFileAtomic(profilePath(projectDir, profile.agent), profile)
}

export function loadCandidates(projectDir) {
  const dir = join(projectDir, 'learning', 'candidates')
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch { /* 损坏候选跳过 */ }
  }
  return out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
}

export function saveCandidate(projectDir, candidate) {
  const dir = join(projectDir, 'learning', 'candidates')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${candidate.agent}-${candidate.id}.json`)
  writeFileAtomic(file, candidate)
  return file
}

/**
 * HR 验收（规则引擎部分）。LLM 的 hr-reviewer 子代理负责增补意见，
 * 但晋升/驳回以本函数 + regression 证据为准。
 *
 * 验收要求（设计 §16）：
 *   1. 当前问题确实改善（candidate.fixes 引用打回的 failure/issue）
 *   2. 旧测试集没有明显退化（实际执行的 regressionResults 全部通过）
 *   3. 没有引入新的高严重度问题（candidate.reportedRisks 无 blocking）
 *   4. 成本/延迟无不可接受恶化（可选）
 *   5. 改进可泛化（candidate.generality 说明）
 *
 * regressionResults 每项必须提供 caseId/executed/assertion/evidence；
 * regressionCases 是迁移期兼容别名，不会读取 candidate 自报的 pass。
 *
 * @returns {object} { verdict: 'PROMOTE'|'REJECT', reasons, profile }
 */
export function hrValidate(projectDir, {
  agent,
  candidate,
  regressionResults = null,
  regressionCases = null,
}) {
  const profile = loadProfile(projectDir, agent) || defaultProfile(agent)
  const reasons = []
  const reject = (r) => reasons.push({ type: 'REJECT', detail: r })
  const accept = (r) => reasons.push({ type: 'NOTE', detail: r })

  // 1. 存在候选
  if (!candidate) {
    reject('无 Learning 候选（learning/candidates 中找不到）')
    return { verdict: 'REJECT', reasons, profile }
  }
  // 不能直接对当前生产版本再晋升同版本
  if (candidate.targetVersion && candidate.targetVersion === profile.version) {
    reject(`候选目标版本 ${candidate.targetVersion} 与生产版本相同，无晋升意义`)
  }
  if (!candidate.kind || typeof candidate.content !== 'string' || !candidate.content.trim()) {
    reject('候选缺少可晋升的 kind/content')
  }

  // 2. 回归测试集检查
  const suppliedResults = Array.isArray(regressionResults)
    ? regressionResults
    : (Array.isArray(regressionCases) ? regressionCases : null)
  const definitions = Array.isArray(candidate.regressionCases) ? candidate.regressionCases : []
  const cases = (suppliedResults || []).map(normalizeRegressionResult)
  if (!definitions.length) {
    reject('候选未声明回归用例——无法确认执行结果覆盖了既有行为')
  }
  if (suppliedResults === null) {
    reject('缺少实际执行的回归结果——候选自报的 pass 不构成验收证据')
  } else if (!cases.length) {
    reject('回归测试集为空——按设计 §16 必须有回归证据')
  } else {
    const resultIds = new Set(cases.map(c => c.caseId).filter(Boolean))
    const definitionIds = new Set(definitions.map(d => d.caseId).filter(Boolean))
    const missing = definitions.filter(d => !resultIds.has(d.caseId)).map(d => d.caseId || d.prompt)
    const undeclared = cases.filter(c => !c.caseId || !definitionIds.has(c.caseId))
    const duplicateIds = cases
      .map(c => c.caseId)
      .filter((id, index, all) => id && all.indexOf(id) !== index)
    if (missing.length) reject(`回归结果未覆盖候选用例：${missing.join(', ')}`)
    if (undeclared.length) reject(`回归结果包含未声明用例：${caseLabels(undeclared)}`)
    if (duplicateIds.length) reject(`回归结果 caseId 重复：${[...new Set(duplicateIds)].join(', ')}`)

    const notExecuted = cases.filter(c => c.executed !== true)
    const missingAssertions = cases.filter(c => typeof c.passed !== 'boolean')
    const missingEvidence = cases.filter(c => !hasEvidence(c.evidence))
    if (notExecuted.length) reject(`回归用例未实际执行：${caseLabels(notExecuted)}`)
    if (missingAssertions.length) reject(`回归用例缺少可判定 assertion：${caseLabels(missingAssertions)}`)
    if (missingEvidence.length) reject(`回归用例缺少可验证 evidence：${caseLabels(missingEvidence)}`)

    const failed = cases.filter(c => c.executed === true && c.passed === false)
    if (failed.length) {
      reject(`回归测试 ${cases.length - failed.length}/${cases.length} 通过，${failed.length} 条失败：${caseLabels(failed)}`)
    } else if (!notExecuted.length && !missingAssertions.length && !missingEvidence.length && !missing.length && !undeclared.length && !duplicateIds.length) {
      accept(`回归测试 ${cases.length} 条全部通过`)
    } else {
      reject('回归证据不完整，不能晋升')
    }
  }

  // 3. 当前问题改善的证据
  if (!candidate.fixes || !candidate.fixes.length) {
    reject('候选未声明修复了哪些已知问题（fixes 为空）')
  } else {
    const covered = (profile.recentFailures || []).filter(f =>
      (candidate.fixes || []).some(fx => fx.failureId === f.id || fx.failureType === f.type),
    ).length
    accept(`候选覆盖 ${covered}/${profile.recentFailures.length} 条近期失败` + (candidate.fixes.map(f => `（${f.failureId || f.failureType}）`).join('')))
    if (!covered && profile.recentFailures.length) reject('候选未覆盖任何近期失败——改进可能不针对实际问题')
  }

  // 4. 新风险
  const risks = candidate.reportedRisks || []
  if (risks.some(r => r.severity === 'blocking' || r.severity === 'high')) {
    reject(`候选引入 ${risks.filter(r => ['blocking', 'high'].includes(r.severity)).map(r => r.severity).join(',')} 级别风险`)
  } else if (risks.length) {
    accept(`候选声明 ${risks.length} 条风险（非高严重度）`)
  }

  // 5. 泛化性
  if (!candidate.generality || candidate.generality.trim().length < 10) {
    reject('候选缺少泛化性说明（改进应可泛化，而非只针对单个样本）')
  } else accept('候选提供泛化性论证')

  const failed = reasons.some(r => r.type === 'REJECT')
  const verdict = failed ? 'REJECT' : 'PROMOTE'

  if (verdict === 'PROMOTE') {
    // 晋升：版本 +1（语义版本小版本递增），结构化改进进入生产档案。
    const nextVersion = bumpVersion(profile.version)
    const promotedAt = new Date().toISOString()
    profile.history.push({
      from: profile.version,
      to: nextVersion,
      at: promotedAt,
      candidateId: candidate.id,
      reasons: reasons.map(r => r.detail),
      result: 'PROMOTED',
    })
    profile.version = nextVersion
    profile.promotedImprovements = [
      ...(profile.promotedImprovements || []).filter(i => i.candidateId !== candidate.id),
      {
        kind: candidate.kind,
        title: candidate.title || '',
        content: candidate.content,
        candidateId: candidate.id,
        promotedAt,
      },
    ]
    // 把被修复的失败归档
    const fixedIds = new Set((candidate.fixes || []).map(f => f.failureId))
    profile.recentFailures = (profile.recentFailures || []).filter(f => !fixedIds.has(f.id))
    profile.capability = { ...(profile.capability || {}), ...(candidate.capabilityDelta || {}) }
    profile.acceptedCases = (profile.acceptedCases || 0) + 1
    profile.kpis.regressionScore = cases.length ? +((cases.filter(c => c.passed === true).length / cases.length) * 100).toFixed(1) : null
  } else {
    profile.history.push({
      from: profile.version,
      to: profile.version,
      at: new Date().toISOString(),
      candidateId: candidate.id,
      reasons: reasons.map(r => r.detail),
      result: 'REJECTED',
    })
    profile.rejectedCases = (profile.rejectedCases || 0) + 1
  }

  saveProfile(projectDir, profile)
  return { verdict, reasons, profile }
}

function normalizeRegressionResult(result) {
  const assertion = result?.assertion
  let passed = null
  if (typeof assertion === 'boolean') passed = assertion
  else if (assertion && typeof assertion === 'object') {
    if (typeof assertion.passed === 'boolean') passed = assertion.passed
    else if (typeof assertion.pass === 'boolean') passed = assertion.pass
  }
  // 兼容旧结果的 pass 命名，但仍要求 executed/assertion/evidence 三类证据齐全。
  if (passed === null && assertion != null && typeof result?.pass === 'boolean') passed = result.pass
  return {
    ...result,
    executed: result?.executed === true,
    passed,
  }
}

function hasEvidence(evidence) {
  if (typeof evidence === 'string') return evidence.trim().length > 0
  if (Array.isArray(evidence)) return evidence.length > 0
  return Boolean(evidence && typeof evidence === 'object' && Object.values(evidence).some(v => {
    if (typeof v === 'string') return v.trim().length > 0
    return v !== null && v !== undefined
  }))
}

function caseLabels(cases) {
  return cases.map(c => c.caseId || c.prompt || '未命名用例').join(', ')
}

/** 记录一条失败（失败数据 → Failure Analyzer 的输入；设计 §15） */
export function recordFailure(projectDir, agent, failure) {
  const profile = loadProfile(projectDir, agent) || defaultProfile(agent)
  profile.recentFailures = profile.recentFailures || []
  profile.recentFailures.push({
    id: `${agent}-f${profile.recentFailures.length + 1}-${String(Date.now()).slice(-5)}`,
    at: new Date().toISOString(),
    ...failure,
  })
  profile.recentFailures = profile.recentFailures.slice(-20)
  profile.rejectedCases = (profile.rejectedCases || 0) + 1
  saveProfile(projectDir, profile)
  return profile.recentFailures[profile.recentFailures.length - 1]
}

function bumpVersion(v) {
  const parts = String(v).split('.').map(Number)
  if (parts.length >= 3) {
    parts[2] = (parts[2] || 0) + 1
    // 每 10 次小修进中版本
    if (parts[2] >= 10) { parts[2] = 0; parts[1] = (parts[1] || 0) + 1 }
  } else if (parts.length === 2) {
    parts[1] = (parts[1] || 0) + 1
  } else {
    return `${v}.1`
  }
  return parts.join('.')
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}
