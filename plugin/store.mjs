/**
 * novel-studio / store
 * ------------------------------------------------------------------
 * AI 小说工作室 —— 存储层（纯 ESM，零外部依赖，可在任意 Node 环境直接测试）。
 *
 * 职责：项目树脚手架、Artifact 生命周期（DRAFT→REVIEW→APPROVED→ACTIVE→SUPERSEDED）、
 * 状态存储（story/character/timeline/foreshadowing/dependency）、章节契约与状态机、
 * 依赖图 STALE 标记、Issue 与 Gate 记录、KPI 统计。
 *
 * 约定：所有写操作先写临时文件再 rename（原子写）；JSON 一律缩进 2 空格持久化。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync, statSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, dirname, relative, basename } from 'node:path'
import {
  normalizeSerialStrategy, normalizeWritingStyle, renderSerialStrategy, renderWritingStyle,
} from './writing-methodology.mjs'

/* ================================================================== 常量 */

/** 项目级工作流状态机（设计文档 §18） */
export const PROJECT_STATES = [
  'INIT', 'RESEARCHING', 'PLANNING', 'PLANNING_REVIEW',
  'PLOT_ENGINEERING', 'PLOT_REVIEW',
  'WRITING', 'CONTENT_REVIEW', 'READER_TEST',
  'DIAGNOSIS', 'REWORK', 'HR_VALIDATION', 'COMPLETE',
]

/** 章节级状态机（设计文档 §18） */
export const CHAPTER_STATES = [
  'PLANNED', 'WRITING', 'QA', 'READER_TEST', 'ACCEPTED', 'DIAGNOSIS', 'REWORK',
]

/** Artifact 生命周期（设计文档 §17） */
export const ARTIFACT_STATUS = ['DRAFT', 'REVIEW', 'APPROVED', 'ACTIVE', 'SUPERSEDED']

/** 设计文档 §4 Agent 组织表：角色 key → 中文名（子代理 persona 用） */
export const ROLES = {
  planner: '总编 Planner',
  'deep-researcher': '市场需求分析专家',
  'research-assistant': '深度资料研究员',
  'world-architect': '世界观架构师',
  'character-growth-expert': '人物成长专家',
  'numeric-expert': '数值体系专家',
  'plot-architect': '情节架构师',
  'hook-designer': 'Hook/爽点/情绪设计师',
  writer: '写手 Writer',
  'continuity-checker': '连续性检查员',
  reviewer: '专业审查 Reviewer',
  'reader-instance': '模拟读者 Reader',
  'diagnosis-analyst': '根因诊断分析师',
  'learning-analyst': 'Agent成长分析师',
  'hr-reviewer': 'HR验收官',
}

/** 设计文档 §17 的项目目录树（相对路径 => 说明） */
export const PROJECT_TREE = {
  '00_project_brief.md': '项目简报（Phase 0 标识产物）',
  '01_market_strategy.md': '市场需求与差异化策略（Phase1 Step1）',
  '02_world_bible.md': '世界观圣经（Phase1 Step3）',
  '03_system_rules.md': '数值/时间/规则体系（Phase1 Step5）',
  '04_master_plot.md': '全书剧情总纲（Phase2 Step6）',
  'research/evidence_index.md': '研究证据索引（Fact/Inference/Assumption 分级）',
  'research/topics/': '专题资料目录',
  'characters/': '人物档案目录',
  'plot/volumes/': '卷级规划目录',
  'plot/chapters/contracts.json': '章节契约登记（机器可读契约库）',
  'manuscript/chapters/': '正文手稿目录',
  'state/story_state.json': '故事状态存储',
  'state/character_state.json': '人物状态存储',
  'state/timeline.json': '时间轴存储',
  'state/foreshadowing.json': '伏笔存储',
  'state/dependency_graph.json': '依赖图存储',
  'reviews/': '专业审查产物',
  'reader_lab/personas.json': 'Reader Persona 池',
  'reader_lab/reports/': 'Reader Lab 报告',
  'issues/': '问题单（结构化 Issue）',
  'learning/candidates/': 'Agent 成长候选（未经 HR 验收不可生效）',
  'agents/': 'Agent Capability Profile 与版本历史',
  'reports/': 'Planner 周期汇报',
  'library/project.json': '项目元数据 + 工作流状态机',
  'library/artifacts.json': 'Artifact 元数据索引',
  'library/gates.json': 'Gate 记录',
  'library/cycles.json': '生产周期记录',
}

/** 设计文档 §14 依赖链：上游节点 → 直接被其影响的下游节点 */
export const DEPENDENCY_CHAIN = {
  '00_project_brief': ['01_market_strategy', 'research', '02_world_bible', '03_system_rules', '04_master_plot'],
  '01_market_strategy': ['research', '02_world_bible', '03_system_rules', '04_master_plot', 'characters'],
  research: ['02_world_bible', '03_system_rules', '04_master_plot', 'characters', 'chapters'],
  '02_world_bible': ['characters', '03_system_rules', '04_master_plot', 'volumes', 'chapters', 'manuscript'],
  characters: ['04_master_plot', 'volumes', 'chapters', 'manuscript'],
  '03_system_rules': ['04_master_plot', 'volumes', 'chapters', 'manuscript'],
  '04_master_plot': ['volumes', 'chapters', 'manuscript'],
  volumes: ['chapters', 'manuscript'],
  chapters: ['manuscript'],
  manuscript: ['reader'],
}

/* ================================================================== 工具 */

export const ok = (data) => data

const ARTIFACT_WRITE_PROTOCOL_VERSION = 'artifact-write-v1'
const ARTIFACT_TRANSACTION_DIR = 'library/artifact_transactions'

let atomicWriteSequence = 0

function atomicTempPath(filePath) {
  atomicWriteSequence += 1
  return `${filePath}.tmp-${process.pid}-${atomicWriteSequence}`
}

/** 原子写 JSON 文件 */
export function writeJsonAtomic(filePath, data) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmp = atomicTempPath(filePath)
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, filePath)
}

export function writeTextAtomic(filePath, text) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmp = atomicTempPath(filePath)
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, filePath)
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function readJson(filePath) {
  const source = readFileSync(filePath, 'utf8')
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(`novel-studio: JSON 文件损坏，无法解析: ${filePath}`, { cause: error })
  }
}

/** 文件缺失时回退；文件存在但损坏时必须显式失败。 */
export function readJsonOr(filePath, fallback) {
  return existsSync(filePath) ? readJson(filePath) : fallback
}

/** 明确声明可容忍缺失或损坏的读取；仅用于可丢弃的辅助数据。 */
export function readJsonTolerant(filePath, fallback) {
  try {
    return readJsonOr(filePath, fallback)
  } catch {
    return fallback
  }
}

export function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled'
}

export function nowIso() {
  return new Date().toISOString()
}

/** 把章节号统一为契约库使用的三位起始格式（001；四位以上不截断）。 */
export function normalizeChapterId(chapter) {
  const raw = String(chapter ?? '').trim()
  if (!/^\d+$/.test(raw)) throw new Error(`novel-studio: 章节号必须是正整数 ${chapter}`)
  const number = Number(raw)
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`novel-studio: 章节号必须是正整数 ${chapter}`)
  }
  return String(number).padStart(3, '0')
}

