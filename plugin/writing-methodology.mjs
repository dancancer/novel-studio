/**
 * 可复用的长篇小说方法论与项目级文风参数。
 *
 * 这里仅保留创作方法，不混入模型适配、对话伪装、显式思维链或互动角色控制规则。
 */

export const DEFAULT_WRITING_STYLE = Object.freeze({
  baseStyle: '平衡',
  narrativeDistance: '限知',
  sentenceRhythm: '长短交错',
  paragraphMode: '长短交错，对白独立成段',
  psychologyDensity: '中',
  dialogueTone: '自然',
  descriptionFocus: Object.freeze(['动作', '对白', '环境']),
  rhetoricDensity: '低至中',
  tone: '克制自然',
  pacingMode: 'balanced',
  endingMode: '服从 Chapter Contract',
  styleNotes: '',
  bannedWords: Object.freeze([]),
  overusedDevices: Object.freeze([]),
})

export const DEFAULT_SERIAL_STRATEGY = Object.freeze({
  mode: 'adaptive',
  coreEmotionalPromise: '由 AI 根据题材、平台与目标读者研究确定',
  secondaryEmotionalPromises: Object.freeze([]),
  readerExpectations: Object.freeze([]),
  readerAvoidances: Object.freeze([]),
  payoffCadence: '由 AI 根据题材、平台与章节功能确定',
  planningHorizonWords: 60000,
  openingPerspective: 'follow_project_style',
  openingPolicy: '服从项目叙事视角，从具体场景、主角身份和当前现实问题切入',
  agencyPolicy: '目标来自人物自身，并随阶段推进提高主角主动发起行动的比例',
  detailPolicy: '只保留推进事件、提供必要信息、深化人物、改变关系、制造或兑现期待、增强可信度的细节',
})

