import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { canonicalMutationKey, registerNovelTools } from '../plugin/operators.mjs'
import {
  addIssue,
  addChapterContracts,
  approveArtifact,
  getArtifacts,
  getProject,
  initProject,
  listGates,
  listIssues,
  loadContracts,
  loadStoryState,
  recordGate,
  resolveStaleNode,
  saveProject,
  setChapterState,
  setWorkflowState,
  writeArtifact,
} from '../plugin/store.mjs'

function contract(chapter, title = `标题${chapter}`) {
  return {
    chapter,
    title,
    pov: 'narrator',
    location: '测试地点',
    time: `第${chapter}日`,
    characters: [],
    entry_state: '进入',
    chapter_goal: '推进测试目标',
    conflict: '测试冲突',
    turning_point: '测试转折',
    payoff: '测试兑现',
    emotional_curve: '平静到紧张',
    information_revealed: '测试信息',
    foreshadowing: [],
    end_hook: '测试钩子',
    exit_state: '离开',
    forbidden_changes: [],
  }
}

function makeProject(t, { chapters = [], brief = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'novel-operators-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { projectDir } = initProject({
    rootDir: root,
    projectId: 'book',
    brief: { chaptersPerBatch: 2, ...brief },
  })
  if (chapters.length) addChapterContracts(projectDir, chapters.map(n => contract(n)))
  return projectDir
}

function prepareProduction(projectDir, state = 'WRITING') {
  for (const id of ['01_market_strategy', 'research', '02_world_bible', '03_system_rules', 'characters', '04_master_plot']) {
    if (!getArtifacts(projectDir).some(row => row.id === id)) writeArtifact(projectDir, { id, content: `# ${id}` })
    const latest = getArtifacts(projectDir).filter(row => row.id === id).sort((a, b) => b.version - a.version)[0]
    if (latest.status !== 'ACTIVE') approveArtifact(projectDir, { id, version: latest.version, approvedBy: 'planner', activate: true })
  }
  for (const node of ['research', '02_world_bible', '03_system_rules', 'characters', '04_master_plot', 'volumes', 'chapters', 'manuscript']) {
    try { resolveStaleNode(projectDir, node, { disposition: 'RE-REVIEW', note: '测试生产就绪' }) } catch { /* 非 STALE */ }
  }
  recordGate(projectDir, { gate: 'planning', target: 'planning-assets', pass: true, score: 90, verdict: 'PASS', evidenceComplete: true })
  recordGate(projectDir, { gate: 'plot', target: 'chapters', pass: true, score: 90, verdict: 'PASS', evidenceComplete: true })
  const project = getProject(projectDir)
  setWorkflowState(project, state, '测试生产就绪')
  saveProject(projectDir, project)
}

