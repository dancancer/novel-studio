# 设计文档 → 实现映射（v1.0）

《AI 小说工作室：多 Agent 写书工作流完整规划 v1.0》的每个章节在本仓库的落地位置。
核心原则（§2）与本实现的对应：

| 原则 | 实现 |
|---|---|
| 1. 规划与执行分离；Writer 不擅自修改上游 Canon | 子代理只读（`agents.mjs` 中每个角色的 `tools: {allow:[只读]}`）；写回由编排层代做 |
| 2. 专业分工 | 15 个角色 persona（`agents.mjs` ROLE_PERSONAS），Reviewer Pool 六路并行 |
| 3. Gate = Hard Constraint + Weighted Score | `gates.mjs` runGate：权重面 + 一票否决 + 关键指标下限 |
| 4. Reader/Reviewer 先根因分析再返工 | `novel_diagnose`（症状→根因）→ `novel_rework_execute`（执行）两步分离 |
| 5. 上游修改必须做依赖图影响分析 | `DEPENDENCY_CHAIN`（store.mjs）+ `markDependentsStale` / `dependencyImpact`（§14） |
| 6. Agent 不允许直接自我升级 | `hr.mjs`：候选落 `learning/candidates/`（status=CANDIDATE），HR 验收才 PROMOTE |
| 7. 修作品 / 提升 Agent 两条独立工作流 | Book Loop 工具（`novel_phase_*`/`novel_writer_*`/`novel_review_*`/`novel_reader_*`）与 Agent Loop 工具（`novel_learning_improve`/`novel_hr_validate`） |

## 逐节映射

- **§3 总体架构**：`novel_autopilot`（`operator-autopilot.mjs`，由 `operators.mjs` 注册）按项目状态机自动推进：
  研究 → 设定 → 剧情 → 写作 → 审查 → 读者验证 → 诊断/返工 → 汇报。
- **§4 Agent 组织**：`agents.mjs` ROLE_PERSONAS——planner / deep-researcher /
  research-assistant / world-architect / character-growth-expert / numeric-expert /
  plot-architect / hook-designer / writer / continuity-checker / reviewer /
  reader-instance / diagnosis-analyst / learning-analyst / hr-reviewer。
- **§5 Phase 0**：`novel_init` → `00_project_brief.md`（含协作/AI 托管配置方式、可观察文风参数、连载叙事策略、禁止事项与用户硬约束）；`writing-methodology.mjs` 统一提供世界观、人物、剧情、正文、连载工程和审查方法。连载策略通过 `adaptive/commercial_serial/custom` 调节，不覆盖项目明确的视角、篇幅与文风。
- **§6 Phase 1**：`novel_phase_research`（Step1/2，使用 `web_search`，Fact/Inference/
  Assumption 分级并保留来源 URL，同时在 `01_market_strategy.md` 固化目标读者、核心/辅助
  情绪承诺、期待/厌恶点、兑现频率及可选书名简介承诺 → `research/evidence_index.md`）与
  `novel_phase_setting`（Step3/4/5 三路并行 →
  `02_world_bible.md` / `characters/` / `03_system_rules.md` / character_state）。人物状态把
  外貌/服饰/装备/身体状况与性格/说话风格/口癖分别保存为
  `physical`、`expression` 的 baseline/current/history，Writer 申报变化，Reviewer 校验因果与连续性；
  人物静态档案还记录社会身份、职业、当前生活、短期/长期目标、思维方式、能力边界/代价及资源缺口。
- **§7 Planning Gate**：`GATE_CONFIGS.planning`（世界观15/情节15/人物10/数值10/
  研究10/Planner10/其他30，通过线 70）；一票否决五类在 `vetoDimensions` +
  `phaseSetting` 的 planner 角色评审后自动执行。
