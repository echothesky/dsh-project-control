# dsh-project v0.1 · P0 交付与验证记录

日期：2026-10-20
包目录：`packages/dsh-project/`
安装方式：`plugin_manager` `install_bundle`（本地目录，profile `desktop`）
条目：`include:dsh-project` · moduleName `dsh-project` · `enabled: true` · `fiberPhase: active`

## 交付物

| 文件 | 作用 |
|---|---|
| `packages/dsh-project/index.js` | Host 插件：简报生成、pre-step 注入、`project_remember`、`project_recall`、`/project` |
| `packages/dsh-project/cordis.patch.yml` | Bundle patch，插入 `dsh-project` 行 |
| `packages/dsh-project/package.json` | `dsh.bundle.patch`、locale/icon 导出、peerDependencies |
| `packages/dsh-project/locale/{en,zh}.json` | `meta.title` / `meta.description` |
| `packages/dsh-project/icon.svg` | 原创图标（文件夹 + 记忆清单 + 勾选） |
| `packages/dsh-project/README.md` | 用法、存储布局、条目格式、配置 |
| `.dsh/project/`（工作区） | 实际运行数据：5 条条目 + `catalog.json` + `brief.md` + `brief.notes.md` |

## 验收结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| A1 | 请求中出现 1 条 `data-dsh-project="brief"` 注入，≤1200 字 | 通过 | 会话内实际出现注入消息（见下） |
| A2 | 内容未变化时不重复注入 | 通过 | 同一 digest 不再注入；恢复时从 `deriveMessages()` 采纳 |
| A3 | `project_remember` 后条目/目录/catalog 同步 | 通过 | 5 个条目文件 + `catalog.json` 5 条记录 |
| A4 | 简报变化后出现 `brief-update` | 通过 | 多次出现，每次带新 digest |
| A5 | 中文子串检索命中（无需分词） | 通过 | `project_recall("向量检索 embedding")` 命中 2 条 |
| A6 | 过滤与 limit 生效 | 通过 | `type=decision, limit=2` 只返回 1 条 decision |
| A7 | 无项目时安全降级 | 通过（代码路径） | 未创建 `.dsh/project` 时 `hasProject=false` 直接跳过 |
| A8 | 子会话不注入 | 通过 | 起 subagent 实测回包 `BRIEF_PRESENT: no`（其上下文中只有 skills 的 system-reminder，无 `data-dsh-project`） |
| A9 | 路径越界防护 | 未实施（P0 简化） | 写入路径由固定目录拼接，不含用户可控路径段 |
| A10 | 卸载后无残留 | 通过 | 两次 disable/enable 重载，注入与工具随之卸载/恢复 |
| A11 | 不写自定义 session 事件、不改 system prompt | 通过（设计约束） | 仅通过 `createUserMessage` 注入 sourced `user/message` |

## 实测注入样例

```text
<system-reminder data-dsh-project="brief" data-digest="e1f89a78149bb5bc">
项目简报（自动生成；细节用 project_recall 查询）

硬约束：
- 不写自定义 session 事件；注入只走 sourced user/message
最近决策：
- dec-20261020-163604-338c P0 只做简报注入与 remember/recall，不做向量检索
索引：2 条（决策 1 / 约束 1 / 术语 0 / 问题 0）· 用法：project_recall(query, type?, tags?, limit?)
</system-reminder>
```

## 验证中发现并修复的问题

1. **catalog 摘要取到了标题行**（如 "决策"、"约束"）→ 摘要逻辑改为跳过 `#` 开头的结构行，取第一行正文；同时保留 `<id>`、`project_remember` 这类标识符（不再被通用标点清洗误伤）。
2. **`brief.notes.md` 更新有最长 3 秒延迟**（整份简报被缓存）→ 改为只缓存条目扫描，人工置顶文件每次请求重新读取。
3. **重载方式确认**：`plugin_manager set_bundle enabled=false → true` 即可加载新代码，无需重启应用。

## 已知限制

- `/project` 命令已注册（`ctx.commands.register` 未抛错），但**客户端渲染未在会话内验证**（无法在对话中触发 slash 命令）。
- 文件读走 Node `fs/promises` 直连项目目录，未经过 `ctx.fs` 沙箱策略；P1 可切换。
- 并发多会话写同一项目时，`catalog.json` 采用最后写入者生效（条目文件唯一命名无冲突）。
- 子会话隔离、压缩后 resume 注入属于 P0 之外（P1），其中子会话隔离为本次实测项。

## 使用方式

- 模型工具：`project_remember`（写）、`project_recall`（查）。
- 人类命令：`/project` 查看条目计数、简报字数、最近条目。
- 人工置顶：编辑 `<project>/.dsh/project/brief.notes.md`（≤300 字），下一次请求即生效。
- 配置（bundle 行）：`maxBriefChars`（默认 1200 字）、`maxRecallHits`（默认 5）、`readOnly`。

## 下一步（P1）

1. `compaction/end` 钩子 → 写 `handoff/latest.md` + 注入 `resume` 简报（≤300 字）。
2. `project_handoff` 工具 + `/handoff` 命令。
3. 改动文件投影（`sessionProjections`）→ 交接快照的「活跃文件」。
4. 子会话精简注入（配置开关）、`ctx.fs` 迁移。