function makeTools(structuredFor = async () => undefined) {
  const definitions = new Map()
  const requests = []
  const subagents = {
    async start(_provider, request) {
      requests.push(request)
      const structured = await structuredFor(request, requests.length)
      return {
        id: `run-${requests.length}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: 'scripted' }],
          structured,
          stopReason: 'completed',
        }),
        async dispose() {},
      }
    },
  }
  const ctx = {
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    get(name) { return name === 'subagents' ? subagents : undefined },
  }
  registerNovelTools(ctx)
  const exec = { agent: { id: 'operator-test-parent' }, signal: new AbortController().signal }
  return {
    requests,
    async call(name, args) {
      const definition = definitions.get(name)
      assert.ok(definition, `工具未注册: ${name}`)
      return definition.execute(args, exec)
    },
  }
}

const LOCK_WORKER_SOURCE = `
import { appendFileSync } from 'node:fs'
import { withProjectMutationLock } from ${JSON.stringify(new URL('../plugin/operators.mjs', import.meta.url).href)}

const [key, eventFile, id, holdMs, mode] = process.argv.slice(1)
try {
  await withProjectMutationLock(key, async () => {
    appendFileSync(eventFile, \`start \${id}\n\`)
    process.stdout.write(\`acquired:\${id}\n\`)
    if (mode === 'crash') process.kill(process.pid, 'SIGKILL')
    await new Promise(resolveWait => setTimeout(resolveWait, Number(holdMs)))
    appendFileSync(eventFile, \`end \${id}\n\`)
  })
} catch (error) {
  process.stderr.write(\`\${error?.message || error}\n\`)
  process.exitCode = 2
}
`

function launchLockWorker({ key, eventFile, id, holdMs = 0, mode = 'normal', env = {} }) {
  const child = spawn(process.execPath, [
    '--input-type=module', '--eval', LOCK_WORKER_SOURCE,
    key, eventFile, id, String(holdMs), mode,
  ], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const done = new Promise((resolveDone, rejectDone) => {
    child.once('error', rejectDone)
    child.once('close', (code, signal) => resolveDone({ code, signal, stdout, stderr }))
  })
  return {
    child,
    done,
    async waitUntilAcquired(timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs
      while (!stdout.includes(`acquired:${id}`)) {
        if (Date.now() >= deadline) throw new Error(`等待锁工作进程 ${id} 超时；stdout=${stdout} stderr=${stderr}`)
        await new Promise(resolveWait => setTimeout(resolveWait, 10))
      }
    },
  }
}

function reviewResult(label, withChapterOneFailure = false) {
  const scores = label.includes('剧情') ? { pacing: 94 }
    : label.includes('人设') ? { continuity: 93 }
      : label.includes('世界观') ? { canon: 95 }
        : label.includes('连续性') ? { continuity: 96 }
          : label.includes('文笔') ? { prose: 92, dialogue: 91, style: 93, fact: 92 }
            : { continuity: 94 }
  return {
    issues: withChapterOneFailure && label.includes('世界观')
      ? [
          { chapter: 1, dimension: 'world', severity: 'blocking', evidence: '第1章违反世界规则' },
          { chapter: 1, dimension: 'plot', severity: 'medium', evidence: '第1章节奏偏慢' },
        ]
      : [],
    dimensionScores: scores,
  }
}

test('novel_chapter_read 统一数字章节号，并兼容旧的带标题手稿文件', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  const legacy = join(projectDir, 'manuscript', 'chapters', '第001章_旧标题.md')
  mkdirSync(join(projectDir, 'manuscript', 'chapters'), { recursive: true })
  writeFileSync(legacy, '# 第 1 章：旧标题\n\n旧版正文\n', 'utf8')

  const tools = makeTools()
  const result = await tools.call('novel_chapter_read', { projectDir, chapter: 1 })

  assert.equal(result.contract.chapter, '001')
  assert.match(result.manuscript, /旧版正文/)
})

test('研究阶段拒绝写入没有来源的 Fact', async t => {
  const projectDir = makeProject(t)
  const tools = makeTools(async request => {
    if (request.label === '市场需求分析') {
      return {
        market: '市场分析',
        differentials: ['差异点'],
        reader_persona: [{ segment: '核心读者', ratio: 1, traits: '测试' }],
        strategy: '连载策略',
        assumptions: [],
        sources: [{ title: '有效来源', url: 'https://example.com/market' }],
      }
    }
    if (request.label === '深度资料研究') {
      return {
        evidence: [{ id: 'F-1', kind: 'Fact', claim: '事实断言', confidence: '高' }],
        topics: ['测试专题'],
      }
    }
    throw new Error(`意外子代理任务: ${request.label}`)
  })

  await assert.rejects(
    tools.call('novel_phase_research', { projectDir }),
    /Fact 缺少可验证来源/,
  )
  assert.equal(getArtifacts(projectDir).some(row => row.id === '01_market_strategy'), false)
})

test('Planning 非法评分在任何设定资产写入或 ACTIVE 变更前 fail closed', async t => {
  const projectDir = makeProject(t)
  for (const id of ['02_world_bible', 'characters', '03_system_rules']) {
    const row = writeArtifact(projectDir, { id, content: `# 旧版 ${id}` })
    approveArtifact(projectDir, { id, version: row.version, approvedBy: 'planner', activate: true })
  }
  const beforeArtifacts = structuredClone(getArtifacts(projectDir))
  const tools = makeTools(async request => {
    if (request.label === '世界观架构') return { canon_rules: ['规则一'], world_bible: '# 新世界观' }
    if (request.label === '人物设定') {
      return {
        characters: [{ id: 'hero', name: '主角', role: '主角', motive: '求真', arc: ['成长'], initial_state: '起点' }],
        character_state: { characters: { hero: { name: '主角', current: { state: '起点' } } } },
      }
    }
    if (request.label === '数值体系') return { system_rules: '# 新数值规则', red_lines: ['不得越级'] }
    if (request.label.includes('Planning Gate')) {
      return {
        issues: [],
        scores: { world: 90, plot: 90, character: 90, numbers: 90, research: 90, planner: 90, other: 'N/A' },
      }
    }
    throw new Error(`意外子代理任务: ${request.label}`)
  })

  await assert.rejects(
    tools.call('novel_phase_setting', { projectDir }),
    /Planning Gate 分数非法.*未写入设定资产/,
  )

  assert.deepEqual(getArtifacts(projectDir), beforeArtifacts)
  assert.equal(existsSync(join(projectDir, 'characters', 'hero.md')), false)
  assert.equal(listGates(projectDir).some(row => row.gate === 'planning'), false)
})

test('Writer 在派发前进入 WRITING，成功后写 canonical 文件并进入 QA', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  prepareProduction(projectDir)
  let statusSeenByWriter = null
  const tools = makeTools(async request => {
    if (request.label === '写第001章') {
      statusSeenByWriter = loadContracts(projectDir).chapters['001'].status
      return { manuscript: '这是测试正文。', stateChanges: {}, problems: [] }
    }
    throw new Error(`意外子代理任务: ${request.label}`)
  })

  const result = await tools.call('novel_writer_write_batch', { projectDir, chapters: [1] })

  assert.equal(statusSeenByWriter, 'WRITING')
  assert.deepEqual(result.chapters, ['001'])
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'QA')
  assert.equal(existsSync(join(projectDir, 'manuscript', 'chapters', '第001章.md')), true)
  assert.equal(existsSync(join(projectDir, 'manuscript', 'chapters', '第001章_标题1.md')), false)
})

test('Writer 失败会留下可恢复的 REWORK 状态且不写半成品', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  prepareProduction(projectDir)
  const tools = makeTools(async request => {
    if (request.label === '写第001章') return undefined
    throw new Error(`意外子代理任务: ${request.label}`)
  })

  await assert.rejects(
    tools.call('novel_writer_write_batch', { projectDir, chapters: [1] }),
    /无正文输出|写作失败/,
  )
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'REWORK')
  assert.equal(existsSync(join(projectDir, 'manuscript', 'chapters', '第001章.md')), false)
})

test('Writer 按章节顺序生产，前章返工会从快照重放后续状态', async t => {
  const projectDir = makeProject(t, { chapters: [1, 2] })
  prepareProduction(projectDir)
  const initialOrder = []
  const initialTools = makeTools(async request => {
    const chapter = Number(request.label.match(/\d+/)[0])
    initialOrder.push(chapter)
    return {
      manuscript: `旧正文${chapter}`,
      stateChanges: { story: { current: { summary: `旧摘要${chapter}` } }, openThreads: [`旧线程${chapter}`] },
      problems: [],
    }
  })
  await initialTools.call('novel_writer_write_batch', { projectDir, chapters: [2, 1] })
  assert.deepEqual(initialOrder, [1, 2])

  setChapterState(projectDir, 1, 'REWORK', '返工第1章')
  const project = getProject(projectDir)
  setWorkflowState(project, 'REWORK', '返工第1章')
  saveProject(projectDir, project)
  const rewritten = []
  const reworkTools = makeTools(async request => {
    const chapter = Number(request.label.match(/\d+/)[0])
    rewritten.push(chapter)
    return {
      manuscript: `新正文${chapter}`,
      stateChanges: { story: { current: { summary: `新摘要${chapter}` } }, openThreads: [`新线程${chapter}`] },
      problems: [],
    }
  })
  await reworkTools.call('novel_writer_write_batch', { projectDir, chapters: [1] })

  const story = loadStoryState(projectDir)
  assert.deepEqual(rewritten, [1, 2])
  assert.deepEqual(story.notes.map(note => note.note), ['新摘要1', '新摘要2'])
  assert.equal(story.openThreads.some(thread => String(thread.summary).startsWith('旧线程')), false)
})

test('旧项目缺少 Writer 前置快照时返工 fail closed 且不改写状态', async t => {
  const projectDir = makeProject(t, { chapters: [1, 2] })
  prepareProduction(projectDir)
  const initialTools = makeTools(async request => {
    const chapter = Number(request.label.match(/\d+/)[0])
    return {
      manuscript: `旧正文${chapter}`,
      stateChanges: { story: { current: { summary: `旧摘要${chapter}` } }, openThreads: [`旧线程${chapter}`] },
      problems: [],
    }
  })
  await initialTools.call('novel_writer_write_batch', { projectDir, chapters: [1, 2] })

  rmSync(join(projectDir, 'state', 'chapter_snapshots', '001.json'), { force: true })
  setChapterState(projectDir, 1, 'REWORK', '模拟升级前项目返工')
  const project = getProject(projectDir)
  setWorkflowState(project, 'REWORK', '模拟升级前项目返工')
  saveProject(projectDir, project)
  const storyBefore = loadStoryState(projectDir)
  const reworkTools = makeTools(async () => ({ manuscript: '不应执行', stateChanges: {}, problems: [] }))

  await assert.rejects(
    reworkTools.call('novel_writer_write_batch', { projectDir, chapters: [1] }),
    /缺少 Writer 前置状态快照.*无法安全返工/,
  )

  assert.equal(reworkTools.requests.length, 0)
  assert.deepEqual(loadStoryState(projectDir), storyBefore)
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'REWORK')
  assert.equal(loadContracts(projectDir).chapters['002'].status, 'QA')
})

test('Writer 在恢复快照前验完全部目标，无效章节不改写状态', async t => {
  const projectDir = makeProject(t, { chapters: [1, 2] })
  prepareProduction(projectDir)
  const initialTools = makeTools(async request => {
    const chapter = Number(request.label.match(/\d+/)[0])
    return {
      manuscript: `旧正文${chapter}`,
      stateChanges: { story: { current: { summary: `旧摘要${chapter}` } }, openThreads: [`旧线程${chapter}`] },
      problems: [],
    }
  })
  await initialTools.call('novel_writer_write_batch', { projectDir, chapters: [1, 2] })
  setChapterState(projectDir, 1, 'REWORK', '返工第1章')
  const project = getProject(projectDir)
  setWorkflowState(project, 'REWORK', '返工第1章')
  saveProject(projectDir, project)
  const beforeStory = structuredClone(loadStoryState(projectDir))
  const beforeContracts = structuredClone(loadContracts(projectDir))
  const reworkTools = makeTools(async () => ({ manuscript: '不应执行', stateChanges: {}, problems: [] }))

  await assert.rejects(
    reworkTools.call('novel_writer_write_batch', { projectDir, chapters: [1, 999] }),
    /章节 999 无契约/,
  )

  assert.equal(reworkTools.requests.length, 0)
  assert.deepEqual(loadStoryState(projectDir), beforeStory)
  assert.deepEqual(loadContracts(projectDir), beforeContracts)
})

test('Reviewer 将专业维度归一到 Chapter Gate，并按章节隔离问题', async t => {
  const projectDir = makeProject(t, { chapters: [1, 2] })
  for (const chapter of [1, 2]) {
    setChapterState(projectDir, chapter, 'WRITING', '测试准备')
    setChapterState(projectDir, chapter, 'QA', '测试准备')
  }
  const tools = makeTools(async request => reviewResult(request.label, true))

  const result = await tools.call('novel_review_run', { projectDir, chapters: [1, 2] })
  const book = loadContracts(projectDir)

  assert.equal(book.chapters['001'].status, 'DIAGNOSIS')
  assert.equal(book.chapters['002'].status, 'READER_TEST')
  assert.equal(getProject(projectDir).workflow.state, 'DIAGNOSIS')
  assert.ok(result.issues.length >= 2)
})

test('Reviewer 显式 veto 透传，plot 与 contract 保持各自 Gate 语义', async t => {
  const projectDir = makeProject(t, { chapters: [1, 2] })
  for (const chapter of [1, 2]) {
    setChapterState(projectDir, chapter, 'WRITING', '测试准备')
    setChapterState(projectDir, chapter, 'QA', '测试准备')
  }
  const tools = makeTools(async request => {
    const result = reviewResult(request.label)
    if (request.label.includes('剧情')) {
      result.issues = [
        { chapter: 1, dimension: 'plot', severity: 'blocking', veto: true, evidence: '显式否决剧情偏离' },
        { chapter: 2, dimension: 'contract', severity: 'blocking', evidence: '偏离 Chapter Contract 核心目标' },
      ]
    }
    return result
  })

  await tools.call('novel_review_run', { projectDir, chapters: [1, 2] })

  const issues = listIssues(projectDir)
  const plotIssue = issues.find(issue => issue.evidence === '显式否决剧情偏离')
  const contractIssue = issues.find(issue => issue.evidence === '偏离 Chapter Contract 核心目标')
  assert.deepEqual(
    { dimension: plotIssue.dimension, reviewDimension: plotIssue.reviewDimension, veto: plotIssue.veto },
    { dimension: 'pacing', reviewDimension: 'plot', veto: true },
  )
  assert.deepEqual(
    { dimension: contractIssue.dimension, reviewDimension: contractIssue.reviewDimension },
    { dimension: 'contract', reviewDimension: 'contract' },
  )
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'DIAGNOSIS')
  assert.equal(loadContracts(projectDir).chapters['002'].status, 'DIAGNOSIS')
})

test('Reviewer 未知维度转为 review_integrity veto 而不中断流程', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  setChapterState(projectDir, 1, 'WRITING', '测试准备')
  setChapterState(projectDir, 1, 'QA', '测试准备')
  const tools = makeTools(async request => {
    const result = reviewResult(request.label)
    if (request.label.includes('剧情')) {
      result.issues = [{ chapter: 1, dimension: 'theme', severity: 'blocking', veto: true, evidence: '主题硬冲突' }]
    }
    return result
  })

  await tools.call('novel_review_run', { projectDir, chapters: [1] })

  const issue = listIssues(projectDir).find(row => row.reviewDimension === 'theme')
  assert.equal(issue.dimension, 'review_integrity')
  assert.equal(issue.severity, 'blocking')
  assert.equal(issue.veto, true)
  assert.match(issue.evidence, /未知审查维度.*theme/)
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'DIAGNOSIS')
  assert.equal(listGates(projectDir).filter(row => row.gate === 'chapter').at(-1).verdict, 'VETOED')
})