- **§8 Phase 2 剧情工程**：`novel_phase_plot`（Book→Volume→Chapter 分层，禁止跳级）；初次总纲包含一句话故事与可配置的前期三阶段窗口。Chapter Contract 在原有剧情字段之外强制保存 `reader_question/protagonist_action/external_feedback/state_delta/next_expectation`，把动作、反应、状态变化与下一轮期待变成可审查协议。
- **§10 Context Builder**：`buildWriterContext`（`operator-production.mjs`）——Global Canon +
  人物状态 + 卷目标 + Chapter Contract + 最近章节摘要与正文末段 + 待回收伏笔 +
  可观察文风参数 + 连载叙事策略与市场情绪承诺 + 禁用词/高频手法 + 禁止事项。
- **§11 专业审查**：`novel_review_run`——六路 Reviewer（剧情/人设/世界观·数值/
  连续性/文笔·事实/伏笔），问题统一结构化（issue_id/severity/evidence/expected/
  actual/possible_source/recommended_action），Reviewer 不改作品；审查明确检查核心情绪兑现、
  主角能动性、真实外部反馈、不可逆状态变化、前后剧情因果和功能性细节。
- **§12 Reader Lab**：`novel_reader_lab_run`——Persona 池默认 学生40%/上班族35%/
  核心20%/资深5%，确定性抽样；行为数据（完读/跳读/弃书点/下一章意愿/伏笔记忆/
  爽点兑现/情绪）；Reader Gate 含 Persona 崩塌与红线一票否决。
- **§13 Diagnosis**：`novel_diagnose`（LLM 根因 + `REWORK_ROUTES` 规则路由 fallback）+
  `novel_rework_execute`（`applyDiagnosis`：回滚到最浅层、影响范围归位、依赖图 STALE）。
- **§14 Dependency Graph**：`state/dependency_graph.json` + `DEPENDENCY_CHAIN` +
  `markDependentsStale`（KEEP/PATCH/REGENERATE/RE-REVIEW 由 Planner 在汇报中决策）。
- **§15 Agent 成长**：Capability Profile（`agents/*.json`：version/capability/
  recentFailures/promotedImprovements/acceptedCases/rejectedCases）；high / blocking 失败由
  `novel_diagnose` 自动记入对应 Agent 档案（`recordFailure`）。
- **§16 HR**：`hrValidate` 五条验收（问题改善/回归无退化/无新高风险/成本延迟/
  泛化性）；默认先执行 Shadow 回归并由独立 HR Reviewer 逐条判定；PROMOTE →
  版本晋升 + 结构化改进注入生产 persona；REJECT → 驳回原因。
- **§17 Artifact 体系**：项目树逐项复刻；每个版本正文独立不可变保存；Artifact 元数据含 ID/Version/Owner/
  Status/Dependencies/CreatedBy/ApprovedBy/Supersedes/ChangeReason；生命周期
  DRAFT→REVIEW→APPROVED→ACTIVE→SUPERSEDED。
- **§18 状态机**：项目级 13 态（`PROJECT_STATES`）与章节级 7 态
  （`CHAPTER_STATES` + `CHAPTER_TRANSITIONS` 合法迁移校验）。
- **§19 Gate 机制**：五类 Gate 独立权重面（`GATE_CONFIGS`），PASS 公式逐字实现。
- **§20 KPI**：`computeKPIs`（作品 KPI：一次通过率/平均返工/伏笔回收/Canon 冲突/
  人物漂移/读者指标）+ Agent KPI（`agents/*.json` kpis）+ 系统 KPI（`reports.mjs`）。
- **§21 Planner 汇报**：`novel_report` 只读生成快照；当前批全部 `ACCEPTED` 后由
  `novel_cycle_close` 持久化 `reports/cycle-NN.md` 并推进周期（本轮完成/作品/问题/
  返工/Agent/风险/下一轮）。
- **§22 实施顺序**：S0-S1 已完整（本实现）；S2 Reader Lab 已有（20-50 起步参数）；
  S3-S5 接口就绪（learning/hr 工具已可跑，规模化参数化扩展）。
- **§23 最终定义**：Planner=总编、Reviewer=QA、Reader Lab=市场测试、Diagnosis=质量
  工程、Learning=培训系统、HR=人力资源、Artifact Store=组织记忆（全部落盘 JSON/Markdown）。
