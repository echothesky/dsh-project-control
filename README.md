# dsh-project-control

[![check](https://github.com/echothesky/dsh-project-control/actions/workflows/check.yml/badge.svg)](https://github.com/echothesky/dsh-project-control/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/dsh-project-control.svg)](https://www.npmjs.com/package/dsh-project-control)
[![license](https://img.shields.io/github/license/echothesky/dsh-project-control.svg)](https://github.com/echothesky/dsh-project-control/blob/main/LICENSE)

**English** | [简体中文](https://github.com/echothesky/dsh-project-control/blob/main/README.zh-CN.md)

Durable project memory and modular-development workflow for [DeepSeek Harness](https://www.deepseek.com/harness/).

Long sessions hit the context limit; compaction keeps a generic summary and drops
the decisions, constraints and open questions that actually drive the work. New
sessions start cold. Different modules compete for one context window.

`dsh-project-control` keeps that state **outside** the model context — as plain
files in your repository — and injects back only a compact brief.

![dsh-project-control overview](https://github.com/echothesky/dsh-project-control/raw/main/docs/assets/overview.svg)

## Features

- **Layered brief injection**: project layer (goal, global constraints, module
  map) plus module layer (goal, next step, module decisions), budgeted in
  characters so CJK text is not under-counted. Injected as a sourced
  `user/message` before each step; the system prompt is never rewritten, so the
  KV-cache prefix survives.
- **Durable store**: decisions, constraints, glossary terms, open questions and
  contracts, one Markdown file per entry. Written by the model through one tool,
  fetched by exact keyword matching — no embeddings, no vector database.
- **Compaction handoff**: on `compaction/end` a resume snapshot is written and a
  short resume brief is injected on the next request. The summary may forget; the
  files do not.
- **Modules**: module cards, session binding by working directory, module-scoped
  recall, and one command to open an isolated module session.
- **Contracts**: `proposed` / `active` / `breaking` contract entries; a breaking
  contract from a dependency surfaces in the brief and in the handoff.
- **On-demand skills**: export the store as `.dsh/skills/*/SKILL.md`; only
  name/description stay resident, bodies load through the `skill` tool. Exports
  refresh automatically after writes.
- **Web board**: a "Project memory" conversation tab with entries, filters,
  expanded bodies and the latest handoff.

## Install

```sh
# npm
dsh plugin --profile web add dsh-project-control

# Git
dsh plugin --profile web add git+https://github.com/echothesky/dsh-project-control.git

# local checkout
dsh plugin --profile web add /absolute/path/to/dsh-project
```

Or open **Settings → Plugins → Add plugin** in the Harness UI and search for
`dsh-project-control`.

> **One restart after the first client load.** The harness caches package
> manifests for the Host lifetime, so the "Project memory" tab joins the boot
> graph only after a restart. Later host-side edits reload without a restart;
> client bundle edits need only a page refresh.

## Quick start

```text
# ask the agent to remember something durable
"Remember: this project always uses pnpm, never npm"
  → project_remember(type: "constraint", ...)

# later, in any session
"Why did we choose this approach?"
  → project_recall(query: "approach")
```

Human commands:

```text
/project                       store status and the current module binding
/project export all            regenerate .dsh/skills
/handoff <next step>           write a resume snapshot
/module list                   list modules and the binding
/module use docs               bind this session to a module
/module open docs --worktree   new session in an isolated Git worktree
```

## How it works

**Brief injection.** Before a step the plugin renders the brief and appends it as
a sourced `user/message` (`source.kind = "dsh-project"`) through `agent/pre-step`.
Each injection carries a digest; a resumed session that already shows the same
digest is not injected again. Failures degrade to no injection.

**Modules and binding.** A session binds to a module by, in order: an explicit
override (`/module use <id>`, stored in `sessions.json`), the longest module
`path` containing the session cwd, then project level (the "integration
session"). Unbound sessions see the project layer, the module map and every
breaking contract.

**Compaction handoff.** `compaction/end` writes `handoff/latest.md` (goal, module,
next step, contracts, open questions, recent decisions, active files, last
instruction) and marks the session for a resume brief. A periodic handoff
refreshes the file every `handoffEveryTurns` turns.

**Skills.** `project_export` writes deterministic `SKILL.md` files under
`<projectRoot>/.dsh/skills/`. The skill filesystem provider watches its roots, so
a new export joins the model catalog on the next request.

**Worktrees.** `worktree: true` opens the module session in a fresh Git worktree
(branch `dsh-<module>-<stamp>`); project memory is shared through a `.dsh`
directory junction, with a snapshot-copy fallback. Cleanup is manual:
`git worktree remove --force <path>` and `git branch -D <branch>`.

## Storage

Everything lives under `<projectRoot>/.dsh/` as plain Markdown/JSON — easy to
review, diff, version and hand-edit:

```text
.dsh/project/
├── brief.notes.md          # optional human-pinned goals and hard rules
├── entries/<type>/<id>.md  # decision | constraint | glossary | question | contract | note
├── modules/<id>.md         # module card: path/owner/status/deps/goal/contract/next step
├── sessions.json           # explicit session -> module bindings
├── handoff/latest.md       # resume snapshot
├── catalog.json            # derived index, rebuildable
└── brief.md                # human-readable mirror of the current brief

.dsh/skills/                # generated, on demand
├── module-<id>/SKILL.md
├── project-contracts/SKILL.md
└── project-memory/SKILL.md
```

`projectRoot` is the nearest ancestor containing `.git` (or an existing
`.dsh/project`); without either, the session working directory is used.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxBriefChars` | `1200` | Brief budget in characters (not tokens) |
| `maxRecallHits` | `5` | Default `project_recall` limit (1–10) |
| `resumeBriefChars` | `300` | Resume brief budget after compaction |
| `autoHandoff` | `true` | Refresh the handoff every `handoffEveryTurns` turns |
| `handoffEveryTurns` | `10` | Turn interval for the periodic handoff |
| `autoExport` | `true` | Re-export skills after writes |
| `autoExportDelayMs` | `1500` | Debounce window (200–10000 ms) |
| `readOnly` | `false` | Refuse writes from tools |

## Documentation

- [Design notes](https://github.com/echothesky/dsh-project-control/blob/main/docs/dsh-project-design.md)
- Verification records: [P0](https://github.com/echothesky/dsh-project-control/blob/main/docs/P0-verification.md),
  [P1](https://github.com/echothesky/dsh-project-control/blob/main/docs/P1-verification.md),
  [P2](https://github.com/echothesky/dsh-project-control/blob/main/docs/P2-verification.md),
  [P0.5](https://github.com/echothesky/dsh-project-control/blob/main/docs/P0.5-verification.md),
  [P3](https://github.com/echothesky/dsh-project-control/blob/main/docs/P3-verification.md),
  [P4 worktree](https://github.com/echothesky/dsh-project-control/blob/main/docs/P4-worktree-verification.md)
- [Release notes](https://github.com/echothesky/dsh-project-control/blob/main/docs/RELEASE-0.2.0.md),
  [Changelog](https://github.com/echothesky/dsh-project-control/blob/main/CHANGELOG.md)

## Development

```sh
node --input-type=module --check < index.js
node --input-type=module --check < client.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
```

Install a local checkout with the Harness plugin manager (`install_bundle` on the
absolute directory), then toggle the bundle off/on to reload Host code.

## Known limitations

- Contracts are free text; breaking-change propagation follows the module `deps`
  declaration, not an import graph.
- Worktree cleanup is manual; the Git CLI fallback is used when the `worktrees`
  service is not composed.
- File access uses Node `fs/promises` on the project directory rather than
  `ctx.fs` sandbox policies.
- Direct edits under `.dsh/project/` do not trigger automatic export.
- Without a `.git` marker the skill root falls back to the session cwd, so skills
  exported from a subdirectory session may not be discovered.

## License

MIT — see [LICENSE](https://github.com/echothesky/dsh-project-control/blob/main/LICENSE).