test('Chapter Gate 评分不完整时生成可诊断 Issue', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  setChapterState(projectDir, 1, 'WRITING', '测试准备')
  setChapterState(projectDir, 1, 'QA', '测试准备')
  const tools = makeTools(async () => ({ issues: [], dimensionScores: { prose: 90 } }))

  await tools.call('novel_review_run', { projectDir, chapters: [1] })

  const issues = listIssues(projectDir).filter(issue => issue.chapter === '001')
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'DIAGNOSIS')
  assert.ok(issues.some(issue => issue.severity === 'high' && /输入不完整|缺评分/.test(issue.evidence)))
})

test('Reader Gate 失败会生成可诊断 Issue，并返回 issueIds', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  setChapterState(projectDir, 1, 'WRITING', '测试准备')
  setChapterState(projectDir, 1, 'QA', '测试准备')
  setChapterState(projectDir, 1, 'READER_TEST', '测试准备')
  const tools = makeTools(async request => ({
    personaId: request.label.replace('读者 ', ''),
    completion: 40,
    nextChapterWillingness: 35,
    skipRate: 60,
    dropPoint: '开头失去兴趣',
    pacing: 45,
    emotionHit: 40,
    characterAffinity: 45,
    payoffDelivery: 30,
    foreshadowRecall: [],
    bestMoments: [],
    worstMoments: ['开头'],
    redLineHit: false,
    redLineNote: '',
    comment: '不会追读',
  }))

  const result = await tools.call('novel_reader_lab_run', { projectDir, chapters: [1], readersPerChapter: 2 })
  const readerIssues = listIssues(projectDir).filter(issue => issue.source === 'reader-lab')

  assert.equal(result.gate.pass, false)
  assert.ok(result.issueIds.length > 0)
  assert.deepEqual(new Set(result.issueIds), new Set(readerIssues.map(issue => issue.issue_id)))
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'DIAGNOSIS')
})

