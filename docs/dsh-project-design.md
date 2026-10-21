# dsh-project · 项目记忆与压缩交接插件 · 设计定稿（v0.2：+ 模块化开发）

> 目标运行时：DeepSeek Harness `desktop` profile（`@deepseek-ai/dsh` 0.2.1-rc.2 线）
> 定位：**小语料（几百条决策/文档）的结构化项目记忆 + 简报注入 + 关键词检索 + 压缩交接**
> 明确不做：向量检索 / embedding / 代码索引 / 自研压缩算法 / 自定义 session 事件

---

## 1. 设计依据（已核对的扩展点）

| 设计要素 | 依赖的 API / 机制 | 核对结果 |
|---|---|---|
| 注入项目简报 | `agent/pre-step` waterfall（`payload.messages: UserMessage[]`，`next()` 返回 `PreStepDecision`） | `PreStepDecision = { kind:'reject' } \| { kind:'enter', messages, startsRequestSeries? }`；可展开 decision 追加消息 |
| 构造注入消息 | `user/message` 的契约（`role`、`content`、`source:{kind:'user'}`） | 官方示例：`session.append('user/message', {role:'user', content:[{type:'text',text}], source:{kind:'user'}}, {surfaceOp:'append'})`；由 loop 补齐信封 |
| 读取会话与头信息 | `ctx.sessions.get(agent.id)` → `Session.header`（`cwd`、`origin`、`parentSession`、`isSeeded`） | 已核对（不依赖 concrete Agent 私有方法） |
| 项目根定位 | `ctx.workingDirectory.get(session)` + 向上探测 `.git` | 已核对（与 `agent-instructions` 同策略） |
| 文件读写 | `ctx.fs.resolve/readText/writeText/listDir/stat/contains/watch` | 已核对 |
| 压缩事件 | `session/event` 提交后事件流，`compaction/end` 等事件 | 官方文档明确存在 `compaction/start`、`compaction/summary`、`compaction/end`；**实现时以安装版本 `SessionEventMap` 为准** |
| 交接数据来源 | `ctx.sessionProjections.register()`（纯函数 fold，host-only key） | 已核对 `ProjectionDefinition {key, stateSchema, init, apply, stateVersion}` |
| goal 读取（可选） | `ctx.goals.get(agent)` | 已核对 |
| 工具/命令注册 | `ctx.tools.register()`、`ctx.commands.register()` | 能力存在；具体 `ToolDefinition`/`CommandDefinition` 形状实现时按安装包类型确认 |
| Bundle 形态 | `dsh.bundle.patch` + `install_bundle` | 已核对模板（`references/host-plugin.md`） |

**硬约束（来自 `references/practices.md`）**
- 不追加自定义 `session` 事件类型（会导致重开失败）；插件状态放文件/投影。
- 模型可见内容必须可重建：注入走 sourced `user/message`，会进日志，可被压缩。
- 不改写 system prompt（会破坏前缀 KV cache）；只做追加式注入。
- 每会话状态用纯函数投影，不订阅 `session/event` 反复重扫。
- 插件卸载/Agent 释放时必须清理注册（放 `agent.ctx` 或全局 disposer）。

---

## 2. 数据模型与文件布局

```
<projectRoot>/.dsh/project/
├── brief.notes.md            # 人工置顶区（目标/铁律），≤300 字，可选
├── entries/
│   ├── decision/dec-20261020-1530-a1b2.md
│   ├── constraint/con-20261019-1015-3c4d.md
│   ├── glossary/glo-…
│   ├── question/que-…
│   └── note/not-…
├── handoff/latest.md         # 最近一次交接快照（自动生成）
├── catalog.json              # 派生索引（条目元数据），可删可重建
└── index.json                # 插件元数据：schemaVersion、lastBriefDigest
```

**一个条目 = 一个文件**：避免多会话并发追加同一文件的冲突；git diff 干净；删除/归档直观。

### 条目模板

```markdown
---
id: dec-20261020-1530-a1b2
type: decision            # decision | constraint | glossary | question | note
title: 简报按字符数预算，不用 token 估算
status: active            # active | superseded | rejected | resolved
tags: [context, compaction, budget]
created: 2026-10-20T15:30:00+08:00
updated: 2026-10-20T15:30:00+08:00
supersedes: []
superseded_by: null
related: []
scope: []                 # 可选：模块/路径前缀
---

## 决策
简报预算以**字符数**为准（默认 1200 字），不用 token 估算。

## 理由
tokenMeter 的 4 字符/token 启发式会低估中文；字符数是保守上界。

## 替代方案
按 token 预算 → 中文场景易超窗，否决。

## 影响
brief.md 生成器；CJK 项目的配置默认值。
```