/** 新手稿统一写入无标题 canonical 文件；title 参数仅为旧调用方兼容。 */
export function manuscriptPathFor(projectDir, chapter, _title = '') {
  return join(projectDir, 'manuscript', 'chapters', `第${normalizeChapterId(chapter)}章.md`)
}

/** 优先返回 canonical 手稿；不存在时兼容历史上的“第NNN章_标题.md”。 */
export function resolveManuscriptPath(projectDir, chapter) {
  const canonical = manuscriptPathFor(projectDir, chapter)
  if (existsSync(canonical)) return canonical
  const dir = dirname(canonical)
  const prefix = `第${normalizeChapterId(chapter)}章_`
  const legacy = readdirSyncSafe(dir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.md'))
    .sort()[0]
  return legacy ? join(dir, legacy) : canonical
}

/** 目录内 .md 文件列表（含子目录，返回相对路径） */
export function collectFiles(root, rel = '', out = []) {
  const dir = join(root, rel)
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const r = rel ? `${rel}/${entry}` : entry
    if (statSync(full).isDirectory()) collectFiles(root, r, out)
    else out.push(r)
  }
  return out
}

export function assertProjectDir(projectDir) {
  if (!existsSync(join(projectDir, 'library', 'project.json'))) {
    throw new Error(`novel-studio: 不是有效的项目目录（缺少 library/project.json）: ${projectDir}`)
  }
}

/* ================================================================== 项目初始化 */

/**
 * Phase 0：初始化项目。
 * @param {object} opts
 * @param {string} opts.projectId 项目 id（slug 化）
 * @param {string} opts.rootDir    项目根目录（绝对路径；实际目录 = rootDir/<projectId> 或 rootDir 本身当 projectId 为空）
 * @param {object} opts.brief      项目简报字段
 */
export function initProject(opts) {
  const { projectId: rawId, rootDir, brief = {} } = opts
  const projectId = slugify(rawId || 'untitled')
  const projectDir = join(rootDir, projectId)
  if (existsSync(join(projectDir, 'library', 'project.json'))) {
    throw new Error(`novel-studio: 项目已存在: ${projectId} @ ${projectDir}`)
  }
  mkdirSync(projectDir, { recursive: true })

  const project = {
    meta: {
      projectId,
      title: brief.title || '未命名作品',
      createdAt: nowIso(),
      generator: 'novel-studio v1',
    },
    brief: {
      genre: brief.genre || '',
      audience: brief.audience || '',
      platform: brief.platform || '',
      targetWords: brief.targetWords ?? 1000000,
      volumeCount: brief.volumeCount ?? 3,
      chaptersPerVolume: brief.chaptersPerVolume ?? 40,
      chaptersPerBatch: brief.chaptersPerBatch ?? 10,
      businessGoals: brief.businessGoals || [],
      referenceWorks: brief.referenceWorks || [],
      forbiddenItems: brief.forbiddenItems || [],
      hardConstraints: brief.hardConstraints || [],
      configurationMode: brief.configurationMode === 'collaborative' ? 'collaborative' : 'ai_managed',
      writingStyle: normalizeWritingStyle(brief),
      serialStrategy: normalizeSerialStrategy(brief),
    },
    workflow: {
      state: 'INIT', // PROJECT_STATES
      history: [{ at: nowIso(), from: null, to: 'INIT', reason: '项目创建' }],
    },
    cycle: {
      current: 1,
      chapterCursor: 0, // 已规划的章节数
    },
    chapterStatus: {}, // { '037': 'PLANNED' }
    counters: {
      issues: 0,
      gates: 0,
      reworks: 0,
      reviews: 0,
      batches: 0,
    },
  }
  writeJsonAtomic(join(projectDir, 'library', 'project.json'), project)
  project.__dir = projectDir // 供 appendArtifact 等内部调用定位（不持久化）

  // 目录树
  for (const rel of Object.keys(PROJECT_TREE)) {
    if (rel.endsWith('/')) mkdirSync(join(projectDir, rel), { recursive: true })
  }

  // 00_project_brief.md
  const briefMd = renderProjectBrief(project)
  writeTextAtomic(join(projectDir, '00_project_brief.md'), briefMd)
  const briefVersionPath = artifactVersionPathFor('00_project_brief', 1)
  writeTextAtomic(join(projectDir, briefVersionPath), briefMd)

  // 章节契约登记簿（空初始）
  writeJsonAtomic(join(projectDir, 'plot', 'chapters', 'contracts.json'), { chapters: {}, order: [] })

  // 状态存储
  writeJsonAtomic(join(projectDir, 'state', 'story_state.json'), emptyStoryState())
  writeJsonAtomic(join(projectDir, 'state', 'character_state.json'), { characters: {} })
  writeJsonAtomic(join(projectDir, 'state', 'timeline.json'), { events: [] })
  writeJsonAtomic(join(projectDir, 'state', 'foreshadowing.json'), { items: [], nextId: 1 })
  writeJsonAtomic(join(projectDir, 'state', 'dependency_graph.json'), emptyDependencyGraph())

  // 元数据索引
  writeJsonAtomic(join(projectDir, 'library', 'artifacts.json'), { artifacts: [] })
  writeJsonAtomic(join(projectDir, 'library', 'gates.json'), { gates: [] })
  writeJsonAtomic(join(projectDir, 'library', 'cycles.json'), { cycles: [] })

  // 第一个 artifact 元数据：00_project_brief
  const artifact = {
    id: '00_project_brief',
    version: 1,
    status: 'ACTIVE',
    owner: 'planner',
    title: '项目简报',
    path: '00_project_brief.md',
    versionPath: briefVersionPath,
    dependencies: [],
    createdBy: 'planner',
    approvedBy: 'planner',
    supersedes: null,
    changeReason: 'Phase 0 项目初始化',
    updatedAt: nowIso(),
  }
  appendArtifact(project, artifact)

  setWorkflowState(project, 'INIT', 'Phase 0 初始化完成')
  return { projectId, projectDir, project }
}

function emptyStoryState() {
  return { current: { chapter: 0, location: '', time: '', summary: '' }, worldState: {}, openThreads: [], notes: [] }
}

function emptyDependencyGraph() {
  return {
    nodes: {},
    edges: [], // { from, to, kind: 'derives' }
  }
}