test('Reader Lab 不会在容量不足时悄悄超额派发', async t => {
  const projectDir = makeProject(t, { chapters: [1, 2] })
  for (const chapter of [1, 2]) {
    setChapterState(projectDir, chapter, 'WRITING', '测试准备')
    setChapterState(projectDir, chapter, 'QA', '测试准备')
    setChapterState(projectDir, chapter, 'READER_TEST', '测试准备')
  }
  const tools = makeTools(async request => ({
    personaId: request.label.replace('读者 ', ''),
    completion: 90,
    nextChapterWillingness: 90,
    skipRate: 5,
    pacing: 90,
    emotionHit: 90,
    characterAffinity: 90,
    payoffDelivery: 90,
    redLineHit: false,
  }))

  await assert.rejects(
    tools.call('novel_reader_lab_run', { projectDir, chapters: [1, 2], readersPerChapter: 3, instanceCount: 3 }),
    /容量|instanceCount|至少/,
  )
  assert.equal(tools.requests.length, 0)
})

test('Reader Lab 有任一计划样本无效时 fail closed', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  setChapterState(projectDir, 1, 'WRITING', '测试准备')
  setChapterState(projectDir, 1, 'QA', '测试准备')
  setChapterState(projectDir, 1, 'READER_TEST', '测试准备')
  const tools = makeTools(async (_request, index) => {
    if (index === 1) return undefined
    return {
      personaId: 'R-1-2', completion: 95, nextChapterWillingness: 95, skipRate: 2,
      pacing: 95, emotionHit: 95, characterAffinity: 95, payoffDelivery: 95,
      redLineHit: false,
    }
  })

  const result = await tools.call('novel_reader_lab_run', {
    projectDir,
    chapters: [1],
    readersPerChapter: 2,
  })

  assert.equal(result.gate.pass, false)
  assert.equal(result.gate.decision, 'VETOED')
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'DIAGNOSIS')
})

test('reader_diagnosis 返工把章节交回 Writer，并注入诊断问题', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  prepareProduction(projectDir)
  setChapterState(projectDir, 1, 'WRITING', '测试准备')
  setChapterState(projectDir, 1, 'QA', '测试准备')
  setChapterState(projectDir, 1, 'READER_TEST', '测试准备')
  setChapterState(projectDir, 1, 'DIAGNOSIS', '读者验证失败')
  const issue = addIssue(projectDir, {
    dimension: 'completion', severity: 'high', chapter: '001', status: 'diagnosed',
    evidence: '开头三段信息密度过低，读者退出', source: 'reader-lab',
  })
  writeFileSync(join(projectDir, 'issues', 'diagnosis-DG-reader.json'), JSON.stringify({
    id: 'DG-reader', issueIds: [issue.issue_id], rootCauses: { writer: 1 },
    rollback_to: 'reader_diagnosis', impactRange: [1, 1], rationale: '读者体验层诊断',
  }), 'utf8')
  let writerPrompt = ''
  const tools = makeTools(async request => {
    writerPrompt = request.prompt[0].text
    return { manuscript: '修订后的正文。', stateChanges: {}, problems: [] }
  })

  await tools.call('novel_rework_execute', { projectDir, diagnosisId: 'DG-reader' })
  const result = await tools.call('novel_autopilot', { projectDir })

  assert.equal(result.action, 'write')
  assert.match(writerPrompt, /开头三段信息密度过低/)
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'QA')
})

test('Plot 语义空产出在 Gate 与剧情资产写入前 fail closed', async t => {
  const projectDir = makeProject(t)
  const tools = makeTools(async request => {
    if (request.label === '全书剧情规划') {
      return {
        master_plot: '   ',
        volumes: [],
        contracts: [1, 2].map(chapter => ({
          ...contract(chapter),
          pov: '', location: ' ', time: '', entry_state: '', chapter_goal: '', conflict: '',
          turning_point: '', payoff: '', emotional_curve: '', information_revealed: '', end_hook: '', exit_state: '',
        })),
      }
    }
    throw new Error(`语义空产出不应进入后续任务: ${request.label}`)
  })

  await assert.rejects(
    tools.call('novel_phase_plot', { projectDir }),
    /剧情规划语义产出不完整.*未进入 Plot Gate.*未写入剧情候选/,
  )

  assert.equal(tools.requests.length, 1)
  assert.equal(getArtifacts(projectDir).some(row => row.id === '04_master_plot'), false)
  assert.deepEqual(loadContracts(projectDir).order, [])
  assert.equal(listGates(projectDir).some(row => row.gate === 'plot'), false)
})

test('Plot 拒绝缺少三个结构化数组的 Chapter Contract', async t => {
  const projectDir = makeProject(t, {
    brief: { volumeCount: 1, chaptersPerVolume: 1, chaptersPerBatch: 1 },
  })
  const tools = makeTools(async request => {
    if (request.label === '全书剧情规划') {
      const candidate = contract(1)
      delete candidate.characters
      delete candidate.foreshadowing
      delete candidate.forbidden_changes
      return { master_plot: '# 总纲', volumes: [{ volume: 1, plan: '# 卷纲' }], contracts: [candidate] }
    }
    throw new Error(`不完整契约不应进入后续任务: ${request.label}`)
  })

  await assert.rejects(
    tools.call('novel_phase_plot', { projectDir }),
    /contracts\[0\].*characters.*foreshadowing.*forbidden_changes.*未进入 Plot Gate/,
  )
  assert.equal(tools.requests.length, 1)
  assert.equal(Object.keys(loadContracts(projectDir).chapters).length, 0)
  assert.equal(listGates(projectDir).some(row => row.gate === 'plot'), false)
})

