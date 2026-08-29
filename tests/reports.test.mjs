/**
 * Planner 周期报告测试：只读汇总、未关闭问题和批次建议。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addChapterContracts, addIssue, initProject, setChapterState, updateIssue, writeJsonAtomic,
} from '../plugin/store.mjs'
import { defaultProfile, saveProfile } from '../plugin/hr.mjs'
import { buildCycleReport, computeSystemKPIs } from '../plugin/reports.mjs'

function makeProject(t, brief = {}) {
  const root = mkdtempSync(join(tmpdir(), 'novel-reports-'))
  const { projectDir } = initProject({
    projectId: 'report-book',
    rootDir: root,
    brief: { chaptersPerBatch: 2, chaptersPerVolume: 4, volumeCount: 1, ...brief },
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return projectDir
}

test('buildCycleReport 只汇总未关闭 Issue', (t) => {
  const projectDir = makeProject(t)
  const openIssue = addIssue(projectDir, {
    dimension: 'canon', severity: 'high', evidence: '仍需修复的设定冲突', status: 'open',
  })
  const closedIssue = addIssue(projectDir, {
    dimension: 'continuity', severity: 'blocking', evidence: '已经修复的人物漂移', status: 'open',
  })
  updateIssue(projectDir, closedIssue.issue_id, { status: 'CLOSED' })

  const report = buildCycleReport(projectDir)

  assert.match(report, new RegExp(`\\[${openIssue.issue_id}\\]`))
  assert.doesNotMatch(report, new RegExp(`\\[${closedIssue.issue_id}\\]`))
  assert.match(report, /未关闭 Issue：1/)
  assert.doesNotMatch(report, /已经修复的人物漂移/)
})

test('buildCycleReport 在当前批未完成时不建议下一批', (t) => {
  const projectDir = makeProject(t)
  addChapterContracts(projectDir, [
    { chapter: 1, characters: [], chapter_goal: '开场', exit_state: 'A' },
    { chapter: 2, characters: [], chapter_goal: '推进', exit_state: 'B' },
  ])

  const report = buildCycleReport(projectDir)

  assert.match(report, /当前批次尚未完成/)
  assert.doesNotMatch(report, /第 3-4 章/)
})

test('buildCycleReport 读取 Reader Lab 实际落盘的 summary 本体', (t) => {
  const projectDir = makeProject(t)
  writeJsonAtomic(join(projectDir, 'reader_lab', 'reports', 'reader-2026-01-01-1.json'), {
    label: 'Reader Lab 第1-2章',
    pass: true,
    score: 86.5,
    metrics: { completion: 91, next_chapter: 82 },
  })

  const report = buildCycleReport(projectDir)

  assert.match(report, /Reader Lab 第1-2章 — PASS（综合 86\.5）/)
})

test('computeSystemKPIs 的 Issue 指标只计未关闭问题', (t) => {
  const projectDir = makeProject(t)
  addIssue(projectDir, { dimension: 'canon', severity: 'blocking', evidence: '未解决', status: 'open' })
  const closed = addIssue(projectDir, {
    dimension: 'continuity', severity: 'high', evidence: '已解决', status: 'open',
  })
  updateIssue(projectDir, closed.issue_id, { status: 'resolved' })

  const [kpi] = computeSystemKPIs([projectDir]).projects

  assert.equal(kpi.issues, 1)
  assert.equal(kpi.canonConflicts, 1)
  assert.equal(kpi.characterDrift, 0)
})

test('buildCycleReport 展示已晋升的结构化 Agent 改进', (t) => {
  const projectDir = makeProject(t)
  const profile = defaultProfile('writer', { version: '2.1' })
  profile.acceptedCases = 1
  profile.promotedImprovements = [{
    kind: 'prompt',
    title: '开场钩子约束',
    content: '开场段必须包含一个未解问题。',
    candidateId: 'writer-c1',
    promotedAt: '2026-01-01T00:00:00.000Z',
  }]
  saveProfile(projectDir, profile)

  const report = buildCycleReport(projectDir)

  assert.match(report, /已晋升改进: prompt·开场钩子约束/)
})

test('buildCycleReport 是纯读操作，不推进 cycle 或创建报告文件', (t) => {
  const projectDir = makeProject(t)
  const projectFile = join(projectDir, 'library', 'project.json')
  const before = readFileSync(projectFile, 'utf8')

  buildCycleReport(projectDir)

  assert.equal(readFileSync(projectFile, 'utf8'), before)
  assert.equal(JSON.parse(before).cycle.current, 1)
  assert.equal(existsSync(join(projectDir, 'reports', 'cycle-01.md')), false)
})

test('buildCycleReport 仅在当前批全部 ACCEPTED 后建议下一批', (t) => {
  const projectDir = makeProject(t)
  addChapterContracts(projectDir, [
    { chapter: 1, characters: [], chapter_goal: '开场', exit_state: 'A' },
    { chapter: 2, characters: [], chapter_goal: '推进', exit_state: 'B' },
  ])
  for (const chapter of [1, 2]) {
    setChapterState(projectDir, chapter, 'WRITING', '开始写作')
    setChapterState(projectDir, chapter, 'QA', '写作完成')
    setChapterState(projectDir, chapter, 'READER_TEST', '审查通过')
    setChapterState(projectDir, chapter, 'ACCEPTED', 'Reader Gate 通过')
  }

  const report = buildCycleReport(projectDir)

  assert.match(report, /## 下一轮\n- 第 3-4 章/)
  assert.doesNotMatch(report, /当前批次尚未完成/)
})
