# dsh-project-control 0.2.0 · 发布说明

日期：2026-10-21
包位置：`packages/dsh-project/`（本地 bundle，安装于 profile `desktop`）
定位：**小语料项目记忆 + 分层注入 + 压缩交接 + 模块化开发**，不依赖向量检索或外部服务。

---

## 一、能力总览

| 阶段 | 能力 | 状态 | 验证记录 |
|---|---|---|---|
| P0 | 简报注入、`project_remember` / `project_recall`、`/project` | ✅ 已交付并实测 | P0-verification.md |
| P1 | `compaction/end` 交接、resume 注入、`project_handoff`、`/handoff`、轮次自动交接 | ✅ 已交付并实测 | P1-verification.md |
| P2 | Web 看板：条目列表、搜索/类型过滤、正文展开、交接卡 | ✅ 已交付并实测 | P2-verification.md |
| P0.5 | 模块卡、会话绑定、分层简报、结构化契约、`/module`、模块会话 | ✅ 已交付并实测 | P0.5-verification.md |
| P3 | 技能导出（模块/契约/用法）+ 自动去抖重导出 | ✅ 已交付并实测 | P3-verification.md |
| P4 | `/module open <id> --worktree` Git 隔离（服务优先 + git CLI 回退） | ✅ 已交付并实测 | P4-worktree-verification.md |

---

## 二、数据模型

```
<projectRoot>/.dsh/project/
├── brief.notes.md            # 人工置顶目标/铁律（≤300 字）
├── entries/<type>/<id>.md    # decision | constraint | glossary | question | contract | note
├── modules/<id>.md           # 模块卡：path/owner/status/deps/goal/contract/nextStep
├── sessions.json             # 会话 → 模块显式绑定
├── handoff/latest.md         # 交接快照（压缩/轮次/手动）
├── catalog.json              # 派生索引，可删可重建
└── brief.md                  # 简报的人类可读镜像

<projectRoot>/.dsh/skills/    # P3 导出
├── module-<id>/SKILL.md      # 每模块一份
├── project-contracts/SKILL.md
└── project-memory/SKILL.md
```

条目 frontmatter：`id / type / title / status / tags / created / updated / supersedes / superseded_by / scope / module`。
契约状态：`proposed` / `active` / `breaking`；模块状态：`planned` / `active` / `paused` / `done`。

---

## 三、模型可见接口

| 类型 | 名称 | 用途 |
|---|---|---|
| 工具 | `project_remember` | 写一条记忆（类型/标题/正文/标签/模块/取代） |
| 工具 | `project_recall` | 检索摘要（query/type/tags/status/module/limit/includeBody） |
| 工具 | `project_handoff` | 写交接快照；`injectResume` 可强制下一次注入 resume |
| 工具 | `project_module` | `list` / `get` / `update` / `bind` / `open`（含 `worktree`） |
| 工具 | `project_export` | 导出技能：`all` / `modules` / `contracts` / `project`，支持 `dryRun` |
| 命令 | `/project` | 状态；`/project export [target]` |
| 命令 | `/handoff [下一步]` | 人工交接 |
| 命令 | `/module` | `list` / `use <id>` / `use none` / `open <id> [--worktree]` |
| 注入 | `brief` / `brief-update` / `resume` | `source.kind = "dsh-project"` 的 sourced `user/message` |
| 面板 | 会话视图「项目记忆」 | 只读看板，数据来自 `/dsh-project/api/{state,entry}` |

---

## 四、配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxBriefChars` | `1200` | 简报字符预算（按字符，不按 token，避免低估中文） |
| `maxRecallHits` | `5` | 检索默认条数（1–10） |
| `resumeBriefChars` | `300` | 压缩后 resume 简报预算 |
| `autoHandoff` | `true` | 按轮次自动刷新交接 |
| `handoffEveryTurns` | `10` | 轮次间隔 |
| `autoExport` | `true` | 写入后自动刷新技能 |
| `autoExportDelayMs` | `1500` | 自动导出防抖窗口（200–10000） |
| `readOnly` | `false` | 禁止写工具 |

