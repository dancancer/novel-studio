/**
 * store 层测试：项目初始化、artifact 生命周期、状态存储、章节状态机、依赖图、KPI。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  initProject, getProject, saveProject, writeArtifact, approveArtifact, getArtifacts,
  writeState, readState, addChapterContracts, setChapterState, listChapterStates,
  markDependentsStale, getGraph, dependencyImpact,
  addIssue, listIssues, getIssue, updateIssue, issuePath, recordGate, listGates, computeKPIs, projectSnapshot,
  normalizeChapterId, manuscriptPathFor, resolveManuscriptPath,
  readArtifact, artifactVersionPathFor, recoverArtifactWrites,
  resolveStaleNode,
  readJsonTolerant,
} from '../plugin/store.mjs'

function makeProject(t, brief = {}) {
  const root = mkdtempSync(join(tmpdir(), 'novel-store-'))
  const { projectDir } = initProject({ projectId: 'test-book', rootDir: root, brief: { title: '测试之书', genre: '都市', ...brief } })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, projectDir }
}

test('initProject 创建完整目录树与简报', (t) => {
  const { projectDir } = makeProject(t, { title: '长生街', hardConstraints: ['主角不能死'] })
  for (const rel of ['00_project_brief.md', 'state/story_state.json', 'state/dependency_graph.json', 'library/artifacts.json', 'plot/chapters/contracts.json', 'manuscript/chapters/']) {
    assert.ok(existsSync(join(projectDir, rel)), `缺少 ${rel}`)
  }
  const brief = readFileSync(join(projectDir, '00_project_brief.md'), 'utf8')
  assert.ok(brief.includes('长生街'))
  assert.ok(brief.includes('主角不能死'))
  const project = getProject(projectDir)
  assert.equal(project.workflow.state, 'INIT')
  const artifacts = getArtifacts(projectDir)
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].id, '00_project_brief')
  assert.equal(artifacts[0].status, 'ACTIVE')
})

test('初始化简报 Artifact 也保存不可变 v1 正文', (t) => {
  const { projectDir } = makeProject(t, { title: '不可变简报' })
  const [meta] = getArtifacts(projectDir)
  assert.ok(meta.versionPath)
  assert.ok(existsSync(join(projectDir, meta.versionPath)))

  writeFileSync(join(projectDir, meta.path), 'canonical 被外部改动', 'utf8')
  assert.match(readArtifact(projectDir, { id: '00_project_brief', version: 1 }).content, /不可变简报/)
})

test('章节编号与手稿路径统一，读取兼容旧标题文件', (t) => {
  const { projectDir } = makeProject(t)
  assert.equal(normalizeChapterId(1), '001')
  assert.equal(normalizeChapterId('001'), '001')
  assert.equal(normalizeChapterId(1000), '1000')
  assert.throws(() => normalizeChapterId('../1'), /章节号/)

  const canonical = join(projectDir, 'manuscript', 'chapters', '第001章.md')
  assert.equal(manuscriptPathFor(projectDir, 1, '标题不会进入文件名'), canonical)

  const legacy = join(projectDir, 'manuscript', 'chapters', '第001章_旧标题.md')
  writeFileSync(legacy, '旧手稿', 'utf8')
  assert.equal(resolveManuscriptPath(projectDir, '001'), legacy)

  writeFileSync(canonical, '新手稿', 'utf8')
  assert.equal(resolveManuscriptPath(projectDir, 1), canonical)
})

test('契约登记与状态机共用 canonical 章节编号', (t) => {
  const { projectDir } = makeProject(t)
  const added = addChapterContracts(projectDir, [
    { chapter: '0001', characters: [], chapter_goal: '开场', exit_state: 'X' },
  ])
  assert.deepEqual(added, ['001'])
  setChapterState(projectDir, '001', 'WRITING', '开始写')
  assert.equal(listChapterStates(projectDir)[0].chapter, '001')
})

test('project.json 从章节契约自愈状态、游标与返工计数', (t) => {
  const { projectDir } = makeProject(t)
  addChapterContracts(projectDir, [
    { chapter: 1, characters: [], chapter_goal: '开场', exit_state: 'X' },
    { chapter: 2, characters: [], chapter_goal: '推进', exit_state: 'Y' },
  ])
  setChapterState(projectDir, 1, 'WRITING', '开始写')
  setChapterState(projectDir, 1, 'REWORK', '中途返工')

  // 模拟 contracts.json 已提交、project.json 尚未来得及提交时进程退出。
  const projectPath = join(projectDir, 'library', 'project.json')
  const interrupted = JSON.parse(readFileSync(projectPath, 'utf8'))
  interrupted.chapterStatus = { '001': 'PLANNED', '999': 'ACCEPTED' }
  interrupted.cycle.chapterCursor = 999
  interrupted.counters.reworks = 0
  writeFileSync(projectPath, JSON.stringify(interrupted, null, 2) + '\n', 'utf8')

  const recovered = getProject(projectDir)
  assert.deepEqual(recovered.chapterStatus, { '001': 'REWORK', '002': 'PLANNED' })
  assert.equal(recovered.cycle.chapterCursor, 2)
  assert.equal(recovered.counters.reworks, 1)

  // getProject 是纯读取，显式保存或后续任意写操作才持久化派生修复。
  saveProject(projectDir, recovered)
  const persisted = JSON.parse(readFileSync(projectPath, 'utf8'))
  assert.deepEqual(persisted.chapterStatus, recovered.chapterStatus)
  assert.equal(persisted.cycle.chapterCursor, 2)
  assert.equal(persisted.counters.reworks, 1)
})

test('writeArtifact 版本递增 + 旧版本 SUPERSEDED + 下游 STALE', (t) => {
  const { projectDir } = makeProject(t)
  const a1 = writeArtifact(projectDir, { id: '02_world_bible', content: 'v1', owner: 'world-architect' })
  assert.equal(a1.version, 1)
  const a2 = writeArtifact(projectDir, { id: '02_world_bible', content: 'v2', owner: 'world-architect' })
  assert.equal(a2.version, 2)
  assert.equal(a2.supersedes.version, 1)
  const rows = getArtifacts(projectDir)
  assert.equal(rows.find(r => r.id === '02_world_bible' && r.version === 1).status, 'SUPERSEDED')
  // 依赖图：02_world_bible 的下游应被标 STALE（writeArtifact 已自动触发）
  const graph = getGraph(projectDir)
  assert.equal(graph.nodes.characters.status, 'STALE')
  assert.equal(graph.nodes.manuscript.status, 'STALE')
  assert.ok(graph.nodes.chapters.staleReason.includes('02_world_bible'))
  // 手动再触发一次：已 STALE 的节点不再重复上报
  const stale = markDependentsStale(projectDir, '02_world_bible', '测试更新')
  assert.equal(stale.length, 0)
  const refreshed = getGraph(projectDir)
  assert.deepEqual(
    refreshed.nodes.chapters.staleHistory.map(entry => entry.reason),
    ['上游资产 02_world_bible v1 已更新', '上游资产 02_world_bible v2 已更新', '测试更新'],
  )
})

test('Artifact 每个版本保存不可变正文并可按 version 读取', (t) => {
  const { projectDir } = makeProject(t)
  const v1 = writeArtifact(projectDir, { id: '02_world_bible', content: '世界观 v1' })
  const v2 = writeArtifact(projectDir, { id: '02_world_bible', content: '世界观 v2' })

  assert.notEqual(v1.versionPath, v2.versionPath)
  assert.equal(readFileSync(join(projectDir, v1.path), 'utf8'), '世界观 v2')
  assert.equal(readArtifact(projectDir, { id: '02_world_bible', version: 1 }).content, '世界观 v1')
  assert.equal(readArtifact(projectDir, { id: '02_world_bible', version: 2 }).content, '世界观 v2')

  writeFileSync(join(projectDir, v2.path), '外部修改 canonical', 'utf8')
  assert.equal(readArtifact(projectDir, { id: '02_world_bible' }).content, '世界观 v2')
})

test('Artifact 重试接管同内容孤儿版本，冲突时保留不可变正文', (t) => {
  const { projectDir } = makeProject(t)
  const id = '02_world_bible'
  const orphanPath = join(projectDir, artifactVersionPathFor(id, 1))
  mkdirSync(dirname(orphanPath), { recursive: true })
  writeFileSync(orphanPath, '中断后留下的正文', 'utf8')

  const recovered = writeArtifact(projectDir, { id, content: '中断后留下的正文' })
  assert.equal(recovered.version, 1)
  assert.equal(readArtifact(projectDir, id).content, '中断后留下的正文')
  assert.equal(getArtifacts(projectDir).filter(row => row.id === id).length, 1)

  const conflictingId = '03_system_rules'
  const conflictingPath = join(projectDir, artifactVersionPathFor(conflictingId, 1))
  mkdirSync(dirname(conflictingPath), { recursive: true })
  writeFileSync(conflictingPath, '必须保留的孤儿正文', 'utf8')
  assert.throws(
    () => writeArtifact(projectDir, { id: conflictingId, content: '不同的新正文' }),
    /孤儿版本正文内容冲突.*保留现场/,
  )
  assert.equal(readFileSync(conflictingPath, 'utf8'), '必须保留的孤儿正文')
  assert.equal(getArtifacts(projectDir).some(row => row.id === conflictingId), false)
})

test('Artifact 索引提交但依赖传播中断时，重试幂等收敛且不增版本', (t) => {
  const { projectDir } = makeProject(t)
  const row = writeArtifact(projectDir, { id: '02_world_bible', content: '世界观事务正文' })
  const artifactsPath = join(projectDir, 'library', 'artifacts.json')
  const artifactBook = JSON.parse(readFileSync(artifactsPath, 'utf8'))
  const persisted = artifactBook.artifacts.find(candidate => candidate.id === row.id && candidate.version === row.version)
  persisted.writeTransaction.dependencyStatus = 'PENDING'
  delete persisted.writeTransaction.appliedAt
  writeFileSync(artifactsPath, JSON.stringify(artifactBook, null, 2) + '\n', 'utf8')
  writeState(projectDir, 'dependency', { nodes: {}, edges: [] })

  const retried = writeArtifact(projectDir, { id: row.id, content: '世界观事务正文' })
  assert.equal(retried.version, 1)
  assert.equal(getArtifacts(projectDir).filter(candidate => candidate.id === row.id).length, 1)
  assert.equal(getArtifacts(projectDir).find(candidate => candidate.id === row.id).writeTransaction.dependencyStatus, 'APPLIED')
  assert.equal(getGraph(projectDir).nodes.manuscript.status, 'STALE')
})

test('Artifact 依赖传播恢复不会重复追加同一事务历史', (t) => {
  const { projectDir } = makeProject(t)
  const row = writeArtifact(projectDir, { id: '02_world_bible', content: '幂等正文' })
  const before = getGraph(projectDir).nodes.chapters.staleHistory.length
  const artifactsPath = join(projectDir, 'library', 'artifacts.json')
  const artifactBook = JSON.parse(readFileSync(artifactsPath, 'utf8'))
  const persisted = artifactBook.artifacts.find(candidate => candidate.id === row.id && candidate.version === row.version)
  persisted.writeTransaction.dependencyStatus = 'PENDING'
  delete persisted.writeTransaction.appliedAt
  writeFileSync(artifactsPath, JSON.stringify(artifactBook, null, 2) + '\n', 'utf8')

  recoverArtifactWrites(projectDir)

  assert.equal(getGraph(projectDir).nodes.chapters.staleHistory.length, before)
  assert.equal(getArtifacts(projectDir).find(candidate => candidate.id === row.id).writeTransaction.dependencyStatus, 'APPLIED')
})

test('Artifact id 不能通过路径片段写出受控目录', (t) => {
  const { root, projectDir } = makeProject(t)
  const outside = join(root, 'escape.md')
  assert.throws(
    () => writeArtifact(projectDir, { id: '../../../escape', content: '越界' }),
    /artifact id/i,
  )
  assert.equal(existsSync(outside), false)
  assert.throws(
    () => writeArtifact(projectDir, { id: 'character/../../escape', content: '越界' }),
    /artifact id/i,
  )
})

test('STALE 节点可处置并在后续上游变化时重新标记', (t) => {
  const { projectDir } = makeProject(t)
  markDependentsStale(projectDir, '02_world_bible', '世界观更新')

  const resolved = resolveStaleNode(projectDir, 'chapters', {
    disposition: 'PATCH',
    note: '章节契约已补丁复审',
    version: 3,
  })
  assert.equal(resolved.status, 'CURRENT')
  assert.equal(resolved.version, 3)
  assert.equal(resolved.staleReason, null)
  assert.equal(resolved.resolution.disposition, 'PATCH')
  assert.equal(resolved.staleHistory.length, 1)

  markDependentsStale(projectDir, '02_world_bible', '世界观再次更新')
  const graph = getGraph(projectDir)
  assert.equal(graph.nodes.chapters.status, 'STALE')
  assert.equal(graph.nodes.chapters.staleHistory.length, 2)
  assert.throws(
    () => resolveStaleNode(projectDir, 'chapters', { disposition: 'IGNORE' }),
    /处置方式/,
  )
})

test('处置旧格式 STALE 节点时迁移当前原因到历史', (t) => {
  const { projectDir } = makeProject(t)
  writeState(projectDir, 'dependency', {
    nodes: {
      chapters: {
        status: 'STALE',
        version: 1,
        staleReason: '旧格式上游变更',
        markedAt: '2026-01-01T00:00:00.000Z',
        markedBy: 'dependency-change',
      },
    },
    edges: [],
  })

  const resolved = resolveStaleNode(projectDir, 'chapters', { disposition: 'KEEP' })
  assert.deepEqual(resolved.staleHistory, [{
    at: '2026-01-01T00:00:00.000Z',
    reason: '旧格式上游变更',
    markedBy: 'dependency-change',
  }])
})

test('approveArtifact 生命周期 DRAFT→APPROVED→ACTIVE 与非法审批', (t) => {
  const { projectDir } = makeProject(t)
  writeArtifact(projectDir, { id: '04_master_plot', content: '大纲', owner: 'plot-architect' })
  let row = approveArtifact(projectDir, { id: '04_master_plot', version: 1, approvedBy: 'planner' })
  assert.equal(row.status, 'APPROVED')
  row = approveArtifact(projectDir, { id: '04_master_plot', version: 1, approvedBy: 'planner', activate: true })
  assert.equal(row.status, 'ACTIVE')
  // SUPERSEDED 版本不能再审批
  writeArtifact(projectDir, { id: '04_master_plot', content: '大纲v2' })
  assert.throws(() => approveArtifact(projectDir, { id: '04_master_plot', version: 1, approvedBy: 'x' }))
})

test('章节契约登记校验人物 id + 章节状态机迁移', (t) => {
  const { projectDir } = makeProject(t)
  writeState(projectDir, 'character', {
    characters: {
      lin: { name: '林一', state: 'initial', current: {}, relations: {}, arcs: {} },
    },
  })
  // 未知人物必须被拒绝
  assert.throws(() => addChapterContracts(projectDir, [{ chapter: 1, characters: ['ghost'] }]))
  const added = addChapterContracts(projectDir, [
    { chapter: 1, characters: ['lin'], pov: 'lin', location: '茶馆', chapter_goal: '开场', exit_state: 'X' },
    { chapter: 2, characters: [], pov: 'lin', location: '街道', chapter_goal: '推进', exit_state: 'Y' },
  ])
  assert.deepEqual(added, ['001', '002'])
  // 状态机
  setChapterState(projectDir, 1, 'WRITING', '开始写')
  setChapterState(projectDir, 1, 'QA', '写完')
  setChapterState(projectDir, 1, 'READER_TEST', '审查过')
  setChapterState(projectDir, 1, 'ACCEPTED', '读者过')
  // 非法迁移：ACCEPTED → PLANNED
  assert.throws(() => setChapterState(projectDir, 1, 'PLANNED'))
  // 接受返工：ACCEPTED → DIAGNOSIS → REWORK → PLANNED
  setChapterState(projectDir, 1, 'DIAGNOSIS', '发现问题')
  setChapterState(projectDir, 1, 'REWORK', '返工')
  setChapterState(projectDir, 1, 'PLANNED', '重写')
  const states = listChapterStates(projectDir)
  assert.equal(states[0].status, 'PLANNED')
})

test('状态存储校验', (t) => {
  const { projectDir } = makeProject(t)
  // 人物缺 name
  assert.throws(() => writeState(projectDir, 'character', { characters: { a: {} } }))
  // 伏笔状态非法
  assert.throws(() => writeState(projectDir, 'foreshadowing', { items: [{ id: 'F1', status: 'weird' }] }))
  // 合法写入
  writeState(projectDir, 'story', {
    current: { chapter: 3, location: '城', time: '夜', summary: 's' },
    worldState: {}, openThreads: [], notes: [],
  })
  const st = readState(projectDir, 'story')
  assert.equal(st.current.chapter, 3)
})

test('状态 JSON 损坏时显式报错而不是静默回退', (t) => {
  const { projectDir } = makeProject(t)
  const file = join(projectDir, 'state', 'story_state.json')
  writeFileSync(file, '{ broken json', 'utf8')
  assert.throws(() => readState(projectDir, 'story'), /JSON.*损坏|损坏.*JSON/)
  assert.deepEqual(readJsonTolerant(file, { recovered: true }), { recovered: true })
})

test('Issue 编号与 Gate 记录', (t) => {
  const { projectDir } = makeProject(t)
  const i1 = addIssue(projectDir, { dimension: 'canon', severity: 'high', evidence: 'e1' })
  const i2 = addIssue(projectDir, { dimension: 'prose', severity: 'low', evidence: 'e2' })
  assert.equal(i1.issue_id, 'ISSUE-0001')
  assert.equal(i2.issue_id, 'ISSUE-0002')
  assert.equal(listIssues(projectDir).length, 2)
  recordGate(projectDir, { gate: 'chapter', target: '1', pass: true, score: 88 })
  recordGate(projectDir, { gate: 'reader', target: '1', pass: false, score: 55 })
  const gates = listGates(projectDir)
  assert.equal(gates.length, 2)
  assert.equal(gates[0].protocolVersion, 'fail-closed-v2')
  assert.equal(gates[0].evidenceComplete, false)
})

test('Issue 读写入口严格拒绝路径、扩展名与非标准编号', (t) => {
  const { projectDir } = makeProject(t)
  const projectPath = join(projectDir, 'library', 'project.json')
  const before = readFileSync(projectPath, 'utf8')
  for (const invalid of ['../../library/project', 'ISSUE-1.json', 'ISSUE-1/extra', 'issue-1', 'ISSUE-']) {
    assert.throws(() => issuePath(projectDir, invalid), /Issue 编号非法/)
    assert.throws(() => getIssue(projectDir, invalid), /Issue 编号非法/)
    assert.throws(() => updateIssue(projectDir, invalid, { status: 'resolved' }), /Issue 编号非法/)
  }
  assert.equal(readFileSync(projectPath, 'utf8'), before)

  const issue = addIssue(projectDir, { issue_id: 'ISSUE-7', evidence: '合法编号' })
  assert.equal(getIssue(projectDir, issue.issue_id).evidence, '合法编号')
  assert.equal(updateIssue(projectDir, issue.issue_id, { status: 'resolved' }).status, 'resolved')
})

test('Issue/Gate 从落盘记录恢复编号并修正 project counters', (t) => {
  const { projectDir } = makeProject(t)
  const projectPath = join(projectDir, 'library', 'project.json')

  // 模拟记录已提交但 project.json 尚未提交；虚高 counter 也应由事实记录纠正。
  writeFileSync(join(projectDir, 'issues', 'ISSUE-0007.json'), JSON.stringify({
    issue_id: 'ISSUE-0007', status: 'open', evidence: '已落盘问题',
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(projectDir, 'library', 'gates.json'), JSON.stringify({
    gates: [{ seq: 4, gate: 'plot', target: 'existing', pass: true }],
  }, null, 2) + '\n', 'utf8')
  const interrupted = JSON.parse(readFileSync(projectPath, 'utf8'))
  interrupted.counters.issues = 42
  interrupted.counters.gates = 99
  writeFileSync(projectPath, JSON.stringify(interrupted, null, 2) + '\n', 'utf8')

  const issue = addIssue(projectDir, { dimension: 'plot', severity: 'high', evidence: '新问题' })
  const gate = recordGate(projectDir, { gate: 'plot', target: 'new', pass: false, score: 60 })
  assert.equal(issue.issue_id, 'ISSUE-0008')
  assert.equal(gate.seq, 5)
  assert.equal(JSON.parse(readFileSync(join(projectDir, 'issues', 'ISSUE-0007.json'), 'utf8')).evidence, '已落盘问题')
  assert.throws(
    () => addIssue(projectDir, { issue_id: 'ISSUE-0007', evidence: '不得覆盖' }),
    /已存在/,
  )

  const recovered = getProject(projectDir)
  assert.equal(recovered.counters.issues, 8)
  assert.equal(recovered.counters.gates, 5)
  assert.deepEqual(listGates(projectDir).map(row => row.seq), [4, 5])
})

test('Gate 记录显式保存当前协议的证据完整性', (t) => {
  const { projectDir } = makeProject(t)
  recordGate(projectDir, {
    gate: 'plot', target: 'chapters 1-2', pass: true, score: 88,
    verdict: 'PASS', evidenceComplete: true,
  })

  const [gate] = listGates(projectDir)
  assert.equal(gate.protocolVersion, 'fail-closed-v2')
  assert.equal(gate.evidenceComplete, true)
})

test('listIssues 忽略同目录的诊断文件', (t) => {
  const { projectDir } = makeProject(t)
  addIssue(projectDir, { dimension: 'canon', severity: 'high', evidence: '真实问题' })
  writeFileSync(join(projectDir, 'issues', 'diagnosis-DG-test.json'), JSON.stringify({
    id: 'DG-test',
    issueIds: ['ISSUE-0001'],
    rollback_to: 'writer',
  }), 'utf8')

  assert.deepEqual(listIssues(projectDir).map(row => row.issue_id), ['ISSUE-0001'])
})

test('KPI 统计', (t) => {
  const { projectDir } = makeProject(t)
  writeState(projectDir, 'character', {
    characters: { lin: { name: '林一', state: 'initial', current: {}, relations: {}, arcs: {} } },
  })
  addChapterContracts(projectDir, [
    { chapter: 1, characters: ['lin'], chapter_goal: 'g1', exit_state: 'x' },
    { chapter: 2, characters: ['lin'], chapter_goal: 'g2', exit_state: 'y' },
  ])
  for (const i of [1, 2]) {
    setChapterState(projectDir, i, 'WRITING', 'w')
    setChapterState(projectDir, i, 'QA', 'q')
    setChapterState(projectDir, i, 'READER_TEST', 'r')
    setChapterState(projectDir, i, 'ACCEPTED', '直接过')
  }
  setChapterState(projectDir, 2, 'DIAGNOSIS', 'bad'); setChapterState(projectDir, 2, 'REWORK', '')
  setChapterState(projectDir, 2, 'WRITING', 'w'); setChapterState(projectDir, 2, 'QA', 'q')
  setChapterState(projectDir, 2, 'READER_TEST', 'r')
  setChapterState(projectDir, 2, 'ACCEPTED', '返工过')
  const kpi = computeKPIs(projectDir)
  assert.equal(kpi.work.chaptersAccepted, 2)
  assert.equal(kpi.work.oncePassRate, 0.5) // 1/2 一次通过
  assert.equal(kpi.work.avgReworksPerChapter, 0.5)
})

test('projectSnapshot 完整性', (t) => {
  const { projectDir } = makeProject(t)
  const snap = projectSnapshot(projectDir)
  assert.ok(snap.workflow)
  assert.ok(snap.artifacts.length >= 1)
  assert.ok(snap.kpi.work)
})