function text(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function list(value, fallback = []) {
  return Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean)
    : [...fallback]
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

/** 兼容旧项目的扁平 brief 字段和新项目的 writingStyle 对象。 */
export function normalizeWritingStyle(brief = {}) {
  const nested = brief?.writingStyle && typeof brief.writingStyle === 'object'
    ? brief.writingStyle
    : {}
  const value = key => nested[key] ?? brief[key]
  return {
    baseStyle: text(value('baseStyle'), DEFAULT_WRITING_STYLE.baseStyle),
    narrativeDistance: text(value('narrativeDistance'), DEFAULT_WRITING_STYLE.narrativeDistance),
    sentenceRhythm: text(value('sentenceRhythm'), DEFAULT_WRITING_STYLE.sentenceRhythm),
    paragraphMode: text(value('paragraphMode'), DEFAULT_WRITING_STYLE.paragraphMode),
    psychologyDensity: text(value('psychologyDensity'), DEFAULT_WRITING_STYLE.psychologyDensity),
    dialogueTone: text(value('dialogueTone'), DEFAULT_WRITING_STYLE.dialogueTone),
    descriptionFocus: list(value('descriptionFocus'), DEFAULT_WRITING_STYLE.descriptionFocus),
    rhetoricDensity: text(value('rhetoricDensity'), DEFAULT_WRITING_STYLE.rhetoricDensity),
    tone: text(value('tone'), DEFAULT_WRITING_STYLE.tone),
    pacingMode: text(value('pacingMode'), DEFAULT_WRITING_STYLE.pacingMode),
    endingMode: text(value('endingMode'), DEFAULT_WRITING_STYLE.endingMode),
    styleNotes: text(value('styleNotes'), DEFAULT_WRITING_STYLE.styleNotes),
    bannedWords: list(value('bannedWords'), DEFAULT_WRITING_STYLE.bannedWords),
    overusedDevices: list(value('overusedDevices'), DEFAULT_WRITING_STYLE.overusedDevices),
  }
}

export function renderWritingStyle(brief = {}) {
  const style = normalizeWritingStyle(brief)
  return [
    `- 基础文风（只取一个主方案）：${style.baseStyle}`,
    `- 叙事距离：${style.narrativeDistance}`,
    `- 句段节奏：${style.sentenceRhythm}；段落：${style.paragraphMode}`,
    `- 心理密度：${style.psychologyDensity}；对白气质：${style.dialogueTone}`,
    `- 描写重点：${style.descriptionFocus.join('、') || '按场景功能决定'}`,
    `- 修辞密度：${style.rhetoricDensity}；整体氛围：${style.tone}`,
    `- 推进速度：${style.pacingMode}；结尾方式：${style.endingMode}`,
    `- 项目禁用词：${style.bannedWords.join('、') || '无'}`,
    `- 已过度使用的手法：${style.overusedDevices.join('、') || '无'}`,
    `- 补充文风说明：${style.styleNotes || '无'}`,
  ].join('\n')
}

/** 商业连载方法是可配置策略，不覆盖项目明确选择的视角、篇幅或文风。 */
export function normalizeSerialStrategy(brief = {}) {
  const nested = brief?.serialStrategy && typeof brief.serialStrategy === 'object'
    ? brief.serialStrategy
    : {}
  const value = key => nested[key] ?? brief[key]
  const mode = ['adaptive', 'commercial_serial', 'custom'].includes(value('serialMode'))
    ? value('serialMode')
    : ['adaptive', 'commercial_serial', 'custom'].includes(nested.mode)
      ? nested.mode
      : DEFAULT_SERIAL_STRATEGY.mode
  const openingPerspective = ['follow_project_style', 'close_third_person'].includes(value('openingPerspective'))
    ? value('openingPerspective')
    : DEFAULT_SERIAL_STRATEGY.openingPerspective
  const targetWords = positiveInteger(brief.targetWords, DEFAULT_SERIAL_STRATEGY.planningHorizonWords)
  return {
    mode,
    coreEmotionalPromise: text(value('coreEmotionalPromise'), DEFAULT_SERIAL_STRATEGY.coreEmotionalPromise),
    secondaryEmotionalPromises: list(value('secondaryEmotionalPromises'), DEFAULT_SERIAL_STRATEGY.secondaryEmotionalPromises),
    readerExpectations: list(value('readerExpectations'), DEFAULT_SERIAL_STRATEGY.readerExpectations),
    readerAvoidances: list(value('readerAvoidances'), DEFAULT_SERIAL_STRATEGY.readerAvoidances),
    payoffCadence: text(value('payoffCadence'), DEFAULT_SERIAL_STRATEGY.payoffCadence),
    planningHorizonWords: positiveInteger(value('planningHorizonWords'), Math.min(targetWords, DEFAULT_SERIAL_STRATEGY.planningHorizonWords)),
    openingPerspective,
    openingPolicy: text(value('openingPolicy'), DEFAULT_SERIAL_STRATEGY.openingPolicy),
    agencyPolicy: text(value('agencyPolicy'), DEFAULT_SERIAL_STRATEGY.agencyPolicy),
    detailPolicy: text(value('detailPolicy'), DEFAULT_SERIAL_STRATEGY.detailPolicy),
  }
}

export function renderSerialStrategy(brief = {}) {
  const strategy = normalizeSerialStrategy(brief)
  const modeLabels = {
    adaptive: '自适应（依据题材、平台和读者研究决定强度）',
    commercial_serial: '商业连载强化',
    custom: '自定义',
  }
  return [
    `- 连载模式：${modeLabels[strategy.mode]}`,
    `- 核心情绪承诺：${strategy.coreEmotionalPromise}`,
    `- 辅助情绪承诺：${strategy.secondaryEmotionalPromises.join('、') || '待研究'}`,
    `- 读者期待：${strategy.readerExpectations.join('、') || '待研究'}`,
    `- 读者厌恶/流失风险：${strategy.readerAvoidances.join('、') || '待研究'}`,
    `- 核心体验兑现频率：${strategy.payoffCadence}`,
    `- 前期规划窗口：${strategy.planningHorizonWords} 字`,
    `- 开篇视角策略：${strategy.openingPerspective === 'close_third_person' ? '贴近主角的第三人称' : '服从项目既定视角与叙事距离'}`,
    `- 开篇策略：${strategy.openingPolicy}`,
    `- 主角能动性：${strategy.agencyPolicy}`,
    `- 细节策略：${strategy.detailPolicy}`,
  ].join('\n')
}

export const SERIAL_NARRATIVE_METHOD = `【连载叙事工程方法】
- 先确定目标读者反复追读所期待的核心情绪，再决定题材元素、主角身份、成长路线与兑现频率；题材是承诺的载体，不是承诺本身。
- 用“情绪承诺 × 代入载体 × 期待差 × 行动反馈 × 连续成长”检查吸引力。任何一项过弱都要具体修补，不能用抽象的“更爽”“更燃”代替设计。
- 基本故事循环是“原有平衡 → 扰动 → 主角受到具体影响 → 形成读者关心的缺口 → 主角选择并行动 → 人物/组织/环境反馈 → 身份、资源、关系、信息、目标或责任发生变化 → 新的不平衡”。
- 期待差可来自处境、认知、身份、目标、价值或关系。延迟兑现时必须持续给出新线索、局部进展、小反馈、风险升级或次级回报；不能用无限拖延冒充悬念。
- 反馈不能止于配角震惊。必须落到现实状态：评价、利益、资源、权限、关系、对手策略、制度反应、责任、代价或更大的问题至少改变一项。
- 小剧情不能是随机任务列表。上一单元的结果应成为下一单元的条件、机会、代价或麻烦；每轮完成小目标、阻力、行动、反馈和阶段收获，同时扩展主角能处理的问题、影响范围与责任。
- 主角身份必须能自然生产事件；目标要从人物现实需求生长并能转化为当前行动。特殊能力只改变解决问题的路径，不替人物制定目标、做关键选择或自动给出全部答案。
- 成长不只记录能力，还可记录资源、身份、权限、声望、关系、认知、责任、影响范围和选择难度；剧情结束后不得全部恢复原样。
- 开篇优先“具体场景 → 主角视角 → 身份处境 → 当前需求 → 主线相关扰动 → 主角行动 → 第一轮反馈 → 新期待”。视角服从项目配置；只有配置明确要求时才强制贴近主角的第三人称。
- 细节必须至少承担推进事件、提供必要信息、深化人物、改变关系、制造或兑现期待、增强可信度之一。生活化来自职业流程、成本、规则、人情与真实后果，不来自吃饭走路天气的流水账。
- 书名与简介是第一轮叙事承诺：优先呈现具体身份、具体行动、熟悉题材元素和差异化反差；不得承诺正文无法持续兑现的体验。`

export const WORLD_BUILDING_METHOD = `【世界观方法】
- 把设定分成不可违反的永久规则、当前阶段事实和可被剧情改变的状态；不得互相混写。
- 每项大设定都说明适用条件、代价、边界、违反后果，以及它能自然产生的利益冲突或选择困境。
- 世界信息只通过人物能接触到的制度、环境、物品、习惯、语言和后果显现；不要写成设定说明书。
- 只展开当前作品真正会用到的层级。名词不能代替因果，奇观不能代替冲突。
- 为关键秘密标明信息边界：谁知道、从何得知、谁只掌握误解、读者何时能够知道。`

export const CHARACTER_BUILDING_METHOD = `【人物方法】
- 每名核心人物同时建立：长期动机、此刻欲望、恐惧、错误信念、防御方式、关系诉求、秘密、核心性格、说话风格、口癖和信息边界。
- 为人物标明具体社会身份、职业、当前生活状态、短期可执行目标、长期成长方向、独特思维方式、已有/缺少资源；核心人物的身份应能自然产生持续事件。
- 特殊能力必须记录边界与代价。它只改变解决问题的方式，不能替人物决定目标、选择或承担后果；没有特殊能力时明确写“无”，不要为了填表强加金手指。
- 人物外在信息分成基线与当前状态：基线记录年龄、性别、身高、体重和稳定外貌特征；当前状态记录可变化外貌、发型或伤痕、服饰、装备和身体状况。
- 性格与表达也分成稳定基线、当前阶段和变化履历。核心性格写主要特质及其内在矛盾；说话风格写词汇、句长、语速、语气和回避方式；口癖只在自然触发时使用，不能句句重复。
- 用“欲望 → 感性反应 → 对局面的理解 → 后果权衡 → 主导特质 → 选择”校验行为；选择必须能从人物已有条件推导。
- 成长弧采用 Initial → Trigger → Conflict → Decision → Cost → Growth → New State；变化必须付出代价并能在行动中被观察。
- 关系不是标签。记录双方当前利益、期待、误解、权力差和尚未说出口的需求，让关系通过试探、选择、补偿和共同经历渐变。
- 不让角色掌握超出身份、经历和信息来源的事实，也不为推进情节临时降低判断力或改写性格底色。
- 外在变化必须有时间或事件原因：年龄、身高、体重只在时间跨度或明确事件支持时改变；服饰与装备要交代穿脱、取得、消耗、损坏、丢失或转交，并写入变化履历。`

export const PLOT_BUILDING_METHOD = `【剧情方法】
- 从全书承诺逐层拆到卷、章节和场景；每一层都写清进入状态、目标、阻力、选择、代价、变化和退出状态。
- 初次规划必须给出一句话故事，并在项目配置的前期规划窗口内拆出“建立主角并首次验证 → 进入更大场域 → 完成第一个阶段目标”三个阶段；短篇则按实际总字数等比例收缩。
- 每章必须至少推进冲突、人物、信息或情绪中的一项，并产生可验证的状态变化；没有变化的章节应合并或删除。
- 每份 Chapter Contract 都要显式写出：读者当前最关心的问题、主角的具体行动、外部反馈、相对 entry_state 的状态增量，以及由本章结果自然生成的下一轮期待。
- 场景节点按“触发条件 → 人物行动/对白 → 对方或环境反应 → 后果 → 下一节点”串联，转折必须来自已有条件而非巧合空降。
- 推进模式必须唯一：slow 只做最小必要变化；balanced 完成本章目标并自然产生一个新变化；active 至少安排三个因果相连、逐步升级的节点。
- 伏笔必须登记 setup、知情范围、预期回收和 dueBy；兑现要回指铺垫，不能用新设定临时解释。
- 章尾按章节功能选择动作收束、对白收束、闭环、悬念或余韵；不机械升华，不用作者总结替代钩子。`

export const WRITING_CORE_METHOD = `【正文方法】
写前只在内部确认：当前时间地点、在场人物与位置、已确认事实、各角色此刻的欲望/情绪/信息/限制、本章最小变化、节点因果、视角边界和连续性风险。不要输出构思或检查过程。

剧情与连续性：
- 事件必须由前文条件、人物动机、环境变化或 Chapter Contract 触发；转场写出必要过程，不用“突然”“忽然”遮盖缺失的铺垫。
- 承接 reader_question，让主角完成 contract 中可观察的 protagonist_action；把 external_feedback 写成真实反应和后果，并确保 state_delta 在正文中发生。章尾的 next_expectation 必须来自本章结果，而不是空降威胁或作者预告。
- 不擅自新增角色、设定或冲突，不让人物无理由介入或离场。重点场景写细，过渡和次要信息简写。
- 全文保持约定人称、焦点视角和叙事距离；限知视角只写焦点人物能够感知、推断或回忆的内容。
- 服饰、装备、伤势、发型和其他外貌状态必须承接人物当前状态；发生变化时写出过程，并在 stateChanges 中申报原因和变化后的完整值。

人物与对白：
- 用选择、动作、停顿、回避、措辞、位置和对物品的处理塑造人物，不用抽象标签宣布性格。
- 每句对白至少承担一项功能：推进动作、暴露立场、改变关系、隐藏信息、制造误解或呈现人物习惯。
- 不同人物保持不同词汇、句长、节奏和回避方式；对白生活化，避免报告式、分析式和机械式表达。
- 性格、说话风格和口癖默认继承当前阶段状态；阶段性转变必须由关键事件、关系变化或成长节点触发，并在 stateChanges 中申报，不能为方便某场戏临时换人格或换声音。

文风与描写：
- 作者隐身。优先白描，让动作、对白、神态、环境与物品变化自行传递情绪、关系和信息。
- 心理活动回应眼前刺激并推动选择；优先自由间接引语，避免连续使用“他想”“她觉得”“他意识到”。
- 有效描写后不追加解释性结论，不用比喻重复说明已经呈现清楚的情绪。
- 细节必须服务人物、氛围、因果或伏笔；不堆无关感官，不把“细腻”误写成逐项罗列。
- 职业流程、金钱/时间成本、组织规则、人情关系和物理后果用于建立可信度，但每段细节仍须服务当前事件、人物选择或后果，不能写成资料展示和日常流水账。
- 不重复近期正文的台词、比喻、动作模板、意象和桥段；不要只换同义词，要更换观察角度、动作选择、节奏或信息呈现方式。

输出：只交付正文和约定的结构化状态，不复述规则，不输出自评、提示词或思维过程。正文以简体中文为主，设定专名除外。`

export const REVIEW_METHOD = `【方法论审查清单】
- 连载承诺：本章是否服务目标读者的核心/辅助情绪承诺；承诺的建立、局部反馈与兑现是否匹配项目频率，是否只制造危机却长期不给回报。
- 期待与能动性：reader_question 是否清楚；主角是否基于自身目标作出选择并采取 protagonist_action，还是长期被系统、反派或巧合推着走。
- 反馈与变化：external_feedback 是否落到评价、利益、资源、权限、关系、策略、制度、责任或代价，而非只有“震惊”；state_delta 是否真实发生且没有在章末恢复原样；next_expectation 是否由结果自然生成。
- 连载因果：上一剧情结果是否成为下一剧情的条件、机会、代价或麻烦；是否出现互不相关的随机任务列表；延迟兑现期间是否持续提供局部进展或次级回报。
- 开篇：第一章是否从配置允许的主角视角和具体场景切入，尽快呈现身份、处境、当前需求、主线相关扰动与行动；是否用百科设定、冗长穿越手续、无因果偶遇或过多支线代替主角故事。
- 因果：节点是否由前文条件和人物选择触发，转场是否有过程，是否用巧合或突发词掩盖铺垫缺失。
- 人物：行为能否从动机、欲望、情绪、关系和已知信息推导；是否出现失智、性格漂移或越权知情。
- 表达状态：核心性格、说话风格与口癖是否继承当前阶段；变化是否有关键事件或成长节点支撑并已申报；口癖是否被机械滥用。
- 外在状态：年龄/身高/体重变化是否有足够时间或事件依据；外貌、服饰、装备、伤势是否与上一章出口一致，取得、消耗、损坏、丢失或转交是否有过程并已申报。
- 视角：人称、焦点和叙事距离是否稳定；是否泄露焦点人物无法感知的信息。
- 文风：基础文风是否稳定；是否作者解释、抽象评判、描写后再总结、无功能细节堆叠。
- 细节：职业流程、成本、规则、人情和环境是否增强可信度并影响压力、选择或后果；删去后六项功能均不受影响的段落应压缩。
- 对白：每句是否有叙事功能；人物声音能否区分；是否报告腔、机械腔或重复已知信息。
- 多样性：是否重复近期章节的台词、比喻、动作模板、意象、桥段或结尾手法；同义替换不算真正变化。
- 结尾：是否符合 Contract 的 end_hook 与项目结尾方式；是否用空泛升华、作者总结或机械悬念收尾。
只引用可定位的正文证据；项目个性化禁用词按简报检查，不把个人偏好冒充通用禁令。`
