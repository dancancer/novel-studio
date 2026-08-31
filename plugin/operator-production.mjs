import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  addIssue, getProject, listChapterStates, listIssues, loadCharacterState,
  loadContracts, loadForeshadowing, loadStoryState, loadTimeline, manuscriptPathFor,
  normalizeChapterId, nowIso, readJsonOr, resolveManuscriptPath, resolveStaleNode,
  saveProject, setChapterState, setWorkflowState, writeJsonAtomic, writeState,
  writeTextAtomic,
} from './store.mjs'
import {
  assertWriterProductionReady, normalizeIssueChapter, readText,
  recentChapterSummaries, spawnProjectRole,
} from './operator-common.mjs'
import { renderSerialStrategy, renderWritingStyle } from './writing-methodology.mjs'

function recentChapterExcerpts(projectDir, chapter, { count = 2, maxChars = 5000 } = {}) {
  const current = Number(chapter)
  const previous = listChapterStates(projectDir)
    .map(row => Number(row.chapter))
    .filter(number => Number.isSafeInteger(number) && number < current)
    .sort((a, b) => b - a)
    .slice(0, count)
    .sort((a, b) => a - b)
  if (!previous.length) return ''

  const perChapter = Math.max(800, Math.floor(maxChars / previous.length))
  return previous.map(number => {
    const body = readText(resolveManuscriptPath(projectDir, number))
      .replace(/^# .*\n+/, '')
      .replace(/^> POV:.*\n+/, '')
      .trim()
    const excerpt = body.length > perChapter ? body.slice(-perChapter) : body
    return excerpt ? `### 第 ${number} 章末段\n${excerpt}` : ''
  }).filter(Boolean).join('\n\n')
}

/** 为 Writer 构造最小充分上下文 */
export function buildWriterContext(projectDir, chapter) {
  const book = loadContracts(projectDir)
  const chapterId = normalizeChapterId(chapter)
  const contract = book.chapters[chapterId]
  if (!contract) throw new Error(`novel-studio: 章节 ${chapterId} 无契约（先运行 novel_phase_plot）`)
  const project = getProject(projectDir)
  const brief = project.brief
  const world = readText(join(projectDir, '02_world_bible.md')).slice(0, 12000)
  const market = readText(join(projectDir, '01_market_strategy.md')).slice(0, 4500)
  const systems = readText(join(projectDir, '03_system_rules.md')).slice(0, 8000)
  const master = readText(join(projectDir, '04_master_plot.md')).slice(0, 8000)
  const volumeNo = contract.volume || 1
  const volume = readText(join(projectDir, 'plot', 'volumes', `volume-${String(volumeNo).padStart(2, '0')}.md`)).slice(0, 6000)
  const chars = loadCharacterState(projectDir)
  const story = loadStoryState(projectDir)
  const fsh = loadForeshadowing(projectDir)

  const involved = (contract.characters || []).map(id => {
    const c = chars.characters[id]
    if (!c) return `${id}（未登记！）`
    const snapshot = {
      current: c.current || {},
      relations: c.relations || {},
      profile: c.profile || {},
      expression: c.expression || {},
      physical: c.physical || {},
    }
    return `${id}（${c.name}）: ${JSON.stringify(snapshot)}`
  }).join('\n    ')

  const pendingFsh = fsh.items
    .filter(i => ['open', 'pending'].includes(i.status))
    .map(i => `  - ${i.id}: ${i.summary}（埋于 ${i.plantedAt}，计划回收 ≤${i.dueBy ?? '?'}）`)
    .join('\n')

  const recents = recentChapterSummaries(projectDir, chapterId)
  const recentProse = recentChapterExcerpts(projectDir, chapterId)

  const reworkFeedback = listIssues(projectDir)
    .filter(issue => normalizeIssueChapter(issue.chapter) === chapterId)
    .filter(issue => !['closed', 'resolved', 'fixed', 'done', 'dismissed'].includes(String(issue.status || 'open').toLowerCase()))
    .slice(-8)
    .map(issue => `- [${issue.issue_id}] ${issue.dimension}/${issue.severity}: ${(issue.evidence || issue.actual || '').slice(0, 400)}${issue.recommended_action ? `；建议：${issue.recommended_action}` : ''}`)
    .join('\n')

  const ctx = [
    '## 1. 全局 Canon（世界观 Bible，摘要）',
    world || '（尚无 —— 请在任务中提示问题）',
    '',
    '## 2. 数值/时间规则（摘要）',
    systems || '（无）',
    '',
    '## 3. 全书大纲（相关部分）',
    master.slice(0, 4000),
    '',
    '## 4. 当前卷目标',
    volume || '（无卷规划）',
    '',
    '## 5. 本章 Chapter Contract',
    JSON.stringify(contract, null, 2),
    '',
    '## 6. 出场人物当前状态',
    involved || '（无）',
    '',
    '## 7. 故事当前位置',
    `章节 ${story.current.chapter}｜地点 ${story.current.location}｜时间 ${story.current.time}`,
    `摘要：${story.current.summary || '（无）'}`,
    '',
    '## 8. 最近章节摘要（续写参考）',
    recents || '（本卷开头）',
    '',
    '## 9. 近期正文样本（承接语气、动作与防重复依据）',
    recentProse || '（本书开头，无近期正文）',
    '',
    '## 10. 待回收伏笔（dueBy 邻近优先）',
    pendingFsh || '（无）',
    '',
    '## 11. 本章未关闭问题（返工时必须逐项处理）',
    reworkFeedback || '（无）',
    '',
    '## 12. 项目创作配置',
    `配置方式：${brief.configurationMode === 'collaborative' ? '协作配置（已确认项优先，空缺由 AI 补齐）' : 'AI 托管'}`,
    `题材：${brief.genre || '未定义'}；目标读者：${brief.audience || '未定义'}；平台：${brief.platform || '未定义'}`,
    `参考作品：${(brief.referenceWorks || []).join('；') || '无（不得仅凭作品名模仿）'}`,
    renderWritingStyle(brief),
    '',
    '### 连载叙事策略',
    renderSerialStrategy(brief),
    '',
    '### 已研究的目标读者与情绪承诺',
    market || '（无市场策略资产；以项目简报为准）',
    `禁止事项：${(brief.forbiddenItems || []).join('；') || '无'}`,
    `用户硬约束：${(brief.hardConstraints || []).join('；') || '无'}`,
  ].join('\n\n')
  return { ctx, contract, project, story }
}

const WRITER_STATE_FILES = {
  story: 'state/story_state.json',
  character: 'state/character_state.json',
  timeline: 'state/timeline.json',
  foreshadowing: 'state/foreshadowing.json',
}

function writerBaselinePath(projectDir, chapter) {
  return join(projectDir, 'state', 'chapter_snapshots', `${normalizeChapterId(chapter)}.json`)
}

function persistWriterBaseline(projectDir, chapter) {
  const states = Object.fromEntries(Object.entries(WRITER_STATE_FILES).map(([kind, relativePath]) => [
    kind,
    readJsonOr(join(projectDir, relativePath), {}),
  ]))
  writeJsonAtomic(writerBaselinePath(projectDir, chapter), { chapter: normalizeChapterId(chapter), states, at: nowIso() })
}

function hasWriterOutputFromChapter(projectDir, chapter) {
  const earliest = Number(chapter)
  const chapters = listChapterStates(projectDir).filter(row => Number(row.chapter) >= earliest)
  if (chapters.some(row => existsSync(resolveManuscriptPath(projectDir, row.chapter)))) return true
  const story = loadStoryState(projectDir)
  if ((story.notes || []).some(row => Number(row.chapter) >= earliest)) return true
  if (Number(story.current?.chapter) >= earliest) return true
  const timeline = loadTimeline(projectDir)
  if ((timeline.events || []).some(row => Number(row.chapter) >= earliest)) return true
  const foreshadowing = loadForeshadowing(projectDir)
  if ((foreshadowing.items || []).some(row => Number(row.plantedAt) >= earliest || Number(row.paidOffAt) >= earliest)) return true
  const characters = loadCharacterState(projectDir).characters || {}
  return Object.values(characters).some(row => Number(row.lastSeenChapter) >= earliest)
}

function restoreWriterBaseline(projectDir, chapter) {
  const snapshot = readJsonOr(writerBaselinePath(projectDir, chapter), null)
  if (!snapshot?.states) {
    if (!hasWriterOutputFromChapter(projectDir, chapter)) return false
    throw new Error(`novel-studio: 第 ${normalizeChapterId(chapter)} 章缺少 Writer 前置状态快照，无法安全返工；请先恢复或迁移快照`)
  }
  const missing = Object.keys(WRITER_STATE_FILES).filter(kind => !Object.hasOwn(snapshot.states, kind))
  if (missing.length) {
    throw new Error(`novel-studio: 第 ${normalizeChapterId(chapter)} 章 Writer 前置状态快照不完整（缺少 ${missing.join(', ')}），无法安全返工`)
  }
  for (const [kind, relativePath] of Object.entries(WRITER_STATE_FILES)) {
    writeJsonAtomic(join(projectDir, relativePath), snapshot.states[kind])
  }
  return true
}

/** 某章之前的最近 N 章出口摘要（来自 story_state 或手稿首行） */

/** Phase 3：Writer 批量写正文（含状态写回） */
export async function phaseWriteBatch(ctx, exec, projectDir, opts) {
  const project = getProject(projectDir)
  assertWriterProductionReady(projectDir, project.workflow.state)
  const range = opts.range || []
  let targets = (opts.chapters || []).map(normalizeChapterId)
  if (range?.length === 2) {
    const [a, b] = [Number(range[0]), Number(range[1])]
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) {
      throw new Error('novel-studio: range 必须是有效的 [start, end] 正整数区间')
    }
    for (let n = a; n <= b; n++) targets.push(normalizeChapterId(n))
  }
  targets = [...new Set(targets)].sort((a, b) => Number(a) - Number(b))
  if (!targets.length) {
    // 默认取下一批 PLANNED
    const states = listChapterStates(projectDir)
    const batchSize = project.brief.chaptersPerBatch || 10
    targets = states
      .filter(s => s.status === 'PLANNED')
      .slice(0, batchSize)
      .map(s => normalizeChapterId(s.chapter))
  }
  if (!targets.length) throw new Error('novel-studio: 没有可写章节（PLANNED），先运行 novel_phase_plot 或 novel_rework_execute 生成契约')

  let book = loadContracts(projectDir)
  // 任何快照恢复或状态迁移前，先验完用户传入的全部目标。
  for (const chapter of targets) {
    const row = book.chapters[chapter]
    if (!row) throw new Error(`novel-studio: 章节 ${chapter} 无契约（先运行 novel_phase_plot）`)
    if (!['PLANNED', 'REWORK'].includes(row.status)) {
      throw new Error(`novel-studio: 章节 ${chapter} 当前为 ${row.status}，只有 PLANNED/REWORK 可进入写作`)
    }
  }

  const requestedRework = targets.filter(chapter => book.chapters[chapter]?.status === 'REWORK')
  if (requestedRework.length) {
    const earliest = Math.min(...requestedRework.map(Number))
    const downstream = book.order.filter(chapter => Number(chapter) >= earliest && book.chapters[chapter]?.status !== 'PLANNED')
    const replayableStates = new Set(['WRITING', 'QA', 'READER_TEST', 'ACCEPTED', 'DIAGNOSIS', 'REWORK'])
    for (const chapter of downstream) {
      const status = book.chapters[chapter]?.status
      if (!replayableStates.has(status)) {
        throw new Error(`novel-studio: 章节 ${chapter} 当前为 ${status || '无状态'}，无法安全重放 Writer 状态`)
      }
    }
    targets = [...new Set([...targets, ...downstream])].sort((a, b) => Number(a) - Number(b))
    restoreWriterBaseline(projectDir, normalizeChapterId(earliest))
    for (const chapter of downstream) {
      if (book.chapters[chapter].status !== 'REWORK') {
        setChapterState(projectDir, chapter, 'REWORK', `第 ${normalizeChapterId(earliest)} 章返工，需顺序重放后续状态`)
      }
    }
    book = loadContracts(projectDir)
  }

  const writingProject = getProject(projectDir)
  setWorkflowState(writingProject, 'WRITING', `写第 ${targets[0]}-${targets[targets.length - 1]} 章`)
  saveProject(projectDir, writingProject)

  const written = []
  const problems = []
  for (const ch of targets) {
    try {
      const entry = await writeOneChapter(ctx, exec, projectDir, ch)
      written.push(ch)
      problems.push(...(entry.problems || []).map(p => `第${ch}章: ${p}`))
    } catch (error) {
      const failedProject = getProject(projectDir)
      setWorkflowState(failedProject, 'REWORK', `第${ch}章写作失败，等待返工`)
      saveProject(projectDir, failedProject)
      throw new Error(`novel-studio: 第 ${ch} 章写作失败：${String(error?.message || error)}`, { cause: error })
    }
  }

  const p2 = getProject(projectDir)
  setWorkflowState(p2, 'CONTENT_REVIEW', '本批正文完成，等待专业审查')
  saveProject(projectDir, p2)
  try { resolveStaleNode(projectDir, 'manuscript', { disposition: 'REGENERATE', note: `Writer 完成第 ${targets.join(', ')} 章` }) } catch { /* 非 STALE */ }
  return { action: 'write', chapters: written, problems, next: '运行 novel_review_run 进行专业审查（Chapter Gate）' }
}

