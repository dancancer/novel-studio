/**
 * novel-studio / gates
 * ------------------------------------------------------------------
 * Gate 引擎（设计文档 §7 / §19）。
 *
 * PASS = 输入完整 AND 无硬约束违反 AND 加权得分 >= 阈值 AND 关键指标 >= 下限
 *
 * 每类 Gate 有独立权重面（Planning/Plot/Chapter/Reader/Release），
 * 支持一票否决（veto）、维度扣分、关键指标红线。
 * 纯 ESM，零依赖，直接可测。
 */

/* ================================================================== Gate 配置 */

/**
 * 维度权重面。分数按维度给出 0-100，加权求和。
 * 设计文档：Planning = 世界观15%/情节15%/人物10%/数值10%/深度研究10%/Planner10%/其他专项30%，通过线 70
 */
export const GATE_CONFIGS = {
  planning: {
    label: 'Planning Gate（战略规划）',
    threshold: 70,
    weights: {
      world: 0.15,
      plot: 0.15,
      character: 0.10,
      numbers: 0.10,
      research: 0.10,
      planner: 0.10,
      other: 0.30,
    },
    vetoDimensions: ['world', 'character', 'plot', 'hard_constraint', 'research'],
    vetoNotes: [
      '世界观核心逻辑冲突',
      '主角核心动机不成立',
      '主线无法闭环',
      '用户硬约束违反',
      '关键事实基础错误',
    ],
  },
  plot: {
    label: 'Plot Gate（剧情工程）',
    threshold: 75,
    weights: {
      structure: 0.20,
      hook: 0.15,
      payoff: 0.15,
      emotion: 0.10,
      character_growth: 0.10,
      info_release: 0.10,
      foreshadow: 0.10,
      pacing: 0.10,
    },
    vetoDimensions: ['structure', 'foreshadow', 'character_growth'],
    vetoNotes: [
      '主线结构性断裂',
      '伏笔埋设自相矛盾',
      '人物成长与既定成长弧冲突',
      'Hook 与情绪曲线设计脱离卷目标',
    ],
  },
  chapter: {
    label: 'Chapter Gate（章节正文）',
    threshold: 75,
    weights: {
      prose: 0.25,
      dialogue: 0.15,
      pacing: 0.15,
      continuity: 0.20,
      canon: 0.15,
      style: 0.10,
    },
    vetoDimensions: ['canon', 'continuity', 'contract', 'review_integrity'],
    vetoNotes: [
      '违反 Canon/世界规则（硬约束）',
      '与前一章连续性断裂（状态/时间/人物）',
      '偏离 Chapter Contract 关键目标',
      '必需 Reviewer 缺失或职责评分不完整',
    ],
  },
  reader: {
    label: 'Reader Gate（读者验证）',
    threshold: 70,
    weights: {
      completion: 0.20,
      next_chapter: 0.20,
      retention: 0.15,
      payoff_delivery: 0.15,
      emotion_hit: 0.10,
      character_affinity: 0.10,
      pacing: 0.10,
    },
    vetoDimensions: ['red_line', 'persona_collapse', 'sample_integrity'],
    vetoNotes: [
      '触发关键红线（弃书点率、负反馈风暴）',
      '目标 Persona 严重崩塌',
      '计划 Reader 样本缺失或指标无效',
    ],
    criticalMetrics: {
      completion: 60,
      next_chapter: 60,
      payoff_delivery: 50,
    },
  },
  release: {
    label: 'Release Gate（发布验收）',
    threshold: 80,
    weights: {
      consistency: 0.25,
      foreshadow_recovery: 0.25,
      arc_closure: 0.25,
      business: 0.25,
    },
    vetoDimensions: ['consistency', 'foreshadow_recovery', 'arc_closure', 'business'],
    vetoNotes: [
      '全书一致性破坏（时间线/人物/CANON）',
      '关键伏笔未回收',
      '人物弧未闭环',
      '商业目标数据不达标',
    ],
  },
}

/** Chapter Gate 的唯一评分维度协议。 */
export const CHAPTER_GATE_DIMENSIONS = Object.freeze(Object.keys(GATE_CONFIGS.chapter.weights))

