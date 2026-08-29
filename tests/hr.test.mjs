/**
 * HR / Agent 成长测试（设计 §15/§16）：档案、候选、验收、晋升/驳回。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  initProject, writeArtifact,
} from '../plugin/store.mjs'
import {
  defaultProfile, loadProfile, saveProfile, recordFailure,
  saveCandidate, loadCandidates, hrValidate,
} from '../plugin/hr.mjs'

function makeProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'novel-hr-'))
  const { projectDir } = initProject({ projectId: 'hr-book', rootDir: root })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return projectDir
}

function goodCandidate() {
  return {
    id: 'writer-c1',
    agent: 'writer',
    kind: 'prompt',
    title: '开场 3 秒内给出信息钩子',
    content: '在 persona 中增加规则：开场段必须包含一个未解问题。',
    targetVersion: '2.1',
    fixes: [{ failureId: 'slow_opening', failureType: 'blocking/pacing' }],
    regressionCases: [
      { caseId: 'R1', prompt: '写一章开头', expected: '包含钩子', pass: false },
      { caseId: 'R2', prompt: '写一章结尾', expected: '保持风格', pass: false },
    ],
    reportedRisks: [{ severity: 'low', detail: '可能拖慢速度' }],
    generality: '该规则适用于所有章节开头，不依赖特定样本。',
    status: 'CANDIDATE',
  }
}

function goodRegressionResults() {
  return [
    {
      caseId: 'R1',
      executed: true,
      assertion: { passed: true, expected: '包含钩子', actual: '首段提出了未解问题' },
      evidence: { source: 'shadow-run/R1', output: '门外是谁？' },
    },
    {
      caseId: 'R2',
      executed: true,
      assertion: { passed: true, expected: '保持风格', actual: '结尾保持原有叙事风格' },
      evidence: { source: 'shadow-run/R2', output: '夜色重新落回长街。' },
    },
  ]
}

test('defaultProfile 与 save/load 往返', (t) => {
  const projectDir = makeProject(t)
  const p = defaultProfile('writer', { version: '2.0' })
  p.capability = { opening_hook: 0.91 }
  saveProfile(projectDir, p)
  const loaded = loadProfile(projectDir, 'writer')
  assert.equal(loaded.version, '2.0')
  assert.equal(loaded.capability.opening_hook, 0.91)
})

test('recordFailure：失败入档并计数', (t) => {
  const projectDir = makeProject(t)
  const profile = loadProfile(projectDir, 'writer') || defaultProfile('writer')
  saveProfile(projectDir, profile)
  const f = recordFailure(projectDir, 'writer', { type: 'blocking/pacing', evidence: 'e' })
  assert.ok(f.id.startsWith('writer-f'))
  const p = loadProfile(projectDir, 'writer')
  assert.equal(p.recentFailures.length, 1)
  assert.equal(p.rejectedCases, 1)
})

test('hrValidate：实际回归通过后以结构化改进晋升', (t) => {
  const projectDir = makeProject(t)
  const profile = defaultProfile('writer', { version: '2.0' })
  profile.recentFailures = [{ id: 'slow_opening', type: 'blocking/pacing', evidence: 'e' }]
  profile.promotedImprovements = [{
    kind: 'prompt', title: '旧内容', content: '旧内容', candidateId: 'writer-c1', promotedAt: '2025-01-01T00:00:00.000Z',
  }]
  saveProfile(projectDir, profile)
  saveCandidate(projectDir, goodCandidate())

  const cands = loadCandidates(projectDir)
  assert.equal(cands.length, 1)
  const verdict = hrValidate(projectDir, {
    agent: 'writer',
    candidate: cands[0],
    regressionResults: goodRegressionResults(),
  })
  assert.equal(verdict.verdict, 'PROMOTE')
  const after = loadProfile(projectDir, 'writer')
  assert.equal(after.version, '2.1')
  assert.ok(after.history.some(h => h.result === 'PROMOTED'))
  assert.ok(after.recentFailures.every(f => f.id !== 'slow_opening'), '已修复失败应归档')
  assert.deepEqual(after.promotedImprovements.map(({ kind, content }) => ({ kind, content })), [{
    kind: 'prompt',
    content: '在 persona 中增加规则：开场段必须包含一个未解问题。',
  }])
  assert.deepEqual(Object.keys(after.promotedImprovements[0]).sort(), [
    'candidateId', 'content', 'kind', 'promotedAt', 'title',
  ])
  assert.equal(after.kpis.regressionScore, 100)
})

test('hrValidate：候选自报 pass 不得冒充实际回归证据', (t) => {
  const projectDir = makeProject(t)
  const profile = defaultProfile('writer', { version: '2.0' })
  profile.recentFailures = [{ id: 'slow_opening', type: 'blocking/pacing', evidence: 'e' }]
  saveProfile(projectDir, profile)

  const candidate = goodCandidate()
  candidate.regressionCases = candidate.regressionCases.map(c => ({ ...c, pass: true }))
  const verdict = hrValidate(projectDir, { agent: 'writer', candidate })

  assert.equal(verdict.verdict, 'REJECT')
  assert.ok(verdict.reasons.some(r => r.detail.includes('实际执行')))
  assert.equal(loadProfile(projectDir, 'writer').version, '2.0')
})

test('hrValidate：候选必须先声明回归用例，不能只提交临时结果', (t) => {
  const projectDir = makeProject(t)
  const candidate = { ...goodCandidate(), regressionCases: [] }

  const verdict = hrValidate(projectDir, {
    agent: 'writer',
    candidate,
    regressionResults: goodRegressionResults(),
  })

  assert.equal(verdict.verdict, 'REJECT')
  assert.ok(verdict.reasons.some(r => r.detail.includes('候选未声明回归用例')))
})

test('hrValidate：拒绝混入未声明用例的回归结果', (t) => {
  const projectDir = makeProject(t)
  const regressionResults = [
    ...goodRegressionResults(),
    {
      caseId: 'R-forged',
      executed: true,
      assertion: true,
      evidence: '未在候选回归集中登记',
    },
  ]

  const verdict = hrValidate(projectDir, {
    agent: 'writer',
    candidate: goodCandidate(),
    regressionResults,
  })

  assert.equal(verdict.verdict, 'REJECT')
  assert.ok(verdict.reasons.some(r => r.detail.includes('未声明')))
})

test('hrValidate：executed、assertion、evidence 缺一不可', (t) => {
  const projectDir = makeProject(t)
  const variants = [
    {
      reason: '未实际执行',
      mutate(results) { results[0].executed = false },
    },
    {
      reason: 'assertion',
      mutate(results) { delete results[0].assertion },
    },
    {
      reason: 'evidence',
      mutate(results) { results[0].evidence = {} },
    },
  ]

  for (const variant of variants) {
    const regressionResults = goodRegressionResults()
    variant.mutate(regressionResults)
    const verdict = hrValidate(projectDir, {
      agent: 'writer', candidate: goodCandidate(), regressionResults,
    })
    assert.equal(verdict.verdict, 'REJECT')
    assert.ok(verdict.reasons.some(r => r.detail.includes(variant.reason)))
  }
})

test('hrValidate：兼容 regressionCases 参数名及布尔 assertion', (t) => {
  const projectDir = makeProject(t)
  const regressionCases = goodRegressionResults().map(result => ({
    ...result,
    assertion: true,
  }))

  const verdict = hrValidate(projectDir, {
    agent: 'writer', candidate: goodCandidate(), regressionCases,
  })

  assert.equal(verdict.verdict, 'PROMOTE')
})

test('hrValidate：回归失败 REJECT + 候选状态保持', (t) => {
  const projectDir = makeProject(t)
  const cand = goodCandidate()
  saveCandidate(projectDir, cand)
  const regressionResults = goodRegressionResults()
  regressionResults[1].assertion.passed = false
  regressionResults[1].assertion.actual = '结尾风格发生漂移'
  const verdict = hrValidate(projectDir, { agent: 'writer', candidate: cand, regressionResults })
  assert.equal(verdict.verdict, 'REJECT')
  const after = loadProfile(projectDir, 'writer') || defaultProfile('writer')
  assert.equal(after.version, '1.0')
  assert.ok(after.history.some(h => h.result === 'REJECTED'))
})

test('hrValidate：空回归集 / 缺 fixes / 缺泛化 均 REJECT', (t) => {
  const projectDir = makeProject(t)
  const c1 = { ...goodCandidate(), regressionCases: [] }
  const c2 = { ...goodCandidate(), fixes: [] }
  const c3 = { ...goodCandidate(), generality: '' }
  for (const c of [c1, c2, c3]) {
    const v = hrValidate(projectDir, { agent: 'writer', candidate: c, regressionResults: goodRegressionResults() })
    assert.equal(v.verdict, 'REJECT', `应驳回：${JSON.stringify({ fixes: c.fixes, n: c.regressionCases?.length, g: c.generality })}`)
  }
})

test('候选不直接生效：写候选≠改 profile', (t) => {
  const projectDir = makeProject(t)
  const profile = defaultProfile('planner', { version: '3.0' })
  saveProfile(projectDir, profile)
  saveCandidate(projectDir, { ...goodCandidate(), agent: 'planner', id: 'planner-c1' })
  // 未经过 HR：profile 版本不变
  assert.equal(loadProfile(projectDir, 'planner').version, '3.0')
  assert.equal(loadCandidates(projectDir).length, 1)
  assert.equal(loadCandidates(projectDir)[0].status, 'CANDIDATE')
})
