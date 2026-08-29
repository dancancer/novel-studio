# AI 小说工作室（novel-studio）· DeepSeek Harness 插件

把「AI 写小说」做成一家软件化的**多 Agent 生产工作室**：需求 → 全书规划 →
资料收集 → 世界观 → 人物成长 → 数值体系 → 剧情工程 → 写手写作 →
专业审查 → 读者验证 → 反馈诊断 → 定向返工 / Agent 成长 → HR 验收 → Planner 汇报。
两个闭环同时运转：

```
Book Loop ：规划 → 创作 → 审查 → Reader Test → 反馈 → 返工 → 再验证
Agent Loop：执行 → 失败数据 → 根因分析 → 能力优化 → HR 验收 → Agent 升级
```

本实现严格按《AI 小说工作室：多 Agent 写书工作流完整规划 v1.0》（见
[docs/DESIGN.md](docs/DESIGN.md) 的逐节映射）落地。

---

## 结构

```
novel-studio/
├── plugin/                  # DSH 主机侧插件（Cordis）
│   ├── index.mjs            # 入口：注册 24 个 novel_* 工具
│   ├── operators.mjs        # 工具实现层（阶段编排 / Context Builder / Autopilot）
│   ├── store.mjs            # 存储层：项目树 / Artifact 生命周期 / 状态存储 / 依赖图 / KPI
│   ├── gates.mjs            # Gate 引擎：权重面 + 一票否决 + 关键指标
│   ├── agents.mjs           # 15 个角色 persona + 子代理派发（ctx.subagents）
│   ├── diagnosis.mjs        # 根因诊断 / 返工路由 / 影响分析
│   ├── hr.mjs               # Agent 档案 / 成长候选 / HR 晋升与驳回
│   └── reports.mjs          # Planner 周期汇报 / KPI
├── tests/                   # 单元测试（node --test，116 例，零外部依赖）
├── smoke/                   # 无头冒烟（16 例，不调 LLM）
└── docs/DESIGN.md           # 设计文档 → 实现的逐节映射
```

## 安装（一次）

1. 插件已通过用户补丁层接入运行中的 GUI（`~/.dsh/profiles/web/cordis.patch.yml`）。
2. **重启 GUI**（补丁热重载在当前构建不可用，重启后生效）：

```sh
launchctl kickstart -k gui/$(id -u)/com.xupeng.deepseek-harness.web
```

3. 刷新 `http://127.0.0.1:3080`。重启后聊天中输入“用 novel 工具开一个写书项目”，
   Agent 即可调用 24 个 `novel_*` 工具（启动标记见 `/tmp/novel-studio-boot.log`）。

## 使用流程（在 GUI 里与 Agent 对话即可）

```text
1. novel_init                     # Phase 0：建项目（题材/读者/体量/硬约束）
2. novel_autopilot                # 自动推进：研究 → 设定(含 Planning Gate) → 剧情(含 Plot Gate)
3. novel_writer_write_batch       # 写一批正文（默认 10 章/批，Writer 按 Chapter Contract 生产）
4. novel_review_run               # Reviewer Pool 六路并行审查 + 每章 Chapter Gate
5. novel_reader_lab_run           # Reader Lab（Persona 抽样模拟读者）+ Reader Gate
6. novel_report                   # 只读查看当前周期快照
7. novel_cycle_close              # 当前批全部 ACCEPTED 后持久化报告并推进周期
```

失败路径（闭环自动衔接）：

```text
Gate FAIL / 读者不喜欢
  → novel_diagnose        # 症状 → 根因分类 + 责任权重 + 返工层 + 影响范围
  → novel_rework_execute  # 回滚状态、依赖图下游标 STALE、受影响章节归位
  → 重跑对应阶段           # 再验证 → 直到 PASS
```

Agent 成长（可选，第二轮起）：

```text
high / blocking 失败自动记入 Agent 档案
  → novel_learning_improve        # Learning Agent 产出候选（prompt/skill/memory/sop/fewshot + 回归用例）
  → novel_hr_validate             # HR 验收：PROMOTE（版本晋升）或 REJECT（驳回补证据）
```

常用辅助：`novel_status`（全景状态）、`novel_gate_run`（手动运行任意 Gate）、
`novel_artifact_*`（产物版本与审批）、`novel_state_*`（状态存储读写审计）、
`novel_projects`（扫描已有项目）。

## 模型选择

所有角色子代理默认继承 GUI 面板选择的 provider/model（不写死）。如需按角色
指定模型，可在工具参数中扩展 `agentOptions`（见 `agents.mjs` 的 `spawnRoleAgent`）。

## 设计要点落地

- **规划与执行分离**：子代理只有只读工具；所有写回由编排层代做。
- **研究证据可追溯**：研究角色可使用 `web_search`，市场来源与每条 Fact 的 URL 必须落盘。
- **Gate = 硬约束 + 加权得分 + 关键指标**：五类 Gate 各有权重面（§7/§19）。
- **回滚到最浅返工层**：`diagnosis.mjs` 内置典型返工路由表（§13）。
- **依赖图 STALE**：上游审批/更新自动标下游（§14）。
- **生产版本不可被 Learning 直接覆盖**：候选 → Shadow → Regression → HR 验收（§15/§16）。
- **Artifact 正文不可变版本化**：每次写入保存独立版本文件，读取可指定版本。
- **Reader Gate**：目标 Persona 崩塌与关键红线一票否决（§12）。

## 开发与验证

```sh
# 单元测试（纯逻辑，无依赖）
cd novel-studio && node --test 'tests/*.test.mjs'

# 无头冒烟（需在 harness 仓库目录运行）
cd /Users/xupeng/mycode/deepseek-harness
node --import tsx /Users/xupeng/mybase/novel-studio/smoke/drive.mjs
```

## Git 版本管理

`novel-studio` 源码自身使用独立 Git 仓库，与具体小说项目的历史隔离。
`novel_init` 创建的每个小说项目也会初始化独立仓库，并在调研、设定、
剧情和周期关闭等关键阶段自动提交快照。

```sh
git status
git log --oneline --decorate
git switch -c feature/my-change
git restore --source=HEAD~1 -- path/to/file
```

## 已知限制

- 当前构建的 `cordis.patch.yml` 热重载不可用（watch-only HMR 配置在 chokidar 上
  初始化失败，profile-boot 静默吞错）→ 改动插件源码或补丁后需重启 GUI。
- Web profile 当前只开放服务端 `web_search`，`web_fetch` 因宿主 SSRF 防护策略关闭；
  研究代理使用搜索结果中的来源 URL 建立证据索引。
- Reader Lab 默认每章 3 名读者 × 上限 60 实例；1000 实例需要 `instanceCount`
  上调并按需扩展 `readersPerChapter`（成本随模型计费）。
- 章节写作按序串行（保持状态连续性）；`novel_writer_write_batch` 支持指定
  chapters/range 批量参数。