/**
 * Reviewer 可以按专业语言报告问题；进入 Chapter Gate 时统一折叠到六个评分面。
 * 这份映射同时供 Reviewer schema 与编排层做协议校验。
 */
export const REVIEWER_TO_CHAPTER_DIMENSION = Object.freeze({
  prose: 'prose',
  dialogue: 'dialogue',
  pacing: 'pacing',
  continuity: 'continuity',
  canon: 'canon',
  style: 'style',
  plot: 'pacing',
  structure: 'pacing',
  hook: 'pacing',
  payoff: 'pacing',
  emotion: 'pacing',
  info_release: 'pacing',
  character: 'continuity',
  foreshadow: 'continuity',
  world: 'canon',
  numbers: 'canon',
  fact: 'canon',
  contract: 'contract',
})

export const REVIEWER_DIMENSIONS = Object.freeze(Object.keys(REVIEWER_TO_CHAPTER_DIMENSION))

/** 维度 → 中文名（展示用） */
export const DIMENSION_LABELS = {
  world: '世界观', plot: '情节', character: '人物', numbers: '数值体系', research: '深度研究',
  planner: '整体规划', other: '其他专项',
  structure: '结构', hook: 'Hook', payoff: '爽点兑现', emotion: '情绪曲线', character_growth: '人物成长',
  info_release: '信息释放', foreshadow: '伏笔', pacing: '节奏',
  prose: '文笔', dialogue: '对话', continuity: '连续性', canon: '世界规则一致', style: '风格',
  completion: '完读率', next_chapter: '下一章意愿', retention: '留存', payoff_delivery: '爽点兑现度',
  emotion_hit: '情绪命中率', character_affinity: '人物喜爱度',
  consistency: '全书一致性', foreshadow_recovery: '伏笔回收', arc_closure: '人物弧闭环', business: '商业目标',
  red_line: '关键红线', persona_collapse: 'Persona崩塌', sample_integrity: '样本完整性',
  review_integrity: '审查完整性', contract: 'Chapter Contract', hard_constraint: '用户硬约束',
}

/** severity 扣分（无显式 score 时） */
const SEVERITY_PENALTY = { blocking: 100, high: 60, medium: 30, low: 10 }

/* ================================================================== 引擎 */

/**
 * 运行一个 Gate。
 *
 * @param {string} gateType planning|plot|chapter|reader|release
 * @param {Array<object>} issues 问题清单，每项:
 *   { dimension, severity: blocking|high|medium|low, score?: 0-100 维度得分,
 *     veto?: boolean, evidence?, expected?, actual?, recommended_action? }
 * @param {object} opts
 *   - threshold?: 覆盖默认通过线
 *   - criticalMetrics?: { metric: value }（reader gate 用；也可自带 minimums）
 *   - weights?: 权重覆盖
 * 完整性规则：每个加权维度必须至少有一个显式 score；配置了关键指标下限的
 * Gate 还必须提交所有对应 criticalMetrics。缺项时 fail closed 为 INCOMPLETE。
 *
 * @returns {object} { pass, gate, score, threshold, breakdown, vetoes, metrics, completeness, decision }
 */