test('Plot 初次规划必须精确覆盖全部卷纲', async t => {
  const projectDir = makeProject(t, {
    brief: { volumeCount: 2, chaptersPerVolume: 1, chaptersPerBatch: 1 },
  })
  const tools = makeTools(async request => {
    if (request.label === '全书剧情规划') {
      return { master_plot: '# 总纲', volumes: [{ volume: 1, plan: '# 第一卷' }], contracts: [contract(1)] }
    }
    throw new Error(`卷纲不完整时不应进入后续任务: ${request.label}`)
  })

  await assert.rejects(
    tools.call('novel_phase_plot', { projectDir }),
    /初次规划缺少卷纲：2.*未进入 Plot Gate/,
  )
  assert.equal(tools.requests.length, 1)
  assert.equal(listGates(projectDir).some(row => row.gate === 'plot'), false)
})

test('Plot 纯参数与现有资产前置条件拒绝时不改变项目状态或历史', async t => {
  const cases = [
    { args: { range: [3, 4] }, error: /Plot range/ },
    { args: { range: [1] }, error: /Plot range/ },
    { args: { volumes: 0 }, error: /volumes 必须是正整数/ },
    { args: { reviewExisting: 'yes' }, error: /reviewExisting.*(?:boolean|布尔值)/ },
    { args: { reviewExisting: true }, error: /没有可重新评审的现有总纲/ },
  ]

  for (const scenario of cases) {
    const projectDir = makeProject(t, {
      brief: { volumeCount: 1, chaptersPerVolume: 2, chaptersPerBatch: 1 },
    })
    const project = getProject(projectDir)
    setWorkflowState(project, 'WRITING', '前置条件测试基线')
    saveProject(projectDir, project)
    const projectPath = join(projectDir, 'library', 'project.json')
    const before = readFileSync(projectPath, 'utf8')
    const tools = makeTools(async () => { throw new Error('前置条件失败时不应派发子代理') })

    await assert.rejects(tools.call('novel_phase_plot', { projectDir, ...scenario.args }), scenario.error)

    assert.equal(tools.requests.length, 0)
    assert.equal(readFileSync(projectPath, 'utf8'), before)
  }
})

test('Plot Gate 畸形 Issue 在剧情候选写入前 fail closed', async t => {
  const projectDir = makeProject(t, {
    brief: { volumeCount: 1, chaptersPerVolume: 1, chaptersPerBatch: 1 },
  })
  const scores = Object.fromEntries([
    'structure', 'hook', 'payoff', 'emotion', 'character_growth', 'info_release', 'foreshadow', 'pacing',
  ].map(dimension => [dimension, 100]))
  const tools = makeTools(async request => {
    if (request.label === '全书剧情规划') {
      return { master_plot: '# 总纲', volumes: [{ volume: 1, plan: '# 第一卷' }], contracts: [contract(1)] }
    }
    if (request.label.includes('Plot Gate 评审')) {
      return {
        issues: [{ dimension: 'structure', severity: 'catastrophic', score: 100, evidence: '主线结构断裂' }],
        scores,
      }
    }
    throw new Error(`意外子代理任务: ${request.label}`)
  })

  await assert.rejects(
    tools.call('novel_phase_plot', { projectDir }),
    /Plot Gate 评审输出非法.*severity.*未写入剧情候选/,
  )

  assert.equal(tools.requests.length, 2)
  assert.equal(getArtifacts(projectDir).some(row => row.id === '04_master_plot'), false)
  assert.deepEqual(loadContracts(projectDir).order, [])
  assert.equal(listGates(projectDir).some(row => row.gate === 'plot'), false)
  assert.notEqual(getProject(projectDir).workflow.state, 'WRITING')
})

test('Plot 阶段使用游标规划下一批，并自动执行 Plot Gate', async t => {
  const projectDir = makeProject(t, { brief: { volumeCount: 1 } })
  const plotPrompts = []
  let planningRound = 0
  const plotScores = {
    structure: 90,
    hook: 90,
    payoff: 90,
    emotion: 90,
    character_growth: 90,
    info_release: 90,
    foreshadow: 90,
    pacing: 90,
  }
  const tools = makeTools(async request => {
    if (request.label === '全书剧情规划' || request.label.includes('章节剧情规划')) {
      plotPrompts.push(request.prompt[0].text)
      planningRound += 1
      const start = planningRound === 1 ? 1 : 3
      return {
        master_plot: '# 总纲',
        volumes: [{ volume: 1, plan: '# 第一卷' }],
        contracts: [contract(start), contract(start + 1)],
      }
    }
    if (request.label.includes('Plot Gate') || request.label.includes('剧情审查')) {
      return { issues: [], scores: plotScores }
    }
    throw new Error(`意外子代理任务: ${request.label}`)
  })

  const first = await tools.call('novel_phase_plot', { projectDir })
  const second = await tools.call('novel_phase_plot', { projectDir })

  assert.equal(first.plotGate.pass, true)
  assert.equal(second.plotGate.pass, true)
  assert.match(plotPrompts[0], /第\s*1-2\s*章/)
  assert.match(plotPrompts[1], /第\s*3-4\s*章/)
  assert.deepEqual(loadContracts(projectDir).order, ['001', '002', '003', '004'])
  assert.equal(getArtifacts(projectDir).filter(a => a.id === '04_master_plot' && a.status === 'ACTIVE').length, 1)
})

test('Autopilot 优先处理 QA，而不是因为还有 PLANNED 就继续写作', async t => {
  const projectDir = makeProject(t, { chapters: [1, 2] })
  prepareProduction(projectDir, 'CONTENT_REVIEW')
  setChapterState(projectDir, 1, 'WRITING', '测试准备')
  setChapterState(projectDir, 1, 'QA', '测试准备')
  const tools = makeTools(async request => {
    if (request.label.startsWith('写第')) return { manuscript: '不应先写', stateChanges: {}, problems: [] }
    return reviewResult(request.label, false)
  })

  const result = await tools.call('novel_autopilot', { projectDir })

  assert.equal(result.action, 'review')
  assert.equal(loadContracts(projectDir).chapters['002'].status, 'PLANNED')
})

test('上游资产更新后 Writer 入口拒绝消费 STALE 下游', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  prepareProduction(projectDir)
  writeArtifact(projectDir, { id: '02_world_bible', content: '# changed world' })
  approveArtifact(projectDir, { id: '02_world_bible', approvedBy: 'planner', activate: true })
  const tools = makeTools(async () => ({ manuscript: '不应写入', stateChanges: {}, problems: [] }))

  await assert.rejects(
    tools.call('novel_writer_write_batch', { projectDir, chapters: [1] }),
    /STALE/,
  )
  assert.equal(tools.requests.length, 0)
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'PLANNED')
})