配置位于 bundle patch 的 `dsh-project` 行；项目级覆盖可后续扩展。

---

## 五、设计约束（已遵守）

- **不写自定义 session 事件**：模型可见内容全部是 sourced `user/message`，可由日志重建、可被压缩。
- **不改写 system prompt**：仅追加注入，保护前缀 KV cache。
- **失败不阻塞 turn**：注入/交接/导出失败只记日志。
- **确定性生成**：简报、交接、技能导出均不调用模型。
- **状态在上下文之外**：压缩吞掉简报是预期行为，真相始终在 `.dsh/project`。

---

## 六、验证摘要

- 注入：首步 `brief`、变更 `brief-update`、压缩后 `resume` 均在真实会话中观察到；
- 幂等：同 digest 不重复注入，resume 从 `deriveMessages()` 采纳；
- 子会话隔离：subagent 实测 `BRIEF_PRESENT: no`；
- 模块：绑定优先级（显式 > cwd > 项目级）、分层简报、模块级检索、契约 breaking 提示均实测；
- 技能：导出 4 个技能后**下一次请求技能目录自动替换**，`skill` 工具加载正文成功；
- 自动导出：写入 10:21:05 → 技能文件 10:21:07 自动刷新（计数 12→14），模块更新同理；
- worktree：真实 Git 仓库创建成功（分支/checkout/记忆副本/显式绑定），非 Git 路径清晰报错且无副作用；
- 客户端：模块注册与渲染离线 smoke 通过，面板标签在重启后实测出现。

详细证据见 `docs/P0-verification.md`、`P1-`、`P2-`、`P0.5-`、`P3-`、`P4-worktree-verification.md`。

---

## 七、安装与升级

- 全新安装：`plugin_manager install_bundle`，target 为 `packages/dsh-project` 绝对路径；
- npm：包名 `dsh-project-control`（`dsh-project` 已被无关的 0.0.1 占用，故采用此名）；
- 本地链接包升级：`remove_bundle` → `install_bundle`；
- **新增/修改 `dsh.client` 声明需要重启应用一次**（`dsh-client-modules` 按 `(baseUrl, loader name)` 缓存 manifest）；宿主侧改动与客户端 bundle 内容改动均可热重载/刷新页面；
- 卸载插件不影响 `.dsh/project` 数据（真相在文件）。

---

## 八、已知限制

1. 契约是自由文本，breaking 影响范围依赖模块 `deps` 声明，未从 import 图推导。
2. `/module open --worktree` 的清理是手动的；依赖本机 `git`，未走 `ctx.subprocess` 策略。
3. 桌面 profile 未挂载 `worktrees` 服务，走 git CLI 回退；worktree 内 `.dsh` 共享依赖 junction，失败退化为快照复制（记忆随后各自演化）。
4. 文件读写使用 Node `fs/promises` 直连项目目录，未经过 `ctx.fs` 沙箱策略（升级方向）。
5. 直接编辑 `.dsh/project/**` 不触发自动导出；需手动 `project_export`。
6. 无 `.git` 时技能发现根回退到会话 cwd，子目录会话可能发现不到导出的技能。
7. 测试期间创建的两个示例会话（P0.5 的 docs 会话、P4 的 worktree 会话）仍在侧栏，可归档。

---

## 九、后续方向

- 面板：显示导出状态/重新导出按钮、仅看 breaking 契约；
- 契约结构化（接口字段校验）与依赖图推导；
- `ctx.fs` / `ctx.subprocess` 迁移，兼容沙箱策略；
- 自动导出扩展到 handoff 后刷新；
- 多项目/多工作区索引与全局统计。

---

## 十、版本历史

| 版本 | 内容 |
|---|---|
| 0.1.0 | P0–P2 与 P0.5/P3/P4 的连续演进（同一工作区迭代，未单独打版本） |
| **0.2.0** | 首次发布整理：补齐 P3 自动导出、worktree 隔离、发布说明与验证归档 |