/** 写单章：Context Builder → Writer 子代理 → 校验 → 手稿落盘 → 状态写回 → QA */
async function writeOneChapter(ctx, exec, projectDir, ch) {
  const chapterId = normalizeChapterId(ch)
  persistWriterBaseline(projectDir, chapterId)
  setChapterState(projectDir, chapterId, 'WRITING', 'Writer 已领取 Chapter Contract')
  const rollbackFiles = [
    'library/project.json',
    'state/story_state.json',
    'state/character_state.json',
    'state/timeline.json',
    'state/foreshadowing.json',
  ]
  const snapshots = new Map(rollbackFiles.map(rel => [rel, readText(join(projectDir, rel))]))
  const manuscriptPath = manuscriptPathFor(projectDir, chapterId)
  const previousManuscript = existsSync(manuscriptPath) ? readText(manuscriptPath) : null

  try {
    const { ctx: writerCtx, contract } = buildWriterContext(projectDir, chapterId)
    const out = await spawnProjectRole(ctx, exec, projectDir, {
      role: 'writer',
      label: `写第${chapterId}章`,
      prompt: [
        '【Chapter Contract 生产任务】',
        `项目目录：${projectDir}｜本章契约号：${chapterId}`,
        '请用只读工具 novel_chapter_read / novel_artifact_read / novel_state_read 核实以下上下文（以下为装配好的 Context Builder 快照，与其冲突时以快照+只读核实为准）：',
        '',
        writerCtx,
        '',
        '要求：',
        '- 严格履行 contract 的 entry_state → chapter_goal → conflict → turning_point → payoff → exit_state；兑现 emotional_curve 与 end_hook。',
        '- 显式完成 reader_question → protagonist_action → external_feedback → state_delta → next_expectation：反馈必须改变现实状态，下一轮期待必须由本章结果生长。',
        '- 服务项目核心情绪承诺，但不要机械塞爽点；延迟兑现时提供局部进展、真实代价或次级回报，不能只增加危机。',
        '- forbidden_changes 与用户硬约束是法律条文：一个字符都不能违反。',
        '- 发现契约与 Canon 冲突：不自行圆场，写进 problems。',
        '- 写作前按正文方法完成内部规划，但不得输出构思、检查过程、规则复述或自我评价。',
        '- 项目文风参数是同一组互斥开关：基础文风只取一个主方案；局部增强不得反向覆盖它。',
        '- 近期正文样本只用于承接与防重复：延续人物声音和叙事距离，但不要复用其中的台词、比喻、动作模板、意象或桥段。',
        '- 执行 persona 中的【正文方法】，只结合本章合同与项目文风参数实例化，不额外发明互相冲突的风格规则。',
        '- 人物外貌/服饰/装备/身体状态变化写进 characters[].physical；性格/说话风格/口癖的阶段变化写进 characters[].expression。两者都必须填写正文已呈现的 changeReason；无变化则不要申报。',
        '- 在返回 manuscript 前必须调用 skill 工具加载 humanizer-zh，并完成一轮中文人性化润色；只改表达、节奏和句式，不得改动剧情事实、人物状态、伏笔、POV 或 Contract 目标。',
        '- 若 humanizer-zh 无法加载，必须在 problems 中报告并停止交付，不得假装完成润色。',
        '- 字数：约 2000-3000 字（按平台习惯），场景承载信息与情绪。',
        '- 返回 manuscript（正文，不含章节号标题）与 stateChanges（人物/伏笔/时间轴/开放线程）。',
      ].join('\n'),
    })

    if (!out.structured?.manuscript || !String(out.structured.manuscript).trim()) {
      throw new Error(`第${chapterId}章无正文输出（${out.error || '结构化缺失'}）`)
    }
    const stateChanges = out.structured.stateChanges || {}
    const ms = String(out.structured.manuscript).replace(/\n{3,}/g, '\n\n').trim()

    applyWriterStateChanges(projectDir, chapterId, stateChanges)
    syncContractForeshadowing(projectDir, contract, chapterId)
    writeTextAtomic(manuscriptPath,
      `# 第 ${Number(chapterId)} 章${contract.title ? '：' + contract.title : ''}\n\n> POV: ${contract.pov || ''} ｜ 地点: ${contract.location || ''} ｜ 时间: ${contract.time || ''}\n\n${ms}\n`)
    setChapterState(projectDir, chapterId, 'QA', '正文完成，等待审查')

    return { ok: true, chapter: chapterId, problems: out.structured.problems || [], notes: stateChanges }
  } catch (error) {
    for (const [rel, content] of snapshots) {
      if (content) writeTextAtomic(join(projectDir, rel), content)
    }
    if (previousManuscript !== null) writeTextAtomic(manuscriptPath, previousManuscript)
    else rmSync(manuscriptPath, { force: true })
    setChapterState(projectDir, chapterId, 'REWORK', `Writer 失败：${String(error?.message || error).slice(0, 200)}`)
    addIssue(projectDir, {
      dimension: 'prose', severity: 'high', chapter: chapterId, status: 'open',
      evidence: String(error?.message || error), expected: 'Writer 输出完整正文并完成状态申报',
      actual: '写作任务失败，已回滚状态与手稿', possible_source: 'writer', source: 'writer-runtime',
      recommended_action: '检查子代理输出与 Chapter Contract 后重跑该章',
    })
    throw error
  }
}