test('Autopilot 在上游资产更新后先重跑设定而不是 Writer', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  prepareProduction(projectDir)
  writeArtifact(projectDir, { id: '02_world_bible', content: '# changed world' })
  approveArtifact(projectDir, { id: '02_world_bible', approvedBy: 'planner', activate: true })
  const tools = makeTools(async request => {
    assert.doesNotMatch(request.label, /^写第/)
    return undefined
  })

  await assert.rejects(tools.call('novel_autopilot', { projectDir }), /设定阶段产出不完整/)
  assert.ok(tools.requests.some(request => request.label === '世界观架构'))
})

test('上游返工按 setting → plot → writer 推进且不重复起点', async t => {
  const projectDir = makeProject(t, { chapters: [1], brief: { volumeCount: 1 } })
  prepareProduction(projectDir)
  setChapterState(projectDir, 1, 'DIAGNOSIS', '世界观问题')
  const issue = addIssue(projectDir, {
    dimension: 'world', severity: 'blocking', chapter: '001', status: 'diagnosed',
    evidence: '世界规则冲突', source: 'review-pool',
  })
  writeFileSync(join(projectDir, 'issues', 'diagnosis-DG-upstream.json'), JSON.stringify({
    id: 'DG-upstream', issueIds: [issue.issue_id], rootCauses: { 'world-architect': 1 },
    rollback_to: 'world_bible', impactRange: [1, 1], rationale: '重建设定', at: new Date().toISOString(),
  }), 'utf8')
  const seen = []
  const plotScores = Object.fromEntries([
    'structure', 'hook', 'payoff', 'emotion', 'character_growth', 'info_release', 'foreshadow', 'pacing',
  ].map(dimension => [dimension, 90]))
  const planningScores = Object.fromEntries([
    'world', 'plot', 'character', 'numbers', 'research', 'planner', 'other',
  ].map(dimension => [dimension, 90]))
  const tools = makeTools(async request => {
    seen.push(request.label)
    if (request.label === '世界观架构') return { canon_rules: ['规则'], world_bible: '# 新世界观' }
    if (request.label === '人物设定') return {
      characters: [{ id: 'hero', name: '主角', role: '主角', motive: '求真', arc: ['成长'], initial_state: '初始', pressurePoints: ['压力'], relations: {} }],
      character_state: { characters: {} },
    }
    if (request.label === '数值体系') return { system_rules: '# 新规则', red_lines: ['不可越界'] }
    if (request.label === '规划资产评审（Planning Gate）') return { issues: [], scores: planningScores }
    if (request.label === '全书剧情规划') return { master_plot: '# 新总纲', volumes: [{ volume: 1, plan: '# 卷纲' }], contracts: [contract(1)] }
    if (request.label.includes('Plot Gate 评审')) return { issues: [], scores: plotScores }
    if (request.label === '写第001章') return { manuscript: '返工正文。', stateChanges: {}, problems: [] }
    throw new Error(`意外子代理任务: ${request.label}`)
  })

  await tools.call('novel_rework_execute', { projectDir, diagnosisId: 'DG-upstream' })
  assert.equal((await tools.call('novel_autopilot', { projectDir })).action, 'setting')
  assert.equal((await tools.call('novel_autopilot', { projectDir })).action, 'plot')
  assert.equal((await tools.call('novel_autopilot', { projectDir })).action, 'write')

  assert.equal(seen.filter(label => label === '世界观架构').length, 1)
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'QA')
})

test('Plot 区间 Issue 经诊断返工后由 Autopilot 正确关联并先路由 Plot', async t => {
  const projectDir = makeProject(t, {
    chapters: [1, 2],
    brief: { volumeCount: 1, chaptersPerVolume: 2, chaptersPerBatch: 2 },
  })
  prepareProduction(projectDir)
  const issue = addIssue(projectDir, {
    dimension: 'structure', severity: 'high', chapter: '001-002', status: 'open',
    evidence: '本批章节契约结构断裂', source: 'plot-gate-review',
  })
  const seen = []
  const plotScores = Object.fromEntries([
    'structure', 'hook', 'payoff', 'emotion', 'character_growth', 'info_release', 'foreshadow', 'pacing',
  ].map(dimension => [dimension, 90]))
  const tools = makeTools(async request => {
    seen.push(request.label)
    if (request.label.startsWith('根因诊断')) {
      return {
        rootCauses: { 'plot-architect': 1 },
        rollback_to: 'chapter_contract',
        impactSuggestion: [1, 99],
        rationale: '重做本批章节契约',
      }
    }
    if (request.label.includes('章节剧情规划')) {
      return { master_plot: '# 既有总纲', volumes: [{ volume: 1, plan: '# 第一卷' }], contracts: [contract(1), contract(2)] }
    }
    if (request.label.includes('Plot Gate 评审')) return { issues: [], scores: plotScores }
    if (request.label.startsWith('写第')) throw new Error('区间诊断未经过 Plot 就错误进入 Writer')
    throw new Error(`意外子代理任务: ${request.label}`)
  })

  const diagnosed = await tools.call('novel_diagnose', { projectDir, issueIds: [issue.issue_id] })
  assert.deepEqual(diagnosed.impactRange, [1, 2])
  await tools.call('novel_rework_execute', { projectDir, diagnosisId: diagnosed.diagnosisId })
  const result = await tools.call('novel_autopilot', { projectDir })

  assert.equal(result.action, 'plot')
  assert.ok(seen.some(label => label.includes('章节剧情规划')))
  assert.equal(seen.some(label => label.startsWith('写第')), false)
  assert.equal(listIssues(projectDir).find(row => row.issue_id === issue.issue_id).status, 'in_rework')
})

test('无章节时上游诊断使用 brief 规划范围并可执行返工', async t => {
  const projectDir = makeProject(t, {
    brief: { volumeCount: 2, chaptersPerVolume: 5, chaptersPerBatch: 2 },
  })
  const issue = addIssue(projectDir, {
    dimension: 'world', severity: 'blocking', status: 'open',
    evidence: '世界观核心逻辑冲突', source: 'planning-gate-review',
  })
  const tools = makeTools(async request => {
    assert.match(request.label, /^根因诊断/)
    return {
      rootCauses: { 'world-architect': 1 }, rollback_to: 'world_bible',
      impactSuggestion: [1, 99], rationale: '重建世界观',
    }
  })

  const diagnosed = await tools.call('novel_diagnose', { projectDir, issueIds: [issue.issue_id] })
  assert.deepEqual(diagnosed.impactRange, [1, 10])
  const rework = await tools.call('novel_rework_execute', { projectDir, diagnosisId: diagnosed.diagnosisId })
  assert.deepEqual(rework.resetChapters, [])
  assert.equal(getProject(projectDir).workflow.state, 'REWORK')
  assert.equal(listIssues(projectDir).find(row => row.issue_id === issue.issue_id).status, 'in_rework')
})