### catalog.json

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-20T15:31:00+08:00",
  "entries": [
    {
      "id": "dec-20261020-1530-a1b2",
      "type": "decision",
      "title": "简报按字符数预算，不用 token 估算",
      "status": "active",
      "tags": ["context", "compaction", "budget"],
      "created": "2026-10-20T15:30:00+08:00",
      "updated": "2026-10-20T15:30:00+08:00",
      "path": "entries/decision/dec-20261020-1530-a1b2.md",
      "summary": "简报预算以字符数（默认 1200 字）为准；token 估算低估中文。"
    }
  ]
}
```

- `summary` 取正文首个非标题段落，截断到 80 字。
- 写入后**全量重建**（几百条文件扫描 < 50ms）；读取时若 catalog 缺失/损坏则回退目录扫描。

---

## 3. 简报（brief）生成规则

**纯确定性生成，不调用模型。** 按优先级拼装并硬截断到 `maxBriefChars`：

| 优先级 | 内容 | 来源 | 预算 |
|---|---|---|---|
| 1 | 目标 / 铁律 | `brief.notes.md`（人工置顶） | ≤200 字 |
| 2 | 硬约束 | `type=constraint, status=active`，按 updated 倒序，最多 5 条 | 5×80 字 |
| 3 | 最近决策 | `type=decision, status=active`，最多 3 条（标题 + 一句结论） | 3×60 字 |
| 4 | 未决问题 | `type=question, status=active`，最多 3 条（仅标题） | 3×50 字 |
| 5 | 下一步 | `handoff/latest.md` 中 24h 内的「下一步」段 | ≤80 字 |
| 6 | 导航行 | 条目计数 + 检索用法 | ≤80 字 |

截断策略：从优先级最低的段落开始整段丢弃；最后一个段落允许截断。

**简报示例（注入到模型的样子）**

```text
<system-reminder data-dsh-project="brief" data-digest="sha1:ab12cd34">
项目简报（来自 .dsh/project，自动生成；细节用 project_recall 查）

目标：为 DSH 增加小语料项目记忆与压缩交接，减少跨会话重复解释。
硬约束：
- 只用本地文件，不引入 embedding / 外部服务
- 不写自定义 session 事件；注入走 sourced user message
- 中文预算按字符数，不按 token 估算
最近决策：
- dec-20261020-1530-a1b2 简报按字符数预算（1200 字）
- dec-20261019-1015-3c4d 一条目一文件，避免并发写冲突
未决问题：
- que-20261020-1600-9f0e UI 面板放 conversation.view 还是独立 main 面板？
索引：87 条（决策 41 / 约束 12 / 术语 9 / 问题 25）· 用法：project_recall(query, type?, tags?, limit?)
</system-reminder>
```

生成后写回 `brief.md`（人可读）并计算 `digest = sha1(注入文本)` 存入 `index.json`。

---

## 4. 注入机制与时序（核心）

### 4.1 适用范围
- 仅 **root session**：`header.origin !== 'subagent'` 且无 `header.parentSession`。
- 子会话默认不注入（`injectToSubagents: false`）。
- 无项目根（找不到 `.git` 且 `cwd` 不存在 `.dsh`）→ 插件静默不激活，不报错。

### 4.2 每会话状态机

```
状态（进程内，Map<SessionId, S>）：
  lastInjectedDigest: string | null
  lastInjectedSeq:    number | -1
  dirty:              boolean        // brief 变更 / 压缩结束 / resume
  turnCount:          number

触发：
  ① 首个 agent/pre-step        → 若 surface 中无同 digest 的 brief → 注入 brief
  ② brief digest 变化          → dirty=true；下一个 pre-step 注入 brief-update（只带变更摘要）
  ③ session/event: compaction/end → dirty=true；下一个 pre-step 注入 resume brief（≤300 字）
  ④ agent/created(source='compact') → 同 ③
  ⑤ /handoff 命令              → 写 handoff/latest.md + dirty=true
