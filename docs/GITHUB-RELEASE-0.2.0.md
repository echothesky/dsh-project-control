# dsh-project 0.2.0

Durable project memory for [DeepSeek Harness](https://www.deepseek.com/harness/):
keep decisions, constraints, contracts and open questions outside the model
context, and inject back only a compact brief. Built for the case where a long
session would otherwise lose its state to compaction, and where a new session
starts cold.

## Highlights

- **Layered brief injection** — project layer (goal, global constraints, module
  map) plus module layer (goal, next step, module decisions), budgeted in
  characters so CJK is not under-counted. Injected as a sourced `user/message`;
  the system prompt is never rewritten, so prefix KV cache survives.
- **Compaction handoff** — `compaction/end` writes a resume snapshot and the next
  request receives a short resume brief. The summary may forget; the files do not.
- **Modules and contracts** — module cards, session binding by cwd, entry
  ownership, and `breaking` contract notices for the modules that depend on them.
- **On-demand skills** — export the store as `.dsh/skills/*/SKILL.md`: only
  name/description stay resident, bodies load through the `skill` tool. Exports
  refresh automatically after writes (debounced).
- **Isolated module sessions** — `project_module open` / `/module open <id>
  --worktree` creates a session in a fresh Git worktree, sharing project memory
  through a `.dsh` junction (snapshot fallback).
- **Web board** — a "Project memory" conversation tab with entries, filters,
  expanded bodies and the latest handoff.

## Added

- Tools: `project_remember`, `project_recall`, `project_handoff`,
  `project_module`, `project_export`.
- Commands: `/project` (+ `export`), `/handoff`, `/module`.
- Storage under `.dsh/project/`: entries, module cards, `sessions.json`,
  `handoff/latest.md`, derived `catalog.json`.
- Configuration: `maxBriefChars`, `maxRecallHits`, `resumeBriefChars`,
  `autoHandoff`, `handoffEveryTurns`, `autoExport`, `autoExportDelayMs`,
  `readOnly`.
- Bilingual plugin metadata (English / 简体中文), icon, and a CI check workflow.

## Fixed

- `breaking` contracts were filtered out of the brief (active-only slice).
- Brief summaries picked up Markdown headings instead of the first prose line.
- `brief.notes.md` edits were delayed by the entry cache.
- Handoff "last instruction" could capture runtime context instead of a user prompt.
- Handoff active files could point outside the project.

## Install

```sh
# npm (once published)
dsh plugin --profile web add dsh-project

# Git
dsh plugin --profile web add git+https://github.com/OWNER/dsh-project.git

# local checkout
dsh plugin --profile web add /absolute/path/to/dsh-project
```

The first client load needs **one application restart** (the harness caches
package manifests for the Host lifetime). After that, host-side edits reload
without restart and client edits need only a page refresh.

## Verified

Brief injection (first step, change, resume), digest idempotency, subagent
isolation, module binding precedence, layered brief, contract breaking notices,
module-scoped recall, skill export + automatic catalog refresh, worktree creation
in a real repository, and the non-Git error path. Details:
`docs/P0-verification.md` … `docs/P4-worktree-verification.md`.

## Known limitations

- Contracts are free text; breaking propagation follows module `deps`, not an
  import graph.
- Worktree cleanup is manual; the Git CLI fallback is used when the `worktrees`
  service is not composed.
- File access uses Node `fs/promises` rather than `ctx.fs` sandbox policies.
- Direct edits under `.dsh/project/` do not trigger automatic export.

## 中文速览

为 DeepSeek Harness 提供持久项目记忆：分层简报注入、压缩交接与 resume 注入、
决策/约束/契约存储与关键词检索、模块绑定与破坏性契约提示、按需技能导出（自动
去抖重导出）、Git worktree 隔离会话，以及 Web 看板。纯本地文件，不联网、不做
向量检索。

完整变更见 [CHANGELOG.md](CHANGELOG.md)。
