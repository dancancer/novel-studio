/**
 * Gate 引擎测试（设计 §7/§19）：权重、一票否决、完整性、协议映射。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GATE_CONFIGS,
  getGateRequirements,
  issuesFromReview,
  normalizeGateDimension,
  renderGateResult,
  runGate,
} from '../plugin/gates.mjs'

function completeScores(gate, overrides = {}) {
  return Object.keys(GATE_CONFIGS[gate].weights).map(dimension => ({
    issue_id: `score-${dimension}`,
    dimension,
    severity: 'low',
    score: overrides[dimension] ?? 100,
  }))
}

test('空 Gate fail closed：返回 INCOMPLETE 而非 100 PASS', () => {
  const r = runGate('planning', [])
  assert.equal(r.pass, false)
  assert.equal(r.decision, 'INCOMPLETE')
  assert.equal(r.score, null)
  assert.equal(r.completeness.complete, false)
  assert.deepEqual(r.completeness.missingScoreDimensions, Object.keys(GATE_CONFIGS.planning.weights))
  assert.ok(Object.values(r.breakdown).every(item => item.score === null))
})

test('缺少任一必须评分维度时返回 INCOMPLETE', () => {
  const issues = completeScores('chapter').filter(i => i.dimension !== 'style')
  const r = runGate('chapter', issues)
  assert.equal(r.pass, false)
  assert.equal(r.decision, 'INCOMPLETE')
  assert.deepEqual(r.completeness.missingScoreDimensions, ['style'])
})

test('planning gate：全维度显式满分通过', () => {
  const r = runGate('planning', completeScores('planning'))
  assert.equal(r.pass, true)
  assert.equal(r.score, 100)
  assert.equal(r.completeness.complete, true)
})

test('chapter gate：加权得分按维度权重计算', () => {
  const issues = completeScores('chapter')
  issues.push(
    { issue_id: 'A1', dimension: 'prose', severity: 'high' },
    { issue_id: 'A2', dimension: 'dialogue', severity: 'medium' },
  )
  const r = runGate('chapter', issues)
  assert.equal(r.score, 80.5)
  assert.equal(r.pass, true)
  assert.equal(r.breakdown.prose.score, 40)
})

test('chapter gate：显式 score 覆盖 severity 扣分', () => {
  const issues = completeScores('chapter')
  issues.push({ issue_id: 'B1', dimension: 'prose', severity: 'blocking', score: 90 })
  const r = runGate('chapter', issues)
  assert.equal(r.breakdown.prose.score, 90)
  assert.equal(r.pass, true)
})

test('one-vote veto：blocking + veto 维度', () => {
  const issues = [
    { issue_id: 'C1', dimension: 'world', severity: 'blocking', evidence: '世界规则自相矛盾' },
  ]
  const r = runGate('planning', issues)
  assert.equal(r.pass, false)
  assert.equal(r.decision, 'VETOED')
  assert.equal(r.vetoes.length, 1)
})

test('veto-only 维度可直接否决，不要求出现在权重面', () => {
  for (const [gate, dimension] of [
    ['reader', 'red_line'],
    ['reader', 'persona_collapse'],
    ['planning', 'hard_constraint'],
  ]) {
    const r = runGate(gate, [{ issue_id: `${gate}-${dimension}`, dimension, severity: 'blocking' }])
    assert.equal(r.pass, false)
    assert.equal(r.decision, 'VETOED')
    assert.equal(r.vetoes[0].dimension, dimension)
    assert.equal(r.breakdown[dimension], undefined)
  }
})

test('Chapter Contract 核心偏离使用独立 veto 维度', () => {
  const issues = Object.keys(GATE_CONFIGS.chapter.weights).map(dimension => ({
    issue_id: `score-${dimension}`, dimension, severity: 'low', score: 100,
  }))
  issues.push({
    issue_id: 'contract-veto', dimension: 'contract', severity: 'blocking',
    evidence: '章节没有履行契约核心目标',
  })

  const result = runGate('chapter', issues)

  assert.equal(result.pass, false)
  assert.equal(result.decision, 'VETOED')
  assert.equal(result.vetoes[0].dimension, 'contract')
})

test('reader veto-only 维度返回与维度对应的否决说明', () => {
  const redLine = runGate('reader', [{ dimension: 'red_line', severity: 'blocking' }])
  const collapse = runGate('reader', [{ dimension: 'persona_collapse', severity: 'blocking' }])
  assert.match(redLine.vetoes[0].note, /红线/)
  assert.match(collapse.vetoes[0].note, /Persona/)
})

test('explicit veto flag 无论加权维度都生效', () => {
  const r = runGate('plot', [{ issue_id: 'D1', dimension: 'pacing', severity: 'low', veto: true }])
  assert.equal(r.pass, false)
  assert.equal(r.decision, 'VETOED')
})

test('below threshold：完整评分低于通过线', () => {
  const issues = completeScores('release', { consistency: 40, foreshadow_recovery: 40 })
  const r = runGate('release', issues)
  assert.equal(r.score, 70)
  assert.equal(r.pass, false)
  assert.equal(r.decision, 'BELOW_THRESHOLD')
})

test('reader gate：关键指标下限', () => {
  const issues = completeScores('reader', {
    completion: 80,
    next_chapter: 75,
    payoff_delivery: 70,
  })
  const r = runGate('reader', issues, {
    criticalMetrics: { completion: 80, next_chapter: 75, payoff_delivery: 40 },
  })
  assert.equal(r.pass, false)
  assert.equal(r.metricFailures.length, 1)
  assert.equal(r.metricFailures[0].metric, 'payoff_delivery')
})

test('reader gate：缺少必须关键指标时返回 INCOMPLETE', () => {
  const r = runGate('reader', completeScores('reader'), {
    criticalMetrics: { completion: 80 },
  })
  assert.equal(r.decision, 'INCOMPLETE')
  assert.deepEqual(r.completeness.missingCriticalMetrics, ['next_chapter', 'payoff_delivery'])
})

test('score、threshold 与关键指标必须是 0-100 有限数', () => {
  for (const score of [-1, 101, NaN, Infinity, '80']) {
    assert.throws(
      () => runGate('chapter', [{ dimension: 'prose', severity: 'low', score }]),
      /score.*0-100.*有限数/,
    )
  }
  for (const threshold of [-1, 101, NaN, Infinity, '75', null]) {
    assert.throws(() => runGate('chapter', [], { threshold }), /threshold.*0-100.*有限数/)
  }
  assert.equal(runGate('chapter', [], { threshold: undefined }).threshold, GATE_CONFIGS.chapter.threshold)
  assert.throws(
    () => runGate('reader', completeScores('reader'), { criticalMetrics: { completion: Infinity } }),
    /criticalMetrics\.completion.*0-100.*有限数/,
  )
})

test('Chapter Gate 将 Reviewer 专业维度映射到六个权重维度', () => {
  assert.equal(normalizeGateDimension('chapter', 'plot'), 'pacing')
  assert.equal(normalizeGateDimension('chapter', 'character'), 'continuity')
  assert.equal(normalizeGateDimension('chapter', 'world'), 'canon')
  assert.equal(normalizeGateDimension('chapter', 'fact'), 'canon')

  const issues = [
    { dimension: 'prose', severity: 'low', score: 90 },
    { dimension: 'dialogue', severity: 'low', score: 90 },
    { dimension: 'plot', severity: 'low', score: 90 },
    { dimension: 'character', severity: 'low', score: 90 },
    { dimension: 'world', severity: 'low', score: 90 },
    { dimension: 'style', severity: 'low', score: 90 },
  ]
  const r = runGate('chapter', issues)
  assert.equal(r.pass, true)
  assert.equal(r.score, 90)
  assert.equal(r.completeness.complete, true)
})

test('Gate requirements 显式公开评分、指标与 veto-only 维度', () => {
  assert.deepEqual(getGateRequirements('reader'), {
    requiredScoreDimensions: Object.keys(GATE_CONFIGS.reader.weights),
    requiredCriticalMetrics: Object.keys(GATE_CONFIGS.reader.criticalMetrics),
    vetoOnlyDimensions: ['red_line', 'persona_collapse', 'sample_integrity'],
  })
})

test('未知维度报错', () => {
  assert.throws(() => runGate('chapter', [{ dimension: 'bogus' }]))
  assert.throws(() => runGate('nope'))
})

test('issuesFromReview 转换保留 chapter 并可触发 veto', () => {
  const items = [{ issue_id: 'X1', chapter: 3, dimension: 'canon', severity: 'blocking', evidence: 'e' }]
  const issues = issuesFromReview(items)
  assert.equal(issues[0].chapter, 3)
  const r = runGate('chapter', issues)
  assert.equal(r.pass, false)
  assert.equal(r.decision, 'VETOED')
  assert.equal(r.vetoes[0].dimension, 'canon')
})

test('renderGateResult 输出人类可读的 INCOMPLETE', () => {
  const text = renderGateResult(runGate('planning', []))
  assert.ok(text.includes('FAIL'))
  assert.ok(text.includes('INCOMPLETE'))
  assert.ok(text.includes('缺少评分'))
})
