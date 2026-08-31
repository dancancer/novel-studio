import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  getArtifacts, getProject, listChapterStates, listGates, listIssues, loadStoryState,
  normalizeChapterId, nowIso, readArtifact, readJsonOr, resolveManuscriptPath, updateIssue,
} from './store.mjs'
import { loadProfile, defaultProfile } from './hr.mjs'
import { spawnRoleAgent, spawnParallel } from './agents.mjs'

export function gitCommit(projectDir, message) {
  try {
    if (!existsSync(join(projectDir, '.git'))) return
    execFileSync('git', ['-C', projectDir, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', projectDir, 'commit', '-m', String(message).slice(0, 120)], { stdio: 'ignore' })
  } catch { /* git 不可用/无仓库/无变更时静默 */ }
}

export function readText(p) {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}

export function requireProject(projectDir) {
  if (!projectDir) throw new Error('novel-studio: 缺少 projectDir（绝对路径）')
  if (!existsSync(join(projectDir, 'library', 'project.json'))) {
    throw new Error(`novel-studio: 不是有效项目目录: ${projectDir}（先运行 novel_init）`)
  }
  return projectDir
}

export function renderToolText(blocks) {
  return [{ type: 'text', text: blocks.join('\n') }]
}

function roleSpec(projectDir, spec) {
  return { ...spec, profile: spec.profile || loadProfile(projectDir, spec.role) || defaultProfile(spec.role) }
}

export function spawnProjectRole(ctx, exec, projectDir, spec) {
  return spawnRoleAgent(ctx, exec, roleSpec(projectDir, spec))
}

export async function attemptProjectRole(ctx, exec, projectDir, spec) {
  try {
    return await spawnProjectRole(ctx, exec, projectDir, spec)
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

export function spawnProjectParallel(limit, ctx, exec, projectDir, jobs) {
  return spawnParallel(limit, ctx, exec, jobs.map(job => roleSpec(projectDir, job)))
}

export function resolveRevalidatedChapterIssues(projectDir, chapter, note, { includeReaderLab = false } = {}) {
  const chapterId = normalizeChapterId(chapter)
  for (const issue of listIssues(projectDir)) {
    if (normalizeIssueChapter(issue.chapter) !== chapterId) continue
    if (!includeReaderLab && issue.source === 'reader-lab') continue
    const status = String(issue.status || 'open').toLowerCase()
    const stageOwnedOpen = status === 'open' && (
      (includeReaderLab && issue.source === 'reader-lab')
      || (!includeReaderLab && ['review-pool', 'writer-runtime'].includes(issue.source))
    )
    if (!stageOwnedOpen && !['diagnosed', 'in_rework'].includes(status)) continue
    updateIssue(projectDir, issue.issue_id, { status: 'resolved', resolution: note, resolved_at: nowIso() })
  }
}

export function normalizeIssueChapter(chapter) {
  if (chapter === undefined || chapter === null || String(chapter).includes(',')) return null
  try { return normalizeChapterId(chapter) } catch { return null }
}

function issueChapterSpans(chapter) {
  if (chapter === undefined || chapter === null) return []
  const spans = []
  for (const token of String(chapter).split(',').map(value => value.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*[-–—]\s*(\d+)$/)
    const start = Number(range ? range[1] : token)
    const end = Number(range ? range[2] : token)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return []
    spans.push([start, end])
  }
  return spans
}

export function issueChapterOverlaps(chapter, chapterIds) {
  const numbers = [...chapterIds].map(Number).filter(Number.isSafeInteger)
  return issueChapterSpans(chapter).some(([start, end]) => numbers.some(number => number >= start && number <= end))
}

export function impactRangeFromIssues(issues) {
  const spans = issues.flatMap(issue => issueChapterSpans(issue.chapter))
  return spans.length
    ? [Math.min(...spans.map(([start]) => start)), Math.max(...spans.map(([, end]) => end))]
    : null
}

const LEAF_REWORK_LAYERS = new Set(['chapter_contract', 'writer', 'plot_payoff', 'reader_diagnosis'])

function normalizeImpactRange(range) {
  const start = Number(Array.isArray(range) ? range[0] : range?.start)
  const end = Number(Array.isArray(range) ? range[1] : range?.end)
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start
    ? [start, end]
    : null
}

function intersectImpactRanges(left, right) {
  const a = normalizeImpactRange(left)
  const b = normalizeImpactRange(right)
  if (!a || !b) return null
  const overlap = [Math.max(a[0], b[0]), Math.min(a[1], b[1])]
  return overlap[0] <= overlap[1] ? overlap : null
}

function plannedProjectRange(projectDir) {
  const brief = getProject(projectDir).brief || {}
  const volumeCount = Math.max(1, Number(brief.volumeCount) || 1)
  const chaptersPerVolume = Math.max(1, Number(brief.chaptersPerVolume) || 40)
  return [1, volumeCount * chaptersPerVolume]
}

function constrainImpactRangeToExistingChapters(projectDir, range, label = '诊断', { allowPlannedRange = false } = {}) {
  const normalized = normalizeImpactRange(range)
  if (!normalized) throw new Error(`novel-studio: ${label}缺少有效的章节影响范围`)
  const [start, end] = normalized
  const existing = listChapterStates(projectDir)
    .map(row => Number(row.chapter))
    .filter(Number.isSafeInteger)
    .sort((a, b) => a - b)
  if (!existing.length && allowPlannedRange) {
    const planned = intersectImpactRanges(normalized, plannedProjectRange(projectDir))
    if (planned) return planned
  }
  const impacted = existing.filter(chapter => chapter >= start && chapter <= end)
  if (!impacted.length) {
    throw new Error(`novel-studio: ${label}影响范围第 ${start}-${end} 章与现有章节无交集，拒绝执行返工`)
  }
  return [impacted[0], impacted[impacted.length - 1]]
}

export function resolveDiagnosisImpactRange(projectDir, { rollback, proposedRange, issueRange, label = '诊断' }) {
  const leaf = LEAF_REWORK_LAYERS.has(rollback)
  const proposed = normalizeImpactRange(proposedRange)
  const evidence = normalizeImpactRange(issueRange)
  let requested
  if (leaf && evidence) {
    // 叶子层只能在所选 Issue 的证据范围内缩小，不允许模型无依据扩大正文返工。
    requested = proposed ? (intersectImpactRanges(proposed, evidence) || evidence) : evidence
  } else {
    requested = proposed || evidence || plannedProjectRange(projectDir)
  }
  return constrainImpactRangeToExistingChapters(projectDir, requested, label, { allowPlannedRange: !leaf })
}

export function readMarkdownDirectory(dir, maxChars = 12000) {
  const parts = []
  let used = 0
  for (const file of readdirNames(dir).filter(name => name.endsWith('.md')).sort()) {
    const text = readText(join(dir, file))
    if (!text) continue
    const remaining = maxChars - used
    if (remaining <= 0) break
    const chunk = text.slice(0, remaining)
    parts.push(`<!-- ${file} -->\n${chunk}`)
    used += chunk.length
  }
  return parts.join('\n\n')
}

export function extractMarkdownSection(content, query) {
  if (!query) return content
  const lines = String(content).split('\n')
  const needle = String(query).trim().toLowerCase()
  const start = lines.findIndex(line => /^#{1,6}\s+/.test(line) && line.toLowerCase().includes(needle))
  if (start < 0) return ''
  const level = lines[start].match(/^#+/)[0].length
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    const heading = lines[index].match(/^(#{1,6})\s+/)
    if (heading && heading[1].length <= level) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

export function isHttpUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function staleNodeIds(projectDir) {
  const graph = readJsonOr(join(projectDir, 'state', 'dependency_graph.json'), { nodes: {} })
  return Object.entries(graph.nodes || {})
    .filter(([, node]) => node?.status === 'STALE')
    .map(([id]) => id)
}

function latestArtifactRecord(projectDir, id) {
  return getArtifacts(projectDir)
    .filter(artifact => artifact.id === id)
    .sort((a, b) => Number(b.version) - Number(a.version))[0]
}

function latestEvidenceCompleteGate(projectDir, gateType) {
  const latest = listGates(projectDir).filter(row => row.gate === gateType).slice(-1)[0]
  return latest?.protocolVersion === 'fail-closed-v2' && latest.evidenceComplete === true ? latest : null
}

export function assertWriterProductionReady(projectDir, workflowState) {
  if (!['WRITING', 'REWORK'].includes(workflowState)) {
    throw new Error(`novel-studio: 当前工作流为 ${workflowState}，只有 WRITING/REWORK 可进入 Writer`)
  }
  const requiredArtifacts = ['01_market_strategy', 'research', '02_world_bible', '03_system_rules', 'characters', '04_master_plot']
  const inactive = requiredArtifacts.filter(id => latestArtifactRecord(projectDir, id)?.status !== 'ACTIVE')
  if (inactive.length) throw new Error(`novel-studio: 生产资产未 ACTIVE：${inactive.join(', ')}`)
  const stale = staleNodeIds(projectDir).filter(id => ['research', '02_world_bible', '03_system_rules', 'characters', '04_master_plot', 'volumes', 'chapters'].includes(id))
  if (stale.length) throw new Error(`novel-studio: 关键依赖仍为 STALE：${stale.join(', ')}；必须先重建或复审`)
  const planningGate = latestEvidenceCompleteGate(projectDir, 'planning')
  const plotGate = latestEvidenceCompleteGate(projectDir, 'plot')
  if (!planningGate?.pass) throw new Error('novel-studio: 缺少当前协议且证据完整的 Planning Gate PASS')
  if (!plotGate?.pass) throw new Error('novel-studio: 缺少当前协议且证据完整的 Plot Gate PASS')
}

/* ================================================================== Context Builder（设计 §10） */

export function readArtifactText(projectDir, id, version) {
  try {
    return readArtifact(projectDir, { id, version }).content || ''
  } catch {
    return ''
  }
}

/** 向子代理注入精确的 Artifact 可用性，避免它在阶段边界猜测尚未生成的 ID。 */
export function artifactReadManifest(projectDir, { stageOutputs = [] } = {}) {
  const latestById = new Map()
  for (const row of getArtifacts(projectDir)) {
    const previous = latestById.get(row.id)
    if (!previous || Number(row.version) > Number(previous.version)) latestById.set(row.id, row)
  }
  const availableIds = [...latestById.keys()].sort()
  const pendingOutputs = stageOutputs.filter(id => !latestById.has(id))
  const revisionOutputs = stageOutputs.filter(id => latestById.has(id))
  return [
    '==== Artifact 可用性（宿主已核实） ====',
    `当前存在的完整 Artifact ID：${availableIds.join(', ') || '（无）'}`,
    pendingOutputs.length
      ? `本阶段待生成、当前不存在：${pendingOutputs.join(', ')}。不要尝试读取它们。`
      : '',
    revisionOutputs.length
      ? `本阶段目标已有旧版，需要修订时可按完整 ID 读取：${revisionOutputs.join(', ')}。`
      : '',
    '上下文正文已在任务中注入，优先直接使用。如需补充核实，先用 novel_artifact_list，且只读上述完整 ID；Markdown 小节用 section 参数，不得拼成新 artifactId。',
  ].filter(Boolean).join('\n')
}

export function recentChapterSummaries(projectDir, chapter) {
  const n = Number(chapter)
  const out = []
  const notes = loadStoryState(projectDir).notes || []
  for (let i = Math.max(1, n - 3); i < n; i++) {
    const note = [...notes].reverse().find(row => Number(row.chapter) === i && row.note)
    if (note) {
      out.push(`第${i}章：${String(note.note).replace(/\s+/g, ' ').slice(0, 300)}`)
      continue
    }
    const md = readText(resolveManuscriptPath(projectDir, i) || '')
    const head = md.replace(/\s+/g, ' ').slice(0, 300)
    if (head) out.push(`第${i}章：${head}…`)
  }
  return out.slice(-3).join('\n')
}

export function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function weightedPick(items, r) {
  const total = items.reduce((s, i) => s + (i.ratio || 0), 0)
  let x = r * total
  for (const it of items) {
    x -= it.ratio || 0
    if (x <= 0) return it
  }
  return items[items.length - 1] || { segment: '读者', traits: '' }
}

export function markdownTitle(id, label) {
  return `# ${label}\n\n> artifact: \`${id}\` ｜ 由 AI 小说工作室自动生成\n`
}

export function bumpHint(v) {
  const parts = String(v || '1.0').split('.').map(Number)
  parts[parts.length - 1] += 1
  return parts.join('.')
}

export function readdirNames(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
