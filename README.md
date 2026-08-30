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
├── package.json              # DSH Profile Bundle 清单
├── cordis.patch.yml          # Bundle 的 Cordis 配置层
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

## 安装（Profile Bundle）

### 环境要求

- 已安装可正常启动的 DeepSeek Harness。
- `dsh`、`pnpm` 和 `git` 已加入 `PATH`。
- 已启用 DSH 的 `web` profile，并能打开 `http://127.0.0.1:3080`。

插件是可信的 Node.js/Cordis 代码。分享或安装前，建议先阅读仓库源码和
`cordis.patch.yml`，确认它会加载哪些工具。

### 从 GitHub 安装（推荐）

在任意目录执行：

```sh
dsh plugin --profile web add github:dancancer/novel-studio
```

`dsh plugin` 会把包安装到 `web` profile，并根据包内 `package.json` 的
`dsh.bundle` 声明自动启用 `cordis.patch.yml`。不需要手动复制插件文件或修改
profile 的 patch。

安装后退出并重启 DSH Web GUI。macOS 当前本机可以执行：

```sh
launchctl kickstart -k gui/$(id -u)/com.xupeng.deepseek-harness.web
```

其他系统使用正常的退出、重新启动方式即可。重启后刷新
`http://127.0.0.1:3080`，新建会话并让 Agent 调用 `novel_*` 工具。

### 从本地目录安装（开发或内测）

如果已经拿到仓库源码，可以用本机绝对路径安装：

```sh
dsh plugin --profile web add /绝对路径/novel-studio
```

也可以先进入仓库目录再执行：

```sh
cd /绝对路径/novel-studio
dsh plugin --profile web add .
```

本地路径只对当前机器有效；分享给其他用户时，应使用 GitHub 安装方式，或让
对方把路径替换成自己的绝对路径。源码或 `cordis.patch.yml` 发生变化后仍需重启
Web GUI。

### 验证、更新与卸载

查看 profile 中是否已安装：

```sh
dsh plugin --profile web list
```

查看最终配置中是否存在插件入口：

```sh
dsh web --dump-default-config | rg -n "novel-studio|dsh-novel-studio"
```

GitHub 安装的包可以更新或移除：

```sh
# 更新当前 profile 中的 dsh-novel-studio
dsh plugin --profile web update dsh-novel-studio

# 卸载插件
dsh plugin --profile web remove dsh-novel-studio
```

更新或卸载后同样需要重启 Web GUI。若使用的是本地路径安装，包名仍然是
`dsh-novel-studio`。

### 直接挂载源码（备用方式）

不想通过 profile 包管理，而是要直接调试源码时，可以在
`~/.dsh/profiles/web/cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: novel-studio
      name: '/绝对路径/novel-studio/plugin/index.mjs'
```

这是与上面两种安装方式互斥的备用方案。不要同时安装 bundle 和手动挂载同一个
`id`，否则会产生重复插件入口。

## 使用方法（在 Web GUI 中与 Agent 对话）

### 1. 创建小说项目

在 DSH Web GUI 新建会话，向 Agent 提供项目的绝对路径和创作约束，并明确要求
调用 `novel_init`。例如：

```text
请调用 novel_init 创建一个小说项目。
rootDir=/Users/me/novels
projectId=my-first-novel
title=我的第一部长篇
genre=玄幻升级
audience=成年网文读者
platform=连载平台
targetWords=1000000
volumeCount=3
chaptersPerVolume=40
chaptersPerBatch=10
hardConstraints=["主角不降智", "关键规则前后一致"]
```

`rootDir` 必须是绝对路径。工具会创建
`<rootDir>/<projectId>`，并返回后续工具要使用的 `projectDir`。之后所有
`novel_*` 调用都应继续使用这个 `projectDir`，不要把插件源码目录当成小说项目目录。
每个小说项目会有自己的项目树和 Git 历史，与 `novel-studio` 源码仓库隔离。

