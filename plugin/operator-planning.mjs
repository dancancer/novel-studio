import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  addChapterContracts, addIssue, approveArtifact, getArtifacts, getProject,
  loadCharacterState, loadContracts, normalizeChapterId, nowIso, readJsonOr,
  recordGate, resolveStaleNode, saveProject, setWorkflowState, slugify,
  writeArtifact, writeJsonAtomic, writeState, writeTextAtomic,
} from './store.mjs'
import { runGate, getGateRequirements } from './gates.mjs'
import { ROLE_PERSONAS } from './agents.mjs'
import { normalizeSerialStrategy } from './writing-methodology.mjs'
import {
  artifactReadManifest, attemptProjectRole, gitCommit, isHttpUrl, markdownTitle, readArtifactText,
  readMarkdownDirectory, readText, readdirNames, spawnProjectParallel, spawnProjectRole,
} from './operator-common.mjs'

/** Phase 1 Step1-2：市场需求 + 深度研究 */
export async function phaseResearch(ctx, exec, projectDir) {
  const project = getProject(projectDir)
  setWorkflowState(project, 'RESEARCHING', '进入研究阶段')
  saveProject(projectDir, project)

  const briefMd = readText(join(projectDir, '00_project_brief.md'))
  const manifest = artifactReadManifest(projectDir, { stageOutputs: ['01_market_strategy', 'research'] })
  const banner = `【AI 小说工作室 · 深度研究任务】\n\n项目目录：${projectDir}\n\n项目简报已由宿主注入下方，直接以此为准完成任务；不要读取本阶段尚未生成的输出资产。\n\n${manifest}\n\n================ 项目简报 ================\n${briefMd}`

  const results = await spawnProjectParallel(2, ctx, exec, projectDir, [
    {
      role: 'deep-researcher',
      label: '市场需求分析',
      prompt: banner + `\n\n请输出《01_market_strategy.md》全文。除市场定位/竞争格局/差异化卖点/目标读者画像/策略外，还要明确 reader_promise（core_emotion/secondary_emotions/expectations/avoidances/payoff_cadence）；可提供 packaging（title_options/synopsis/promise_consistency）。核心情绪必须是可反复兑现的阅读体验，不能只写题材标签；已有用户配置优先，空缺由研究补齐。\n返回结构化对象：market、differentials、reader_persona、reader_promise、packaging（可选）、strategy、assumptions、sources。`,
    },
    {
      role: 'research-assistant',
      label: '深度资料研究',
      prompt: banner + `\n\n请围绕题材做深度研究，输出证据索引（每条目标注 Fact/Inference/Creative Assumption 与置信度）。\n返回结构化对象：evidence（条目数组）、topics（专题清单）。`,
    },
  ])

  const [market, research] = results
  if (!market?.structured || !research?.structured) {
    const details = results.map(r => `${r.label}: ${r.ok ? '✓' : `✗ ${r.error || '无结构化输出'}`}`).join('\n')
    throw new Error(`novel-studio: 研究阶段产出不完整\n${details}`)
  }

  const marketSources = Array.isArray(market.structured.sources) ? market.structured.sources : []
  const validMarketSources = marketSources.filter(source => isHttpUrl(source?.url))
  if (!validMarketSources.length) {
    throw new Error('novel-studio: 市场研究缺少可验证的 HTTP(S) 来源；未写入研究资产')
  }
  const evidence = Array.isArray(research.structured.evidence) ? research.structured.evidence : []
  const unverifiedFacts = evidence.filter(item => item?.kind === 'Fact' && !isHttpUrl(item.sourceUrl))
  if (unverifiedFacts.length) {
    const ids = unverifiedFacts.map(item => item.id || '未命名 Fact').join(', ')
    throw new Error(`novel-studio: Fact 缺少可验证来源（${ids}）；未写入研究资产`)
  }
  const readerPromise = market.structured.reader_promise
  const promiseErrors = []
  if (!readerPromise || typeof readerPromise !== 'object' || Array.isArray(readerPromise)) {
    promiseErrors.push('reader_promise 缺失')
  } else {
    if (typeof readerPromise.core_emotion !== 'string' || !readerPromise.core_emotion.trim()) promiseErrors.push('core_emotion 为空')
    for (const field of ['secondary_emotions', 'expectations', 'avoidances']) {
      if (!Array.isArray(readerPromise[field])) promiseErrors.push(`${field} 不是数组`)
    }
    if (typeof readerPromise.payoff_cadence !== 'string' || !readerPromise.payoff_cadence.trim()) promiseErrors.push('payoff_cadence 为空')
  }
  if (promiseErrors.length) {
    throw new Error(`novel-studio: 市场研究缺少可执行的读者情绪承诺（${promiseErrors.join('、')}）；未写入研究资产`)
  }

  // 写 01_market_strategy.md
  const strategyMd = market.structured.strategy
    ? [markdownTitle('01_market_strategy', '市场需求与差异化策略'),
      '## 市场定位与竞争格局', market.structured.market || '',
      '## 差异化卖点', (market.structured.differentials || []).map(d => `- ${d}`).join('\n'),
      '## 目标读者画像', (market.structured.reader_persona || []).map(p => `- ${p.segment}（${Math.round((p.ratio || 0) * 100)}%）：${p.traits || ''}`).join('\n'),
      '## 读者情绪承诺', [
        `- 核心情绪：${readerPromise.core_emotion}`,
        `- 辅助情绪：${readerPromise.secondary_emotions.join('、') || '无'}`,
        `- 主要期待：${readerPromise.expectations.join('、') || '待验证'}`,
        `- 厌恶与流失风险：${readerPromise.avoidances.join('、') || '待验证'}`,
        `- 兑现频率：${readerPromise.payoff_cadence}`,
      ].join('\n'),
      ...(market.structured.packaging ? [
        '## 书名与简介承诺',
        `- 书名备选：${(market.structured.packaging.title_options || []).join('；') || '沿用项目书名'}`,
        `- 承诺一致性：${market.structured.packaging.promise_consistency || ''}`,
        '',
        market.structured.packaging.synopsis || '',
      ] : []),
      '## 连载与商业化策略', market.structured.strategy,
      '## 创作假设（Creative Assumption）', (market.structured.assumptions || []).map(a => `- ${a}`).join('\n'),
      '## 来源', validMarketSources.map(source => `- [${source.title || source.url}](${source.url})`).join('\n'),
    ].join('\n\n')
    : market.structured.market || ''
  writeArtifact(projectDir, { id: '01_market_strategy', title: '市场需求与差异化策略', content: strategyMd, owner: 'deep-researcher', changeReason: 'Phase1 Step1 市场需求分析' })

  // 写 research/evidence_index.md
  const evidenceMd = [
    markdownTitle('research', '证据索引 evidence_index'),
    ...evidence.map(e => {
      const source = isHttpUrl(e.sourceUrl)
        ? `\n- 来源：[${e.sourceTitle || e.sourceUrl}](${e.sourceUrl})`
        : ''
      return `### [${e.kind}] ${e.id || ''}（置信度：${e.confidence || '?'}）\n\n${e.claim || ''}\n\n- 计划用途：${e.usedIn || '—'}${source}`
    }),
    '## 专题清单',
    (research.structured.topics || []).map(t => `- ${t}`).join('\n'),
  ].join('\n\n')
  writeArtifact(projectDir, { id: 'research', title: '证据索引', content: evidenceMd, owner: 'research-assistant', changeReason: 'Phase1 Step2 深度资料研究' })

  const pResearch = getProject(projectDir)
  setWorkflowState(pResearch, 'PLANNING', '研究完成，进入设定规划')
  saveProject(projectDir, pResearch)
  gitCommit(projectDir, `research: 完成研究（证据 ${evidence.length} 条）`)
  return {
    action: 'research',
    artifacts: ['01_market_strategy', 'research'],
    evidenceCount: evidence.length,
    sourceCount: validMarketSources.length + evidence.filter(item => isHttpUrl(item.sourceUrl)).length,
    readerPromise,
    topics: research.structured.topics || [],
    next: '运行 novel_phase_setting（世界观/人物/数值），随后由 novel_gate_run(planning) 把关',
  }
}

