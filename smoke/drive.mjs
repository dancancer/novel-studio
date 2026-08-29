/**
 * novel-studio 无头冒烟：
 * 在 harness 仓库目录下运行（bare 模块解析依赖其 node_modules）：
 *   cd /Users/xupeng/mycode/deepseek-harness && node /Users/xupeng/mybase/novel-studio/smoke/drive.mjs
 *
 * 覆盖：工具注册（24 个）、novel_init → artifact 写/审批 → state 读写 →
 * gate → 诊断文件 → rework → report → projects 扫描。
 * 不调用 LLM（subagents 服务不存在，阶段工具会明确报错——符合预期）。
 */

import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const smokeDir = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'novel-smoke-'))

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@deepseek-ai/cordis-plugin-include',
  config: { path: join(smokeDir, 'smoke-cordis.yml') },
})

// 等插件激活
await new Promise(r => setTimeout(r, 800))

let pass = 0
let fail = 0
const results = []
async function call(name, args) {
  const result = await ctx.tools.execute({ callId: CallId('smoke-' + name), name, arguments: args, signal: new AbortController().signal })
  return result
}
async function check(name, args, pred, desc) {
  try {
    const result = await call(name, args)
    const value = result.value
    const ok = pred(value)
    if (ok) pass++
    else fail++
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${desc}\n      → ${JSON.stringify(value).slice(0, 220)}`)
  } catch (err) {
    fail++
    results.push(`FAIL  ${name} ${desc}\n      → 抛出: ${String(err?.message || err).slice(0, 220)}`)
  }
}

// 1) 工具注册
const schemas = ctx.get('tools')?.schemas?.() || []
const novelTools = schemas.map(s => s.name).filter(n => n.startsWith('novel_'))
console.log(`已注册 novel_* 工具 ${novelTools.length} 个：${novelTools.join(', ')}`)
if (novelTools.length < 20) {
  console.log('FAIL  工具注册数量不足')
  process.exit(1)
}

const projectId = 'smoke-book'
let projectDir = join(root, projectId)

await check('novel_init', {
  rootDir: root, projectId, title: '冒烟测试之书', genre: '都市异能',
  hardConstraints: ['主角不能死'], targetWords: 300000,
}, v => v.projectDir === projectDir && v.state === 'INIT', '创建项目')

await check('novel_artifact_write', {
  projectDir, artifactId: '02_world_bible', title: '世界观圣经', owner: 'world-architect',
  content: '# 世界观\n\n## Canon Rules\n1. 灵术消耗生命。',
}, v => v.id === '02_world_bible' && v.version === 1 && v.status === 'DRAFT', '写 artifact v1')

await check('novel_artifact_write', {
  projectDir, artifactId: '02_world_bible', content: '# 世界观 v2\n\n## Canon Rules\n1. 灵术消耗生命。\n2. 时间不可倒流。',
}, v => v.version === 2 && v.supersedes?.version === 1, '写 artifact v2（旧版 SUPERSEDED）')

await check('novel_artifact_approve', {
  projectDir, artifactId: '02_world_bible', version: 2, approvedBy: 'planner', activate: true,
}, v => v.status === 'ACTIVE', '审批 activate 02_world_bible')

await check('novel_artifact_list', { projectDir }, v => v.filter(a => a.id === '02_world_bible').length === 2, 'artifact 列表（含 SUPERSEDED 旧版）')

await check('novel_artifact_read', { projectDir, artifactId: '02_world_bible' }, v => String(v.content).includes('时间不可倒流'), '读取 artifact 正文')

await check('novel_state_write', {
  projectDir, kind: 'character', reason: '冒烟',
  data: { characters: { lin: { name: '林一', state: 'initial', current: {}, relations: {}, arcs: {} } } },
}, v => v.kind === 'character', '写人物状态')

await check('novel_state_write', {
  projectDir, kind: 'foreshadowing',
  data: { items: [{ id: 'F0001', summary: '护身符来历', plantedAt: 1, dueBy: 12, status: 'open' }], nextId: 2 },
}, v => v.kind === 'foreshadowing', '写伏笔状态')

await check('novel_state_read', { projectDir, kind: 'foreshadowing' }, v => v.items.length === 1, '读伏笔状态')

await check('novel_gate_run', {
  projectDir, gate: 'planning',
  issues: [
    { issue_id: 'S1', dimension: 'world', score: 90 },
    { issue_id: 'S2', dimension: 'plot', score: 88 },
    { issue_id: 'S3', dimension: 'character', score: 80 },
    { issue_id: 'S4', dimension: 'numbers', score: 86 },
    { issue_id: 'S5', dimension: 'research', score: 85 },
    { issue_id: 'S6', dimension: 'planner', score: 90 },
    { issue_id: 'S7', dimension: 'other', score: 82 },
  ],
}, v => v.pass === true && v.score >= 70, 'planning gate 通过')

await check('novel_gate_run', {
  projectDir, gate: 'planning',
  issues: [{ issue_id: 'S8', dimension: 'world', severity: 'blocking', evidence: '灵术规则自相矛盾' }],
}, v => v.pass === false && v.decision === 'VETOED', 'planning gate 一票否决')

// 诊断文件（由 novel_diagnose 的 LLM 产出；这里直接构造以测 rework 链路）
const { writeFileSync } = await import('node:fs')
writeFileSync(join(projectDir, 'issues', 'diagnosis-DG-smoke1.json'), JSON.stringify({
  id: 'DG-smoke1', issueIds: ['ISSUE-0001'], rootCauses: { 'world-architect': 0.8, planner: 0.2 },
  rollback_to: 'world_bible', impactRange: [1, 5], note: '冒烟返工', at: new Date().toISOString(),
}, null, 2))

await check('novel_rework_execute', { projectDir, diagnosisId: 'DG-smoke1' },
  v => Array.isArray(v.resetChapters) && v.resetChapters.length === 0 && Array.isArray(v.staleNodes), 'rework（无章节时上游返工安全执行）')

await check('novel_report', { projectDir, cycle: 1 },
  v => String(v.report).includes('Cycle 1') && String(v.report).includes('Chapter 1-10'), '周期汇报生成')

await check('novel_status', { projectDir }, v => v.project.projectId === projectId, '项目全景状态')

await check('novel_projects', { rootDir: root }, v => v.length === 1 && v[0].projectId === projectId, '项目扫描')

// 阶段工具在无 subagents 时应明确报错（而不是静默）
try {
  const res = await call('novel_phase_research', { projectDir })
  if (res.isError) {
    results.push(`PASS  novel_phase_research 无 subagents 时明确报错（${String(res.content?.[0]?.text || '').slice(0, 80)}）`)
    pass++
  } else {
    results.push(`FAIL  novel_phase_research 应在无 subagents 时报错（却成功了?）`)
    fail++
  }
} catch (err) {
  results.push(`PASS  novel_phase_research 无 subagents 时明确报错（${String(err?.message || err).slice(0, 80)}）`)
  pass++
}

console.log('\n===== 冒烟结果 =====')
console.log(results.join('\n'))
console.log(`\n${pass} 通过 / ${fail} 失败`)
rmSync(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