export function renderProjectBrief(project) {
  const b = project.brief
  return [
    `# ${project.meta.title} —— 项目简报（00）`,
    '',
    `> 项目 ID：\`${project.meta.projectId}\` ｜ 生成时间：${project.meta.createdAt} ｜ 来源：Phase 0 用户需求`,
    '',
    '## 题材与类型',
    `- 题材：${b.genre || '（待定）'}`,
    `- 目标读者：${b.audience || '（待定）'}`,
    `- 发布平台：${b.platform || '（待定）'}`,
    `- 商业目标：${b.businessGoals.length ? b.businessGoals.map(g => `\n  - ${g}`).join('') : '（待定）'}`,
    '',
    '## 体量规划',
    `- 目标总字数：约 ${b.targetWords} 字`,
    `- 卷数：${b.volumeCount} 卷，每卷约 ${b.chaptersPerVolume} 章`,
    `- 每批生产：${b.chaptersPerBatch} 章（滚动生产批次）`,
    '',
    '## 参考作品',
    b.referenceWorks.length ? b.referenceWorks.map(r => `- ${r}`).join('\n') : '- （无）',
    '',
    '## 创作配置',
    `- 配置方式：${b.configurationMode === 'collaborative' ? '协作配置（用户确认，AI 补齐）' : 'AI 托管（AI 自动选择并保持一致）'}`,
    '',
    '### 可观察文风参数',
    renderWritingStyle(b),
    '',
    '### 连载叙事策略',
    renderSerialStrategy(b),
    '',
    '## 禁止事项（用户硬约束）',
    b.forbiddenItems.length ? b.forbiddenItems.map(r => `- ${r}`).join('\n') : '- （无）',
    '',
    '## 用户硬约束（Gate 一票否决项）',
    b.hardConstraints.length ? b.hardConstraints.map(r => `- ${r}`).join('\n') : '- （无）',
    '',
    '## 工作流状态',
    `当前项目状态：\`${project.workflow.state}\``,
    '',
  ].join('\n')
}

/* ================================================================== 工作流状态机 */

export function setWorkflowState(project, to, reason) {
  if (!PROJECT_STATES.includes(to)) throw new Error(`novel-studio: 未知项目状态 ${to}`)
  const from = project.workflow.state
  project.workflow.state = to
  project.workflow.history.push({ at: nowIso(), from, to, reason: reason || '' })
}

export function getProject(projectDir) {
  assertProjectDir(projectDir)
  const project = readJsonOr(join(projectDir, 'library', 'project.json'), null)
  // 读取保持无副作用，避免只读状态查询与并发写操作互相覆盖；下一次
  // saveProject 会把从事实记录派生出的修复一并持久化。
  reconcileProjectDerivedState(projectDir, project)
  return project
}

export function saveProject(projectDir, project) {
  reconcileProjectDerivedState(projectDir, project)
  writeJsonAtomic(join(projectDir, 'library', 'project.json'), project)
}

/**
 * contracts / Issue / Gate 是事实记录，project.json 只保存其派生索引。
 * 任一事实文件先提交而 project.json 尚未提交时，读取结果立即收敛；下一次保存持久化修复。
 */
function reconcileProjectDerivedState(projectDir, project) {
  let changed = false
  project.cycle = project.cycle && typeof project.cycle === 'object' ? project.cycle : {}
  project.counters = project.counters && typeof project.counters === 'object' ? project.counters : {}

  const contractsPath = join(projectDir, 'plot', 'chapters', 'contracts.json')
  if (existsSync(contractsPath)) {
    const book = readJson(contractsPath)
    if (!book?.chapters || typeof book.chapters !== 'object' || Array.isArray(book.chapters)) {
      throw new Error('novel-studio: 章节契约登记簿结构非法')
    }
    const chapterStatus = {}
    let chapterCursor = 0
    let reworks = 0
    for (const [key, row] of Object.entries(book.chapters)) {
      const chapter = normalizeChapterId(row?.chapter ?? key)
      if (Object.hasOwn(chapterStatus, chapter)) {
        throw new Error(`novel-studio: 章节契约编号重复 ${chapter}`)
      }
      if (!CHAPTER_STATES.includes(row?.status)) {
        throw new Error(`novel-studio: 章节 ${chapter} 状态非法: ${row?.status}`)
      }
      chapterStatus[chapter] = row.status
      chapterCursor = Math.max(chapterCursor, Number(chapter))
      const transitions = Array.isArray(row.history)
        ? row.history.filter(entry => entry?.to === 'REWORK').length
        : 0
      reworks += transitions || (row.status === 'REWORK' ? 1 : 0)
    }
    const orderedStatus = Object.fromEntries(
      Object.entries(chapterStatus).sort(([a], [b]) => Number(a) - Number(b)),
    )
    if (JSON.stringify(project.chapterStatus || {}) !== JSON.stringify(orderedStatus)) {
      project.chapterStatus = orderedStatus
      changed = true
    }
    if (project.cycle.chapterCursor !== chapterCursor) {
      project.cycle.chapterCursor = chapterCursor
      changed = true
    }
    if (project.counters.reworks !== reworks) {
      project.counters.reworks = reworks
      changed = true
    }
  }

  const issues = persistedIssueCounter(projectDir)
  if (project.counters.issues !== issues) {
    project.counters.issues = issues
    changed = true
  }
  const gates = persistedGateCounter(projectDir)
  if (project.counters.gates !== gates) {
    project.counters.gates = gates
    changed = true
  }
  return changed
}

function persistedIssueCounter(projectDir) {
  const dir = join(projectDir, 'issues')
  if (!existsSync(dir)) return 0
  let max = 0
  for (const file of readdirSync(dir)) {
    const match = /^ISSUE-(\d+)\.json$/.exec(file)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isSafeInteger(value)) max = Math.max(max, value)
  }
  return max
}

function gateCounter(gates) {
  if (!Array.isArray(gates)) throw new Error('novel-studio: Gate 登记簿结构非法')
  let max = gates.length
  for (const gate of gates) {
    const seq = Number(gate?.seq)
    if (Number.isSafeInteger(seq) && seq > 0) max = Math.max(max, seq)
  }
  return max
}

function persistedGateCounter(projectDir) {
  const file = join(projectDir, 'library', 'gates.json')
  if (!existsSync(file)) return 0
  return gateCounter(readJson(file)?.gates)
}

/* ================================================================== Artifact 元数据 */

export function getArtifacts(projectDir) {
  const book = readJsonOr(join(projectDir, 'library', 'artifacts.json'), { artifacts: [] })
  if (!book || !Array.isArray(book.artifacts)) {
    throw new Error('novel-studio: Artifact 索引结构非法')
  }
  return book.artifacts
}

export function saveArtifacts(projectDir, artifacts) {
  writeJsonAtomic(join(projectDir, 'library', 'artifacts.json'), { artifacts })
}

function appendArtifact(project, row) {
  const artifacts = getArtifacts(projectDirOf(project))
  artifacts.push(row)
  saveArtifacts(projectDirOf(project), artifacts)
}

function projectDirOf(project) {
  return project.__dir
}

function artifactTransactionPath(projectDir, transactionId) {
  const value = String(transactionId || '')
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error(`novel-studio: Artifact 写事务编号非法 ${transactionId}`)
  }
  return join(projectDir, ARTIFACT_TRANSACTION_DIR, `${value}.json`)
}