```

### 4.3 pre-step 监听（伪代码）

```js
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  if (decision.kind === 'reject') return decision

  const session = ctx.sessions.get(payload.agent.id)
  if (!session || !shouldInject(session)) return decision

  const msg = await composeInjection(session)   // 可能为 null
  if (!msg) return decision

  return {
    ...decision,                                 // 保留 startsRequestSeries 等字段
    messages: [...decision.messages, msg],
  }
})
```

### 4.4 注入消息格式

```js
{
  role: 'user',
  content: [{ type: 'text', text: '<system-reminder …>…</system-reminder>' }],
  source: { kind: 'user' },
}
```

三种模板：
1. `brief`：首次注入完整简报（≤1200 字）。
2. `brief-update`：仅「变更摘要 + 变化段落」，≤300 字（`data-dsh-project="brief-update"`）。
3. `resume`：压缩后恢复，≤300 字：目标 / 下一步 / 最近 3 条决策标题 / 检索提示（`data-dsh-project="resume"`）。

### 4.5 幂等与重放
- 每次注入带 `data-digest`；首步先扫一遍 `session.deriveMessages()` 的用户消息（一次，缓存于会话生命周期），若已存在同 digest 的 `brief` 消息 → 只同步状态、不重复注入。
- 插件重启/resume 后靠日志中的 digest 恢复状态，不依赖内存。
- 注入失败（fs 读取异常、项目目录被删）→ `log.warn`，放行 step，绝不影响 turn。

### 4.6 KV cache / 压缩交互
- 只追加、不改 system prompt：注入点之后的前缀失效，之前的不受影响。
- 简报会随历史被压缩吞掉，这是**预期行为**；靠 `compaction/end` 后的 `resume` 注入恢复，真相始终在 `.dsh/project/`。

---

## 5. 工具与命令契约

### 5.1 `project_remember`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | `decision \| constraint \| glossary \| question \| note` | ✓ | 条目类型 |
| `title` | string ≤80 字 | ✓ | 一句话结论 |
| `body` | string ≤4000 字 | ✓ | 结构化正文（决策/理由/替代方案/影响） |
| `tags` | string[] ≤8 | | 检索标签 |
| `status` | `active \| rejected` | | 默认 active |
| `supersedes` | string[] | | 被本条目取代的 id（自动把旧条目标记 superseded） |
| `scope` | string[] | | 模块/路径前缀 |

返回：`{ id, path, catalogSize, briefChanged: true }`。
幂等：同 `type + 去空白 title` 在 10 分钟内重复调用 → 返回既有 id（防模型重试重复写）。

### 5.2 `project_recall`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | | 缺省时返回最近更新条目 |
| `type` | enum | | 过滤类型 |
| `tags` | string[] | | 任一标签命中 |
| `status` | enum | | 默认 `active` |
| `limit` | 1..10 | | 默认 5 |
| `includeBody` | boolean | | 默认 false；true 时单条正文 ≤800 字 |

返回：`{ hits: [{id,type,title,status,tags,summary,path,updated}], total, hint }`。
无命中：`hint = "无匹配条目（共 N 条）。可 read .dsh/project/catalog.json 浏览目录，或改关键词。"`

**检索算法（无分词、无向量）**

```
tokens = [整串, ...query.split(/[\s,，。;；]+/)]
score(entry) = 5*标题命中 + 3*标签命中 + 1*正文命中 + 2*(status==active) + 近 30 天 +2 / 近 90 天 +1
中文直接用 includes() 子串匹配（不需要分词器）；英文不区分大小写。
```

### 5.3 `project_handoff`（P1）

参数：`{ note?: string }` → 生成 `handoff/latest.md`（目标/已完成/未决/下一步/最近改动文件），返回摘要与「新会话开场白」。

### 5.4 命令

| 命令 | 行为 |
|---|---|
| `/project` | 输出项目状态卡（条目计数、最近 3 条决策、未决问题、简报字数），不进模型上下文 |
| `/handoff [note]` | 生成交接快照；`--new` 可选：用 `ctx.agents.create` 直接开新会话（P2） |
| `/remember …` | 交互式快捷入口，等价 `project_remember`（P2，可先不做） |

---

## 6. 压缩交接（P1）

**触发**
1. `session/event` 收到 `compaction/end` → 立即写 `handoff/latest.md`，标 dirty（**不阻塞压缩事务**）。
2. 每 `handoffEveryTurns`（默认 10）个 `turn/end` 更新一次，防止未压缩会话丢失。
3. `/handoff` 手动。
4. **不**在 `compaction/summary-error` 时写（失败路径，避免放大问题）。

**数据来源（纯规则，不调模型）**
- 目标：`ctx.goals.get(agent)?.objective` → 否则 `brief.notes.md`。
- 最近改动文件：host-only 投影 `dshProjectFiles` 折叠 `tool/call`（`read/write/edit` 的 `file_path` / `path` 参数），去重取最近 5 个。
- 最近用户指令：投影记录最后一条非注入 `user/message` 的文本（截断 200 字）。
- 未决问题：brief 中的 question 条目。
- 下一步：`/handoff` 的 `note` 参数；自动触发时留空并提示「待模型补充」。

**交接模板**

```markdown
---
generated: 2026-10-20T16:40:00+08:00
session: <sessionId>
reason: compaction | turns | manual
---