/** Phase 1 Step3-5：世界观 + 人物 + 数值 */
export async function phaseSetting(ctx, exec, projectDir) {
  const project = getProject(projectDir)
  setWorkflowState(project, 'PLANNING', '设定阶段进行中')
  saveProject(projectDir, project)

  const briefMd = readText(join(projectDir, '00_project_brief.md'))
  const market = readArtifactText(projectDir, '01_market_strategy')
  const evidence = readArtifactText(projectDir, 'research')

  // 修订模式：把上一版设定资产 + 上轮 Planning Gate 的 issue 反馈注入上下文，
  // 让三路子代理在既有底座上对齐修订，而不是每次推倒重造（避免跨资产命名/数值漂移）
  const prevWorld = readArtifactText(projectDir, '02_world_bible')
  const prevChrs = readText(join(projectDir, 'characters', ''))
  const prevSystems = readArtifactText(projectDir, '03_system_rules')
  const prevIssues = (() => {
    try {
      const dir = join(projectDir, 'issues')
      if (!existsSync(dir)) return []
      return readdirNames(dir)
        .filter(f => /^ISSUE-\d+\.json$/.test(f))
        .slice(-12)
        .map(f => readJsonOr(join(dir, f), null))
        .filter(Boolean)
        .map(i => `- [${i.severity}] ${i.dimension}：${(i.evidence || '').slice(0, 200)}`)
        .join('\n')
    } catch { return '' }
  })()
  const revisionCtx = [
    '',
    '==== 上一版设定要点（修订对齐，不得推倒重造） ====',
    prevWorld ? `[02_world_bible 现有 Canon Rules 摘要]\n${prevWorld.split('\n').filter(l => l.startsWith('CR-')).slice(0, 12).join('\n')}` : '（无上一版）',
    prevSystems ? `[03_system_rules 现有刻度摘要]\n${prevSystems.split('\n').filter(l => /S0-|L1 |L2 |L3 |主刻度|境界序列/.test(l)).slice(0, 10).join('\n')}` : '（无上一版）',
    '==== 上轮 Planning Gate 问题反馈（必须逐条吸收） ====',
    prevIssues || '（无历史反馈）',
    '硬性要求：境界体系与跨资产命名以 02_world_bible 的 Canon Rules 为唯一权威；03_system_rules 的数值刻度必须与 02_world_bible 完全一致（同名同轨）；characters 的境界词必须与 02_world_bible / 03_system_rules 一致。',
  ].join('\n\n')

  const manifest = artifactReadManifest(projectDir, { stageOutputs: ['02_world_bible', 'characters', '03_system_rules'] })
  const banner = `【AI 小说工作室 · 设定任务】\n\n项目目录：${projectDir}\n\n简报、市场策略和证据索引已由宿主注入下方，直接以注入内容完成任务。\n\n${manifest}\n\n==== 简报 ====\n${briefMd.slice(0, 4000)}\n\n==== 市场策略要点 ====\n${market.slice(0, 3000)}\n\n==== 证据索引要点 ====\n${evidence.slice(0, 3000)}${revisionCtx}`

  const results = await spawnProjectParallel(3, ctx, exec, projectDir, [
    {
      role: 'world-architect',
      label: '世界观架构',
      prompt: banner + `\n\n先按 persona 的【世界观方法】完成内部校验。输出 canon_rules（不可违反规则清单，必须自洽）+ world_bible（02_world_bible.md 全文）。world_bible 必须区分永久规则/阶段事实/可变状态，并包含：历史、地理、阵营、社会、经济、技术或能力体系；每项关键设定的条件/代价/边界/违反后果/冲突用途；自然呈现方式；关键秘密的信息边界。不要输出内部分析。`,
    },
    {
      role: 'character-growth-expert',
      label: '人物设定',
      prompt: banner + `\n\n先按 persona 的【人物方法】完成内部校验。输出 characters（每人含 id/name/role/motive/desire/fear/misbelief/socialIdentity/occupation/currentLife/shortTermGoal/longTermGoal/thinkingPattern/specialAbility/abilityBoundary/abilityCost/resources/missingResources/personality/speechStyle/catchphrases/voice/knowledgeBoundary/decisionLogic/age/gender/height/weight/appearance/clothing/equipment/physicalCondition/arc/initial_state/pressurePoints/relations）+ character_state（形如 { characters: { id: { name, state, current, relations, arcs } } }，id 必须与 characters 数组一致）。主角的身份与职业必须能自然产生至少十类潜在事件；短期目标必须可执行，能力只能改变解决路径，不能替人物做选择。年龄、性别、身高、体重和稳定外貌作为人物基线；服饰、装备、伤病与可变外貌作为开篇当前状态。核心性格、说话风格和口癖要分别记录为稳定基线与开篇阶段状态，口癖只能在自然语境触发。角色行为要能从欲望、情绪、理解、权衡和主导特质推导，关系与成长都必须有可观察变化和代价。不要输出内部分析。`,
    },
    {
      role: 'numeric-expert',
      label: '数值体系',
      prompt: banner + `\n\n输出：system_rules（03_system_rules.md 全文：战力/经济/等级/资源/时间轴/移动时间，每条规则附验算例子）+ red_lines。`,
    },
  ])

  const [world, characters, numbers] = results
  if (!world?.structured || !characters?.structured || !numbers?.structured) {
    throw new Error('novel-studio: 设定阶段产出不完整，请重试。\n' +
      results.map(r => `${r.label}: ${r.ok ? '✓' : `✗ ${r.error || '无结构化输出'}`}`).join('\n'))
  }
  const semanticErrors = []
  if (!String(world.structured.world_bible || '').trim()) semanticErrors.push('world_bible 为空')
  if (!(world.structured.canon_rules || []).some(rule => String(rule).trim())) semanticErrors.push('canon_rules 为空')
  if (!(characters.structured.characters || []).some(character => character?.id && character?.name)) semanticErrors.push('characters 为空或缺少 id/name')
  for (const [index, character] of (characters.structured.characters || []).entries()) {
    const missingText = [
      'motive', 'desire', 'fear', 'misbelief', 'personality', 'speechStyle',
      'voice', 'decisionLogic', 'socialIdentity', 'occupation', 'currentLife',
      'shortTermGoal', 'longTermGoal', 'thinkingPattern', 'specialAbility', 'abilityBoundary', 'abilityCost',
      'age', 'gender', 'height', 'weight', 'appearance', 'clothing',
    ]
      .filter(field => typeof character?.[field] !== 'string' || !character[field].trim())
    const missingArrays = ['resources', 'missingResources', 'catchphrases', 'knowledgeBoundary', 'equipment', 'physicalCondition', 'arc', 'pressurePoints']
      .filter(field => !Array.isArray(character?.[field]))
    if (!character?.relations || typeof character.relations !== 'object' || Array.isArray(character.relations)) missingArrays.push('relations')
    if (missingText.length || missingArrays.length) {
      semanticErrors.push(`characters[${index}] 缺少 ${[...missingText, ...missingArrays].join(', ')}`)
    }
  }
  if (!String(numbers.structured.system_rules || '').trim()) semanticErrors.push('system_rules 为空')
  if (!(numbers.structured.red_lines || []).some(rule => String(rule).trim())) semanticErrors.push('red_lines 为空')
  if (semanticErrors.length) {
    throw new Error(`novel-studio: 设定阶段语义产出不完整：${semanticErrors.join('；')}；未写入设定资产`)
  }

  // 先在内存中装配全部设定候选；Planning Reviewer 输出通过结构校验前不落盘，
  // 避免非法评分让旧 ACTIVE 版本被提前 supersede。
  const canonList = (world.structured.canon_rules || []).map((c, i) => `${i + 1}. ${c}`).join('\n')
  const worldMd = [
    markdownTitle('02_world_bible', '世界观圣经'),
    '## Canon Rules（不可违反规则）',
    canonList || '- （未提供）',
    '',
    world.structured.world_bible || '',
  ].join('\n')

  // 4) 装配人物档案 + 人物状态候选
  const charState = { characters: {} }
  const charDocs = []
  for (const c of (characters.structured.characters || [])) {
    if (!c.id) continue
    charDocs.push({ id: slugify(c.id), md: [
      `# ${c.name || c.id}（${c.id}）`,
      '',
      `- 角色定位：${c.role || ''}`,
      `- 核心动机：${c.motive || ''}`,
      `- 当前/长期欲望：${c.desire || ''}`,
      `- 恐惧：${c.fear || ''}`,
      `- 错误信念：${c.misbelief || ''}`,
      `- 决策逻辑：${c.decisionLogic || ''}`,
      `- 信息边界：${(c.knowledgeBoundary || []).map(item => `\n  - ${item}`).join('')}`,
      '',
      '## 社会位置与行动资源',
      '',
      `- 社会身份：${c.socialIdentity || ''}`,
      `- 职业/学业/组织职责：${c.occupation || ''}`,
      `- 当前生活状态：${c.currentLife || ''}`,
      `- 短期目标：${c.shortTermGoal || ''}`,
      `- 长期成长方向：${c.longTermGoal || ''}`,
      `- 独特思维方式：${c.thinkingPattern || ''}`,
      `- 特殊能力/专长：${c.specialAbility || ''}`,
      `- 能力边界：${c.abilityBoundary || ''}`,
      `- 能力代价：${c.abilityCost || ''}`,
      `- 已有资源：${(c.resources || []).map(item => `\n  - ${item}`).join('') || '无'}`,
      `- 缺少资源：${(c.missingResources || []).map(item => `\n  - ${item}`).join('') || '无'}`,
      '',
      '## 性格与表达基线',
      '',
      `- 核心性格：${c.personality || ''}`,
      `- 说话风格：${c.speechStyle || ''}`,
      `- 口癖：${(c.catchphrases || []).map(item => `\n  - ${item}`).join('') || '无'}`,
      `- 综合语言指纹：${c.voice || ''}`,
      '',
      '## 外在基线',
      '',
      `- 年龄：${c.age || ''}`,
      `- 性别：${c.gender || ''}`,
      `- 身高：${c.height || ''}`,
      `- 体重/体型：${c.weight || ''}`,
      `- 外貌：${c.appearance || ''}`,
      '',
      '## 开篇当前状态',
      '',
      `- 服饰：${c.clothing || ''}`,
      `- 装备：${(c.equipment || []).map(item => `\n  - ${item}`).join('') || '无'}`,
      `- 身体状况：${(c.physicalCondition || []).map(item => `\n  - ${item}`).join('') || '无异常'}`,
      '',
      '## 成长与关系',
      '',
      `- 成长弧：${(c.arc || []).map(item => `\n  - ${item}`).join('')}`,
      `- 初始状态：${c.initial_state || ''}`,
      `- 压力测试点：${(c.pressurePoints || []).map(item => `\n  - ${item}`).join('')}`,
      '',
    ].join('\n') })
    charState.characters[c.id] = {
      name: c.name,
      role: c.role,
      state: 'initial',
      current: { state: c.initial_state || '', detail: '' },
      relations: (c.relations || {}),
      arcs: c.arc ? { main: { steps: c.arc, progress: 0 } } : {},
      profile: {
        motive: c.motive || '', desire: c.desire || '', fear: c.fear || '',
        misbelief: c.misbelief || '', personality: c.personality || '',
        socialIdentity: c.socialIdentity || '', occupation: c.occupation || '',
        currentLife: c.currentLife || '', shortTermGoal: c.shortTermGoal || '',
        longTermGoal: c.longTermGoal || '', thinkingPattern: c.thinkingPattern || '',
        specialAbility: c.specialAbility || '', abilityBoundary: c.abilityBoundary || '',
        abilityCost: c.abilityCost || '', resources: c.resources || [],
        missingResources: c.missingResources || [],
        speechStyle: c.speechStyle || '', catchphrases: c.catchphrases || [], voice: c.voice || '',
        knowledgeBoundary: c.knowledgeBoundary || [], decisionLogic: c.decisionLogic || '',
      },
      expression: {
        baseline: {
          personality: c.personality || '', speechStyle: c.speechStyle || '',
          catchphrases: c.catchphrases || [], voice: c.voice || '',
        },
        current: {
          personality: c.personality || '', speechStyle: c.speechStyle || '',
          catchphrases: c.catchphrases || [],
        },
        history: [],
      },
      physical: {
        baseline: {
          age: c.age || '', gender: c.gender || '', height: c.height || '',
          weight: c.weight || '', appearance: c.appearance || '',
        },
        current: {
          age: c.age || '', height: c.height || '', weight: c.weight || '',
          appearance: c.appearance || '', clothing: c.clothing || '',
          equipment: c.equipment || [], physicalCondition: c.physicalCondition || [],
        },
        history: [],
      },
    }
  }
  const charStateInput = characters.structured.character_state
  const mergedCharState = { characters: charState.characters }
  if (charStateInput && charStateInput.characters) {
    for (const [id, v] of Object.entries(charStateInput.characters)) {
      if (mergedCharState.characters[id]) {
        mergedCharState.characters[id] = { ...mergedCharState.characters[id], ...v, name: v.name || mergedCharState.characters[id].name }
      } else {
        mergedCharState.characters[id] = { name: v.name || id, ...v, current: v.current || {}, relations: v.relations || {}, arcs: v.arcs || {} }
      }
    }
  }
  const charactersMd = [
    markdownTitle('characters', '人物设定与初始状态'),
    '## 人物档案',
    ...charDocs.map(d => `[${d.id}](characters/${d.id}.md)\n\n${d.md}`),
    '## 初始状态（character_state）',
    '```json',
    JSON.stringify(mergedCharState, null, 2),
    '```',
  ].join('\n\n')

  // 5) 装配数值/时间体系候选
  const systemsMd = [
    markdownTitle('03_system_rules', '数值/时间体系规则'),
    numbers.structured.system_rules || '',
    '',
    '## 数值红线（验算）',
    (numbers.structured.red_lines || []).map(r => `- ${r}`).join('\n'),
  ].join('\n')

  // == Planning Gate：由 planner 角色评审全部规划资产 ==
  const planningRequirements = getGateRequirements('planning')
  const planningScoreDimensions = planningRequirements.requiredScoreDimensions
  const planningIssueDimensions = [...new Set([...planningScoreDimensions, ...planningRequirements.vetoOnlyDimensions])]
  const planReview = await attemptProjectRole(ctx, exec, projectDir, {
    role: 'planner',
    label: '规划资产评审（Planning Gate）',
    prompt: [
      '【Planning Gate 评审任务】',
      `项目目录：${projectDir}`,
      '以下是尚未落盘的设定候选，已由宿主完整注入。不要调用 novel_artifact_read 读取 02_world_bible、characters 或 03_system_rules；它们只会在本轮评审通过结构校验后写入。',
      '请直接审阅下方候选内容，按 Planning Gate 维度（world 世界观/plot 情节/character 人物/numbers 数值/research 深度研究/planner 整体规划/other 其他）逐维评分（0-100）并给出问题清单。',
      '特别检查一票否决项：世界观核心逻辑冲突、主角核心动机不成立、主线无法闭环、用户硬约束违反、关键事实基础错误。',
      '',
      '==== 世界观 ====',
      worldMd.slice(0, 6000),
      '==== 数值 ====',
      systemsMd.slice(0, 4000),
      '==== 人物 ====',
      JSON.stringify(mergedCharState).slice(0, 4000),
      '',
      '返回：{ issues: [{ dimension, severity(blocking/high/medium/low), score, evidence, veto }], scores: { world, plot, character, numbers, research, planner, other } }；scores 只允许这七个维度，值必须是 0-100 的 JSON number；不要把 planning_gate、veto、veto_reasons 等摘要字段放进 scores。',
    ].join('\n'),
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['issues', 'scores'],
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['dimension', 'severity', 'evidence'],
            properties: {
              dimension: { type: 'string', enum: planningIssueDimensions },
              severity: { type: 'string', enum: ['blocking', 'high', 'medium', 'low'] },
              score: { type: 'number' },
              veto: { type: 'boolean' },
              evidence: { type: 'string' },
              recommended_action: { type: 'string' },
            },
          },
        },
        scores: { type: 'object', additionalProperties: true },
      },
    },
  })

  if (planReview?.structured) {
    const invalidScores = []
    const scores = planReview.structured.scores
    if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
      invalidScores.push('scores 必须是对象')
    } else {
      for (const [dimension, score] of Object.entries(scores)) {
        // 模型有时会在 scores 中附带 planning_gate/veto 等摘要字段；Gate 只消费合法评分维度，缺失的合法维度仍由 runGate 判为输入不完整。
        if (!planningScoreDimensions.includes(dimension)) continue
        if (!Number.isFinite(score) || score < 0 || score > 100) {
          invalidScores.push(`scores.${dimension}=${JSON.stringify(score)}`)
        }
      }
    }
    for (const [index, issue] of (planReview.structured.issues || []).entries()) {
      if (issue?.score !== undefined && (!Number.isFinite(issue.score) || issue.score < 0 || issue.score > 100)) {
        invalidScores.push(`issues[${index}].score=${JSON.stringify(issue.score)}`)
      }
    }
    if (invalidScores.length) {
      throw new Error(`novel-studio: Planning Gate 分数非法：${invalidScores.join('；')}；未写入设定资产`)
    }
  }

  // Reviewer 输出已通过结构校验，现在才提交设定候选。
  writeArtifact(projectDir, {
    id: '02_world_bible', title: '世界观圣经', content: worldMd,
    owner: 'world-architect', changeReason: 'Phase1 Step3 世界观设计',
  })
  writeState(projectDir, 'character', mergedCharState, { reason: 'Phase1 Step4 人物设定' })
  for (const doc of charDocs) writeTextAtomic(join(projectDir, 'characters', `${doc.id}.md`), doc.md)
  writeArtifact(projectDir, {
    id: 'characters', title: '人物设定与状态', content: charactersMd,
    owner: 'character-growth-expert', changeReason: 'Phase1 Step4 人物设定',
  })
  writeArtifact(projectDir, {
    id: '03_system_rules', title: '数值/时间体系规则', content: systemsMd,
    owner: 'numeric-expert', changeReason: 'Phase1 Step5 数值体系设计',
  })

  let gate = null
  const issues4gate = []
  // Planning Gate 权重面内合法维度；LLM 输出不规范时归一化到 other，避免 runGate 硬报错
  const PLANNING_SCORE_DIMS = new Set(planningScoreDimensions)
  const PLANNING_ISSUE_DIMS = new Set(planningIssueDimensions)
  const normIssueDim = d => (d && PLANNING_ISSUE_DIMS.has(d) ? d : 'other')
  const normScoreDim = d => (d && PLANNING_SCORE_DIMS.has(d) ? d : 'other')
  if (!planReview?.structured) {
    const row = addIssue(projectDir, {
      dimension: 'planner',
      severity: 'high',
      evidence: planReview?.error || 'Planning Gate 评审没有结构化输出',
      expected: '完整的逐维评分与问题清单',
      actual: '评审输出缺失',
      possible_source: 'planner',
      source: 'planning-gate-review',
      status: 'open',
    })
    issues4gate.push({ issue_id: row.issue_id, dimension: 'planner', severity: 'high', evidence: row.evidence })
  } else {
    for (const it of planReview.structured.issues) {
      const dim = normIssueDim(it.dimension)
      const row = addIssue(projectDir, {
        dimension: dim,
        severity: it.severity,
        score: it.score,
        veto: it.veto,
        evidence: it.evidence,
        expected: it.expected,
        actual: it.actual,
        recommended_action: it.recommended_action,
        possible_source: 'planning',
        source: 'planning-gate-review',
      })
      issues4gate.push({ issue_id: row.issue_id, dimension: dim, severity: it.severity, score: it.score, veto: it.veto, evidence: it.evidence, recommended_action: it.recommended_action })
    }
    // 显式分数覆盖默认扣分
    const scores = planReview.structured.scores || {}
    for (const [dim, score] of Object.entries(scores)) {
      const d = normScoreDim(dim)
      issues4gate.push({ issue_id: `score-${d}`, dimension: d, severity: 'low', score })
    }
  }
  gate = runGate('planning', issues4gate)
  recordGate(projectDir, {
    gate: 'planning',
    target: 'planning-assets',
    pass: gate.pass,
    score: gate.score,
    verdict: gate.decision,
    issues: issues4gate.filter(row => !String(row.issue_id).startsWith('score-')).map(row => row.issue_id),
    evidenceComplete: gate.completeness.complete,
  })

  const p2 = getProject(projectDir)
  if (gate.pass) {
    for (const id of ['01_market_strategy', 'research', '02_world_bible', '03_system_rules', 'characters']) {
      approveArtifact(projectDir, { id, approvedBy: 'planner', activate: true, note: 'Planning Gate PASS' })
    }
    for (const node of ['research', '02_world_bible', '03_system_rules', 'characters']) {
      try { resolveStaleNode(projectDir, node, { disposition: 'RE-REVIEW', note: 'Planning Gate PASS' }) } catch { /* 节点未被标记 STALE */ }
    }
    setWorkflowState(p2, 'PLANNING_REVIEW', 'Planning Gate PASS')
    saveProject(projectDir, p2)
  } else {
    setWorkflowState(p2, 'PLANNING', 'Planning Gate FAIL，待修订')
    saveProject(projectDir, p2)
  }

  gitCommit(projectDir, `setting: 世界观/人物/数值 v${Math.max(...getArtifacts(projectDir).filter(a => a.id === '02_world_bible').map(a => a.version))}，Planning Gate ${gate.pass ? 'PASS' : 'FAIL'}（${gate.score}）`)

  return {
    action: 'setting',
    artifacts: ['02_world_bible', '03_system_rules', 'characters'],
    planningGate: gate,
    next: gate.pass ? '运行 novel_phase_plot 进入剧情工程' : '按 Gate 问题修订设定（见 issue 列表）后重跑 novel_phase_setting 或 novel_gate_run(planning)',
  }
}