function validateArtifactWriteTransaction(row) {
  const id = assertArtifactId(row?.id)
  const version = Number(row?.version)
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`novel-studio: Artifact 写事务版本非法 ${row?.version}`)
  }
  const transaction = row?.writeTransaction
  if (transaction?.protocolVersion !== ARTIFACT_WRITE_PROTOCOL_VERSION) {
    throw new Error(`novel-studio: Artifact ${id} v${version} 写事务协议非法`)
  }
  artifactTransactionPath('.', transaction.transactionId)
  if (!/^[a-f0-9]{64}$/.test(String(transaction.contentSha256 || ''))) {
    throw new Error(`novel-studio: Artifact ${id} v${version} 写事务摘要非法`)
  }
  const versionPath = artifactVersionPathFor(id, version)
  const canonicalPath = artifactPathFor(id)
  if (row.versionPath !== versionPath || row.path !== canonicalPath) {
    throw new Error(`novel-studio: Artifact ${id} v${version} 写事务路径非法`)
  }
  return { id, version, versionPath, canonicalPath, transaction }
}

function readArtifactTransactionBody(projectDir, row) {
  const { id, version, versionPath, transaction } = validateArtifactWriteTransaction(row)
  const file = join(projectDir, versionPath)
  if (!existsSync(file)) {
    throw new Error(`novel-studio: Artifact ${id} v${version} 恢复失败：索引已提交但不可变版本正文缺失 ${file}`)
  }
  const content = readFileSync(file, 'utf8')
  if (sha256Text(content) !== transaction.contentSha256) {
    throw new Error(`novel-studio: Artifact ${id} v${version} 不可变版本正文内容冲突，已保留现场：${file}`)
  }
  return content
}

function previousArtifactContent(projectDir, artifacts, row) {
  const previous = artifacts
    .filter(candidate => candidate.id === row.id && Number(candidate.version) < Number(row.version))
    .sort((a, b) => Number(b.version) - Number(a.version))[0]
  if (!previous?.versionPath) return null
  const file = join(projectDir, previous.versionPath)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

function ensureArtifactCanonical(projectDir, artifacts, row, content, { indexed }) {
  const canonical = join(projectDir, artifactPathFor(row.id))
  if (!existsSync(canonical)) {
    writeTextAtomic(canonical, content)
    return
  }
  const current = readFileSync(canonical, 'utf8')
  if (current === content) return

  // 索引提交前，canonical 只能从上一不可变版本推进到本版本；其他内容视为外部冲突。
  const previous = indexed ? null : previousArtifactContent(projectDir, artifacts, row)
  if (!indexed && previous !== null && current === previous) {
    writeTextAtomic(canonical, content)
    return
  }
  throw new Error(`novel-studio: Artifact ${row.id} v${row.version} canonical 正文内容冲突，已保留现场：${canonical}`)
}

function indexArtifactTransaction(artifacts, transactionRow) {
  const existing = artifacts.find(row => row.id === transactionRow.id && Number(row.version) === Number(transactionRow.version))
  if (existing) {
    const current = validateArtifactWriteTransaction(existing).transaction
    const incoming = validateArtifactWriteTransaction(transactionRow).transaction
    if (current.transactionId !== incoming.transactionId || current.contentSha256 !== incoming.contentSha256) {
      throw new Error(`novel-studio: Artifact ${transactionRow.id} v${transactionRow.version} 索引事务冲突`)
    }
    return existing
  }
  const newer = artifacts.some(row => row.id === transactionRow.id && Number(row.version) > Number(transactionRow.version))
  if (newer) {
    throw new Error(`novel-studio: Artifact ${transactionRow.id} v${transactionRow.version} 恢复时发现更新版本，拒绝回放旧事务`)
  }
  for (const old of artifacts.filter(row => row.id === transactionRow.id)) {
    if (old.status !== 'SUPERSEDED') old.status = 'SUPERSEDED'
  }
  artifacts.push(transactionRow)
  return transactionRow
}

function applyArtifactDependencyTransaction(projectDir, artifacts, row) {
  const { transaction } = validateArtifactWriteTransaction(row)
  if (transaction.dependencyStatus === 'APPLIED') return false
  if (transaction.dependencyStatus !== 'PENDING') {
    throw new Error(`novel-studio: Artifact ${row.id} v${row.version} 依赖传播状态非法`)
  }
  markDependentsStale(projectDir, row.id, transaction.dependencyReason, {
    transactionId: transaction.transactionId,
  })
  transaction.dependencyStatus = 'APPLIED'
  transaction.appliedAt = nowIso()
  saveArtifacts(projectDir, artifacts)
  return true
}

/**
 * 恢复 Artifact 的多文件写事务。该函数只由持有项目 mutation lock 的写入口调用，
 * 也可作为显式修复入口使用；getProject/getArtifacts 保持纯读取。
 */
export function recoverArtifactWrites(projectDir) {
  assertProjectDir(projectDir)
  let artifacts = getArtifacts(projectDir)
  const recovered = []
  const transactionDir = join(projectDir, ARTIFACT_TRANSACTION_DIR)

  for (const file of readdirSyncSafe(transactionDir).filter(name => /^[A-Za-z0-9_-]{8,128}\.json$/.test(name)).sort()) {
    const journalPath = join(transactionDir, file)
    const journal = readJson(journalPath)
    if (journal?.protocolVersion !== ARTIFACT_WRITE_PROTOCOL_VERSION || !journal.row) {
      throw new Error(`novel-studio: Artifact 写事务日志损坏：${journalPath}`)
    }
    const details = validateArtifactWriteTransaction(journal.row)
    if (`${details.transaction.transactionId}.json` !== file) {
      throw new Error(`novel-studio: Artifact 写事务日志编号不匹配：${journalPath}`)
    }
    const indexed = artifacts.find(row => row.id === details.id && Number(row.version) === details.version)
    const versionFile = join(projectDir, details.versionPath)

    // PREPARED 后尚未提交不可变正文时没有数据需要恢复，可以安全撤销意图。
    if (!existsSync(versionFile) && !indexed) {
      rmSync(journalPath, { force: true })
      continue
    }

    const body = readArtifactTransactionBody(projectDir, indexed || journal.row)
    ensureArtifactCanonical(projectDir, artifacts, indexed || journal.row, body, { indexed: Boolean(indexed) })
    const row = indexArtifactTransaction(artifacts, journal.row)
    if (!indexed) saveArtifacts(projectDir, artifacts)
    applyArtifactDependencyTransaction(projectDir, artifacts, row)
    rmSync(journalPath, { force: true })
    recovered.push(row)
  }

  // 即使事务日志被意外删除，索引中的 PENDING 标记仍足以完成依赖传播。
  artifacts = getArtifacts(projectDir)
  for (const row of artifacts.filter(candidate => candidate?.writeTransaction?.dependencyStatus === 'PENDING')) {
    const body = readArtifactTransactionBody(projectDir, row)
    ensureArtifactCanonical(projectDir, artifacts, row, body, { indexed: true })
    applyArtifactDependencyTransaction(projectDir, artifacts, row)
    recovered.push(row)
  }
  return recovered
}

/**
 * 写入 Artifact 正文（DRAFT。同 id 再次写入 → 版本 +1，旧版本 SUPERSEDED）。
 * @returns {object} 新元数据行
 */
export function writeArtifact(projectDir, { id, content, owner = 'planner', title, dependencies = [], changeReason = '', status = 'DRAFT' }) {
  assertArtifactId(id)
  getProject(projectDir)
  const recovered = recoverArtifactWrites(projectDir)
  const recoveredRetry = recovered
    .filter(row => row.id === id && row.writeTransaction?.contentSha256 === sha256Text(content))
    .sort((a, b) => Number(b.version) - Number(a.version))[0]
  if (recoveredRetry) return recoveredRetry

  const artifacts = getArtifacts(projectDir)
  const prev = artifacts.filter(a => a.id === id)
  const version = prev.length ? Math.max(...prev.map(a => a.version)) + 1 : 1
  const relPath = artifactPathFor(id)
  const versionPath = artifactVersionPathFor(id, version)

  // 升级旧索引时，至少在覆盖 canonical 前保住当前可恢复的上一版正文。
  const latestPrev = prev.slice().sort((a, b) => b.version - a.version)[0]
  if (latestPrev && !latestPrev.versionPath && existsSync(join(projectDir, relPath))) {
    latestPrev.versionPath = artifactVersionPathFor(id, latestPrev.version)
    if (!existsSync(join(projectDir, latestPrev.versionPath))) {
      writeTextAtomic(join(projectDir, latestPrev.versionPath), readFileSync(join(projectDir, relPath), 'utf8'))
    }
  }
  const versionFile = join(projectDir, versionPath)
  if (existsSync(versionFile) && readFileSync(versionFile, 'utf8') !== content) {
    throw new Error(`novel-studio: Artifact ${id} v${version} 孤儿版本正文内容冲突，拒绝覆盖并保留现场：${versionFile}`)
  }
  const transactionId = randomUUID()
  const dependencyReason = `上游资产 ${id} v${version} 已更新`
  const row = {
    id,
    version,
    status,
    owner,
    title: title || id,
    path: relPath,
    versionPath,
    dependencies: dependencies.length ? dependencies : defaultDependenciesFor(id),
    createdBy: owner,
    approvedBy: null,
    supersedes: prev.length ? { version: Math.max(...prev.map(a => a.version)), at: nowIso() } : null,
    changeReason: changeReason || '常规更新',
    updatedAt: nowIso(),
    writeTransaction: {
      protocolVersion: ARTIFACT_WRITE_PROTOCOL_VERSION,
      transactionId,
      contentSha256: sha256Text(content),
      dependencyStatus: 'PENDING',
      dependencyReason,
    },
  }
  const journalPath = artifactTransactionPath(projectDir, transactionId)
  writeJsonAtomic(journalPath, {
    protocolVersion: ARTIFACT_WRITE_PROTOCOL_VERSION,
    transactionId,
    row,
    preparedAt: nowIso(),
  })

  if (!existsSync(versionFile)) writeTextAtomic(versionFile, content)
  ensureArtifactCanonical(projectDir, artifacts, row, content, { indexed: false })
  indexArtifactTransaction(artifacts, row)
  saveArtifacts(projectDir, artifacts)
  applyArtifactDependencyTransaction(projectDir, artifacts, row)
  rmSync(journalPath, { force: true })
  return row
}

/** Artifact 某个不可变版本正文的相对路径。 */
export function artifactVersionPathFor(id, version) {
  assertArtifactId(id)
  const n = Number(version)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`novel-studio: artifact 版本非法 ${version}`)
  return `library/artifact_versions/${id}/v${String(n).padStart(4, '0')}.md`
}

