# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Documentation

- Bilingual README: English (`README.md`) and 简体中文 (`README.zh-CN.md`), with a
  language switcher at the top of both files.

## [0.2.0] - 2026-10-21

First consolidated release.

### Packaging

- Published as **`dsh-project-control`**: the unscoped `dsh-project` name is
  owned by an unrelated `0.0.1` package on npm, so this package uses a distinct
  unscoped name. The bundle row name and the client bundle id match the package
  name.

### Added

- **Layer brief injection** (`agent/pre-step`): project layer (goal, global
  constraints, module map) plus module layer (goal, next step, module decisions,
  module constraints, module questions) within one character budget; injected as
  a sourced `user/message` with per-digest idempotency.
- **Compaction handoff**: on `compaction/end` the plugin writes
  `handoff/latest.md` (goal, module, next step, contracts, open questions,
  decisions, active files, last instruction) and injects a resume brief
  (`resumeBriefChars`, default 300) on the next request.
- **Tools**: `project_remember`, `project_recall`, `project_handoff`,
  `project_module` (`list`/`get`/`update`/`bind`/`open`), `project_export`.
- **Commands**: `/project` (with `export`), `/handoff`, `/module`.
- **Modules**: module cards under `.dsh/project/modules/`, entry `module`
  field, session binding by explicit override → longest cwd prefix → project
  level, `sessions.json`, layered brief, module-scoped recall.
- **Contracts**: `type: contract` entries with `proposed` / `active` /
  `breaking` status; breaking contracts of dependencies surface in the brief and
  in the handoff.
- **Skill export**: generated `.dsh/skills/{module-<id>, project-contracts,
  project-memory}/SKILL.md`; bodies load on demand through the `skill` tool.
- **Automatic export**: debounced re-export after `project_remember` /
  `project_module update` (`autoExport`, `autoExportDelayMs`).
- **Worktree isolation**: `project_module open` with `worktree: true` (or
  `/module open <id> --worktree`); prefers the composed `ctx.worktrees` service
  and falls back to `git worktree add`; shares `.dsh` through a directory
  junction (snapshot copy when the junction is unavailable).
- **Web board**: a "Project memory" conversation tab reading
  `/dsh-project/api/{state,entry}` — entries, filters, expanded bodies, handoff.
- **Icons, locale metadata, and configuration**: bilingual plugin metadata and a
  documented config surface.

### Fixed

- Contract entries with `breaking` status were filtered out of the brief
  (initial implementation read only `active` entries).
- Project brief summary picked up Markdown headings instead of the first prose
  line.
- `brief.notes.md` edits were delayed by the entry cache; the notes file is now
  read on every request.
- "Last instruction" in a handoff could capture runtime context; it now accepts
  only `source.kind === "user"` messages.
- Active files in a handoff could point outside the project; they are now
  project-relative and confined to the project root.

### Known limitations

See [README](README.md#known-limitations) and `docs/`.

## [0.1.0] - 2026-10-20

Internal development line (not separately released): brief injection,
`project_remember` / `project_recall`, `/project`, compaction handoff,
`/handoff`, and the Web board, developed and verified incrementally.
