import { join } from 'node:path'
import {
  addIssue, getProject, listChapterStates, loadContracts, normalizeChapterId,
  nowIso, recordGate, resolveStaleNode, saveProject, setChapterState,
  setWorkflowState, writeJsonAtomic,
} from './store.mjs'
import { runGate, normalizeGateDimension, REVIEWER_DIMENSIONS } from './gates.mjs'
import {
  hash, mulberry32, resolveRevalidatedChapterIssues, spawnProjectParallel, weightedPick,
} from './operator-common.mjs'
import { renderSerialStrategy, renderWritingStyle, REVIEW_METHOD } from './writing-methodology.mjs'

/** Phase 4：Reviewer Pool 专业审查 + Chapter Gate */
export async function phaseReview(ctx, exec, projectDir, opts = {}) {
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
    '项目可观察文风参数：',
    renderWritingStyle(project.brief),
    '项目连载叙事策略：',
    renderSerialStrategy(project.brief),
    REVIEW_METHOD,
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
export async function phaseReaderLab(ctx, exec, projectDir, opts = {}) {
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
      `项目承诺与连载策略：\n${renderSerialStrategy(project.brief)}`,
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