/** 按 id/version 读取 Artifact；省略 version 时读取最新不可变版本。 */
export function readArtifact(projectDir, idOrOptions, requestedVersion) {
  const options = typeof idOrOptions === 'string'
    ? { id: idOrOptions, version: requestedVersion }
    : (idOrOptions || {})
  const { id, version } = options
  const candidates = getArtifacts(projectDir).filter(a => a.id === id)
  if (!candidates.length) throw new Error(`novel-studio: 不存在 artifact ${id}`)
  const latest = candidates.slice().sort((a, b) => b.version - a.version)[0]
  const target = version === undefined
    ? latest
    : candidates.find(a => a.version === Number(version))
  if (!target) throw new Error(`novel-studio: artifact ${id} 没有版本 ${version}`)

  const versionFile = target.versionPath && join(projectDir, target.versionPath)
  if (versionFile && existsSync(versionFile)) {
    return { meta: target, content: readFileSync(versionFile, 'utf8') }
  }
  if (target.version === latest.version) {
    const canonical = join(projectDir, target.path || artifactPathFor(id))
    if (existsSync(canonical)) return { meta: target, content: readFileSync(canonical, 'utf8') }
  }
  throw new Error(`novel-studio: artifact ${id} v${target.version} 缺少不可变版本正文`)
}

/** Artifact id → 默认正文文件相对路径（约定） */
export function artifactPathFor(id) {
  assertArtifactId(id)
  const fixed = {
    '00_project_brief': '00_project_brief.md',
    '01_market_strategy': '01_market_strategy.md',
    '02_world_bible': '02_world_bible.md',
    '03_system_rules': '03_system_rules.md',
    '04_master_plot': '04_master_plot.md',
    research: 'research/evidence_index.md',
  }
  if (fixed[id]) return fixed[id]
  if (id.startsWith('volume/')) return `plot/volumes/${id.slice('volume/'.length)}.md`
  if (id.startsWith('chapter/')) return `plot/chapters/contract-${id.slice('chapter/'.length)}.json`
  if (id.startsWith('character/')) return `characters/${id.slice('character/'.length)}.md`
  return `library/ops/${id}.md`
}

function assertArtifactId(id) {
  const value = String(id ?? '')
  const segments = value.split('/')
  const safeSegment = /^[\p{L}\p{N}_-]+$/u
  const namespaced = segments.length === 2 && ['volume', 'chapter', 'character'].includes(segments[0])
  const valid = value.length <= 160
    && ((segments.length === 1 && safeSegment.test(segments[0]))
      || (namespaced && safeSegment.test(segments[1])))
  if (!valid) throw new Error(`novel-studio: artifact id 非法或包含路径越界片段: ${id}`)
  return value
}

function defaultDependenciesFor(id) {
  switch (id) {
    case '01_market_strategy': return ['00_project_brief']
    case 'research': return ['00_project_brief', '01_market_strategy']
    case '02_world_bible': return ['00_project_brief', '01_market_strategy', 'research']
    case '03_system_rules': return ['00_project_brief', '01_market_strategy', 'research', '02_world_bible']
    case 'characters': return ['00_project_brief', '01_market_strategy', '02_world_bible']
    case '04_master_plot': return ['00_project_brief', '01_market_strategy', '02_world_bible', '03_system_rules', 'characters']
    default: return []
  }
}

/**
 * 审批 Artifact：DRAFT/REVIEW → APPROVED；再次审批同版本 → ACTIVE（生产 Agent 可消费）。
 */