/** Phase 2：剧情工程（全书大纲 → 卷纲 → 章纲契约）+ Plot Gate */
export async function phasePlot(ctx, exec, projectDir, opts = {}) {
  const project = getProject(projectDir)
  const briefMd = readText(join(projectDir, '00_project_brief.md'))
  const market = readArtifactText(projectDir, '01_market_strategy')
  const world = readArtifactText(projectDir, '02_world_bible')
  const chars = readMarkdownDirectory(join(projectDir, 'characters')) || JSON.stringify(loadCharacterState(projectDir))
  const systems = readArtifactText(projectDir, '03_system_rules')
  const serialStrategy = normalizeSerialStrategy(project.brief)
  for (const flag of ['regenerateMaster', 'reviewExisting']) {
    if (opts[flag] !== undefined && typeof opts[flag] !== 'boolean') {
      throw new Error(`novel-studio: ${flag} 必须是布尔值`)
    }
  }
  const vols = Number(opts.volumes ?? project.brief.volumeCount ?? 3)
  if (!Number.isSafeInteger(vols) || vols < 1) {
    throw new Error('novel-studio: volumes 必须是正整数')
  }
  const batchSize = Math.max(1, Number(project.brief.chaptersPerBatch) || 10)
  const totalChapters = Math.max(1, vols * (Number(project.brief.chaptersPerVolume) || 40))
  let requestedRange = null
  if (opts.range !== undefined) {
    if (!Array.isArray(opts.range) || opts.range.length !== 2) {
      throw new Error(`novel-studio: Plot range 必须是 1-${totalChapters} 内的有效 [start, end]`)
    }
    requestedRange = opts.range.map(Number)
    if (!requestedRange.every(Number.isSafeInteger) || requestedRange[0] < 1 || requestedRange[1] < requestedRange[0] || requestedRange[1] > totalChapters) {
      throw new Error(`novel-studio: Plot range 必须是 1-${totalChapters} 内的有效 [start, end]`)
    }
  }
  const startChapter = requestedRange ? requestedRange[0] : Number(project.cycle.chapterCursor || 0) + 1
  if (startChapter > totalChapters) {
    throw new Error(`novel-studio: 全部 ${totalChapters} 章契约均已规划，无需继续生成`)
  }
  const endChapter = requestedRange ? requestedRange[1] : Math.min(totalChapters, startChapter + batchSize - 1)
  const reworkingContracts = Boolean(requestedRange)
  const reviewExisting = opts.reviewExisting === true
  const initialPlanning = !reviewExisting && (Number(project.cycle.chapterCursor || 0) === 0 || opts.regenerateMaster === true)
  const currentMaster = readArtifactText(projectDir, '04_master_plot')
  const manifest = artifactReadManifest(projectDir, { stageOutputs: ['04_master_plot'] })

  let data = null
  if (reviewExisting) {
    if (!currentMaster) throw new Error('novel-studio: 没有可重新评审的现有总纲')
    const existing = loadContracts(projectDir)
    const contracts = []
    for (let chapter = startChapter; chapter <= endChapter; chapter++) {
      const row = existing.chapters[normalizeChapterId(chapter)]
      if (!row) throw new Error(`novel-studio: 现有契约缺少第 ${chapter} 章，不能只做重新评审`)
      contracts.push(row)
    }
    const volumeNumbers = [...new Set(contracts.map(row => Number(row.volume) || 1))]
    data = {
      master_plot: currentMaster,
      volumes: volumeNumbers.map(volume => ({
        volume,
        plan: readText(join(projectDir, 'plot', 'volumes', `volume-${String(volume).padStart(2, '0')}.md`)),
      })),
      contracts,
    }
  }

  // 纯参数、范围和只读资产前置条件全部通过后，才公开阶段迁移。
  setWorkflowState(project, 'PLOT_ENGINEERING', '进入剧情工程')
  saveProject(projectDir, project)

  let plotTask = null
  if (!reviewExisting) {
    plotTask = await spawnProjectRole(ctx, exec, projectDir, {
      role: 'plot-architect',
      label: initialPlanning ? '全书剧情规划' : `第${startChapter}-${endChapter}章章节剧情规划`,
      prompt: [
        '【剧情工程任务】',
        `项目目录：${projectDir}`,
        manifest,
        `规划范围：全书 ${vols} 卷；本轮只生成第 ${startChapter}-${endChapter} 章契约。`,
        initialPlanning
          ? `1) 产出 04_master_plot.md 全文：开头先给一句话故事，再写主线/支线/人物线/成长线/感情线/世界事件线/伏笔线 + 全书节奏结构；前 ${serialStrategy.planningHorizonWords} 字必须拆成“建立主角并首次验证 → 进入更大场域 → 完成第一个阶段目标”三阶段，短篇按总字数等比例收缩。`
          : '1) 既有 04_master_plot 已审批，本轮不得重写；返回原总纲摘要用于结构化协议即可。',
        initialPlanning
          ? '2) 产出全部卷级规划（volume_goal/initial_state/main_conflict/midpoint/climax/character_change/world_change/setup/payoff/end_hook）。'
          : '2) 依据既有总纲与卷纲滚动细化，不得改变已审批 Canon。',
        `3) 精确产出第 ${startChapter}-${endChapter} 章契约（chapter/pov/location/time/characters/entry_state/chapter_goal/reader_question/conflict/turning_point/protagonist_action/external_feedback/payoff/emotional_curve/information_revealed/foreshadowing[plant→dueBy]/end_hook/exit_state/state_delta/next_expectation/forbidden_changes）。`,
        '层级铁律：Book → Arc → Volume → Chapter Group → Chapter → Scene，禁止跳级；每章必须回答“本章为什么必须存在”。',
        '契约方法：chapter_goal 写可验证的最小叙事变化；reader_question 写读者当前关心的未闭合缺口；conflict 写目标/阻力/代价；turning_point 写触发条件/人物选择/直接后果；protagonist_action 必须是为人物自身目标采取的具体行动；external_feedback 不能止于震惊；state_delta 写相对 entry_state 的实际变化；next_expectation 必须由本章结果自然产生；information_revealed 写谁通过什么来源得知什么以及仍未知什么。',
        `开篇冲突决策：openingPerspective=${serialStrategy.openingPerspective}。${serialStrategy.openingPerspective === 'close_third_person' ? '第一章采用贴近主角的第三人称。' : '第一章服从项目既定视角和叙事距离，不强制第三人称。'} ${serialStrategy.openingPolicy}`,
        '场景因果：在契约文本中按“触发 → 行动或对白 → 反应 → 后果 → 下一节点”设计；根据项目 pacingMode 只选择 slow/balanced/active 之一，不用巧合空降转折。',
        '人物与世界：只使用登记人物和 Canon 条件；角色不得越过 knowledgeBoundary；世界信息应通过制度、环境、物品、习惯和后果自然显现。不要输出内部分析。',
        '',
        '==== 简报 ====',
        briefMd.slice(0, 3000),
        '==== 市场策略与读者情绪承诺 ====',
        market.slice(0, 4500),
        '==== 世界观 ====',
        world.slice(0, 8000),
        '==== 人物 ====',
        chars.slice(0, 4000),
        '==== 数值/时间 ====',
        systems.slice(0, 3000),
        ...(!initialPlanning ? ['==== 已审批总纲 ====', currentMaster.slice(0, 8000)] : []),
      ].join('\n'),
      outputSchema: ROLE_PERSONAS['plot-architect'].outputSchema,
    })
    data = plotTask?.structured
  }

  if (!data || !data.master_plot || !Array.isArray(data.volumes) || !Array.isArray(data.contracts)) {
    throw new Error(`novel-studio: 剧情规划产出不完整（${plotTask?.error || '无结构化输出'}）——请重试 novel_phase_plot`)
  }

  const plotSemanticErrors = []
  if (typeof data.master_plot !== 'string' || !data.master_plot.trim()) plotSemanticErrors.push('master_plot 为空或类型非法')
  // reviewExisting 读取的是可能来自旧版本的已持久化数据；这里仅拦截新子代理候选的语义空值。
  if (!reviewExisting) {
    if (!data.volumes.length) {
      plotSemanticErrors.push('volumes 为空')
    } else {
      for (const [index, volume] of data.volumes.entries()) {
        if (!volume || !Number.isSafeInteger(volume.volume) || volume.volume < 1 || typeof volume.plan !== 'string' || !volume.plan.trim()) {
          plotSemanticErrors.push(`volumes[${index}] 缺少有效 volume/plan`)
        }
      }
      const volumeIds = data.volumes.map(volume => volume?.volume).filter(Number.isSafeInteger)
      const duplicateVolumes = volumeIds.filter((volume, index) => volumeIds.indexOf(volume) !== index)
      const unexpectedVolumes = volumeIds.filter(volume => volume < 1 || volume > vols)
      if (duplicateVolumes.length) plotSemanticErrors.push(`volumes 重复：${[...new Set(duplicateVolumes)].join(', ')}`)
      if (unexpectedVolumes.length) plotSemanticErrors.push(`volumes 越界：${[...new Set(unexpectedVolumes)].join(', ')}`)
      if (initialPlanning) {
        const missingVolumes = Array.from({ length: vols }, (_, index) => index + 1).filter(volume => !volumeIds.includes(volume))
        if (missingVolumes.length) plotSemanticErrors.push(`初次规划缺少卷纲：${missingVolumes.join(', ')}`)
      }
    }
    const contractTextFields = [
      'pov', 'location', 'time', 'entry_state', 'chapter_goal', 'conflict', 'turning_point',
      'reader_question', 'protagonist_action', 'external_feedback', 'state_delta', 'next_expectation',
      'payoff', 'emotional_curve', 'information_revealed', 'end_hook', 'exit_state',
    ]
    for (const [index, contract] of data.contracts.entries()) {
      const missingFields = contractTextFields.filter(field => typeof contract?.[field] !== 'string' || !contract[field].trim())
      const missingArrays = ['characters', 'foreshadowing', 'forbidden_changes']
        .filter(field => !Array.isArray(contract?.[field]))
      const chapter = Number(contract?.chapter)
      if (!Number.isSafeInteger(chapter) || chapter < 1) missingFields.unshift('chapter')
      missingFields.push(...missingArrays)
      if (missingFields.length) plotSemanticErrors.push(`contracts[${index}] 缺少 ${missingFields.join(', ')}`)
    }
  }
  if (plotSemanticErrors.length) {
    throw new Error(`novel-studio: 剧情规划语义产出不完整：${plotSemanticErrors.join('；')}；未进入 Plot Gate，未写入剧情候选`)
  }

  const expectedIds = []
  for (let chapter = startChapter; chapter <= endChapter; chapter++) expectedIds.push(normalizeChapterId(chapter))
  const actualIds = data.contracts.map(row => normalizeChapterId(row.chapter))
  const duplicateIds = actualIds.filter((id, index) => actualIds.indexOf(id) !== index)
  const missingIds = expectedIds.filter(id => !actualIds.includes(id))
  const unexpectedIds = actualIds.filter(id => !expectedIds.includes(id))
  if (duplicateIds.length || missingIds.length || unexpectedIds.length) {
    throw new Error([
      `novel-studio: 剧情规划没有精确覆盖第 ${startChapter}-${endChapter} 章`,
      duplicateIds.length ? `重复：${[...new Set(duplicateIds)].join(', ')}` : '',
      missingIds.length ? `缺失：${missingIds.join(', ')}` : '',
      unexpectedIds.length ? `越界：${unexpectedIds.join(', ')}` : '',
    ].filter(Boolean).join('；'))
  }
  const knownCharacters = loadCharacterState(projectDir).characters || {}
  for (const contract of data.contracts) {
    const missingCharacters = (contract.characters || []).filter(id => id !== 'narrator' && !knownCharacters[id])
    if (missingCharacters.length) {
      throw new Error(`novel-studio: 第 ${normalizeChapterId(contract.chapter)} 章契约引用未知人物 ${missingCharacters.join(',')}（Gate 前校验未通过）`)
    }
  }
  if (!reviewExisting && !reworkingContracts) {
    const existingContracts = loadContracts(projectDir).chapters
    const conflicts = actualIds.filter(id => existingContracts[id])
    if (conflicts.length) throw new Error(`novel-studio: 章节契约已存在，拒绝覆盖：${conflicts.join(', ')}`)
  }

  const pPlot = getProject(projectDir)
  setWorkflowState(pPlot, 'PLOT_REVIEW', `第${startChapter}-${endChapter}章候选进入 Plot Gate`)
  saveProject(projectDir, pPlot)

  const plotDimensions = new Set(getGateRequirements('plot').requiredScoreDimensions)
  const plotReview = await attemptProjectRole(ctx, exec, projectDir, {
    role: 'planner',
    label: `剧情 Plot Gate 评审（第${startChapter}-${endChapter}章）`,
    prompt: [
      '【Plot Gate 评审任务】',
      `项目目录：${projectDir}｜候选范围：第 ${startChapter}-${endChapter} 章`,
      '下方总纲、卷纲与契约是本轮内存候选，已由宿主完整注入。请直接审阅，不要用 novel_artifact_read 尝试读取尚未落盘的 04_master_plot 或 chapter/*。',
      '按 structure/hook/payoff/emotion/character_growth/info_release/foreshadow/pacing 八个维度逐维评分 0-100。',
      '重点验证每章 reader_question → protagonist_action → external_feedback → state_delta → next_expectation 是否闭环；反馈不能只有配角震惊，延迟兑现必须有局部进展，上一单元结果应成为下一单元的条件、机会、代价或麻烦。',
      '第一章按项目 openingPerspective 审查，不得把“贴近主角第三人称”当成所有项目的强制规则；同时检查具体场景、身份处境、现实问题、主线扰动与关键行动是否及时建立。',
      '检查一票否决：主线结构断裂、伏笔矛盾、人物成长弧冲突；问题必须给出具体证据。',
      '返回 { issues: [{dimension,severity,score?,veto?,evidence,recommended_action}], scores: {dimension: score} }。',
      '==== 总纲 ====',
      String(initialPlanning ? data.master_plot : currentMaster).slice(0, 8000),
      '==== 卷纲 ====',
      JSON.stringify(data.volumes).slice(0, 6000),
      '==== 本批契约 ====',
      JSON.stringify(data.contracts, null, 2).slice(0, 16000),
    ].join('\n'),
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['issues', 'scores'],
      properties: {
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['dimension', 'severity', 'evidence'],
            properties: {
              dimension: { type: 'string', enum: [...plotDimensions] },
              severity: { type: 'string', enum: ['blocking', 'high', 'medium', 'low'] },
              score: { type: 'number' },
              veto: { type: 'boolean' },
              evidence: { type: 'string' },
              recommended_action: { type: 'string' },
            },
          },
        },
        scores: { type: 'object', additionalProperties: true },
      },
    },
  })

  if (plotReview?.structured) {
    const malformed = []
    const review = plotReview.structured
    const allowedIssueKeys = new Set(['dimension', 'severity', 'score', 'veto', 'evidence', 'recommended_action'])
    if (!Array.isArray(review.issues)) {
      malformed.push('issues 必须是数组')
    } else {
      for (const [index, issue] of review.issues.entries()) {
        if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
          malformed.push(`issues[${index}] 必须是对象`)
          continue
        }
        const extraKeys = Object.keys(issue).filter(key => !allowedIssueKeys.has(key))
        if (extraKeys.length) malformed.push(`issues[${index}] 包含未知字段 ${extraKeys.join(', ')}`)
        if (!plotDimensions.has(issue.dimension)) malformed.push(`issues[${index}].dimension=${JSON.stringify(issue.dimension)}`)
        if (!['blocking', 'high', 'medium', 'low'].includes(issue.severity)) malformed.push(`issues[${index}].severity=${JSON.stringify(issue.severity)}`)
        if (typeof issue.evidence !== 'string' || !issue.evidence.trim()) malformed.push(`issues[${index}].evidence 为空或类型非法`)
        if (issue.score !== undefined && (!Number.isFinite(issue.score) || issue.score < 0 || issue.score > 100)) {
          malformed.push(`issues[${index}].score=${JSON.stringify(issue.score)}`)
        }
        if (issue.veto !== undefined && typeof issue.veto !== 'boolean') malformed.push(`issues[${index}].veto 必须是布尔值`)
        if (issue.recommended_action !== undefined && typeof issue.recommended_action !== 'string') {
          malformed.push(`issues[${index}].recommended_action 必须是字符串`)
        }
      }
    }
    if (!review.scores || typeof review.scores !== 'object' || Array.isArray(review.scores)) {
      malformed.push('scores 必须是对象')
    } else {
      for (const [dimension, score] of Object.entries(review.scores)) {
        if (!plotDimensions.has(dimension)) malformed.push(`scores 包含未知维度 ${JSON.stringify(dimension)}`)
        if (!Number.isFinite(score) || score < 0 || score > 100) malformed.push(`scores.${dimension}=${JSON.stringify(score)}`)
      }
    }
    if (malformed.length) {
      throw new Error(`novel-studio: Plot Gate 评审输出非法：${malformed.join('；')}；未写入剧情候选`)
    }
  }

  const gateInputs = []
  const persistedIssueIds = []
  for (const issue of (plotReview?.structured?.issues || [])) {
    const dimension = plotDimensions.has(issue.dimension) ? issue.dimension : 'structure'
    const row = addIssue(projectDir, {
      ...issue,
      dimension,
      severity: issue.severity || 'high',
      possible_source: issue.possible_source || 'plot-architect',
      source: 'plot-gate-review',
      chapter: `${normalizeChapterId(startChapter)}-${normalizeChapterId(endChapter)}`,
      status: 'open',
    })
    persistedIssueIds.push(row.issue_id)
    gateInputs.push({ ...issue, issue_id: row.issue_id, dimension, severity: row.severity })
  }
  for (const [dimension, score] of Object.entries(plotReview?.structured?.scores || {})) {
    if (plotDimensions.has(dimension) && Number.isFinite(score) && score >= 0 && score <= 100) {
      gateInputs.push({ issue_id: `score-${startChapter}-${dimension}`, dimension, severity: 'low', score })
    }
  }
  if (!plotReview?.structured) {
    const row = addIssue(projectDir, {
      dimension: 'structure', severity: 'high', status: 'open', source: 'plot-gate-review',
      evidence: plotReview?.error || 'Plot Gate 评审没有结构化输出',
      expected: '八维完整评分', actual: '评审输出缺失', possible_source: 'planner',
    })
    persistedIssueIds.push(row.issue_id)
    gateInputs.push({ issue_id: row.issue_id, dimension: 'structure', severity: 'high', evidence: row.evidence })
  }
  const gate = runGate('plot', gateInputs)
  recordGate(projectDir, {
    gate: 'plot', target: `chapters ${startChapter}-${endChapter}`, pass: gate.pass,
    score: gate.score, verdict: gate.decision, issues: persistedIssueIds,
    evidenceComplete: gate.completeness.complete,
  })

  writeJsonAtomic(join(projectDir, 'reviews', `plot-${normalizeChapterId(startChapter)}-${normalizeChapterId(endChapter)}.json`), {
    range: [startChapter, endChapter], at: nowIso(), gate, issueIds: persistedIssueIds,
    candidate: { master_plot: initialPlanning ? data.master_plot : undefined, volumes: data.volumes, contracts: data.contracts },
  })

  let masterWritten = false
  if (initialPlanning) {
    writeArtifact(projectDir, {
      id: '04_master_plot', title: '全书剧情总纲', content: data.master_plot,
      owner: 'plot-architect', changeReason: `Phase2 全书规划，第${startChapter}-${endChapter}章候选`,
    })
    masterWritten = true
  }

  if (gate.pass) {
    if (masterWritten) approveArtifact(projectDir, { id: '04_master_plot', approvedBy: 'planner', activate: true, note: 'Plot Gate PASS' })
    if (!reviewExisting) {
      for (const v of data.volumes || []) {
        const text = typeof v.plan === 'string' ? v.plan : JSON.stringify(v, null, 2)
        writeTextAtomic(join(projectDir, 'plot', 'volumes', `volume-${String(v.volume).padStart(2, '0')}.md`), text)
      }
      addChapterContracts(projectDir, data.contracts, { owner: 'plot-architect', overwrite: reworkingContracts })
    }
    for (const node of ['04_master_plot', 'volumes', 'chapters']) {
      try { resolveStaleNode(projectDir, node, { disposition: 'RE-REVIEW', note: `Plot Gate PASS，第${startChapter}-${endChapter}章` }) } catch { /* 非 STALE */ }
    }
    const current = getProject(projectDir)
    setWorkflowState(current, 'WRITING', `Plot Gate PASS，第${startChapter}-${endChapter}章可生产`)
    saveProject(projectDir, current)
  }

  gitCommit(projectDir, `plot: Plot Gate ${gate.pass ? 'PASS' : 'FAIL'}，第${startChapter}-${endChapter}章（${gate.score ?? 'incomplete'}）`)
  return {
    action: 'plot',
    volumes: (data.volumes || []).map(v => v.volume),
    contracts: (data.contracts || []).map(c => c.chapter),
    plotGate: gate,
    issueIds: persistedIssueIds,
    next: gate.pass ? '运行 novel_writer_write_batch 生产本批正文' : '按 Plot Gate 问题修订后重跑 novel_phase_plot；失败候选不会推进章节游标',
  }
}
