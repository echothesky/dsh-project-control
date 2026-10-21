# dsh-project · 模块会话 Git Worktree 隔离 · 交付与验证记录

日期：2026-10-21
范围：`project_module action=open` / `/module open <id>` 的 `--worktree` 选项
安装：`include:dsh-project` · `enabled: true` · `fiberPhase: active`

## 交付内容

| 能力 | 说明 |
|---|---|
| 服务优先 | 组合里有 `ctx.worktrees` 时用它创建（策略/清理/cwd 发布由服务负责） |
| Git CLI 回退 | 桌面 profile 未挂载 `worktrees` 服务，改用 `git worktree add`（`node:child_process`） |
| 前置校验 | 先沿模块目录向上找 `.git`；找不到直接报错，**不会创建多余会话** |
| 分支/路径 | 分支 `dsh-<module>-<stamp>`；checkout `<repo 父目录>/.dsh-worktrees/<repo>-<module>-<stamp>` |
| 记忆共享 | worktree 根建 `.dsh` 目录 junction 指向项目 `.dsh`；失败时复制快照并报告 `memory: copied` |
| 会话绑定 | 新会话同时写显式绑定到 `.dsh/project/sessions.json` |
| 失败回收 | 创建失败时 `handle.dispose()` 释放新 agent，并 `git worktree remove` + `branch -D` |

## 验证结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| H1 | 环境原语可用 | 通过 | 临时仓库 `git worktree add` 成功（分支 test-branch）；Node 目录 junction 读取成功 |
| H2 | 真实仓库成功创建 | 通过 | 夹具仓库 `.dsh/worktree-fixture`（commit 3a3fc61）→ `open fixture --worktree` 成功 |
| H3 | 新会话与 worktree | 通过 | 返回 `session-b8f8bb0f-acb2-40f0-84f6-ada642cf0d89`；checkout 位于 `.dsh/.dsh-worktrees/worktree-fixture-fixture-mvhhx87w`，`git worktree list` 显示分支 `dsh-fixture-mvhhx87w`，工作区含 `README.md` |
| H4 | 记忆随 worktree 可用 | 通过（复制回退） | junction 对「位于 `.dsh` 内部的 worktree」不可用 → 自动复制快照，`memory: copied`；checkout 内 `.dsh/project/` 含 brief/catalog/entries/handoff |
| H5 | 显式绑定 | 通过 | `sessions.json` 增加 `session-b8f8bb0f… -> fixture` |
| H6 | 非 Git 仓库错误路径 | 通过 | 对 `host-core`（工作区无 `.git`）执行 worktree 打开 → `worktree isolation requires a Git repository containing …\packages\dsh-project`，未创建会话 |
| H7 | 清理 | 通过 | `git worktree remove`、`git branch -D`、夹具目录/模块卡/skill/绑定均已删除；`worktree list` 只剩主仓库 |

## 设计取舍

1. **为什么走 Git CLI 回退**：`worktrees` 服务在 Service 目录里可见，但本 profile 的组合并未挂载它（`cordis.yml` 无对应行），`ctx.get('worktrees')` 返回 `undefined`。保留服务优先以适配其他 profile。
2. **为什么 junction 可能退化为复制**：worktree 默认放在仓库同级目录；本测试的夹具仓库位于 `.dsh` 内部，worktree 也在 `.dsh` 内，junction 指向祖先目录被系统拒绝。真实项目（worktree 在仓库外）通常会成功 junction，实现真正的共享记忆。
3. **不把 worktree 放进仓库内部**：避免 checkout 被父仓库当作未跟踪目录；默认放在仓库父目录的 `.dsh-worktrees/`。

## 已知限制

- 清理是手动的（无自动过期/回收）；失败路径会回收，成功路径保留 checkout 供合并。
- Windows 上 junction 需要文件系统支持；其它情况退化为快照复制，两个 worktree 的记忆此后各自演化。
- 依赖本机 `git` 可执行文件；未使用 `ctx.subprocess` 策略（后续可迁移）。
- 测试产生的一个会话（`session-b8f8bb0f…`）仍在侧栏，可直接归档。

## 使用

```
/module open docs --worktree
# 或模型侧：
project_module { action: "open", id: "docs", worktree: true }
```

返回的 `hint` 会给出会话 id、worktree 路径/分支与 memory 模式（linked/copied）。打开该会话即在该模块的隔离 checkout 中工作；合并后手动清理。
