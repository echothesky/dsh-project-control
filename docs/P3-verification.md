# dsh-project v0.1 · P3 交付与验证记录（技能导出）

日期：2026-10-21
范围：P3 = 把项目记忆导出为按需加载的 `.dsh/skills` 技能（模块卡、契约总览、使用说明）
安装：`include:dsh-project` · `enabled: true` · `fiberPhase: active`

## 交付内容

| 能力 | 实现 | 说明 |
|---|---|---|
| 模块技能 | `moduleSkill()` | `.dsh/skills/module-<id>/SKILL.md`：路径/负责人/状态/依赖、当前下一步、模块目标、对外提供、契约、近期决策、约束、未决问题、检索指路 |
| 契约总览技能 | `contractsSkill()` | `.dsh/skills/project-contracts/SKILL.md`：全部契约及状态（breaking 可见） |
| 使用说明技能 | `projectSkill()` | `.dsh/skills/project-memory/SKILL.md`：工具/命令/目录结构 |
| 工具 | `project_export` | `target: all \| modules \| contracts \| project`、`module` 限定、`dryRun` |
| 命令 | `/project export [target]` | 与工具同一 `exportSkills()` 路径 |
| 幂等 | 每次覆盖生成 | 导出是确定性的；手工改生成文件会被下次导出覆盖 |

技能 frontmatter 使用 JSON 字符串作为 YAML 标量（`description`/`whenToUse`），避免中文冒号与引号破坏解析。`name` 为 kebab-case（`module-<id>`、`project-contracts`、`project-memory`）。

## 验证结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| F1 | 导出 4 个技能文件 | 通过 | `project_export target=all` 返回 4 条；`find .dsh/skills -name SKILL.md` 命中 4 个 |
| F2 | frontmatter 合法且被 provider 接受 | 通过 | 下一次请求的技能目录自动替换并包含 4 个新技能（见下） |
| F3 | 目录自动刷新（无需重启） | 通过 | 系统技能目录出现 `module-docs`、`module-host-core`、`project-contracts`、`project-memory`，描述即导出内容 |
| F4 | 按需加载正文 | 通过 | `skill("module-host-core")` 返回完整正文（目标/契约/决策/检索指路） |
| F5 | 临时目录正确 | 通过 | 基目录为 `…\工作流\.dsh\skills\module-host-core` |
| F6 | 语法检查 | 通过 | `node --check index.js` |

### 目录刷新证据（导出后自动替换的 available skills）

```
- module-docs: docs（设计与验证文档）：维护设计定稿（v0.2）与 P0/P1/P2/P0.5 各阶段验证记录。
- module-host-core: host-core（插件宿主核心）：Host 半实现：分层简报注入、remember/recall、压缩交接、模块绑定与 Web API。
- project-contracts: 项目契约总览：各模块对外接口、状态与破坏性变更
- project-memory: 项目记忆库使用说明：模块、契约、决策、交接与检索方式
```

### 技能正文样例（`module-host-core`）

```markdown
# 模块：host-core（插件宿主核心）

- 路径：packages/dsh-project
- 负责人：lead
- 状态：active
- 依赖：docs

## 当前下一步
刷新页面确认契约筛选；评估 /module open --worktree；准备 P3 技能导出

## 模块目标
Host 半实现：分层简报注入、remember/recall、压缩交接、模块绑定与 Web API。

## 对外提供
project_* 工具、/project、/handoff、/module 命令，以及 /dsh-project/api/state、/api/entry 只读接口。

## 近期决策
- dec-20261021-094218-d70e 模块绑定按 cwd 最长前缀，显式绑定优先

## 详细检索
调用 project_recall(query, module: "host-core") 取条目摘要；完整正文在 .dsh/project/entries/ 下。
```

## 成本说明

- 常驻成本 = 4 条目录项（名称 + 描述），约 120 token；正文只在 `skill` 工具调用时进入上下文。
- 导出本身零模型调用、纯确定性生成；写入本地文件，不联网。

## 已知限制

- 导出是**手动触发**（工具或 `/project export`），条目/模块变更后不会自动重写；需要时可重复执行。
- 生成的 `SKILL.md` 是派生产物，手工修改会被覆盖；要改内容请改 `.dsh/project` 或模块卡后重新导出。
- 技能发现根是「最近 `.git` 祖先，缺省用 cwd」。本仓库无 `.git`，因此根为工作目录；若会话 cwd 是子目录且项目无 `.git`，技能可能不被发现（与 `agent-instructions` 同一限制）。
- 技能描述为中文；如需英文目录可后续加 locale 参数。

## 追加交付：自动导出（去抖）

写入成功后自动刷新技能，不再依赖手动导出：

- 触发点：`project_remember`（含 supersede 重写）、`project_module update`；
- 去抖：按项目根合并，默认 1.5s（`autoExportDelayMs`，范围 200–10000ms）；
- 开关：`autoExport`（默认 `true`）；
- 生命周期：定时器挂在插件 effect 上，卸载/热重载时 `clearAutoExports()`，不会在卸载后触发；
- 失败只记 `logger.warn`，不影响写入结果。

### 验证

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| G1 | 写入触发导出 | 通过 | 10:21:05 写入第 14 条；10:21:07 `project-memory/SKILL.md` 自动刷新，计数 12 → 14 |
| G2 | 模块更新触发导出 | 通过 | 10:21:24 更新 host-core 下一步；10:21:26 `module-host-core/SKILL.md` 的「当前下一步」已更新 |
| G3 | 去抖合并 | 代码路径 | 同项目根复用同一 timer，连续写入只保留最后一个；单次导出行为由 G1/G2 证明 |
| G4 | 卸载清理 | 代码路径 | `ctx.effect(() => () => clearAutoExports())`；热重载后未出现迟到导出 |

### 限制

- 只有插件的写工具会触发；直接编辑 `.dsh/project/**` 需手动 `project_export`（或 `/project export`）。
- 导出仍是全量重写（4 个文件、纯确定性），对几百条条目耗时可忽略。

## 下一步建议

1. 自动导出：在模块/条目写入后做去抖重导出（`ctx.debounce`），或由 `project_handoff` 顺手刷新。
2. `--worktree` 模块会话（并行开发时）。
3. 面板增加「技能已导出 / 重新导出」状态。
