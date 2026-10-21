# dsh-project-control

[![check](https://github.com/echothesky/dsh-project-control/actions/workflows/check.yml/badge.svg)](https://github.com/echothesky/dsh-project-control/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/dsh-project-control.svg)](https://www.npmjs.com/package/dsh-project-control)
[![license](https://img.shields.io/github/license/echothesky/dsh-project-control.svg)](https://github.com/echothesky/dsh-project-control/blob/main/LICENSE)

[English](https://github.com/echothesky/dsh-project-control/blob/main/README.md) | **简体中文**

面向 [DeepSeek Harness](https://www.deepseek.com/harness/) 的持久项目记忆与模块化开发工作流。

长会话会撞上上下文上限；压缩只留下通用摘要，真正推动工作的决策、约束和未决问题反而丢了；新会话从零开始；多个模块争抢同一个上下文窗口。

`dsh-project-control` 把这些状态**放在模型上下文之外**——以纯文本文件的形式存进你的仓库——每次只把一个精简简报注入回去。

![dsh-project-control 架构图](https://github.com/echothesky/dsh-project-control/raw/main/docs/assets/overview.svg)

## 功能

- **分层简报注入**：项目层（目标、全局约束、模块地图）+ 模块层（模块目标、下一步、模块决策），预算按**字符数**计算（中文不会被低估）。每一步之前以带 source 的 `user/message` 注入；不改写 system prompt，前缀 KV cache 得以保留。
- **持久化记忆库**：决策、约束、术语、未决问题、契约，一条一个 Markdown 文件。模型通过一个工具写入，按精确关键词检索——不做向量检索、不联网。
- **压缩交接**：`compaction/end` 时写交接快照，下一次请求注入 resume 简报。摘要可能遗忘，文件不会。
- **模块化**：模块卡、按工作目录自动绑定会话、模块级检索，一条命令打开隔离的模块会话。
- **契约**：`proposed` / `active` / `breaking` 三种状态；依赖模块的破坏性契约会出现在简报和交接里。
- **按需技能**：把记忆库导出为 `.dsh/skills/*/SKILL.md`，常驻只有名称与描述，正文通过 `skill` 工具按需加载；写入后自动去抖重导出。
- **Web 看板**：会话内「项目记忆」标签页，支持条目列表、搜索过滤、正文展开和最近交接。

## 安装

```sh
# npm
dsh plugin --profile web add dsh-project-control

# Git
dsh plugin --profile web add git+https://github.com/echothesky/dsh-project-control.git

# 本地目录
dsh plugin --profile web add /绝对路径/dsh-project
```

也可以在 Harness UI 里打开 **Settings → Plugins → Add plugin**，搜索 `dsh-project-control`。

> **首次加载客户端后需要重启一次应用。** Harness 会在 Host 生命周期内缓存插件 manifest，「项目记忆」标签页要重启后才进入 boot graph。之后宿主侧改代码可热重载；客户端 bundle 改动刷新页面即可。

## 快速上手

```text
# 让模型记住一条长期事实
"记住：本项目一律用 pnpm，不用 npm"
  → project_remember(type: "constraint", ...)

# 之后的任意会话
"上次为什么选了这个方案？"
  → project_recall(query: "方案")
```

人类命令：

```text
/project                       查看记忆库状态与当前模块绑定
/project export all            重新生成 .dsh/skills
/handoff <下一步>               写交接快照
/module list                   列出模块与绑定
/module use docs               把当前会话绑定到某个模块
/module open docs --worktree   在隔离的 Git worktree 里打开新会话
```

## 工作原理

**简报注入。** 每一步之前，插件生成简报并通过 `agent/pre-step` 追加为带 source 的 `user/message`（`source.kind = "dsh-project"`）。每次注入携带 digest；恢复的会话如果已经能看到相同 digest，就不会重复注入。注入失败时降级为不注入。

**模块与绑定。** 会话按以下优先级绑定模块：显式覆盖（`/module use <id>`，写入 `sessions.json`）→ 会话 cwd 所在的最长模块路径 → 项目级（集成会话）。未绑定的会话看到项目层、模块地图和全部破坏性契约。

**压缩交接。** `compaction/end` 时写 `handoff/latest.md`（目标、模块、下一步、契约、未决问题、最近决策、活跃文件、最近指令），并标记下一次请求注入 resume 简报。周期性交接每 `handoffEveryTurns` 轮刷新一次文件。

**技能导出。** `project_export` 在 `<projectRoot>/.dsh/skills/` 下生成确定性的 `SKILL.md`。技能文件系统 provider 会监听根目录，新导出的技能在下一次请求进入模型目录。

**Worktree 隔离。** `worktree: true` 在全新的 Git worktree 中打开模块会话（分支 `dsh-<module>-<stamp>`）；项目记忆通过 `.dsh` 目录 junction 共享，junction 不可用时退化为快照复制。清理是手动的：`git worktree remove --force <path>` 与 `git branch -D <branch>`。

## 存储结构

所有内容都在 `<projectRoot>/.dsh/` 下，纯 Markdown/JSON，方便审查、diff、版本管理和手工编辑：

```text
.dsh/project/
├── brief.notes.md          # 可选：人工置顶的目标与铁律
├── entries/<type>/<id>.md  # decision | constraint | glossary | question | contract | note
├── modules/<id>.md         # 模块卡：path/owner/status/deps/goal/contract/nextStep
├── sessions.json           # 会话 → 模块的显式绑定
├── handoff/latest.md       # 交接快照
├── catalog.json            # 派生索引，可删可重建
└── brief.md                # 当前简报的人类可读镜像

.dsh/skills/                # 按需生成
├── module-<id>/SKILL.md
├── project-contracts/SKILL.md
└── project-memory/SKILL.md
```

`projectRoot` 是最近的、包含 `.git`（或已存在 `.dsh/project`）的祖先目录；都不存在时使用会话工作目录。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBriefChars` | `1200` | 简报预算（字符数，不是 token） |
| `maxRecallHits` | `5` | `project_recall` 默认条数（1–10） |
| `resumeBriefChars` | `300` | 压缩后 resume 简报预算 |
| `autoHandoff` | `true` | 每 `handoffEveryTurns` 轮刷新交接 |
| `handoffEveryTurns` | `10` | 周期性交接的轮次间隔 |
| `autoExport` | `true` | 写入后自动重导出技能 |
| `autoExportDelayMs` | `1500` | 去抖窗口（200–10000 毫秒） |
| `readOnly` | `false` | 禁止工具写入 |

## 文档

- [设计定稿](https://github.com/echothesky/dsh-project-control/blob/main/docs/dsh-project-design.md)
- 验证记录：[P0](https://github.com/echothesky/dsh-project-control/blob/main/docs/P0-verification.md)、
  [P1](https://github.com/echothesky/dsh-project-control/blob/main/docs/P1-verification.md)、
  [P2](https://github.com/echothesky/dsh-project-control/blob/main/docs/P2-verification.md)、
  [P0.5](https://github.com/echothesky/dsh-project-control/blob/main/docs/P0.5-verification.md)、
  [P3](https://github.com/echothesky/dsh-project-control/blob/main/docs/P3-verification.md)、
  [P4 worktree](https://github.com/echothesky/dsh-project-control/blob/main/docs/P4-worktree-verification.md)
- [发布说明](https://github.com/echothesky/dsh-project-control/blob/main/docs/RELEASE-0.2.0.md)、
  [变更日志](https://github.com/echothesky/dsh-project-control/blob/main/CHANGELOG.md)

## 开发

```sh
node --input-type=module --check < index.js
node --input-type=module --check < client.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
```

用 Harness 插件管理器安装本地目录（`install_bundle` 指向绝对路径），然后关闭/开启 bundle 以重载 Host 代码。

## 已知限制

- 契约是自由文本，破坏性影响的传播依赖模块 `deps` 声明，而非 import 图。
- worktree 清理是手动的；组合中没有 `worktrees` 服务时走 Git CLI 回退。
- 文件读写使用 Node `fs/promises` 直接操作项目目录，未经过 `ctx.fs` 沙箱策略。
- 直接编辑 `.dsh/project/` 下的文件不会触发自动导出。
- 没有 `.git` 标记时，技能发现根回退到会话 cwd，子目录会话可能发现不到导出的技能。

## 许可

MIT — 见 [LICENSE](https://github.com/echothesky/dsh-project-control/blob/main/LICENSE)。