test('叶子层诊断不能把局部 Issue 无依据扩成全书返工', async t => {
  const projectDir = makeProject(t, { chapters: Array.from({ length: 10 }, (_, index) => index + 1) })
  setChapterState(projectDir, 5, 'WRITING', '测试准备')
  setChapterState(projectDir, 5, 'QA', '测试准备')
  const issue = addIssue(projectDir, {
    dimension: 'prose', severity: 'high', chapter: '005', status: 'open',
    evidence: '仅第5章文笔问题', source: 'review-pool',
  })
  const tools = makeTools(async request => {
    assert.match(request.label, /^根因诊断/)
    return {
      rootCauses: { writer: 1 }, rollback_to: 'writer',
      impactSuggestion: [1, 10], rationale: '模型尝试扩大范围',
    }
  })

  const diagnosed = await tools.call('novel_diagnose', { projectDir, issueIds: [issue.issue_id] })
  assert.deepEqual(diagnosed.impactRange, [5, 5])
  const rework = await tools.call('novel_rework_execute', { projectDir, diagnosisId: diagnosed.diagnosisId })
  assert.deepEqual(rework.resetChapters, ['005'])
  assert.equal(loadContracts(projectDir).chapters['004'].status, 'PLANNED')
  assert.equal(loadContracts(projectDir).chapters['005'].status, 'REWORK')
  assert.equal(loadContracts(projectDir).chapters['006'].status, 'PLANNED')
})

test('完全越界的诊断影响范围在诊断和旧诊断返工入口均 fail closed', async t => {
  const projectDir = makeProject(t, { chapters: [1, 2] })
  const issue = addIssue(projectDir, {
    dimension: 'structure', severity: 'high', chapter: '900-901', status: 'open',
    evidence: '不存在章节的区间问题', source: 'plot-gate-review',
  })
  const tools = makeTools(async request => {
    assert.match(request.label, /^根因诊断/)
    return {
      rootCauses: { 'plot-architect': 1 },
      rollback_to: 'chapter_contract',
      impactSuggestion: [900, 901],
      rationale: '错误的越界范围',
    }
  })

  await assert.rejects(
    tools.call('novel_diagnose', { projectDir, issueIds: [issue.issue_id] }),
    /第 900-901 章与现有章节无交集/,
  )
  assert.equal(listIssues(projectDir).find(row => row.issue_id === issue.issue_id).status, 'open')

  writeFileSync(join(projectDir, 'issues', 'diagnosis-DG-out-of-range.json'), JSON.stringify({
    id: 'DG-out-of-range', issueIds: [issue.issue_id], rootCauses: { 'plot-architect': 1 },
    rollback_to: 'chapter_contract', impactRange: [900, 901], rationale: '旧版越界诊断', at: new Date().toISOString(),
  }), 'utf8')
  const before = getProject(projectDir)
  await assert.rejects(
    tools.call('novel_rework_execute', { projectDir, diagnosisId: 'DG-out-of-range' }),
    /第 900-901 章与现有章节无交集/,
  )
  assert.equal(getProject(projectDir).workflow.state, before.workflow.state)
  assert.deepEqual(loadContracts(projectDir).order.map(chapter => loadContracts(projectDir).chapters[chapter].status), ['PLANNED', 'PLANNED'])
})

test('Autopilot 不会因陈旧的工作流状态向空章节集合派发 Reviewer', async t => {
  const projectDir = makeProject(t, { chapters: [1] })
  prepareProduction(projectDir)
  const project = getProject(projectDir)
  setWorkflowState(project, 'CONTENT_REVIEW', '模拟中断后遗留状态')
  saveProject(projectDir, project)
  const tools = makeTools(async request => {
    assert.match(request.label, /^写第001章$/)
    return { manuscript: '恢复后的正文。', stateChanges: {}, problems: [] }
  })

  const result = await tools.call('novel_autopilot', { projectDir })

  assert.equal(result.action, 'write')
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'QA')
})

test('Autopilot 不信任旧协议 Plot PASS，只重新评审现有契约', async t => {
  const projectDir = makeProject(t, { chapters: [1, 2] })
  prepareProduction(projectDir)
  const project = getProject(projectDir)
  project.counters.gates = 1
  setWorkflowState(project, 'PLOT_REVIEW', '等待兼容校验')
  saveProject(projectDir, project)
  writeFileSync(join(projectDir, 'library', 'gates.json'), JSON.stringify({
    gates: [{ gate: 'plot', target: 'manual', pass: true, score: 89, verdict: 'PASS', issues: 8, seq: 1 }],
  }), 'utf8')
  const scores = Object.fromEntries([
    'structure', 'hook', 'payoff', 'emotion', 'character_growth', 'info_release', 'foreshadow', 'pacing',
  ].map(dimension => [dimension, 90]))
  const tools = makeTools(async request => {
    assert.match(request.label, /Plot Gate 评审/)
    return { issues: [], scores }
  })

  const result = await tools.call('novel_autopilot', { projectDir })

  assert.equal(result.action, 'plot')
  assert.equal(tools.requests.length, 1)
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'PLANNED')
  assert.equal(getProject(projectDir).workflow.state, 'WRITING')
})

test('novel_report 是纯快照，不会因查看报告推进周期或批次', async t => {
  const projectDir = makeProject(t)
  const tools = makeTools()
  const before = getProject(projectDir)

  await tools.call('novel_report', { projectDir })
  const after = getProject(projectDir)

  assert.equal(after.cycle.current, before.cycle.current)
  assert.equal(after.counters.batches, before.counters.batches)
})

test('novel_cycle_close 只在整批 ACCEPTED 后显式推进周期', async t => {
  const projectDir = makeProject(t, {
    chapters: [1, 2],
    brief: { volumeCount: 1, chaptersPerVolume: 2, chaptersPerBatch: 2 },
  })
  const tools = makeTools()
  await assert.rejects(tools.call('novel_cycle_close', { projectDir }), /尚不能关闭/)
  for (const chapter of [1, 2]) {
    setChapterState(projectDir, chapter, 'WRITING', '测试准备')
    setChapterState(projectDir, chapter, 'QA', '测试准备')
    setChapterState(projectDir, chapter, 'READER_TEST', '测试准备')
    setChapterState(projectDir, chapter, 'ACCEPTED', '测试准备')
  }

  const result = await tools.call('novel_cycle_close', { projectDir })

  assert.equal(result.cycle, 1)
  assert.equal(getProject(projectDir).cycle.current, 2)
  assert.equal(existsSync(join(projectDir, 'reports', 'cycle-01.md')), true)
  await assert.rejects(tools.call('novel_cycle_close', { projectDir }), /均已关闭/)
})

