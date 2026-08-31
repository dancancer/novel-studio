import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  approveArtifact, getArtifacts, getProject, initProject, loadCharacterState,
  loadContracts, loadForeshadowing, loadStoryState, loadTimeline, normalizeChapterId,
  projectSnapshot, readArtifact, readJsonOr, readState, recordGate,
  resolveManuscriptPath, saveProject, setWorkflowState, slugify, writeArtifact,
  writeState,
} from './store.mjs'
import { runGate, renderGateResult, GATE_CONFIGS } from './gates.mjs'
import { listRoles } from './agents.mjs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  extractMarkdownSection, gitCommit, readText, renderToolText, requireProject,
} from './operator-common.mjs'
import { buildWriterContext, phaseWriteBatch } from './operator-production.mjs'
import { phasePlot, phaseResearch, phaseSetting } from './operator-planning.mjs'
import { phaseReaderLab, phaseReview } from './operator-quality.mjs'
import {
  AGENT_KEYS, phaseCycleClose, phaseDiagnose, phaseHR, phaseLearning, phaseReport, phaseRework,
} from './operator-governance.mjs'
import { autopilotNext } from './operator-autopilot.mjs'
import { canonicalMutationKey, withProjectMutationLock } from './operator-lock.mjs'
import { phaseResultText, statusText } from './operator-render.mjs'

const GATE_KEYS = Object.keys(GATE_CONFIGS)
const READ_ONLY_TOOLS = new Set([
  'novel_status', 'novel_artifact_list', 'novel_artifact_read', 'novel_state_read',
  'novel_chapter_read', 'novel_report', 'novel_projects',
])