export function approveArtifact(projectDir, { id, version, approvedBy, activate = false, note = '' }) {
  recoverArtifactWrites(projectDir)
  const artifacts = getArtifacts(projectDir)
  const candidates = artifacts.filter(a => a.id === id)
  if (!candidates.length) throw new Error(`novel-studio: 不存在 artifact ${id}`)
  const target = version !== undefined
    ? candidates.find(a => a.version === version)
    : candidates[candidates.length - 1]
  if (!target) throw new Error(`novel-studio: artifact ${id} 没有版本 ${version}`)
  if (target.status === 'SUPERSEDED') throw new Error(`novel-studio: artifact ${id} v${target.version} 已被取代，不能审批`)
  if (target.status === 'ACTIVE' && !activate) throw new Error(`novel-studio: artifact ${id} 已是 ACTIVE`)
  target.status = activate ? 'ACTIVE' : 'APPROVED'
  target.approvedBy = approvedBy
  target.approvedAt = nowIso()
  if (note) target.approveNote = note
  saveArtifacts(projectDir, artifacts)

  // 审批通过：验证依赖已就绪（只提示，不阻断）
  const missing = (target.dependencies || []).filter(depId => {
    const dep = artifacts.filter(a => a.id === depId && a.status !== 'SUPERSEDED').pop()
    return !dep || !['APPROVED', 'ACTIVE'].includes(dep.status)
  })
  if (missing.length) {
    // 依赖未就绪也允许（Planning Gate 会兜底），但记录
    target.pendingDependencies = missing
    saveArtifacts(projectDir, artifacts)
  }

  markDependentsStale(projectDir, id, `上游资产 ${id} v${target.version} 审批通过`, { onApprove: true })
  return target
}

/* ================================================================== 依赖图 */

function loadDependencyGraph(projectDir) {
  return readJsonOr(join(projectDir, 'state', 'dependency_graph.json'), emptyDependencyGraph())
}

function saveDependencyGraph(projectDir, graph) {
  writeJsonAtomic(join(projectDir, 'state', 'dependency_graph.json'), graph)
}

export function getGraph(projectDir) {
  return loadDependencyGraph(projectDir)
}

/** 把某节点的所有下游（递归）标为 STALE，并写原因 */
export function markDependentsStale(projectDir, nodeId, reason, opts = {}) {
  const graph = loadDependencyGraph(projectDir)
  const touched = []
  const visited = new Set()
  let changed = false
  const visit = (id, depth) => {
    if (depth > 12) return
    const dependents = DEPENDENCY_CHAIN[id] || []
    for (const dep of dependents) {
      if (visited.has(dep)) continue
      visited.add(dep)
      const node = graph.nodes[dep] || (graph.nodes[dep] = { status: 'DRAFT', version: 0, staleReason: null, markedAt: null })
      const transactionApplied = opts.transactionId && node.lastStaleTransactionId === opts.transactionId
      if (node.status !== 'SUPERSEDED' && !transactionApplied) {
        const wasStale = node.status === 'STALE'
        const staleReason = opts.onApprove
          ? `${reason}（全文需复审）`
          : reason
        node.staleHistory = node.staleHistory || []
        if (!node.staleHistory.length && node.staleReason) {
          node.staleHistory.push({
            at: node.markedAt,
            reason: node.staleReason,
            markedBy: node.markedBy || 'dependency-change',
          })
        }
        node.status = 'STALE'
        node.staleReason = staleReason
        node.markedAt = nowIso()
        node.markedBy = opts.onApprove ? 'approval' : 'dependency-change'
        if (opts.transactionId) node.lastStaleTransactionId = opts.transactionId
        node.staleHistory.push({ at: node.markedAt, reason: staleReason, markedBy: node.markedBy })
        changed = true
        if (!wasStale) touched.push(dep)
      }
      visit(dep, depth + 1)
    }
  }
  visit(nodeId, 0)
  if (changed) saveDependencyGraph(projectDir, graph)
  return touched
}

/** 处置一个 STALE 节点，使其回到可消费状态；历史原因不会被清除。 */
export function resolveStaleNode(projectDir, nodeId, { disposition = 'KEEP', note = '', version } = {}) {
  const dispositions = ['KEEP', 'PATCH', 'REGENERATE', 'RE-REVIEW']
  if (!dispositions.includes(disposition)) {
    throw new Error(`novel-studio: 未知 STALE 处置方式 ${disposition}`)
  }
  const graph = loadDependencyGraph(projectDir)
  const node = graph.nodes[nodeId]
  if (!node) throw new Error(`novel-studio: 依赖图中不存在节点 ${nodeId}`)
  if (node.status !== 'STALE') throw new Error(`novel-studio: 节点 ${nodeId} 当前不是 STALE`)
  if (version !== undefined) {
    const n = Number(version)
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`novel-studio: 节点版本非法 ${version}`)
    node.version = n
  }
  const at = nowIso()
  const resolution = { at, disposition, note }
  node.staleHistory = node.staleHistory || []
  if (!node.staleHistory.length && node.staleReason) {
    node.staleHistory.push({
      at: node.markedAt,
      reason: node.staleReason,
      markedBy: node.markedBy || 'dependency-change',
    })
  }
  node.status = 'CURRENT'
  node.staleReason = null
  node.markedAt = null
  node.markedBy = null
  node.resolvedAt = at
  node.resolution = resolution
  node.resolutionHistory = node.resolutionHistory || []
  node.resolutionHistory.push(resolution)
  saveDependencyGraph(projectDir, graph)
  return node
}

export function dependencyImpact(projectDir, nodeId) {
  const visited = new Set()
  const stack = [nodeId]
  while (stack.length) {
    const id = stack.pop()
    if (visited.has(id)) continue
    visited.add(id)
    for (const dep of DEPENDENCY_CHAIN[id] || []) stack.push(dep)
  }
  return [...visited].filter(id => id !== nodeId)
}

/* ================================================================== 章节契约与状态 */

export function loadContracts(projectDir) {
  return readJsonOr(join(projectDir, 'plot', 'chapters', 'contracts.json'), { chapters: {}, order: [] })
}

export function saveContracts(projectDir, contracts) {
  writeJsonAtomic(join(projectDir, 'plot', 'chapters', 'contracts.json'), contracts)
}

/** 批量登记章节契约（来自剧情工程阶段）；要求 plot 阶段产物已审批或正处于该阶段 */
export function addChapterContracts(projectDir, contracts, { owner = 'plot-architect', overwrite = false } = {}) {
  const book = loadContracts(projectDir)
  const chars = loadCharacterState(projectDir)
  const added = []
  for (const c of contracts) {
    const n = normalizeChapterId(c.chapter)
    const previous = book.chapters[n]
    if (previous && !overwrite) throw new Error(`novel-studio: 章节 ${n} 契约已存在（覆盖请传 overwrite: true）`)
    // 契约中的出场人物必须已在人物状态中登记（防漂移）
    const missing = (c.characters || []).filter(id => !chars.characters[id] && id !== 'narrator')
    if (missing.length) {
      throw new Error(`novel-studio: 契约引用未知人物 ${missing.join(',')}（请先建设人设）`)
    }
    const status = previous && overwrite && previous.status !== 'PLANNED' ? 'REWORK' : 'PLANNED'
    const history = previous?.history ? [...previous.history] : []
    if (previous && overwrite) {
      history.push({
        at: nowIso(),
        from: previous.status,
        to: status,
        reason: `Chapter Contract 覆盖升级 v${Number(previous.version || 0) + 1}`,
      })
    }
    book.chapters[n] = {
      ...c,
      chapter: n,
      status,
      version: previous && overwrite ? Number(previous.version || 0) + 1 : 1,
      history,
      updatedAt: nowIso(),
    }
    added.push(n)
  }
  book.order = Object.keys(book.chapters).sort((a, b) => Number(a) - Number(b))
  saveContracts(projectDir, book)

  const project = getProject(projectDir)
  for (const n of added) project.chapterStatus[n] = book.chapters[n].status
  project.cycle.chapterCursor = Math.max(project.cycle.chapterCursor, Number(book.order[book.order.length - 1] || 0))
  saveProject(projectDir, project)
  return added
}