## 目标
…
## 已完成（最近 5 项）
- [tool] 修改 src/plugin/host/index.js
## 未决问题
- …
## 下一步
…
## 活跃文件
- src/plugin/host/index.js
```

**resume 注入模板（≤300 字）**

```text
<system-reminder data-dsh-project="resume" data-digest="sha1:…">
（上下文已压缩）继续工作只需这些项目状态：
目标：…
下一步：…
最近决策：dec-…（标题）／dec-…（标题）／con-…（约束）
细节：project_recall("关键词") 或 read .dsh/project/handoff/latest.md
</system-reminder>
```

---

## 7. 多会话 / 权限 / 并发 / 失败兜底

| 场景 | 处理 |
|---|---|
| 多会话同时写 | 条目文件唯一命名（时间戳+4 hex），不覆盖；catalog 全量重建，最后写入者生效 |
| catalog 损坏/过期 | 读取回退目录扫描；解析失败只警告，不抛给模型 |
| 路径越界 | 写入前 `ctx.fs.contains(projectDir, target)` 校验，拒绝 `..` 与符号链接逃逸 |
| 项目根歧义 | `cwd` 向上找 `.git`；找不到用 cwd；可用 `rootMarkers` 配置 |
| 只读模式 | `readOnly: true` 时只注入/检索，`project_remember` 返回明确错误 |
| 插件卸载 | 所有注册走 `ctx.effect()`；注入停止，项目文件保留（真相在文件） |
| 子会话 | 默认不注入；`injectToSubagents: true` 时只注入 300 字精简版 |
| 项目文件被删 | 视为空库，重新创建目录；不阻塞会话 |
| 注入内容逃逸 | 渲染时转义 `</system-reminder>`，防止项目文件内容关闭框架 |

---

## 8. 插件工程结构（Host-only Bundle，P0）

```
dsh-project/
├── package.json
├── cordis.patch.yml
├── index.js              # apply(ctx, config)
├── locale/en.json
├── locale/zh.json
├── icon.svg
└── README.md
```

**package.json**

```json
{
  "name": "dsh-project",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"]
}
```

**cordis.patch.yml**

```yaml
- insert:
    - id: dsh-project
      name: dsh-project
      config:
        maxBriefChars: 1200
        injectToSubagents: false
        autoHandoff: true
        handoffEveryTurns: 10
        readOnly: false
```

**index.js 结构**

```js
export const inject = ['tools', 'fs', 'sessions', 'workingDirectory']

export const Config = { /* maxBriefChars, injectToSubagents, autoHandoff, … */ }