export function runGate(gateType, issues = [], opts = {}) {
  const config = GATE_CONFIGS[gateType]
  if (!config) throw new Error(`novel-studio: 未知 Gate 类型 ${gateType}，可用：${Object.keys(GATE_CONFIGS).join(',')}`)

  const weights = opts.weights || config.weights
  const threshold = opts.threshold === undefined ? config.threshold : opts.threshold
  assertScore('threshold', threshold)

  if (!Array.isArray(issues)) throw new Error('novel-studio: issues 必须是数组')

  // 1) 按维度聚合
  const byDim = {}
  for (const issue of issues) {
    const sourceDimension = issue?.dimension
    const dim = normalizeGateDimension(gateType, sourceDimension)
    const weighted = Object.hasOwn(weights, dim)
    const vetoDimension = (config.vetoDimensions || []).includes(dim)
      || (config.vetoDimensions || []).includes(sourceDimension)
    if (!weighted && !vetoDimension) {
      throw new Error(`novel-studio: issue 维度 "${sourceDimension}" 不在 ${gateType} gate 协议中: ${[...Object.keys(weights), ...(config.vetoDimensions || [])].join(',')}`)
    }
    if (issue.score !== undefined) assertScore(`issue ${issue.issue_id || sourceDimension} score`, issue.score)
    if (weighted) {
      byDim[dim] = [...(byDim[dim] || []), {
        ...issue,
        dimension: dim,
        sourceDimension,
      }]
    }
  }

  // 2) 维度得分：issue.score ?? 100 - penalty（取该维度最差）
  const breakdown = {}
  let weightedSum = 0
  let weightTotal = 0
  for (const [dim, weight] of Object.entries(weights)) {
    const dimIssues = byDim[dim] || []
    let score = null
    for (const issue of dimIssues) {
      const s = issue.score !== undefined ? issue.score : Math.max(0, 100 - SEVERITY_PENALTY[issue.severity] || 0)
      score = score === null ? s : Math.min(score, s)
    }
    breakdown[dim] = {
      weight,
      score,
      explicitlyScored: dimIssues.some(i => i.score !== undefined),
      issues: dimIssues.map(i => i.issue_id || i.dimension),
      worstSeverity: dimIssues.map(i => i.severity).sort(bySeverity).pop() || null,
    }
    weightedSum += weight * (score ?? 0)
    weightTotal += weight
  }
  const provisionalScore = weightTotal > 0 ? +(weightedSum / weightTotal).toFixed(1) : null

  // 3) 一票否决
  const vetoes = []
  for (const issue of issues) {
    const sourceDimension = issue.dimension
    const dimension = normalizeGateDimension(gateType, sourceDimension)
    const isVeto = issue.veto === true
      || (issue.severity === 'blocking' && (
        (config.vetoDimensions || []).includes(dimension)
        || (config.vetoDimensions || []).includes(sourceDimension)
      ))
    if (isVeto) {
      vetoes.push({
        issue_id: issue.issue_id || '(匿名)',
        dimension: sourceDimension,
        gateDimension: dimension,
        evidence: issue.evidence || '',
        note: config.vetoNotes.find((_, i) => config.vetoDimensions[i] === sourceDimension)
          || config.vetoNotes.find((_, i) => config.vetoDimensions[i] === dimension)
          || '一票否决',
      })
    }
  }

  // 4) 关键指标（reader/release）
  const metrics = {}
  const metricFailures = []
  const criticalMetrics = config.criticalMetrics || {}
  if (opts.criticalMetrics) {
    for (const [m, v] of Object.entries(opts.criticalMetrics)) {
      assertScore(`criticalMetrics.${m}`, v)
      metrics[m] = v
      const min = criticalMetrics[m]
      if (min !== undefined && v < min) metricFailures.push({ metric: m, value: v, minimum: min })
    }
  }

  const requirements = getGateRequirements(gateType, { weights })
  const scoredDimensions = requirements.requiredScoreDimensions.filter(dim => breakdown[dim]?.explicitlyScored)
  const missingScoreDimensions = requirements.requiredScoreDimensions.filter(dim => !scoredDimensions.includes(dim))
  const suppliedCriticalMetrics = requirements.requiredCriticalMetrics.filter(metric => Object.hasOwn(metrics, metric))
  const missingCriticalMetrics = requirements.requiredCriticalMetrics.filter(metric => !suppliedCriticalMetrics.includes(metric))
  const complete = missingScoreDimensions.length === 0 && missingCriticalMetrics.length === 0
  const completeness = {
    complete,
    requiredScoreDimensions: requirements.requiredScoreDimensions,
    scoredDimensions,
    missingScoreDimensions,
    requiredCriticalMetrics: requirements.requiredCriticalMetrics,
    suppliedCriticalMetrics,
    missingCriticalMetrics,
  }

  const noVeto = vetoes.length === 0
  const score = complete ? provisionalScore : null
  const scoreOk = complete && score >= threshold
  const metricsOk = metricFailures.length === 0
  const pass = complete && noVeto && scoreOk && metricsOk

  return {
    pass,
    gate: gateType,
    gateLabel: config.label,
    score,
    provisionalScore,
    threshold,
    breakdown,
    vetoes,
    metrics,
    metricFailures,
    criticalMetrics,
    completeness,
    decision: pass
      ? 'PASS'
      : !noVeto
        ? 'VETOED'
        : !complete
          ? 'INCOMPLETE'
          : !scoreOk
            ? 'BELOW_THRESHOLD'
            : 'METRICS_FAILED',
    formula: 'PASS = 输入完整 AND 无硬约束违反 AND 加权得分 >= 阈值 AND 关键指标 >= 下限',
    at: new Date().toISOString(),
  }
}