const CHAPTER_TRANSITIONS = {
  PLANNED: ['WRITING', 'DIAGNOSIS', 'REWORK'],
  WRITING: ['QA', 'DIAGNOSIS', 'REWORK'],
  QA: ['READER_TEST', 'DIAGNOSIS', 'REWORK'],
  READER_TEST: ['ACCEPTED', 'DIAGNOSIS', 'REWORK'],
  ACCEPTED: ['DIAGNOSIS', 'REWORK', 'READER_TEST'],
  DIAGNOSIS: ['REWORK', 'PLANNED', 'WRITING', 'QA'],
  REWORK: ['PLANNED', 'WRITING', 'QA', 'DIAGNOSIS'],
}

/** 章节状态机迁移（设计文档 §18 章节级） */
export function setChapterState(projectDir, chapter, to, reason = '') {
  const book = loadContracts(projectDir)
  const n = normalizeChapterId(chapter)
  const row = book.chapters[n]
  if (!row) throw new Error(`novel-studio: 章节 ${n} 无契约`)
  const from = row.status
  if (from === to) return row
  if (!(CHAPTER_TRANSITIONS[from] || []).includes(to)) {
    throw new Error(`novel-studio: 非法章节状态迁移 ${from} → ${to}（章节 ${n}）`)
  }
  row.status = to
  row.history = row.history || []
  row.history.push({ at: nowIso(), from, to, reason: reason || '' })
  saveContracts(projectDir, book)

  const project = getProject(projectDir)
  project.chapterStatus[n] = to
  if (to === 'ACCEPTED') markChapterAccepted(project)
  saveProject(projectDir, project)
  return row
}

function markChapterAccepted(project) {
  const book = project.__contracts
  // no-op：ACCEPTED 计数在 KPI 中实时统计
}

/** 章节状态一览（含批次信息） */
export function listChapterStates(projectDir) {
  const book = loadContracts(projectDir)
  return Object.values(book.chapters).map(c => ({
    chapter: c.chapter,
    status: c.status,
    title: c.title || '',
    pov: c.pov || '',
    location: c.location || '',
    goal: c.chapter_goal || '',
    version: c.version || 1,
  })).sort((a, b) => Number(a.chapter) - Number(b.chapter))
}

/* ================================================================== 状态存储 */

export function loadStoryState(projectDir) {
  return readJsonOr(join(projectDir, 'state', 'story_state.json'), emptyStoryState())
}

export function loadCharacterState(projectDir) {
  return readJsonOr(join(projectDir, 'state', 'character_state.json'), { characters: {} })
}

export function loadTimeline(projectDir) {
  return readJsonOr(join(projectDir, 'state', 'timeline.json'), { events: [] })
}

export function loadForeshadowing(projectDir) {
  return readJsonOr(join(projectDir, 'state', 'foreshadowing.json'), { items: [], nextId: 1 })
}

const STATE_KINDS = {
  story: { file: 'story_state.json', desc: '故事状态' },
  character: { file: 'character_state.json', desc: '人物状态' },
  timeline: { file: 'timeline.json', desc: '时间轴' },
  foreshadowing: { file: 'foreshadowing.json', desc: '伏笔' },
  dependency: { file: 'dependency_graph.json', desc: '依赖图' },
}

export function listStateKinds() {
  return STATE_KINDS
}

export function readState(projectDir, kind) {
  const meta = STATE_KINDS[kind]
  if (!meta) throw new Error(`novel-studio: 未知状态存储 ${kind}，可用：${Object.keys(STATE_KINDS).join(',')}`)
  return readJsonOr(join(projectDir, 'state', meta.file), {})
}

/**
 * 写状态存储（整体替换指定 kind）。写前做结构与引用校验；character/foreshadowing 有强约束。
 */
export function writeState(projectDir, kind, data, { reason = '' } = {}) {
  const meta = STATE_KINDS[kind]
  if (!meta) throw new Error(`novel-studio: 未知状态存储 ${kind}`)
  validateState(kind, data, projectDir)
  const filePath = join(projectDir, 'state', meta.file)
  const prev = readJsonOr(filePath, {})
  writeJsonAtomic(filePath, data)
  // 审计（不引入额外文件，记到 project.json）
  const project = getProject(projectDir)
  project.stateAudit = project.stateAudit || []
  project.stateAudit.push({ at: nowIso(), kind, reason: reason || '直接写入' })
  saveProject(projectDir, project)
  return { kind, updatedAt: nowIso(), prev }
}

function validateState(kind, data, projectDir) {
  if (kind === 'character') {
    if (typeof data !== 'object' || !data.characters || typeof data.characters !== 'object') {
      throw new Error('novel-studio: 人物状态必须形如 { characters: { id: {...} } }')
    }
    for (const [id, c] of Object.entries(data.characters)) {
      if (!c.name) throw new Error(`novel-studio: 人物 ${id} 缺少 name 字段`)
    }
  } else if (kind === 'foreshadowing') {
    if (!Array.isArray(data.items)) throw new Error('novel-studio: 伏笔存储缺少 items 数组')
    const ids = new Set(data.items.map(i => i.id))
    if (ids.size !== data.items.length) throw new Error('novel-studio: 伏笔 id 重复')
    for (const item of data.items) {
      if (!['open', 'pending', 'paid_off', 'orphaned'].includes(item.status)) {
        throw new Error(`novel-studio: 伏笔 ${item.id} 状态非法: ${item.status}`)
      }
    }
  } else if (kind === 'timeline') {
    if (!Array.isArray(data.events)) throw new Error('novel-studio: 时间轴缺少 events 数组')
  } else if (kind === 'dependency') {
    if (!data.nodes || !Array.isArray(data.edges)) throw new Error('novel-studio: 依赖图结构非法')
  } else if (kind === 'story') {
    if (!data.current || typeof data.current !== 'object') throw new Error('novel-studio: 故事状态缺少 current')
  }
}

/* ================================================================== Issue / Gate 记录 */

function assertIssueId(issueId) {
  const value = String(issueId ?? '')
  if (!/^ISSUE-\d+$/.test(value)) {
    throw new Error(`novel-studio: Issue 编号非法 ${issueId}`)
  }
  return value
}

export function issuePath(projectDir, issueId) {
  return join(projectDir, 'issues', `${assertIssueId(issueId)}.json`)
}

