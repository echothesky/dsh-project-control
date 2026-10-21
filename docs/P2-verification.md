# dsh-project v0.1 · P2 交付与验证记录（Web 看板）

日期：2026-10-21
范围：P2 = 会话内「项目记忆」标签页 + 只读 Host JSON API + 中英文案 + 主题 token 样式
安装：`include:dsh-project` · `enabled: true` · `fiberPhase: active`

## 交付内容

| 文件 / 能力 | 说明 |
|---|---|
| `packages/dsh-project/client.js` | 客户端半：注册 `conversation.view` 标签页（id `project`、order 40、label 走 locale） |
| `package.json` → `dsh.client` | `platform: web`，`inject: [dsh-client-ui-conversation, dsh-client-locale]`，新增 `./client` 导出 |
| `index.js` → `/dsh-project/api/state` | 返回项目目录、条目计数、条目列表（id/type/title/status/tags/summary/path/updated）、简报字数、最近交接 |
| `index.js` → `/dsh-project/api/entry` | 按 `entries/<type>/<id>.md` 读取正文；正则 + `relative()` 双重限制在项目目录内 |
| 面板功能 | 关键字/类型过滤、条目展开正文、状态与类型徽章、最近交接卡、刷新按钮、空状态与错误态 |
| 样式 | 只使用 `--dsw-alias-*` 主题 token（背景/层/边框/品牌色/状态色），自动适配明暗主题 |
| 文案 | `ctx.locale.register` 注册 en/zh 字典，标签用 thunk 跟随语言切换 |
| 只读 | 面板不写项目文件；写入仍由模型工具与命令完成 |

## 已验证

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| C1 | Host state API | 通过 | `curl` 返回 `ok:true`、6 条条目、计数 6、projectDir 正确 |
| C2 | Host entry API | 通过 | 返回指定决策条目正文；路径校验走 `entries/...` 白名单 |
| C3 | 客户端模块契约 | 通过 | 离线 smoke 测试：`__ModuleLoader__.load` 注册 id `dsh-project`；`factory(require)` 正常运行 |
| C4 | 插槽注册 | 通过 | smoke 测试捕获 `{name:'conversation.view', id:'project', order:40}` |
| C5 | 组件渲染 | 通过 | smoke 测试调用组件返回 `div`，10 个子节点，无异常 |
| C6 | 语法/清单 | 通过 | `node --check` 两个文件；`package.json` JSON 合法；patch YAML 合法 |
| C7 | 客户端面板真实加载 | **待重启验证** | 见下 |

## 为什么需要重启一次

`dsh-client-modules` 对每个插件按 `(baseUrl, loader name)` 缓存 package.json 元数据（`resolveMeta` → `pkgMeta`），缓存只在 Host 进程生命周期内有效且**没有失效入口**。该包在 P0/P1 时期（尚无 `dsh.client` 声明）已被扫描并缓存为 `null`，因此本次新增的客户端半不会进入 boot graph，页面刷新也不够。

处理：**重启一次桌面应用**。之后客户端插件行会随 boot graph 加载；后续宿主代码改动仍可热重载。

## 重启后的验收步骤

1. 重启应用，打开任一会话（或刷新页面）。
2. 会话视图标签应出现 **项目记忆 / Project**（位于 Chat、Trajectory、Context、Fleet 之后，order 40）。
3. 点开应看到：6 条条目、类型/状态徽章、搜索框、类型筛选 chips、最近交接卡（下一步 + 活跃文件）。
4. 搜索“向量”应只剩 `P0 只做简报注入与 remember/recall…` 一条；点开显示完整正文。
5. 类型筛选 `决策` 应只剩 1 条；`全部` 恢复。
6. 明暗主题切换下背景/边框/文字颜色随主题变化（token 生效）。
7. 若标签未出现：Settings → Plugins 查看 `dsh-project` 是否有页面本地同步/加载错误（可点重试）。

## 已知限制

- 面板只读；编辑/删除条目仍需通过模型工具或直接编辑文件。
- API 基于本地 127.0.0.1 且不额外鉴权，依赖项目目录约束（白名单 + 相对路径校验）防越界。
- `/dsh-project/api/*` 依赖 `webServer` 服务；无 Web 的组合中该路由不注册，其余功能不受影响。
- 条目正文展开为原文（含 frontmatter），未做 Markdown 渲染；后续可接入宿主 Markdown 组件。

## 下一步

- P0.5 模块维度（模块卡、`entry.module`、cwd 绑定、分层注入、契约提示），面板随之增加模块筛选/看板。
- 或面板增强：写入入口、Markdown 渲染、按更新时间分组。