export function apply(ctx, config) {
  const store = createStore(ctx, config)      // 文件读写 + catalog
  const brief = createBrief(ctx, config, store)
  const state = new Map()                      // SessionId → 注入状态

  ctx.effect(() => { /* agent/pre-step 注入 */ })
  ctx.effect(() => { /* session/event 监听 compaction/end、turn/end */ })
  ctx.effect(() => { /* tools.register project_remember / project_recall */ })
  ctx.effect(() => { /* commands.register /project /handoff */ })
  ctx.inject(['goals'], (g) => { /* 可选读取 goal */ })
}
```

**模块划分（建议）**

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口、注册与生命周期 |
| `store.js` | 条目 CRUD、frontmatter 解析、catalog 重建 |
| `brief.js` | 简报生成、摘要与截断、digest |
| `inject.js` | pre-step 注入状态机、消息构造、转义 |
| `recall.js` | 关键词检索与打分 |
| `handoff.js` | 交接生成、改动文件提取（P1） |
| `config.js` | Config 校验与默认值 |

安装：`plugin_manager` `install_bundle`，target 为包目录绝对路径；不要手工改 profile 的 `package.json` 或 `cordis.patch.yml`。

---

## 9. 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `projectDirName` | `.dsh/project` | 相对项目根 |
| `rootMarkers` | `['.git']` | 项目根探测标记 |
| `maxBriefChars` | `1200` | 简报字符上限（中文按字符，不按 token） |
| `maxRecallHits` | `5` | recall 默认返回条数 |
| `injectToSubagents` | `false` | 是否向子会话注入精简简报 |
| `autoHandoff` | `true` | 压缩/轮次触发交接 |
| `handoffEveryTurns` | `10` | 轮次触发间隔 |
| `readOnly` | `false` | 禁止写入 |
| `catalogRebuild` | `'on-write'` | `on-write` \| `lazy` |

支持项目级覆盖：`<project>/.dsh/project/config.json`（仅允许上面白名单字段，优先级高于插件 Config）。

---

## 10. 验收标准

| # | 验收项 | 判定 |
|---|---|---|
| A1 | 新会话首个请求包含 1 条 `data-dsh-project="brief"` 消息，长度 ≤1200 字 | 手动观察 + 日志 |
| A2 | 同会话第二个请求**不**重复注入 | 同上 |
| A3 | `project_remember` 后，下一请求出现 `brief-update`（≤300 字）；条目文件与 catalog 同步 | 检查文件 + 请求 |
| A4 | 注入 `compaction/end` 后，下一请求出现 `resume` 消息（≤300 字） | 触发 `/compact` 验证 |
| A5 | `project_recall("缓存")` 命中含「缓存」的条目；中文无需分词 | 单测 |
| A6 | 300 条条目下 recall 耗时 <20ms，返回 ≤limit 条、摘要 ≤80 字 | 基准脚本 |
| A7 | 无命中时返回兜底 hint，不返回空对象 | 单测 |
| A8 | 子会话不注入（默认配置）；打开配置后注入精简版 | 起 subagent 验证 |
| A9 | 越界写入被拒绝（`../`、符号链接逃逸） | 单测 |
| A10 | 插件卸载后无残留注入、无报错，项目文件完整 | 卸载验证 |
| A11 | 不产生任何新的 session 事件类型；`/project`、`/handoff` 不影响压缩事务 | 日志检查 |

---

## 11. 里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| **P0** | store（文件+catalog）、brief 生成、pre-step 注入、`project_remember`/`project_recall`、`/project`、双语 locale + 图标 | 1~2 天 |
| **P1** | `compaction/end` 钩子、resume 注入、`project_handoff`、`/handoff`、轮次自动交接、改动文件投影 | 1~2 天 |
| **P2** | 客户端面板（`sidebar.panellist` + `main` 或 `conversation.view`）：条目列表/搜索/状态切换 | 2~3 天 |
| **P3** | 导出 `.dsh/skills/project-<topic>/SKILL.md`（细节按需加载）、与 `dsh-context` 联动显示简报占用 | 按需 |

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 简报膨胀占满上下文 | `maxBriefChars` 硬截断 + 优先级丢弃；字符预算而非 token |
| 模型不主动 recall | 简报内置导航行 + 首步非命中时提示；后续可加「关键词→条目」提示位 |
| 压缩吞掉简报 | 压缩事件后 resume 注入；真相在文件，随时可重建 |
| 并发写坏数据 | 一条目一文件、唯一文件名；catalog 派生可重建 |
| KV cache 失效 | 只追加、不改 system prompt；增量 update 只带变化 |
| 中文检索漏召 | 子串匹配 + 标题/标签加权；不做分词依赖 |
| Electron/原生依赖 | 纯 JS + 内置 `node:sqlite`（若 P2 需要）；不装原生模块 |
| 升级破坏兼容 | catalog `schemaVersion` + 自动重建；Config 只增不改 |

---

## 13. 模块化开发扩展（v0.2 增补，可与 P0 同批实现）

### 13.1 为什么两者能叠加

上下文限制的根源不是“窗口小”，而是**一个会话被迫同时持有整个项目的状态**。模块化把“一个大上下文”拆成“多个小上下文 + 一份边界契约”：

- 每个会话只加载**所属模块**的简报 + 项目级契约摘要，单会话上下文更小、更聚焦；
- 模块边界天然是压缩边界：模块内细节压缩后仍在模块文件里，跨会话可续；
- 与 v0.1 的注入机制**完全复用**，只是把“一个 brief”变成“项目层 + 模块层”两层，总预算不变。

> token 账：v0.1 单层简报 1200 字；v0.2 拆成项目层 400 + 模块层 700 + 导航 100 = 仍 1200 字，但**信噪比更高**（不再把 B 模块的决策塞给做 A 模块的会话）。

### 13.2 数据模型增补

```
.dsh/project/
├── brief.notes.md               # 项目级：目标 / 全局约束 / 架构原则
├── modules/
│   ├── <moduleId>.md            # 模块卡
│   └── <moduleId>.contract.md   # 模块对外契约
├── entries/<type>/…             # frontmatter 增加 module: <moduleId>
└── sessions.json                # 可选：sessionId → moduleId 显式覆盖
```

**模块卡模板**

```markdown
---
id: host-core
title: 插件宿主核心
path: src/plugin/host          # 用于 cwd 绑定与 write scope
owner: lead
status: active                 # planned | active | paused | done
deps: [store, inject]
tags: [host, compaction]
updated: 2026-10-20T17:00:00+08:00
---

