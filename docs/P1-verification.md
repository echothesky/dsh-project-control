# dsh-project v0.1 · P1 交付与验证记录（压缩交接）

日期：2026-10-20
范围：P1 = `compaction/end` 钩子 + `project_handoff` 工具 + `/handoff` 命令 + 轮次自动交接 + resume 注入
安装：`include:dsh-project` · `enabled: true` · `fiberPhase: active`（`set_bundle` 热重载生效，无需重启应用）

## 交付内容

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 压缩后交接 | `index.js` 的 `ctx.on('session/event')` | 收到 `compaction/end` → 标 `pendingResume` + 异步写 `handoff/latest.md`（`reason: compaction`） |
| 轮次自动交接 | 同上 | `turn/end` 计数达到 `handoffEveryTurns`（默认 10）→ 写交接（`reason: turns`） |
| resume 注入 | pre-step 守卫 | 下次请求注入 ≤`resumeBriefChars`（默认 300 字）的 `data-dsh-project="resume"`，只带目标/下一步/活跃文件/最近决策 |
| 手动交接 | `project_handoff` 工具 | 参数 `nextStep` / `note` / `injectResume`；返回路径、下一步、活跃文件、未决问题数 |
| 命令 | `/handoff [下一步]` | 与工具同一条 `performHandoff` 路径 |
| 活跃文件 | `collectActivity()` | 从 `deriveMessages()` 的 `tool-call` 块提取 `read/write/edit` 的 `file_path`/`path`，限项目根内、转相对路径、取最近 5 个 |
| 最近指令 | 同上 | 只认 `source.kind === "user"` 的直接用户消息，排除 runtime context 与插件注入 |

## 验证结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| B1 | `project_handoff` 写出完整交接文件 | 通过 | `handoff/latest.md` 含 frontmatter + 6 个段落 |
| B2 | 交接内容正确 | 通过 | 目标来自 `brief.notes.md`；下一步来自工具参数；未决问题=1；最近决策=1 |
| B3 | 活跃文件为项目内相对路径 | 通过 | `packages/dsh-project/index.js`、`docs/P0-verification.md` 等，无 asar/绝对路径 |
| B4 | 最近指令为真实用户消息 | 通过 | `## 最近指令` = `嗯，继续做P1吧`（此前误取 runtime context，已修） |
| B5 | resume 注入 | 通过（强制路径） | `project_handoff(injectResume:true)` 后下一步出现 `data-dsh-project="resume"`，含目标/下一步/活跃文件/最近决策/提示 |
| B6 | resume 预算 | 通过 | 注入正文远小于 300 字上限；目标行不再重复“目标：目标：” |
| B7 | 简报目标行去重 | 通过 | `brief` 注入显示 `目标：为 DeepSeek Harness…`（无重复前缀） |
| B8 | 热重载后功能保持 | 通过 | 两次 `set_bundle` 重载后，简报/工具/交接均正常 |
| B9 | 不阻塞压缩事务 | 通过（设计） | `session/event` 为同步 emit，交接异步执行且错误只记日志 |
| B10 | `/handoff` 命令注册 | 已注册，UI 未验 | 无法在对话内触发 slash 命令 |
| B11 | 真实压缩触发 `compaction/end` 自动交接 | **待用户实测** | 需在聊天框执行 `/compact`；agent 无法自行触发压缩 |

## 实测 resume 注入样例

```text
<system-reminder data-dsh-project="resume" data-digest="b4424809a95833e2">
（上下文已压缩）继续工作所需的项目状态：
目标：为 DeepSeek Harness 做一个"项目记忆 + 压缩交接"插件，缓解长会话/新会话的上下文限制。 铁律：只存本地文件，不…
下一步：验证 P1：resume 注入格式、活跃文件相对路径、/handoff 命令，然后更新文档
活跃文件：packages/dsh-project/index.js, packages/dsh-project/cordis.patch.yml, docs/P0-v…
最近决策：P0 只做简报注入与 remember/recall，不做向量检索
细节：project_recall("关键词") 或 read .dsh/project/handoff/latest.md
</system-reminder>
```

## P1 修复记录

1. **目标行重复前缀**（`目标：目标：…`）→ 简报生成与 resume 渲染都识别已有 `目标/铁律` 标签，不再叠加。
2. **活跃文件混入项目外路径**（asar 内的阅读路径）→ 仅保留项目根内文件并转相对路径。
3. **最近指令取到 runtime context**（时间/时区提示）→ 只接受 `source.kind === "user"` 的真实用户消息。

## 已知限制

- `/project`、`/handoff` 的命令行 UI 渲染未在会话内验证（需人工在输入框执行）。
- 真实 `compaction/end` 路径待实测：请在聊天框执行 `/compact`，随后应看到一条 `data-dsh-project="resume"` 注入；`handoff/latest.md` 的 `reason` 应为 `compaction`。
- 文件写仍为 Node `fs/promises` 直连；`ctx.fs` 沙箱迁移留到后续。
- 交接的「下一步」在自动触发时沿用 24 小时内上一次的值；过期则留空待人工补充。

## 下一步

- P0.5：模块维度（模块卡、`entry.module`、cwd 绑定、分层注入、契约提示）。
- 或 P2：客户端面板（侧栏入口 + 条目列表/搜索 + 交接状态）。
