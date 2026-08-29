/**
 * 诊断/返工路由测试（设计 §13/§14）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initProject, writeState, addChapterContracts, getProject, loadContracts, saveProject, setChapterState } from '../plugin/store.mjs'
import { routeByPattern, applyDiagnosis, renderRootCauses } from '../plugin/diagnosis.mjs'

function makeProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'novel-diag-'))
  const { projectDir } = initProject({ projectId: 'diag-book', rootDir: root })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeState(projectDir, 'character', { characters: { lin: { name: '林一', state: 'initial', current: {}, relations: {}, arcs: {} } } })
  addChapterContracts(projectDir, Array.from({ length: 10 }, (_, i) => ({ chapter: i + 1, characters: ['lin'], chapter_goal: `g${i}`, exit_state: 'x' })))
  return projectDir
}

test('routeByPattern：问题模式 → 返工层', () => {
  assert.equal(routeByPattern({ evidence: '主角战力突然碾压全场，与数值表不符' }).layer, 'system_rules')
  assert.equal(routeByPattern({ evidence: '这段对话很生硬，人物语气不像本人' }).layer, 'writer')
  assert.equal(routeByPattern({ dimension: 'canon', evidence: '世界规则冲突' }).layer, 'world_bible')
  assert.equal(routeByPattern({ evidence: '高潮不够爽，铺垫没有兑现' }).layer, 'plot_payoff')
  assert.equal(routeByPattern({ evidence: '完全不知道在写什么' }), null)
})

test('applyDiagnosis：章节状态重置 + 下游 STALE + 工作流转 REWORK', (t) => {
  const projectDir = makeProject(t)
  // 1-5 章走完生产链进到 ACCEPTED，6-8 在 QA
  for (let i = 1; i <= 5; i++) {
    setChapterState(projectDir, i, 'WRITING', 'w')
    setChapterState(projectDir, i, 'QA', 'q')
    setChapterState(projectDir, i, 'READER_TEST', 'r')
    setChapterState(projectDir, i, 'ACCEPTED', 'pass')
  }
  for (let i = 6; i <= 8; i++) {
    setChapterState(projectDir, i, 'WRITING', 'w')
    setChapterState(projectDir, i, 'QA', 'qa')
  }
  const result = applyDiagnosis(projectDir, {
    issueIds: ['ISSUE-0001'],
    rootCauses: { writer: 0.8, 'plot-architect': 0.2 },
    rollback_to: 'writer',
    impact_range: [4, 8],
    note: '文笔问题，重写 4-8',
  })
  assert.ok(result.resetChapters.length > 0, '应重置受影响章节')
  const book = loadContracts(projectDir)
  assert.equal(book.chapters['004'].status, 'DIAGNOSIS')
  assert.equal(book.chapters['006'].status, 'REWORK')
  // 依赖图 STALE
  assert.ok(result.staleNodes.length > 0)
  const project = getProject(projectDir)
  assert.equal(project.workflow.state, 'REWORK')
  assert.equal(project.chapterStatus['004'], 'DIAGNOSIS')
  assert.equal(project.chapterStatus['006'], 'REWORK')
})

test('applyDiagnosis：全书级返工影响范围大', (t) => {
  const projectDir = makeProject(t)
  const result = applyDiagnosis(projectDir, {
    rollback_to: 'world_bible',
    impact_range: [1, 10],
    note: '世界观冲突',
  })
  assert.ok(result.impactNodes.includes('chapters'))
  assert.ok(result.impactNodes.includes('manuscript'))
})

test('applyDiagnosis：上游返工重置影响范围内所有阶段且不波及范围外章节', (t) => {
  const projectDir = makeProject(t)
  for (const chapter of [1, 2]) {
    setChapterState(projectDir, chapter, 'WRITING', 'w')
    setChapterState(projectDir, chapter, 'QA', 'q')
    setChapterState(projectDir, chapter, 'READER_TEST', 'r')
    setChapterState(projectDir, chapter, 'ACCEPTED', 'pass')
  }
  setChapterState(projectDir, 3, 'WRITING', 'w')
  setChapterState(projectDir, 3, 'QA', 'q')

  const result = applyDiagnosis(projectDir, {
    rollback_to: 'world_bible',
    impact_range: { start: 2, end: 4 },
    note: '规则变化需重做 2-4 章',
  })

  assert.deepEqual(result.resetChapters, ['002', '003', '004'])
  const book = loadContracts(projectDir)
  assert.equal(book.chapters['001'].status, 'ACCEPTED')
  assert.equal(book.chapters['002'].status, 'DIAGNOSIS')
  assert.equal(book.chapters['003'].status, 'REWORK')
  assert.equal(book.chapters['004'].status, 'REWORK')
  assert.equal(book.chapters['005'].status, 'PLANNED')

  const project = getProject(projectDir)
  assert.equal(project.chapterStatus['002'], 'DIAGNOSIS')
  assert.equal(project.chapterStatus['003'], 'REWORK')
  assert.equal(project.chapterStatus['004'], 'REWORK')
})

test('applyDiagnosis：修复既有 contracts 与 project.chapterStatus 漂移', (t) => {
  const projectDir = makeProject(t)
  setChapterState(projectDir, 1, 'REWORK', '已在返工')
  const drifted = getProject(projectDir)
  drifted.chapterStatus['001'] = 'PLANNED'
  saveProject(projectDir, drifted)

  const result = applyDiagnosis(projectDir, {
    rollback_to: 'writer',
    impact_range: [1, 1],
    note: '继续返工',
  })

  assert.deepEqual(result.resetChapters, [])
  assert.equal(loadContracts(projectDir).chapters['001'].status, 'REWORK')
  assert.equal(getProject(projectDir).chapterStatus['001'], 'REWORK')
})

test('renderRootCauses 排序输出', () => {
  const text = renderRootCauses({ writer: 0.2, 'plot-architect': 0.5, 'hook-designer': 0.3 })
  const lines = text.trim().split('\n')
  assert.ok(lines[0].includes('plot-architect: 50%'))
})