## 模块目标
## 对外提供
## 依赖的契约
## 当前下一步
```

**契约模板（`<moduleId>.contract.md`）**

```markdown
---
id: host-core.contract
module: host-core
status: active        # proposed | active | breaking
interfaces:
  - name: project_recall
    kind: tool
    fields: [query, type?, module?, limit?]
  - name: onPreStepInjection
    kind: event
breaking: []          # 本次变更中不兼容的点
updated: 2026-10-20T17:00:00+08:00
---
```

条目 frontmatter 新增 `module: <id>`；`type` 增加 `contract`。

### 13.3 会话 ↔ 模块绑定（四级优先级）

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `/module use <id>` | 写 `sessions.json` 显式覆盖，最高优先 |
| 2 | `session.header.cwd` 最长前缀匹配 `modules[].path` | **免费且持久**：cwd 存在 session header 里，resume/fork 自动恢复 |
| 3 | 本会话触及文件最多的模块（P1，投影推断） | 用于“忘了开模块会话”的场景，首步后生效 |
| 4 | 未绑定 | 视为**项目级/集成会话**，只注入项目层简报 |

绑定失效（模块目录改名/移动）→ 回退到优先级 2/4，并在简报里提示“模块绑定已失效”，不报错。

### 13.4 分层注入与预算

| 层 | 内容 | 预算 |
|---|---|---|
| 项目层 | 目标、全局约束（≤3）、模块地图（id + 一句话）、跨模块契约状态 | ≤400 字 |
| 模块层 | 模块目标、契约摘要、最近 3 条模块决策、下一步、本模块未决问题 | ≤700 字 |
| 导航层 | 条目计数 + `project_recall(..., module?)` 用法 | ≤100 字 |

- 截断顺序：先丢模块层细节 → 再丢项目层模块地图 → 最后保留目标与下一步。
- `resume` 注入（压缩后）同样分层，≤350 字：项目目标 1 行 + 当前模块的状态 3 行。
- 集成会话（未绑定模块）只注入项目层 + 全量契约状态，不注入任何模块细节。

### 13.5 契约与跨模块变更（防接口漂移）

1. 模块的对外接口只写在 `contract.md`；改接口必须同时写一条 `type=contract` 条目，并 `supersedes` 旧契约。
2. 契约条目 `status=breaking` 时，**所有相关模块会话**的下一次请求都会收到一条 ≤150 字的「契约变更提示」。
3. 集成会话提供 `project_contracts` 视图：列出所有 `proposed/breaking` 契约与未合并变更。
4. `project_remember` 写入时若检测到条目 `scope` 命中**两个以上模块的 path**，返回告警：“跨模块变更，请补契约条目或改用集成会话”。

### 13.6 并行开发编排（复用现有 DSH 能力，不重造）

| 需求 | 复用什么 | 插件只做什么 |
|---|---|---|
| 每模块一个会话 | `ctx.agents.create` + `ctx.workingDirectory.set(agent, modulePath)` + 种子消息（模块简报） | `/module open <id>` 编排 |
| 并行多代理 | **Agent Teams**：teammate 一人一模块，共享任务板，`write_scopes` = 模块 path | 提供模块简报文本给 spawn prompt |
| 批量独立任务 | `subagent` / `workflow`（把模块简报放进子任务 prompt） | 生成“模块任务包”文本 |
| 隔离文件系统 | `ctx.worktrees.create(agent)` 每会话独立 git worktree，完成后合并 | 在 `/module open` 时可选 `--worktree` |
| 进度与阻塞 | `goals`（模块里程碑）/ `todo_write`（轮内） | 模块状态同步到模块卡 |
| 集成与验收 | 项目级会话 + 测试命令 | 交接快照 + 契约核对清单 |

**典型流程**

```
拆分：定义 modules/*.md 与 *.contract.md（或让模型用 project_module_update 生成草稿）
  ↓
逐模块：/module open host-core  → 新会话（cwd=src/plugin/host，注入模块简报）
  ↓
并行：spawn_teammate(module=store) / (module=inject) …  任务板按模块分配 write_scopes
  ↓
集成：/module use none  → 项目级会话，读全部契约与交接，跑测试与合并
```

### 13.7 工具与命令增补（控制数量，避免 schema 常驻成本）

新增**一个**工具 `project_module`，用 `action` 多态：

| action | 参数 | 说明 |
|---|---|---|
| `list` | — | 模块列表（id/status/owner/条目数） |
| `get` | `id` | 模块卡 + 契约摘要 |
| `update` | `id`, `{title,path,status,owner,deps,nextStep}` | 更新模块卡（含 `nextStep`） |
| `contract` | `id`, `{status, interfaces, breaking}` | 写契约条目 |
| `bind` | `id` | 等价 `/module use`（模型可主动绑定当前会话） |

`project_recall` 增加 `module?: string` 过滤；无 `module` 时按当前会话绑定过滤，`module: "*"` 才跨模块。
新增命令：`/module list|use <id>|open <id> [--worktree]|status`。

### 13.8 验收增补

| # | 验收项 | 判定 |
|---|---|---|
| B1 | 模块会话的注入只含所属模块条目，不含其他模块正文 | 检查注入文本 |
| B2 | `cwd` 位于 `src/plugin/host` 时自动绑定 `host-core` | 新会话验证 |
| B3 | 模块目录改名后，绑定回退且简报提示失效，不报错 | 改目录验证 |
| B4 | `contract` 条目 `status=breaking` 后，相关模块下一请求收到 ≤150 字提示 | 触发并观察 |
| B5 | 集成会话（未绑定）只含项目层 + 契约，无模块细节 | 检查注入文本 |
| B6 | 两个并行会话写同一模块 → 写入响应带跨模块/冲突告警 | 双会话验证 |
| B7 | 总注入预算仍 ≤`maxBriefChars`（默认 1200 字），分层不叠加超限 | 字数统计 |
| B8 | `project_recall` 的 `module` 过滤生效，`module:"*"` 可跨模块 | 单测 |

### 13.9 里程碑调整

| 阶段 | 原内容 | **增补** |
|---|---|---|
| **P0** | store/brief/注入/两工具/`/project` | 模块数据模型（模块卡 + `entry.module` + cwd 绑定 + 分层注入 + recall 过滤）；不做 UI、不做自动推断 |
| **P1** | 压缩交接/resume/`/handoff` | `project_module` 工具、`/module open`、契约条目与变更提示、集成会话模式 |
| **P2** | 客户端面板 | 模块看板（状态/条目数/契约告警）、worktree 集成、Agent Teams 协作模板 |
| **P3** | 导出技能 | 按模块导出 `.dsh/skills/module-<id>/SKILL.md` |

> 建议**先把 v0.1 的 P0 做完再上模块维度**（module 属于 P0.5），否则一次改太多不易验证。也可以用 v0.1 插件管理自身的模块化开发，作为 dogfood。

### 13.10 风险与边界

| 风险 | 对策 |
|---|---|
| 过度拆分（>12 个模块 / 单模块 <1000 行） | 收益被协调成本吃掉；给出阈值建议，`project_module` 返回告警 |
| 双份注入推高 token | 三层共享同一总预算；集成会话不带模块层 |
| 跨模块改动频繁 | 设“横向会话”模式（项目级），或临时 `bind` 到主模块并显式声明跨模块 scope |
| cwd 绑定脆弱（移动/重命名） | `sessions.json` 覆盖优先；模块卡 `path` 变更时自动迁移；失效回退不报错 |
| 契约漂移 | 契约条目 + breaking 提示 + 集成检查清单（P1 提供 `/module status`） |
| 子代理拿不到模块上下文 | 父代理把模块简报写进 subagent prompt（约定）；或 `injectToSubagents: true` 注入精简版 |
| 并行写同一文件 | 依赖 Agent Teams 的 `write_scopes` + 插件冲突告警；高风险模块用 worktree 隔离 |

---

## 附录 A · 实现期需核对的 3 个细节

1. **`SessionEventMap` 中压缩事件的精确 type 与 data 形状**（本设计按 `compaction/start|summary|end` 编写）→ 读安装包的 `lib/types` 或运行时打印事件确认。
2. **`ToolDefinition` / `CommandDefinition` 的字段**（`execute` 入参、返回内容块格式、命令回执结构）→ 按安装包类型定义实现。
3. **`user/message` 经 `agent/pre-step` 注入时**：确认 loop 是否补齐 `id`/`time`，以及 `source` 是否允许 `{kind:'user'}`；若不允许，降级为 `agent.inject()` 通道（practices.md 推荐路径）。

## 附录 B · 与既有能力的分工

| 既有能力 | 负责什么 | 本插件不做什么 |
|---|---|---|
| `AGENTS.md`（agent-instructions） | 静态项目规范/风格 | 不重复静态规范；只放**会变的状态** |
| `.dsh/skills`（skill-filesystem） | 按需加载的详细知识正文 | P3 才把条目导出成技能 |
| `compaction-basic` | 通用历史压缩 | 不实现压缩；只做压缩前后交接 |
| `tool-result-pruner` / `spill-policy` | 工具结果裁剪与落盘 | 不重复 |
| `goals` / `todo_write` | 会话级目标 / 单轮待办 | 项目级持久状态由本插件负责 |

---

## 14. 实现状态（v0.2.0，2026-10-21）

| 设计章节 | 状态 | 落地位置 / 验证 |
|---|---|---|
| §2 存储布局、条目格式 | ✅ | `index.js` store 层；P0 验证 |
| §3 简报生成与预算 | ✅（分层扩展） | `buildBrief()`；P0/P0.5 验证 |
| §4 注入时序与幂等 | ✅ | `agent/pre-step` + `createUserMessage`；P0/P1/P2 验证 |
| §5 工具与命令 | ✅（新增 `project_module`/`project_export`） | P0/P0.5/P1/P3 验证 |
| §6 压缩交接与 resume | ✅ | `session/event` `compaction/end`；P1 验证 |
| §7 权限/并发/失败兜底 | ✅ | 路径约束、失败降级；P0/P1 验证 |
| §8 工程结构 | ✅（Host + Client 两半） | bundle 安装 active；P2 验证 |
| §9 配置项 | ✅（新增 autoExport/工作树相关默认） | `cordis.patch.yml` |
| §10 验收标准 A1–A11 | ✅（A11 压缩触发待用户 `/compact` 复验） | P0/P1 记录 |
| §13 模块化扩展 | ✅ | 模块卡/绑定/分层注入/契约；P0.5 验证 |
| §13.6 并行编排 | ⚠️ 部分 | `open` 与 worktree 已落地；Agent Teams 协作模板未实现 |
| §13.5 契约结构化 | ⚠️ 部分 | 文本契约 + breaking 提示已落地；结构化字段与依赖图推导未实现 |

附录 A 的三个待核对项在实际实现中已确认：`compaction/start|summary|end` 事件名正确；`defineTool` / 命令 handler 形状按安装包实现；`createUserMessage` 可携带自定义 `source.kind`。

**版本差异说明**：设计中的 P2「面板」以 `conversation.view` 标签实现；P3 技能导出与自动导出为新增能力；worktree 隔离为设计 §13.6 的落地。