/** 注册全部 novel_* 工具 */
export function registerNovelTools(ctx) {
  // 值 schema DSL 不支持 required（仅参数层支持）：输出 schema 统一剥离 required
  const stripRequired = (schema) => JSON.parse(JSON.stringify(schema, (key, value) => key === 'required' ? undefined : value))
  const register = (def) => {
    const execute = READ_ONLY_TOOLS.has(def.name)
      ? def.execute
      : (args, exec) => {
          const key = args?.projectDir
            || (def.name === 'novel_init' ? join(String(args.rootDir), slugify(args.projectId)) : def.name)
          return withProjectMutationLock(canonicalMutationKey(key), () => def.execute(args, exec))
        }
    return ctx.tools.register(defineTool({
      ...def,
      execute,
      output: def.output ? { ...def.output, schema: stripRequired(def.output.schema) } : undefined,
    }))
  }

  /* ---------- 项目与产物 ---------- */
  register({
    name: 'novel_init',
    description: 'AI 小说工作室 Phase 0：初始化项目并配置创作方法。configurationMode=collaborative 时先邀请用户确认配置，ai_managed 时由 AI 自动选择并接管；商业连载方法可用 serialMode 单独调节。',
    parameters: {
      rootDir: { type: 'string', required: true, description: '项目根目录（绝对路径），项目将创建为 <rootDir>/<projectId>' },
      projectId: { type: 'string', required: true, description: '项目 ID（自动 slug 化）' },
      title: { type: 'string', description: '作品名' },
      genre: { type: 'string', description: '题材/类型（如 都市异能/历史架空/玄幻升级）' },
      audience: { type: 'string', description: '目标读者' },
      platform: { type: 'string', description: '发布平台' },
      targetWords: { type: 'number', description: '目标总字数，默认 1000000' },
      volumeCount: { type: 'number', description: '卷数，默认 3' },
      chaptersPerVolume: { type: 'number', description: '每卷章数，默认 40' },
      chaptersPerBatch: { type: 'number', description: '每批生产章数（滚动批次），默认 10' },
      businessGoals: { type: 'array', items: { type: 'string' }, description: '商业目标' },
      referenceWorks: { type: 'array', items: { type: 'string' }, description: '参考作品' },
      configurationMode: { type: 'string', enum: ['collaborative', 'ai_managed'], description: '配置方式：collaborative 用户参与确认；ai_managed AI 全权接管（默认）' },
      baseStyle: { type: 'string', description: '基础文风，只选一个主方案，如 简练/平衡/细腻/干练朦胧' },
      narrativeDistance: { type: 'string', description: '叙事距离，如 客观/限知/贴身主观' },
      sentenceRhythm: { type: 'string', description: '句段节奏，如 短促/长短交错/长句长段' },
      paragraphMode: { type: 'string', description: '段落方式，如 短段为主/长短交错/长段描写为主' },
      psychologyDensity: { type: 'string', description: '心理描写密度：低/中/高' },
      dialogueTone: { type: 'string', description: '对白气质，如 自然/戏剧化/诙谐/克制' },
      descriptionFocus: { type: 'array', items: { type: 'string' }, description: '描写重点，如 动作/环境/五感/心理/视听' },
      rhetoricDensity: { type: 'string', description: '修辞密度：低/中/高' },
      tone: { type: 'string', description: '整体氛围，如 轻快/静谧/克制/紧张/苍凉' },
      pacingMode: { type: 'string', enum: ['slow', 'balanced', 'active'], description: '推进速度；默认 balanced' },
      endingMode: { type: 'string', description: '常用结尾方式，如 动作收束/对白收束/章节闭环/悬念/余韵' },
      styleNotes: { type: 'string', description: '补充文风说明，优先描述可观察特征，不只写作者或作品名' },
      bannedWords: { type: 'array', items: { type: 'string' }, description: '项目级禁用词' },
      overusedDevices: { type: 'array', items: { type: 'string' }, description: '已过度使用、后续需回避的意象/动作模板/桥段' },
      serialMode: { type: 'string', enum: ['adaptive', 'commercial_serial', 'custom'], description: '连载方法强度：adaptive 按题材自适应（默认）；commercial_serial 强化商业连载；custom 使用自定义策略' },
      coreEmotionalPromise: { type: 'string', description: '读者持续追读时反复获得的核心情绪体验，如 能力被验证/关系升温/探索揭秘' },
      secondaryEmotionalPromises: { type: 'array', items: { type: 'string' }, description: '辅助情绪体验' },
      readerExpectations: { type: 'array', items: { type: 'string' }, description: '目标读者最期待看到的内容' },
      readerAvoidances: { type: 'array', items: { type: 'string' }, description: '目标读者厌恶或容易流失的内容' },
      payoffCadence: { type: 'string', description: '核心体验兑现频率，如 每2-3章一次局部反馈、每10章一次阶段兑现' },
      planningHorizonWords: { type: 'number', description: '开书前重点细化的前期字数窗口；默认不超过 60000 字，短篇按总字数收缩' },
      openingPerspective: { type: 'string', enum: ['follow_project_style', 'close_third_person'], description: '开篇视角：服从项目既定文风（默认）或明确采用贴近主角的第三人称' },
      openingPolicy: { type: 'string', description: '开篇切入策略' },
      agencyPolicy: { type: 'string', description: '主角目标来源与主动发起行动的阶段策略' },
      detailPolicy: { type: 'string', description: '职业、生活和环境细节的取舍规则' },
      forbiddenItems: { type: 'array', items: { type: 'string' }, description: '禁止事项' },
      hardConstraints: { type: 'array', items: { type: 'string' }, description: '用户硬约束（Gate 一票否决项）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['projectId', 'projectDir', 'state', 'configurationMode', 'writingStyle', 'serialStrategy'], properties: { projectId: { type: 'string' }, projectDir: { type: 'string' }, state: { type: 'string' }, configurationMode: { type: 'string' }, writingStyle: { type: 'object', additionalProperties: true }, serialStrategy: { type: 'object', additionalProperties: true } } },
      render: (_a, v) => renderToolText([`✅ 项目已创建：**${v.projectId}**\n\n项目目录：\`${v.projectDir}\`\n工作流状态：\`${v.state}\`\n配置方式：\`${v.configurationMode}\`\n基础文风：${v.writingStyle?.baseStyle || '平衡'}｜叙事距离：${v.writingStyle?.narrativeDistance || '限知'}｜推进：${v.writingStyle?.pacingMode || 'balanced'}\n连载策略：${v.serialStrategy?.mode || 'adaptive'}｜前期规划：${v.serialStrategy?.planningHorizonWords || 60000} 字\n\n下一步：运行 \`novel_autopilot\` 或 \`novel_phase_research\` 开始创作。`]),
    },
    execute: async (args, exec) => {
      const { projectId, projectDir, project } = initProject({ projectId: args.projectId, rootDir: args.rootDir, brief: args })
      // 版本管理：项目目录即 git 仓库（迭代历史 = git log / git diff）
      try {
        if (!existsSync(join(projectDir, '.git'))) {
          execFileSync('git', ['-C', projectDir, 'init', '-q'], { stdio: 'ignore' })
        }
        gitCommit(projectDir, 'init: 项目创建（00_project_brief）')
      } catch { /* git 不可用时静默 */ }
      return {
        projectId,
        projectDir,
        state: project.workflow.state,
        configurationMode: project.brief.configurationMode,
        writingStyle: project.brief.writingStyle,
        serialStrategy: project.brief.serialStrategy,
      }
    },
  })

  register({
    name: 'novel_status',
    description: 'AI 小说工作室：查看项目全景状态（工作流状态机/Artifact 生命周期/章节状态/STALE 节点/KPI/问题单）。',
    parameters: {
      projectDir: { type: 'string', required: true, description: '项目目录（绝对路径）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([statusText(v)]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      return projectSnapshot(dir)
    },
  })

  register({
    name: 'novel_artifact_write',
    description: 'AI 小说工作室：写入/更新一个 Artifact（DRAFT）。同一 id 再次写入会版本 +1 并把旧版本标记 SUPERSEDED，同时按依赖图把下游标为 STALE。',
    parameters: {
      projectDir: { type: 'string', required: true, description: '项目目录' },
      artifactId: { type: 'string', required: true, description: 'Artifact id（00_project_brief / 01_market_strategy / 02_world_bible / 03_system_rules / 04_master_plot / research / characters / volume/<NN> / chapter/<NNN>）' },
      content: { type: 'string', required: true, description: 'Artifact 正文（Markdown 或 JSON 文本）' },
      title: { type: 'string', description: '显示标题' },
      owner: { type: 'string', description: '负责人角色，默认 planner' },
      changeReason: { type: 'string', description: '变更原因' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, version: { type: 'number' }, status: { type: 'string' }, supersedes: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] } } },
      render: (_a, v) => renderToolText([`📝 ${v.id} v${v.version}（${v.status}）已写入${v.supersedes ? `，旧版本 v${v.supersedes.version} → SUPERSEDED` : ''}`]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      return writeArtifact(dir, {
        id: args.artifactId,
        content: args.content,
        title: args.title,
        owner: args.owner,
        changeReason: args.changeReason,
      })
    },
  })

  register({
    name: 'novel_artifact_approve',
    description: 'AI 小说工作室：审批 Artifact（DRAFT/REVIEW → APPROVED，再传 activate 转 ACTIVE 供生产消费）。审批通过会按依赖图把下游节点标记 STALE（待复审）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      artifactId: { type: 'string', required: true },
      version: { type: 'number', description: '版本号，默认最新' },
      approvedBy: { type: 'string', required: true, description: '审批人（如 planner）' },
      activate: { type: 'boolean', description: '是否直接激活（ACTIVE），默认 false' },
      note: { type: 'string', description: '审批备注' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([`✅ 审批通过：${v.id} v${v.version} → ${v.status}（审批人：${v.approvedBy || ''}）`, ...(v.pendingDependencies?.length ? [`⚠️ 依赖未就绪：${v.pendingDependencies.join(', ')}`] : [])]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      return approveArtifact(dir, {
        id: args.artifactId,
        version: args.version,
        approvedBy: args.approvedBy,
        activate: args.activate,
        note: args.note,
      })
    },
  })

  register({
    name: 'novel_artifact_list',
    description: 'AI 小说工作室：列出项目全部 Artifact 元数据（id/版本/状态/负责人/审批/依赖）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      status: { type: 'string', enum: ['DRAFT', 'REVIEW', 'APPROVED', 'ACTIVE', 'SUPERSEDED', 'STALE'], description: '按状态过滤' },
    },
    output: {
      schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
      render: (_a, v) => renderToolText(['| id | v | 状态 | 负责人 | 审批 | 依赖 |', '|---|---|---|---|---|---|', ...v.map(a => `| ${a.id} | ${a.version} | ${a.status} | ${a.owner} | ${a.approvedBy || '—'} | ${(a.dependencies || []).join(',') || '—'} |`)]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      const rows = getArtifacts(dir)
      return args.status ? rows.filter(a => a.status === args.status || (args.status === 'STALE' && a.stale)) : rows
    },
  })

  register({
    name: 'novel_artifact_read',
    description: 'AI 小说工作室：按完整精确 ID 读取 Artifact 元数据与正文。小节用 section 读取，不要把小节名拼成 artifactId。未生成的资产默认返回 found=false 和可用 ID，不会造成 Tool call Error；只有业务必须存在时才传 required=true。',
    parameters: {
      projectDir: { type: 'string', required: true },
      artifactId: { type: 'string', required: true, description: '完整精确 ID；先用 novel_artifact_list 发现，不要使用 02 / 02_canon_rules 等缩写或拼接值' },
      version: { type: 'number', description: '读取指定不可变版本；缺省为最新' },
      section: { type: 'string', description: '只返回标题中包含该文本的 Markdown 小节，例如从 02_world_bible 读取 Canon Rules' },
      maxChars: { type: 'number', description: '正文最大字符数（1-200000），默认完整返回' },
      required: { type: 'boolean', description: '该资产/版本/小节在当前业务中是否必须存在；默认 false，缺失时返回可发现结果' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => v.found === false
        ? renderToolText([
            `⚪ Artifact \`${v.requestedArtifactId}\`${v.requestedVersion === undefined ? '' : ` v${v.requestedVersion}`} 尚未生成或不存在（这在项目初期是正常状态）。`,
            `当前可用的完整 Artifact ID：${v.availableArtifactIds?.join(', ') || '（无）'}`,
            v.hint || '',
          ].filter(Boolean))
        : v.sectionFound === false
          ? renderToolText([
              `⚪ Artifact \`${v.meta?.id}\` 存在，但找不到小节 \`${v.requestedSection}\`。`,
              `可用小节：${v.availableSections?.join(', ') || '（无 Markdown 标题）'}`,
            ])
          : renderToolText([`# ${v.meta?.id} v${v.meta?.version} [${v.meta?.status}]`, '', v.content ? String(v.content).slice(0, 6000) : '（无正文）']),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      const maxChars = args.maxChars === undefined ? null : Number(args.maxChars)
      if (maxChars !== null && (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 200000)) {
        throw new Error('novel-studio: maxChars 必须是 1-200000 的整数')
      }
      const rows = getArtifacts(dir)
      const availableArtifactIds = [...new Set(rows.map(row => row.id))].sort()
      const candidates = rows.filter(row => row.id === args.artifactId)
      const requestedVersion = args.version === undefined ? undefined : Number(args.version)
      const versionExists = requestedVersion === undefined
        || candidates.some(row => Number(row.version) === requestedVersion)
      if (!candidates.length || !versionExists) {
        if (args.required) {
          readArtifact(dir, { id: args.artifactId, version: args.version })
        }
        return {
          found: false,
          requestedArtifactId: args.artifactId,
          ...(requestedVersion === undefined ? {} : { requestedVersion }),
          availableArtifactIds,
          availableVersions: candidates.map(row => Number(row.version)).sort((a, b) => a - b),
          hint: 'artifact id 必须使用完整精确值；先用 novel_artifact_list 发现。Canon Rules 等 Markdown 小节应通过 section 参数读取，不是独立 artifact。',
        }
      }
      const artifact = readArtifact(dir, { id: args.artifactId, version: args.version })
      const selected = extractMarkdownSection(artifact.content, args.section)
      if (args.section && !selected) {
        if (args.required) throw new Error(`novel-studio: artifact ${args.artifactId} 中找不到小节 ${args.section}`)
        const availableSections = artifact.content
          .split(/\r?\n/)
          .map(line => line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1]?.trim())
          .filter(Boolean)
        return {
          found: true,
          sectionFound: false,
          requestedSection: args.section,
          meta: artifact.meta,
          content: '',
          availableSections,
          truncated: false,
          totalChars: 0,
        }
      }
      return {
        found: true,
        ...(args.section ? { sectionFound: true } : {}),
        meta: artifact.meta,
        content: maxChars === null ? selected : selected.slice(0, maxChars),
        truncated: maxChars !== null && selected.length > maxChars,
        totalChars: selected.length,
      }
    },
  })

  register({
    name: 'novel_state_read',
    description: 'AI 小说工作室：读取状态存储（story 故事状态 / character 人物状态 / timeline 时间轴 / foreshadowing 伏笔 / dependency 依赖图）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      kind: { type: 'string', required: true, enum: ['story', 'character', 'timeline', 'foreshadowing', 'dependency'] },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([`\`\`\`json\n${JSON.stringify(v, null, 2).slice(0, 8000)}\n\`\`\``]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      return readState(dir, args.kind)
    },
  })

  register({
    name: 'novel_state_write',
    description: 'AI 小说工作室：整体写入状态存储（带结构/引用校验）。写入前请先 novel_state_read 读取当前值再合并修改。',
    parameters: {
      projectDir: { type: 'string', required: true },
      kind: { type: 'string', required: true, enum: ['story', 'character', 'timeline', 'foreshadowing', 'dependency'] },
      data: { type: 'object', required: true, additionalProperties: true, description: '完整新状态对象' },
      reason: { type: 'string', description: '变更原因（审计）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string' }, updatedAt: { type: 'string' } } },
      render: (_a, v) => renderToolText([`💾 ${v.kind} 已写入（${v.updatedAt}）`]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      const res = writeState(dir, args.kind, args.data, { reason: args.reason })
      return { kind: res.kind, updatedAt: res.updatedAt }
    },
  })

  register({
    name: 'novel_chapter_read',
    description: 'AI 小说工作室：读取一章的完整生产上下文（契约 + 正文 + 相关状态）。Writer/Reviewer/Reader 角色用。',
    parameters: {
      projectDir: { type: 'string', required: true },
      chapter: { type: 'number', required: true, description: '章节号' },
      include: { type: 'array', items: { type: 'string' }, description: 'include: contract/manuscript/state/context，默认全部' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([`# 第 ${v.chapter} 章 ${v.contract?.title || ''} [${v.contract?.status}]`, '', `POV: ${v.contract?.pov || ''} ｜ ${v.contract?.location || ''} ｜ ${v.contract?.time || ''}`, '', '## 契约', '```json', JSON.stringify(v.contract, null, 1).slice(0, 4000), '```', '', '## 正文', String(v.manuscript || '（未写）').slice(0, 8000)]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      const ch = normalizeChapterId(args.chapter)
      const book = loadContracts(dir)
      const contract = book.chapters[ch]
      if (!contract) throw new Error(`novel-studio: 章节 ${ch} 无契约（先 novel_phase_plot）`)
      const include = args.include || ['contract', 'manuscript', 'state', 'context']
      const out = { chapter: Number(ch), contract }
      if (include.includes('manuscript')) {
        const md = readText(resolveManuscriptPath(dir, ch) || '')
        if (md) out.manuscript = md
      }
      if (include.includes('state')) {
        out.storyState = loadStoryState(dir)
        const cs = loadCharacterState(dir)
        out.characters = Object.fromEntries((contract.characters || []).filter(id => cs.characters[id]).map(id => [id, cs.characters[id]]))
        out.foreshadowing = loadForeshadowing(dir).items.filter(i => Number(i.plantedAt) === Number(ch) || Number(i.paidOffAt) === Number(ch))
        out.timeline = loadTimeline(dir).events.filter(e => Number(e.chapter) === Number(ch))
      }
      if (include.includes('context') && args.include) {
        out.writerContext = buildWriterContext(dir, ch).ctx
      }
      return out
    },
  })

  /* ---------- Gate ---------- */
  register({
    name: 'novel_gate_run',
    description: 'AI 小说工作室：运行一个 Gate（planning/plot/chapter/reader/release）。PASS = 无硬约束违反 AND 加权得分 >= 阈值 AND 关键指标 >= 下限。',
    parameters: {
      projectDir: { type: 'string', required: true },
      gate: { type: 'string', required: true, enum: GATE_KEYS },
      target: { type: 'string', description: 'Gate 目标，例如 planning-assets / chapters 1-10 / chapter-001' },
      issues: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { issue_id: { type: 'string' }, dimension: { type: 'string' }, severity: { type: 'string', enum: ['blocking', 'high', 'medium', 'low'] }, score: { type: 'number', description: '该维度得分 0-100（缺省按 severity 扣分）' }, veto: { type: 'boolean' }, evidence: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, recommended_action: { type: 'string' } } }, description: '问题清单（来自 Reviewer/Reader/Planner 评审）' },
      criticalMetrics: { type: 'object', additionalProperties: true, description: '关键指标（reader: completion/next_chapter/payoff_delivery 等，0-100）' },
      threshold: { type: 'number', description: '覆盖默认通过线' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => renderToolText([renderGateResult(v)]),
    },
    execute: async (args, _exec) => {
      const dir = requireProject(args.projectDir)
      const result = runGate(args.gate, args.issues || [], { criticalMetrics: args.criticalMetrics, threshold: args.threshold })
      recordGate(dir, {
        gate: args.gate, target: args.target || 'manual', pass: result.pass, score: result.score,
        verdict: result.decision, issues: (args.issues || []).map(issue => issue.issue_id).filter(Boolean),
        evidenceComplete: result.completeness.complete,
      })
      const project = getProject(dir)
      if (args.gate === 'plot') {
        if (result.pass) {
          const latest = getArtifacts(dir).filter(row => row.id === '04_master_plot').sort((a, b) => b.version - a.version)[0]
          if (latest && latest.status !== 'ACTIVE') approveArtifact(dir, { id: '04_master_plot', version: latest.version, approvedBy: 'planner', activate: true, note: 'Manual Plot Gate PASS' })
          setWorkflowState(project, 'WRITING', 'Manual Plot Gate PASS')
        } else setWorkflowState(project, 'PLOT_REVIEW', `Manual Plot Gate ${result.decision}`)
        saveProject(dir, project)
      } else if (args.gate === 'planning') {
        setWorkflowState(project, result.pass ? 'PLANNING_REVIEW' : 'PLANNING', `Manual Planning Gate ${result.decision}`)
        saveProject(dir, project)
      }
      return result
    },
  })

  /* ---------- 阶段 ---------- */
  register({
    name: 'novel_phase_research',
    description: 'AI 小说工作室 Phase 1 Step1-2：市场、目标读者、情绪承诺与兑现频率分析（deep-researcher）+ 深度资料研究（research-assistant，Fact/Inference/Assumption 分级）。产出 01_market_strategy.md 与 research/evidence_index.md。',
    parameters: {
      projectDir: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseResearch(ctx, exec, requireProject(args.projectDir)),
  })

  register({
    name: 'novel_phase_setting',
    description: 'AI 小说工作室 Phase 1 Step3-5：世界观架构 + 人物设定与成长 + 数值体系（三路并行），随后自动运行 Planning Gate（含一票否决检查）。PASS 则规划资产转 ACTIVE。',
    parameters: {
      projectDir: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseSetting(ctx, exec, requireProject(args.projectDir)),
  })

  register({
    name: 'novel_phase_plot',
    description: 'AI 小说工作室 Phase 2：剧情工程与自动 Plot Gate。首次生成一句话故事、前期三阶段规划、总纲/卷纲/首批契约；契约强制记录读者问题、主角行动、外部反馈、状态增量与下一期待。之后按章节游标滚动生成下一批；Gate 失败不推进游标。',
    parameters: {
      projectDir: { type: 'string', required: true },
      volumes: { type: 'number', description: '规划卷数（默认取简报）' },
      range: { type: 'array', items: { type: 'number' }, description: '返工时指定需重建的 [start,end] 契约区间' },
      regenerateMaster: { type: 'boolean', description: '返工是否同时重建全书总纲' },
      reviewExisting: { type: 'boolean', description: '只用当前总纲/卷纲/契约重新执行 Plot Gate，不生成或覆盖剧情资产' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phasePlot(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_writer_write_batch',
    description: 'AI 小说工作室 Phase 3：Writer 按 Chapter Contract 生产正文（Context Builder 装配最小充分上下文），自动完成状态写回（人物/伏笔/时间轴）并把章节转 QA。',
    parameters: {
      projectDir: { type: 'string', required: true },
      chapters: { type: 'array', items: { type: 'number' }, description: '指定章节号；缺省取下一批 PLANNED' },
      range: { type: 'array', items: { type: 'number' }, description: '或传 [start, end] 区间' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseWriteBatch(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_review_run',
    description: 'AI 小说工作室 Phase 4：Reviewer Pool（剧情/人设/世界观/数值/连续性/文笔/伏笔 六路并行）专业审查 + 每章 Chapter Gate。PASS → READER_TEST；FAIL → DIAGNOSIS。',
    parameters: {
      projectDir: { type: 'string', required: true },
      chapters: { type: 'array', items: { type: 'number' }, description: '缺省取所有 QA 章节' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseReview(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_reader_lab_run',
    description: 'AI 小说工作室 Phase 5：Reader Lab（按 Persona 池抽样模拟读者，默认 学生40%/上班族35%/核心20%/资深5%）+ Reader Gate（完读率/下一章意愿/留存/跳读/弃书点/爽点兑现/情绪命中/人物喜爱/伏笔记忆；目标 Persona 崩塌与关键红线一票否决）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      chapters: { type: 'array', items: { type: 'number' }, description: '缺省取 READER_TEST 章节' },
      readersPerChapter: { type: 'number', description: '每章读者数，默认 3' },
      instanceCount: { type: 'number', description: '读者实例总数上限，默认 60（S2 建议 20-50 起步，可扩到 1000）' },
      personaMix: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { segment: { type: 'string' }, ratio: { type: 'number' }, traits: { type: 'string' } } }, description: 'Persona 池覆盖' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseReaderLab(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_diagnose',
    description: 'AI 小说工作室：根因诊断（症状 → 根因分类 + 责任权重 + 返工层 + 影响范围）。blocking 级失败自动记入对应 Agent 档案（连接 Agent Loop）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      issueIds: { type: 'array', items: { type: 'string' }, required: true, description: 'issue id 列表（ISSUE-xxxx）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseDiagnose(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_rework_execute',
    description: 'AI 小说工作室：执行返工（按诊断的返工层回滚状态、依赖图下游标 STALE、影响范围内章节归位）。',
    parameters: {
      projectDir: { type: 'string', required: true },
      diagnosisId: { type: 'string', description: '诊断 id（缺省取最近一次）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, _exec) => phaseRework(requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_learning_improve',
    description: 'AI 小说工作室 Agent Loop：Learning Agent 根据失败记录产出能力改进候选（prompt/skill/memory/sop/fewshot + 回归用例）。候选不会直接生效。',
    parameters: {
      projectDir: { type: 'string', required: true },
      agentId: { type: 'string', required: true, enum: [...AGENT_KEYS], description: '目标 Agent' },
      failureIds: { type: 'array', items: { type: 'string' }, description: '指定失败记录 id（缺省全部近期失败）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseLearning(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_hr_validate',
    description: 'AI 小说工作室 Agent Loop：HR 验收（规则引擎：当前问题改善 + 回归全过 + 无新高风险 + 可泛化）。PROMOTE 晋升 Agent 版本；REJECT 驳回并给原因。',
    parameters: {
      projectDir: { type: 'string', required: true },
      agentId: { type: 'string', required: true, enum: [...AGENT_KEYS] },
      candidateId: { type: 'string', description: '候选 id（缺省取最新）' },
      regressionResults: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { caseId: { type: 'string' }, executed: { type: 'boolean' }, assertion: { type: 'object', additionalProperties: true }, evidence: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] } } }, description: '外部 runner 已执行的回归证据；缺省由工作室自动跑 Shadow + HR 逐条判定' },
      withLLMReview: { type: 'boolean', description: '是否让 hr-reviewer 子代理复核（默认 false，规则为准）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => phaseHR(ctx, exec, requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_report',
    description: 'AI 小说工作室：只读生成当前生产周期的 Planner 汇报快照；不会推进周期或生产批次。',
    parameters: {
      projectDir: { type: 'string', required: true },
      cycle: { type: 'number', description: '周期号（缺省当前）' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([v.report]) },
    execute: async (args, _exec) => phaseReport(requireProject(args.projectDir), args),
  })

  register({
    name: 'novel_cycle_close',
    description: 'AI 小说工作室：在当前批次全部 ACCEPTED 后显式关闭周期，持久化报告并推进 cycle。',
    parameters: {
      projectDir: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([v.report]) },
    execute: async (args, _exec) => phaseCycleClose(requireProject(args.projectDir)),
  })

  register({
    name: 'novel_autopilot',
    description: 'AI 小说工作室：Planner 自动调度 —— 按项目状态机自动推进下一个阶段（研究→设定→剧情→写作→审查→读者验证→诊断/返工→汇报）。适合持续滚动生产。',
    parameters: {
      projectDir: { type: 'string', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderToolText([phaseResultText(v)]) },
    execute: async (args, exec) => autopilotNext(ctx, exec, requireProject(args.projectDir)),
  })

  register({
    name: 'novel_projects',
    description: 'AI 小说工作室：扫描根目录下的全部项目（novel_init 创建的项目）。',
    parameters: {
      rootDir: { type: 'string', required: true, description: '扫描的根目录' },
    },
    output: { schema: { type: 'array', items: { type: 'object', additionalProperties: true } }, render: (_a, v) => renderToolText(v.length ? ['| 项目 | 标题 | 状态 | 目录 |', '|---|---|---|---|', ...v.map(p => `| ${p.projectId} | ${p.title} | ${p.state} | ${p.dir} |`)] : ['（无项目）']) },
    execute: async (args, _exec) => {
      const { readdirSync } = await import('node:fs')
      const entries = existsSync(args.rootDir) ? readdirSync(args.rootDir) : []
      const out = []
      for (const e of entries) {
        const dir = join(args.rootDir, e)
        if (!existsSync(join(dir, 'library', 'project.json'))) continue
        const p = readJsonOr(join(dir, 'library', 'project.json'), null)
        if (p) out.push({ projectId: p.meta.projectId, title: p.meta.title, state: p.workflow.state, dir })
      }
      return out
    },
  })
}