### 2. 自动模式（推荐）

拿到 `projectDir` 后，重复让 Agent 调用 `novel_autopilot`：

```text
请对 projectDir=/Users/me/novels/my-first-novel 运行 novel_autopilot。
按状态机只推进下一个安全阶段；如果 Gate 失败，不要绕过 Gate，先报告问题和下一步。
```

每次调用推进一个下一个阶段，并在结果中给出下一步建议。正常顺序是：研究 →
世界观/人物/数值设定 → 剧情工程 → 批量写作 → 专业审查 → Reader Lab →
周期汇报与关闭。发生失败时，Autopilot 会优先处理诊断、返工和过期依赖，不会因为
还有待写章节就跳过失败环节。

### 3. 手动模式

需要控制每个阶段时，按以下顺序调用工具。每次都传入同一个 `projectDir`：

```text
novel_phase_research          # 市场策略、资料研究和证据索引
novel_phase_setting           # 世界观、人物成长、数值体系和 Planning Gate
novel_phase_plot              # 总纲、卷纲、Chapter Contract 和 Plot Gate
novel_writer_write_batch      # 按契约生产下一批正文
novel_review_run              # Reviewer Pool 和 Chapter Gate
novel_reader_lab_run          # Persona 抽样和 Reader Gate
novel_report                  # 查看当前周期的只读汇报
novel_cycle_close             # 当前批全部 ACCEPTED 后关闭周期
```

常用参数可以直接告诉 Agent：

- `novel_writer_write_batch`：传 `chapters=[1,2,3]` 或 `range=[1,10]` 指定章节；不传时使用下一批 PLANNED 章节，数量取初始化时的 `chaptersPerBatch`，默认 10 章。
- `novel_review_run`：传 `chapters=[...]` 只审查指定章节；不传时审查所有 QA 章节。
- `novel_reader_lab_run`：传 `readersPerChapter`、`instanceCount` 或 `personaMix` 调整读者抽样；默认每章 3 名读者，实例上限 60。
- `novel_cycle_close`：只有当前批所有章节都是 `ACCEPTED` 时才会推进周期并保存报告。

例如：

```text
请对 /Users/me/novels/my-first-novel 执行 novel_writer_write_batch，生产第 1 到第 10 章。
完成后再对同一目录执行 novel_review_run 和 novel_reader_lab_run。
```

### 4. Gate 失败与返工

当 Chapter Gate 或 Reader Gate 失败时，不要直接覆盖已生成的产物。让 Agent 按以下
闭环处理：

```text
novel_status                  # 查看状态和未关闭的 ISSUE-xxxx
novel_diagnose                # issueIds=[...]，分析根因、责任 Agent 和返工层
novel_rework_execute          # 使用 diagnosisId 执行状态回滚和依赖失效标记
重跑对应阶段                  # 重新生成、审批、审查，再做 Reader 验证
```

也可以直接再次调用 `novel_autopilot`，由 Planner 自动选择诊断、返工或再验证。
只有 Gate 通过并完成相应审批后，下游产物才会继续生产。

### 5. 查看项目状态与产物

遇到中断或需要核对上下文时，优先使用这些只读工具：

```text
novel_status          # 项目全景状态、章节游标、Gate 和问题
novel_chapter_read    # 查看指定章节的契约、正文和故事状态
novel_artifact_list   # 查看产物版本和审批状态
novel_artifact_read   # 读取指定产物版本
novel_report          # 查看当前周期汇报
novel_projects        # 扫描某个 rootDir 下由 novel_init 创建的项目
```

### 6. Agent 能力成长（可选）

出现 `high` 或 `blocking` 级失败后，可以让 Agent 执行 `novel_learning_improve`，
为指定 `agentId` 生成 prompt、skill、memory、SOP 或 few-shot 候选及回归用例；再用
`novel_hr_validate` 做 Shadow/Regression 验收。候选不会直接覆盖生产版本，HR 通过后
才会晋升。

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