export function addIssue(projectDir, issue) {
  const project = getProject(projectDir)
  const issueId = assertIssueId(issue.issue_id || `ISSUE-${String(persistedIssueCounter(projectDir) + 1).padStart(4, '0')}`)
  if (existsSync(issuePath(projectDir, issueId))) {
    throw new Error(`novel-studio: Issue ${issueId} 已存在，拒绝覆盖`)
  }
  const row = {
    issue_id: issueId,
    status: 'open',
    ...issue,
    project_state: project.workflow.state,
    created_at: nowIso(),
  }
  writeJsonAtomic(issuePath(projectDir, issueId), row)
  saveProject(projectDir, project)
  return row
}

export function listIssues(projectDir, opts = {}) {
  const dir = join(projectDir, 'issues')
  if (!existsSync(dir)) return []
  const rows = []
  for (const f of readdirSync(dir)) {
    if (!/^ISSUE-\d+\.json$/.test(f)) continue
    const row = readJsonOr(join(dir, f), null)
    if (!row?.issue_id) continue
    if (opts.status && row.status !== opts.status) continue
    rows.push(row)
  }
  return rows.sort((a, b) => a.issue_id.localeCompare(b.issue_id))
}

export function getIssue(projectDir, issueId) {
  return readJsonOr(issuePath(projectDir, issueId), null)
}

export function updateIssue(projectDir, issueId, patch) {
  const row = getIssue(projectDir, issueId)
  if (!row) throw new Error(`novel-studio: 无此 issue ${issueId}`)
  const next = { ...row, ...patch, updated_at: nowIso() }
  writeJsonAtomic(issuePath(projectDir, issueId), next)
  return next
}

export const GATE_PROTOCOL_VERSION = 'fail-closed-v2'

export function recordGate(projectDir, row) {
  const gates = readJsonOr(join(projectDir, 'library', 'gates.json'), { gates: [] })
  const project = getProject(projectDir)
  const record = {
    protocolVersion: GATE_PROTOCOL_VERSION,
    evidenceComplete: false,
    ...row,
    seq: gateCounter(gates.gates) + 1,
    at: nowIso(),
  }
  gates.gates.push(record)
  writeJsonAtomic(join(projectDir, 'library', 'gates.json'), gates)
  saveProject(projectDir, project)
  return record
}

export function listGates(projectDir) {
  return readJsonOr(join(projectDir, 'library', 'gates.json'), { gates: [] }).gates
}

/* ================================================================== KPI 统计 */

/** 作品 KPI（设计文档 §20） */
export function computeKPIs(projectDir) {
  const project = getProject(projectDir)
  const book = loadContracts(projectDir)
  const chapters = Object.values(book.chapters)
  const allIssues = listIssues(projectDir)
  const issues = allIssues.filter(isOpenIssue)
  const gates = listGates(projectDir)
  const fsh = loadForeshadowing(projectDir)

  const accepted = chapters.filter(c => c.status === 'ACCEPTED').length
  const reworkedChapters = chapters.filter(c => (c.history || []).some(h => h.to === 'REWORK')).length
  const oncePass = Math.max(0, accepted - reworkedChapters)
  const readerReports = readdirSyncSafe(join(projectDir, 'reader_lab', 'reports')).filter(f => f.endsWith('.json'))
  const lastReader = readerReports.length
    ? readJsonOr(join(projectDir, 'reader_lab', 'reports', readerReports.sort().pop()), null)
    : null

  const fshTotal = fsh.items.length
  const fshClosed = fsh.items.filter(i => i.status === 'paid_off').length
  const fshOrphaned = fsh.items.filter(i => i.status === 'orphaned').length

  const canonIssues = issues.filter(i => i.dimension === 'canon' && ['high', 'blocking'].includes(i.severity)).length
  const continuityIssues = issues.filter(i => i.dimension === 'continuity').length
  const pendingFsh = fsh.items.filter(i => (i.status === 'open' || i.status === 'pending') && Number(i.dueBy || 9999) <= (project.cycle.chapterCursor + 3)).length

  return {
    work: {
      chaptersPlanned: chapters.length,
      chaptersAccepted: accepted,
      chaptersInProduction: chapters.filter(c => !['ACCEPTED', 'PLANNED', 'REWORK'].includes(c.status)).length,
      oncePassRate: accepted ? +(oncePass / accepted).toFixed(3) : null,
      avgReworksPerChapter: chapters.length ? +((chapters.reduce((s, c) => s + (c.history || []).filter(h => h.to === 'REWORK').length, 0)) / chapters.length).toFixed(2) : 0,
      canonConflicts: canonIssues,
      characterDrift: continuityIssues,
      foreshadowRecoveryRate: fshTotal ? +((fshClosed + fshOrphaned) / fshTotal).toFixed(3) : null,
      pendingForeshadowingDueSoon: pendingFsh,
      reader: lastReader ? lastReader.summary || lastReader : null,
      gates: gates.length,
      issues: issues.length,
      issuesTotal: allIssues.length,
      reworks: project.counters.reworks,
    },
    agent: aggregateAgentKpis(projectDir),
  }
}

function isOpenIssue(issue) {
  const status = String(issue?.status || 'open').trim().toLowerCase().replaceAll('_', '-')
  return !['closed', 'resolved', 'fixed', 'done', 'dismissed', 'wontfix', "won't-fix"].includes(status)
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function aggregateAgentKpis(projectDir) {
  const dir = join(projectDir, 'agents')
  if (!existsSync(dir)) return { profiles: 0 }
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const p = readJsonOr(join(dir, f), null)
    if (p) out.push({ agent: p.agent, version: p.version, accepted: p.acceptedCases, rejected: p.rejectedCases, kpis: p.kpis || {} })
  }
  return { profiles: out }
}

/* ================================================================== 项目定位 */

/** 在根目录下查找项目（by id 或 唯一项目） */
export function locateProject(rootDir, projectId) {
  const id = slugify(projectId || '')
  if (id) {
    const dir = join(rootDir, id)
    if (existsSync(join(dir, 'library', 'project.json'))) return dir
    return null
  }
  const candidates = readdirSyncSafe(rootDir).filter(f => existsSync(join(rootDir, f, 'library', 'project.json')))
  if (candidates.length === 1) return join(rootDir, candidates[0])
  return null
}

/** 全状态快照（novel_status / novel_report 用） */
export function projectSnapshot(projectDir) {
  assertProjectDir(projectDir)
  const project = getProject(projectDir)
  const artifacts = getArtifacts(projectDir)
  const graph = loadDependencyGraph(projectDir)
  const issues = listIssues(projectDir)
  return {
    project: project.meta,
    brief: project.brief,
    workflow: project.workflow,
    cycle: project.cycle,
    chapterStatus: project.chapterStatus,
    counters: project.counters,
    artifacts,
    staleNodes: Object.entries(graph.nodes).filter(([, n]) => n.status === 'STALE').map(([id, n]) => ({ id, reason: n.staleReason, at: n.markedAt })),
    chapters: listChapterStates(projectDir),
    issues,
    openIssues: issues.filter(isOpenIssue),
    kpi: computeKPIs(projectDir),
    stateKinds: Object.keys(STATE_KINDS),
  }
}

/** 树状展示项目目录 */
export function projectTree(projectDir) {
  const rels = collectFiles(projectDir)
  return rels.sort().map(r => `  ${r}`).join('\n')
}