test('同一项目的并发写操作按项目串行，Artifact 版本不冲突', async t => {
  const projectDir = makeProject(t)
  const tools = makeTools()

  const rows = await Promise.all([
    tools.call('novel_artifact_write', { projectDir, artifactId: 'concurrency', content: 'v1' }),
    tools.call('novel_artifact_write', { projectDir, artifactId: 'concurrency', content: 'v2' }),
  ])

  assert.deepEqual(rows.map(row => row.version), [1, 2])
})

test('新项目路径通过最深现存父目录 realpath 归一 symlink 别名', t => {
  const root = mkdtempSync(join(tmpdir(), 'novel-lock-key-'))
  const physicalRoot = join(root, 'physical')
  const aliasRoot = join(root, 'alias')
  mkdirSync(physicalRoot)
  symlinkSync(physicalRoot, aliasRoot, 'dir')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const physicalKey = canonicalMutationKey(join(physicalRoot, 'new', 'book'))
  const aliasKey = canonicalMutationKey(join(aliasRoot, 'new', 'book'))

  assert.equal(aliasKey, physicalKey)
  assert.equal(aliasKey, resolve(realpathSync(physicalRoot), 'new', 'book'))
})

test('跨进程项目写锁串行执行，等待者在持有者释放后进入', async t => {
  const root = mkdtempSync(join(tmpdir(), 'novel-cross-lock-'))
  const eventFile = join(root, 'events.log')
  const key = canonicalMutationKey(join(root, 'book'))
  const env = {
    NOVEL_STUDIO_LOCK_TIMEOUT_MS: '2000',
    NOVEL_STUDIO_LOCK_RETRY_MS: '10',
    NOVEL_STUDIO_LOCK_HEARTBEAT_MS: '1000',
    NOVEL_STUDIO_LOCK_STALE_HEARTBEAT_MS: '60',
    NOVEL_STUDIO_LOCK_ORPHAN_GRACE_MS: '20',
  }
  const first = launchLockWorker({ key, eventFile, id: 'first', holdMs: 220, env })
  t.after(() => {
    first.child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  })
  await first.waitUntilAcquired()
  const second = launchLockWorker({ key, eventFile, id: 'second', holdMs: 10, env })
  t.after(() => second.child.kill('SIGKILL'))

  const [firstResult, secondResult] = await Promise.all([first.done, second.done])

  assert.equal(firstResult.code, 0, firstResult.stderr)
  assert.equal(secondResult.code, 0, secondResult.stderr)
  assert.deepEqual(readFileSync(eventFile, 'utf8').trim().split('\n'), [
    'start first', 'end first', 'start second', 'end second',
  ])
})

test('活跃长任务不会被陈旧阈值误清理，等待超时给出明确错误', async t => {
  const root = mkdtempSync(join(tmpdir(), 'novel-live-lock-'))
  const eventFile = join(root, 'events.log')
  const key = canonicalMutationKey(join(root, 'book'))
  const commonEnv = {
    NOVEL_STUDIO_LOCK_RETRY_MS: '10',
    NOVEL_STUDIO_LOCK_HEARTBEAT_MS: '1000',
    NOVEL_STUDIO_LOCK_STALE_HEARTBEAT_MS: '40',
    NOVEL_STUDIO_LOCK_ORPHAN_GRACE_MS: '10',
  }
  const holder = launchLockWorker({ key, eventFile, id: 'holder', holdMs: 350, env: commonEnv })
  t.after(() => {
    holder.child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  })
  await holder.waitUntilAcquired()
  const waiter = launchLockWorker({
    key, eventFile, id: 'waiter', holdMs: 0,
    env: { ...commonEnv, NOVEL_STUDIO_LOCK_TIMEOUT_MS: '90' },
  })
  t.after(() => waiter.child.kill('SIGKILL'))

  const waiterResult = await waiter.done
  const holderResult = await holder.done

  assert.equal(waiterResult.code, 2)
  assert.match(waiterResult.stderr, /等待项目跨进程写锁超时（90ms）.*当前持有者 pid=/s)
  assert.equal(holderResult.code, 0, holderResult.stderr)
  assert.deepEqual(readFileSync(eventFile, 'utf8').trim().split('\n'), ['start holder', 'end holder'])
})

test('持锁进程崩溃后自动回收遗留锁', async t => {
  const root = mkdtempSync(join(tmpdir(), 'novel-orphan-lock-'))
  const eventFile = join(root, 'events.log')
  const key = canonicalMutationKey(join(root, 'book'))
  const env = {
    NOVEL_STUDIO_LOCK_TIMEOUT_MS: '1000',
    NOVEL_STUDIO_LOCK_RETRY_MS: '10',
    NOVEL_STUDIO_LOCK_ORPHAN_GRACE_MS: '10',
  }
  const crashed = launchLockWorker({ key, eventFile, id: 'crashed', mode: 'crash', env })
  t.after(() => {
    crashed.child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  })
  const crashedResult = await crashed.done
  assert.equal(crashedResult.signal, 'SIGKILL')

  const recovered = launchLockWorker({ key, eventFile, id: 'recovered', holdMs: 0, env })
  t.after(() => recovered.child.kill('SIGKILL'))
  const recoveredResult = await recovered.done

  assert.equal(recoveredResult.code, 0, recoveredResult.stderr)
  assert.deepEqual(readFileSync(eventFile, 'utf8').trim().split('\n'), [
    'start crashed', 'start recovered', 'end recovered',
  ])
})

test('novel_init 不通过 shell 解释包含命令替换字符的路径', async t => {
  const root = mkdtempSync(join(tmpdir(), 'novel-shell-'))
  const marker = join(process.cwd(), 'NOVEL_STUDIO_SHELL_INJECTION')
  const attackRoot = join(root, '$(touch NOVEL_STUDIO_SHELL_INJECTION)')
  rmSync(marker, { force: true })
  t.after(() => {
    rmSync(marker, { force: true })
    rmSync(root, { recursive: true, force: true })
  })
  const tools = makeTools()

  const result = await tools.call('novel_init', { rootDir: attackRoot, projectId: 'safe-book' })

  assert.equal(existsSync(result.projectDir), true)
  assert.equal(existsSync(marker), false)
})