/** 将 Reviewer 专业维度归一化为目标 Gate 的评分维度。 */
export function normalizeGateDimension(gateType, dimension) {
  if (!GATE_CONFIGS[gateType]) {
    throw new Error(`novel-studio: 未知 Gate 类型 ${gateType}，可用：${Object.keys(GATE_CONFIGS).join(',')}`)
  }
  if (gateType === 'chapter' && Object.hasOwn(REVIEWER_TO_CHAPTER_DIMENSION, dimension)) {
    return REVIEWER_TO_CHAPTER_DIMENSION[dimension]
  }
  return dimension
}

/** 编排层可据此生成完整评分输入，而不复制 Gate 的隐含规则。 */
export function getGateRequirements(gateType, { weights } = {}) {
  const config = GATE_CONFIGS[gateType]
  if (!config) throw new Error(`novel-studio: 未知 Gate 类型 ${gateType}，可用：${Object.keys(GATE_CONFIGS).join(',')}`)
  const scoreDimensions = Object.keys(weights || config.weights)
  return {
    requiredScoreDimensions: scoreDimensions,
    requiredCriticalMetrics: Object.keys(config.criticalMetrics || {}),
    vetoOnlyDimensions: (config.vetoDimensions || []).filter(dim => !scoreDimensions.includes(dim)),
  }
}

function assertScore(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`novel-studio: ${name} 必须是 0-100 的有限数`)
  }
}

function bySeverity(a, b) {
  const order = { low: 0, medium: 1, high: 2, blocking: 3 }
  return (order[a] ?? 0) - (order[b] ?? 0)
}

/** 便捷：把 review 结果转成 issues 输入 */
export function issuesFromReview(reviewItems) {
  return (reviewItems || []).map(r => ({
    issue_id: r.issue_id,
    chapter: r.chapter,
    dimension: r.dimension,
    severity: r.severity,
    score: r.score,
    veto: r.veto,
    evidence: r.evidence,
    expected: r.expected,
    actual: r.actual,
    recommended_action: r.recommended_action,
    source: r.source || 'review',
  }))
}

/** 输出 Gate 结果的人类可读文本（tool render 用） */
export function renderGateResult(result) {
  const lines = [
    `【${result.gateLabel}】结果：${result.pass ? '✅ PASS' : '❌ FAIL'}（决策: ${result.decision}）`,
    `综合得分：**${result.score ?? '未完成'}** / 通过线 ${result.threshold}`,
  ]
  if (result.completeness && !result.completeness.complete) {
    if (result.completeness.missingScoreDimensions.length) {
      lines.push(`缺少评分：${result.completeness.missingScoreDimensions.map(d => DIMENSION_LABELS[d] || d).join('、')}`)
    }
    if (result.completeness.missingCriticalMetrics.length) {
      lines.push(`缺少关键指标：${result.completeness.missingCriticalMetrics.map(d => DIMENSION_LABELS[d] || d).join('、')}`)
    }
  }
  lines.push('')
  lines.push('| 维度 | 权重 | 得分 |')
  lines.push('|---|---|---|')
  for (const [dim, b] of Object.entries(result.breakdown)) {
    lines.push(`| ${DIMENSION_LABELS[dim] || dim} | ${(b.weight * 100).toFixed(0)}% | ${b.score ?? '未评分'} |`)
  }
  if (result.vetoes.length) {
    lines.push('')
    lines.push('🚫 一票否决命中：')
    for (const v of result.vetoes) lines.push(`- [${result.gate}] ${v.dimension}: ${v.evidence || v.note}`)
  }
  if (result.metricFailures.length) {
    lines.push('')
    lines.push('📉 关键指标未达标：')
    for (const m of result.metricFailures) {
      lines.push(`- ${DIMENSION_LABELS[m.metric] || m.metric}: ${m.value} < 下限 ${m.minimum}`)
    }
  }
  return lines.join('\n')
}