function applyWriterStateChanges(projectDir, ch, changes) {
  // 1) story
  if (changes.story) {
    const story = loadStoryState(projectDir)
    const merged = {
      current: {
        chapter: Number(ch),
        location: changes.story.current?.location || story.current.location || '',
        time: changes.story.current?.time || story.current.time || '',
        summary: changes.story.current?.summary || `第${ch}章完成`,
      },
      worldState: { ...(story.worldState || {}), ...(changes.story.worldState || {}) },
      openThreads: changes.openThreads && changes.openThreads.length
        ? [...(story.openThreads || []), ...changes.openThreads.map(t => ({ id: `T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, summary: t, status: 'open' }))]
        : story.openThreads,
      notes: [...(story.notes || []), { chapter: Number(ch), at: nowIso(), note: changes.story.current?.summary || '' }].slice(-50),
    }
    writeState(projectDir, 'story', merged, { reason: `Writer 第${ch}章状态申报` })
  }

  // 2) characters
  if (Array.isArray(changes.characters)) {
    const cs = loadCharacterState(projectDir)
    for (const u of changes.characters) {
      if (!cs.characters[u.id]) {
        // 不存在的 id：记录为问题（写入 notes 会抛出；这里静默收集到 story notes）
        continue
      }
      cs.characters[u.id].state = u.state || cs.characters[u.id].state
      cs.characters[u.id].current = { ...(cs.characters[u.id].current || {}), state: u.state || cs.characters[u.id].current?.state || '', detail: u.detail || '' }
      applyTrackedCharacterPatch(cs.characters[u.id], 'physical', u.physical, ch, [
        'age', 'height', 'weight', 'appearance', 'clothing', 'equipment', 'physicalCondition',
      ])
      applyTrackedCharacterPatch(cs.characters[u.id], 'expression', u.expression, ch, [
        'personality', 'speechStyle', 'catchphrases',
      ])
      cs.characters[u.id].lastSeenChapter = Number(ch)
    }
    writeState(projectDir, 'character', cs, { reason: `Writer 第${ch}章人物状态` })
  }

  // 3) foreshadowing
  if (Array.isArray(changes.foreshadowing)) {
    const fsh = loadForeshadowing(projectDir)
    for (const f of changes.foreshadowing) {
      const action = f.action || 'none'
      if (action === 'plant') {
        fsh.items.push({
          id: `F${String(fsh.nextId).padStart(4, '0')}`,
          summary: f.summary || '',
          plantedAt: Number(ch),
          dueBy: f.dueBy ?? Number(ch) + 20,
          status: 'open',
        })
        fsh.nextId += 1
      } else if (action === 'payoff') {
        const target = fsh.items.find(i => ['open', 'pending'].includes(i.status) && (!f.targetId || i.id === f.targetId) && (!f.summary || i.summary.includes(String(f.summary).slice(0, 12)) || String(f.summary).includes(i.summary.slice(0, 12))))
        if (target) {
          target.status = 'paid_off'
          target.paidOffAt = Number(ch)
        }
      }
    }
    writeState(projectDir, 'foreshadowing', fsh, { reason: `Writer 第${ch}章伏笔登记` })
  }

  // 4) timeline
  if (Array.isArray(changes.timeline)) {
    const tl = loadTimeline(projectDir)
    for (const e of changes.timeline) {
      if (e && e.event) tl.events.push({ chapter: Number(ch), at: nowIso(), time: e.time || '', location: e.location || '', event: e.event })
    }
    writeState(projectDir, 'timeline', tl, { reason: `Writer 第${ch}章时间轴` })
  }
}

function applyTrackedCharacterPatch(character, kind, patch, chapter, allowedFields) {
  if (patch === undefined) return
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(`人物 ${character.name || '未知'} 的 ${kind} 变化必须是对象`)
  }
  const reason = typeof patch.changeReason === 'string' ? patch.changeReason.trim() : ''
  if (!reason) throw new Error(`人物 ${character.name || '未知'} 的 ${kind} 变化缺少 changeReason`)

  const tracked = character[kind] && typeof character[kind] === 'object'
    ? character[kind]
    : { baseline: {}, current: {}, history: [] }
  const current = tracked.current && typeof tracked.current === 'object' ? tracked.current : {}
  const next = { ...current }
  const before = {}
  const after = {}
  for (const field of allowedFields) {
    if (!Object.hasOwn(patch, field)) continue
    before[field] = current[field]
    after[field] = patch[field]
    next[field] = patch[field]
  }
  if (!Object.keys(after).length) return

  character[kind] = {
    baseline: tracked.baseline && typeof tracked.baseline === 'object' ? tracked.baseline : {},
    current: next,
    history: [
      ...(Array.isArray(tracked.history) ? tracked.history : []),
      { chapter: Number(chapter), before, after, reason },
    ].slice(-100),
  }
}

/** 契约里声明的伏笔 plan/payoff 与伏笔库对齐（防止契约与正文脱节） */
function syncContractForeshadowing(projectDir, contract, ch) {
  const fsh = loadForeshadowing(projectDir)
  let changed = false
  for (const f of contract.foreshadowing || []) {
    if (!f || !f.action || f.action === 'none') continue
    if (f.action === 'plant') {
      if (!fsh.items.some(i => i.plantedAt === Number(ch) && i.summary.includes(String(f.summary || '').slice(0, 10)))) {
        fsh.items.push({
          id: `F${String(fsh.nextId).padStart(4, '0')}`,
          summary: f.summary || '(契约伏笔)',
          plantedAt: Number(ch),
          dueBy: f.dueBy ?? Number(ch) + 20,
          status: 'pending',
          source: 'contract',
        })
        fsh.nextId += 1
        changed = true
      }
    } else if (f.action === 'payoff') {
      const target = fsh.items.find(i => ['open', 'pending'].includes(i.status) && ((i.summary || '').includes(String(f.summary || '').slice(0, 10)) || String(f.summary || '').includes((i.summary || '').slice(0, 10))))
      if (target && target.status !== 'paid_off') {
        target.status = 'paid_off'
        target.paidOffAt = Number(ch)
        changed = true
      }
    }
  }
  if (changed) writeState(projectDir, 'foreshadowing', fsh, { reason: `契约-库对齐 第${ch}章` })
}
