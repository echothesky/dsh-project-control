/**
 * dsh-project — durable project memory for DeepSeek Harness.
 *
 * Canonical project state lives in `<projectRoot>/.dsh/project/` as one Markdown file per
 * entry plus a derived `catalog.json`. The model never reads the whole store: a compact
 * brief (<= maxBriefChars) is injected as a sourced user message before a step, and
 * details are fetched on demand through `project_recall`.
 *
 * Design invariants:
 * - Never append custom session event types; injected context is an ordinary sourced
 *   `user/message` built through `createUserMessage`, so replay/compaction stay sound.
 * - Append-only injection: the rendered system prompt is never rewritten.
 * - Injection is idempotent per digest; a resumed session adopts what the log already shows.
 * - Failure never blocks a turn: every hook path degrades to "no injection".
 *
 * @module dsh-project
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-project'
export const inject = ['tools', 'commands', 'workingDirectory', 'agents', 'sessions']

/** Source kind stamped on every injected message; also the resume-detection key. */
const SOURCE_KIND = 'dsh-project'
/** Project-scoped state directory, relative to the project root. */
const PROJECT_DIR = '.dsh/project'
const ENTRY_TYPES = ['decision', 'constraint', 'glossary', 'question', 'contract', 'note']
const ID_PREFIX = {
  decision: 'dec',
  constraint: 'con',
  glossary: 'glo',
  question: 'que',
  contract: 'ctr',
  note: 'not',
}
const MAX_TITLE_CHARS = 80
const MAX_BODY_CHARS = 4000
const MAX_TAGS = 8
const BRIEF_TTL_MS = 3000
const ROOT_TTL_MS = 5000

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString()

/** Short stable digest for a rendered block. */
const digestOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16)

/** Collapse whitespace and clip to `max` characters. */
function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

/** Prevent repository-controlled text from closing the plugin-owned reminder frame. */
const escapeFrame = (text) => String(text).replace(/<\/system-reminder>/gi, '<\\/system-reminder>')

function normalizedList(value, maxItems) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = clip(item, 60)
    if (text.length > 0 && !out.includes(text)) out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

function normalizedIdList(value) {
  return normalizedList(value, 16).filter((id) => /^[a-z]{3}-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id))
}

/** Mint a collision-free entry id: `<prefix>-<yyyymmdd>-<hhmmss>-<hex4>`. */
function mintId(type) {
  const date = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${ID_PREFIX[type] ?? 'not'}-${day}-${time}-${randomBytes(2).toString('hex')}`
}

// ---------------------------------------------------------------------------
// frontmatter: a deliberately small parser for files this plugin writes
// ---------------------------------------------------------------------------

function unquote(raw) {
  const text = raw.trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1)
  }
  return text
}

function parseScalar(raw) {
  const text = raw.trim()
  if (text === '') return ''
  if (text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (inner === '') return []
    return inner
      .split(',')
      .map((part) => unquote(part))
      .filter((part) => part.length > 0)
  }
  return unquote(text)
}

/** Parse one entry file. Returns `null` for anything that is not a plugin entry. */
function parseEntry(text, filePath, projectDir) {
  const source = String(text)
  if (!source.startsWith('---')) return null
  const end = source.indexOf('\n---', 3)
  if (end === -1) return null
  const head = source.slice(3, end).split('\n')
  const body = source.slice(end + 4).replace(/^\n+/, '')
  const meta = {}
  for (const line of head) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (key.length === 0) continue
    meta[key] = parseScalar(line.slice(index + 1))
  }
  if (typeof meta.id !== 'string' || meta.id.length === 0) return null
  return {
    id: meta.id,
    type: typeof meta.type === 'string' && ENTRY_TYPES.includes(meta.type) ? meta.type : 'note',
    title: typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : meta.id,
    status: typeof meta.status === 'string' ? meta.status : 'active',
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    created: typeof meta.created === 'string' ? meta.created : '',
    updated: typeof meta.updated === 'string' ? meta.updated : '',
    supersedes: Array.isArray(meta.supersedes) ? meta.supersedes.map(String) : [],
    superseded_by: typeof meta.superseded_by === 'string' ? meta.superseded_by : null,
    scope: Array.isArray(meta.scope) ? meta.scope.map(String) : [],
    module: typeof meta.module === 'string' && meta.module.length > 0 ? meta.module : null,
    body,
    path: relative(projectDir, filePath).split('\\').join('/'),
    file: filePath,
  }
}

/** Render one entry file from a plain record. */
function renderEntry(record) {
  const lines = [
    '---',
    `id: ${record.id}`,
    `type: ${record.type}`,
    `title: ${clip(record.title, MAX_TITLE_CHARS)}`,
    `status: ${record.status}`,
    `tags: [${record.tags.join(', ')}]`,
    `created: ${record.created}`,
    `updated: ${record.updated}`,
    `supersedes: [${record.supersedes.join(', ')}]`,
    `superseded_by: ${record.superseded_by ?? 'null'}`,
    `scope: [${record.scope.join(', ')}]`,
    `module: ${record.module ?? 'null'}`,
    '---',
    '',
    record.body.trim(),
    '',
  ]
  return lines.join('\n')
}

/** First meaningful body line, used as the catalog summary and brief detail. */
function summaryOf(entry) {
  for (const rawLine of String(entry.body ?? '').split('\n')) {
    const line = rawLine.trim()
    // Headings are structural; the summary is the first prose line under them.
    if (line.length === 0 || line.startsWith('#') || line.startsWith('---')) continue
    // Strip only structural markers (quote/list prefix, code ticks) so identifiers,
    // underscores, and angle-bracket placeholders survive in the summary.
    const text = line.replace(/^[>*+-]\s*/, '').replace(/`/g, '').trim()
    if (text.length > 0) return clip(text, 80)
  }
  return clip(entry.title, 80)
}

// ---------------------------------------------------------------------------
// filesystem helpers
// ---------------------------------------------------------------------------

async function pathKind(path) {
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'dir'
    if (info.isFile()) return 'file'
    return 'other'
  } catch {
    return null
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function readEntries(projectDir) {
  const entries = []
  for (const type of ENTRY_TYPES) {
    const dir = join(projectDir, 'entries', type)
    let names
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const entryName of names) {
      if (!entryName.endsWith('.md')) continue
      const file = join(dir, entryName)
      const text = await readOptional(file)
      if (text === null) continue
      const entry = parseEntry(text, file, projectDir)
      if (entry !== null) entries.push(entry)
    }
  }
  entries.sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)))
  return entries
}

function catalogOf(entries) {
  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    entries: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      title: entry.title,
      status: entry.status,
      tags: entry.tags,
      created: entry.created,
      updated: entry.updated,
      path: entry.path,
      module: entry.module ?? null,
      summary: summaryOf(entry),
    })),
  }
}

async function writeCatalog(projectDir, entries) {
  try {
    await writeFile(join(projectDir, 'catalog.json'), `${JSON.stringify(catalogOf(entries), null, 2)}\n`, 'utf8')
  } catch {
    // catalog is derived state; a failed write must not fail the tool call
  }
}

// ---------------------------------------------------------------------------
// modules: project decomposition (module cards + session binding)
// ---------------------------------------------------------------------------

const moduleCache = new Map()

/** Read one `## heading` section out of a module card body. */
function sectionOf(body, heading) {
  const pattern = new RegExp(`^##\\s*${heading}\\s*$`, 'm')
  const match = pattern.exec(body)
  if (match === null) return ''
  const rest = body.slice(match.index + match[0].length)
  const next = /\n##\s+/.exec(rest)
  return (next === null ? rest : rest.slice(0, next.index)).trim()
}

function parseModuleFile(text, filePath, projectDir) {
  const source = String(text)
  if (!source.startsWith('---')) return null
  const end = source.indexOf('\n---', 3)
  if (end === -1) return null
  const head = source.slice(3, end).split('\n')
  const body = source.slice(end + 4).replace(/^\n+/, '')
  const meta = {}
  for (const line of head) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (key.length === 0) continue
    meta[key] = parseScalar(line.slice(index + 1))
  }
  if (typeof meta.id !== 'string' || meta.id.length === 0) return null
  return {
    id: meta.id,
    title: typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : meta.id,
    path: typeof meta.path === 'string' ? meta.path : '',
    owner: typeof meta.owner === 'string' ? meta.owner : '',
    status: typeof meta.status === 'string' ? meta.status : 'active',
    deps: Array.isArray(meta.deps) ? meta.deps.map(String) : [],
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    updated: typeof meta.updated === 'string' ? meta.updated : '',
    goal: sectionOf(body, '模块目标') || sectionOf(body, '目标'),
    contract: sectionOf(body, '对外提供') || sectionOf(body, '契约'),
    nextStep: sectionOf(body, '当前下一步') || sectionOf(body, '下一步'),
    body,
    file: filePath,
    relPath: relative(projectDir, filePath).split('\\').join('/'),
  }
}

function renderModuleFile(record) {
  return [
    '---',
    `id: ${record.id}`,
    `title: ${clip(record.title ?? record.id, MAX_TITLE_CHARS)}`,
    `path: ${record.path ?? ''}`,
    `owner: ${record.owner ?? ''}`,
    `status: ${record.status ?? 'active'}`,
    `deps: [${(record.deps ?? []).join(', ')}]`,
    `tags: [${(record.tags ?? []).join(', ')}]`,
    `updated: ${record.updated ?? nowIso()}`,
    '---',
    '',
    '## 模块目标',
    record.goal !== undefined && record.goal.length > 0 ? record.goal : '（待补充）',
    '',
    '## 对外提供',
    record.contract !== undefined && record.contract.length > 0 ? record.contract : '（待补充）',
    '',
    '## 当前下一步',
    record.nextStep !== undefined && record.nextStep.length > 0 ? record.nextStep : '（待补充）',
    '',
  ].join('\n')
}

async function readModules(projectDir) {
  let names
  try {
    names = await readdir(join(projectDir, 'modules'))
  } catch {
    return []
  }
  const modules = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const file = join(projectDir, 'modules', name)
    const text = await readOptional(file)
    if (text === null) continue
    const module = parseModuleFile(text, file, projectDir)
    if (module !== null) modules.push(module)
  }
  modules.sort((left, right) => left.id.localeCompare(right.id))
  return modules
}

async function modulesFor(projectDir) {
  const cached = moduleCache.get(projectDir)
  if (cached !== undefined && Date.now() - cached.at < BRIEF_TTL_MS) return cached.value
  const value = await readModules(projectDir)
  moduleCache.set(projectDir, { at: Date.now(), value })
  return value
}

async function writeModuleCard(projectDir, record) {
  await mkdir(join(projectDir, 'modules'), { recursive: true })
  const file = join(projectDir, 'modules', `${record.id}.md`)
  await writeFile(file, renderModuleFile({ ...record, updated: nowIso() }), 'utf8')
  moduleCache.delete(projectDir)
  return file
}

/** Explicit per-session overrides, stored beside the project state. */
async function readSessionBindings(projectDir) {
  const text = await readOptional(join(projectDir, 'sessions.json'))
  if (text === null) return {}
  try {
    const parsed = JSON.parse(text)
    const sessions = parsed !== null && typeof parsed === 'object' ? parsed.sessions : undefined
    return sessions !== null && typeof sessions === 'object' ? sessions : {}
  } catch {
    return {}
  }
}

async function writeSessionBinding(projectDir, sessionId, moduleId) {
  const sessions = await readSessionBindings(projectDir)
  if (moduleId === null) delete sessions[sessionId]
  else sessions[sessionId] = { module: moduleId, updated: nowIso() }
  try {
    await writeFile(
      join(projectDir, 'sessions.json'),
      `${JSON.stringify({ schemaVersion: 1, sessions }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // binding is a convenience override; failing to persist it keeps the cwd rule working
  }
}

/** Absolute directory depth when `cwd` lives under the module path, else -1. */
function moduleMatchDepth(module, cwd, projectRoot) {
  if (typeof module.path !== 'string' || module.path.trim().length === 0) return -1
  try {
    const moduleDir = resolve(projectRoot, module.path.trim())
    const relativePath = relative(moduleDir, cwd)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) return -1
    return moduleDir.length
  } catch {
    return -1
  }
}

/**
 * Bind one session to a module: explicit override, then the longest module path
 * that contains the session cwd, then the project-level (unbound) fallback.
 */
async function resolveBinding(ctx, session, project) {
  const modules = await modulesFor(project.dir)
  if (modules.length === 0) return { module: null, source: 'none', modules }
  const bindings = await readSessionBindings(project.dir)
  const explicit = bindings[session.id]
  if (explicit !== undefined && explicit !== null && typeof explicit.module === 'string') {
    const found = modules.find((module) => module.id === explicit.module)
    if (found !== undefined) return { module: found, source: 'explicit', modules }
  }
  const cwd = sessionCwd(ctx, session)
  if (cwd !== null) {
    let best = null
    let bestDepth = -1
    for (const module of modules) {
      const depth = moduleMatchDepth(module, cwd, project.root)
      if (depth > bestDepth) {
        best = module
        bestDepth = depth
      }
    }
    if (best !== null) return { module: best, source: 'cwd', modules }
  }
  return { module: null, source: 'project', modules }
}

function moduleMapLine(modules) {
  const parts = modules.map((module) => `${module.id}${module.status === 'active' ? '' : `(${module.status})`}`)
  return `模块地图：${parts.join(' / ')}`
}

/**
 * Share the project state with a worktree checkout. A directory junction keeps one
 * canonical `.dsh/project`; filesystems that reject junctions fall back to a
 * snapshot copy so the new session still starts with memory.
 */
async function linkWorktreeMemory(project, worktreePath) {
  const target = join(worktreePath, '.dsh')
  if ((await pathKind(target)) !== null) return 'kept'
  await mkdir(join(worktreePath, '.dsh'), { recursive: true })
  try {
    await symlink(join(project.root, '.dsh'), target, 'junction')
    return 'linked'
  } catch {
    await cp(project.dir, join(target, 'project'), { recursive: true })
    return 'copied'
  }
}

const execFileAsync = promisify(execFile)

/** Walk up from `startDir` to the nearest directory containing `.git`. */
async function findGitRoot(startDir) {
  let dir = resolve(startDir)
  for (let depth = 0; depth < 64; depth += 1) {
    if ((await pathKind(join(dir, '.git'))) !== null) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Branch + checkout paths are siblings of the repository, outside its working tree. */
function worktreeTarget(repoRoot, moduleId) {
  const stamp = Date.now().toString(36)
  const safe = moduleId.replace(/[^a-z0-9-]/g, '-').slice(0, 24)
  return {
    branch: `dsh-${safe}-${stamp}`,
    path: join(dirname(repoRoot), '.dsh-worktrees', `${basename(repoRoot)}-${safe}-${stamp}`),
  }
}

async function createGitWorktree(repoRoot, moduleId, signal) {
  const target = worktreeTarget(repoRoot, moduleId)
  await mkdir(dirname(target.path), { recursive: true })
  await execFileAsync('git', ['-C', repoRoot, 'worktree', 'add', '-b', target.branch, target.path], {
    windowsHide: true,
    signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  const { stdout } = await execFileAsync('git', ['-C', target.path, 'rev-parse', 'HEAD'], {
    windowsHide: true,
    signal,
    maxBuffer: 1024 * 1024,
  })
  return { ...target, baseCommit: stdout.trim(), repositoryRoot: repoRoot }
}

async function removeGitWorktree(repoRoot, path, branch) {
  try {
    await execFileAsync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', path], { windowsHide: true })
  } catch {
    // best effort: a failed cleanup leaves the checkout for the user to inspect
  }
  try {
    await execFileAsync('git', ['-C', repoRoot, 'branch', '-D', branch], { windowsHide: true })
  } catch {
    // best effort
  }
}

/** Create a new session for a module; with `worktree` it gets an isolated checkout. */
async function openModuleSession(ctx, project, module, options = {}) {
  const modulePath = typeof module.path === 'string' ? module.path.trim() : ''
  if (modulePath.length === 0) throw new Error(`module "${module.id}" has no path; set one before opening a session`)
  const moduleDir = resolve(project.root, modulePath)
  if ((await pathKind(moduleDir)) !== 'dir') throw new Error(`module path does not exist: ${moduleDir}`)
  const agents = ctx.get('agents')
  if (agents === undefined) throw new Error('agent service is unavailable in this composition')

  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  const agentOptions =
    selection !== null &&
    selection !== undefined &&
    typeof selection.provider === 'string' &&
    typeof selection.model === 'string'
      ? { provider: selection.provider, model: selection.model }
      : undefined
  const createAgent = (cwd) =>
    agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd },
      ...(agentOptions !== undefined ? { agentOptions } : {}),
    })

  if (options.worktree !== true) {
    const handle = await createAgent(moduleDir)
    return { sessionId: handle.agent.id, cwd: moduleDir, worktree: null }
  }

  const repoRoot = await findGitRoot(moduleDir)
  if (repoRoot === null) throw new Error(`worktree isolation requires a Git repository containing ${moduleDir}`)
  // The desktop profile does not mount the `worktrees` service, so the git CLI is the
  // fallback; when the service is composed it owns policy, cleanup, and cwd publication.
  const worktrees = ctx.get('worktrees')
  const handle = await createAgent(moduleDir)
  let created
  let viaService = false
  try {
    if (worktrees !== undefined) {
      viaService = true
      const safe = module.id.replace(/[^a-z0-9-]/g, '-').slice(0, 24)
      const result = await worktrees.create(
        handle.agent,
        { name: `dsh-${safe}-${Date.now().toString(36)}` },
        options.signal,
      )
      created = {
        path: result.path,
        branch: result.branch,
        baseCommit: result.baseCommit,
        repositoryRoot: result.repositoryRoot,
      }
    } else {
      created = await createGitWorktree(repoRoot, module.id, options.signal)
    }
    const memory = await linkWorktreeMemory(project, created.path)
    const inWorktree = resolve(created.path, modulePath)
    const finalCwd = (await pathKind(inWorktree)) === 'dir' ? inWorktree : created.path
    if (finalCwd !== created.path) {
      try {
        await ctx.workingDirectory.set(handle.agent, finalCwd, options.signal)
      } catch {
        // the explicit binding below still points the session at its module
      }
    }
    await writeSessionBinding(project.dir, handle.agent.id, module.id)
    return {
      sessionId: handle.agent.id,
      cwd: finalCwd,
      worktree: { ...created, memory, via: viaService ? 'service' : 'git' },
    }
  } catch (error) {
    try {
      await handle.dispose()
    } catch {
      // disposing is best-effort; the error below is the actionable one
    }
    if (!viaService && created !== undefined) await removeGitWorktree(repoRoot, created.path, created.branch)
    throw new Error(`worktree isolation failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Resolve a requested module id against the bound default; `none` clears it. */
function chooseModuleId(binding, requested) {
  if (requested === undefined || requested === null) return binding.module === null ? null : binding.module.id
  const text = String(requested).trim()
  if (text === '' || text === 'none') return null
  const found = binding.modules.find((module) => module.id === text)
  if (found === undefined) {
    const known = binding.modules.map((module) => module.id).join(', ')
    throw new Error(`unknown module "${text}"${known.length > 0 ? `; known modules: ${known}` : '; no modules defined yet'}`)
  }
  return found.id
}


// ---------------------------------------------------------------------------
// skills export: on-demand knowledge under <projectRoot>/.dsh/skills
// ---------------------------------------------------------------------------

const SKILL_DIR = join('.dsh', 'skills')

/** JSON string literals are valid YAML scalars, so quotes/colons stay safe. */
function yamlString(value) {
  return JSON.stringify(String(value))
}

function skillFrontmatter(skillName, description, whenToUse) {
  return [
    '---',
    `name: ${skillName}`,
    `description: ${yamlString(description)}`,
    ...(whenToUse !== undefined ? [`whenToUse: ${yamlString(whenToUse)}`] : []),
    '---',
    '',
  ].join('\n')
}

function moduleSkill(module, entries) {
  const moduleEntries = entries.filter((entry) => entry.module === module.id)
  const contracts = moduleEntries.filter((entry) => entry.type === 'contract')
  const constraints = moduleEntries.filter((entry) => entry.type === 'constraint' && entry.status === 'active').slice(0, 6)
  const decisions = moduleEntries.filter((entry) => entry.type === 'decision' && entry.status === 'active').slice(0, 6)
  const questions = moduleEntries.filter((entry) => entry.type === 'question' && entry.status === 'active').slice(0, 4)
  const lines = [
    skillFrontmatter(
      `module-${module.id}`,
      `${module.id}（${module.title}）：${clip(module.goal.length > 0 ? module.goal : module.title, 90)}`,
      `当任务涉及模块 ${module.id}${module.path.length > 0 ? `（${module.path}）` : ''}，或需要该模块的契约、约束与近期决策时`,
    ),
    `# 模块：${module.id}（${module.title}）`,
    '',
    `- 路径：${module.path || '（未设置）'}`,
    `- 负责人：${module.owner || '（未设置）'}`,
    `- 状态：${module.status}`,
    `- 依赖：${module.deps.length > 0 ? module.deps.join(', ') : '（无）'}`,
    ...(module.nextStep.length > 0 ? ['', '## 当前下一步', module.nextStep] : []),
    ...(module.goal.length > 0 ? ['', '## 模块目标', module.goal] : []),
    ...(module.contract.length > 0 ? ['', '## 对外提供', module.contract] : []),
    ...(contracts.length > 0
      ? ['', '## 契约', ...contracts.map((entry) => `- [${entry.status}] ${entry.id} ${entry.title}（${entry.path}）`)]
      : []),
    ...(constraints.length > 0 ? ['', '## 约束', ...constraints.map((entry) => `- ${entry.id} ${entry.title}`)] : []),
    ...(decisions.length > 0 ? ['', '## 近期决策', ...decisions.map((entry) => `- ${entry.id} ${entry.title}`)] : []),
    ...(questions.length > 0 ? ['', '## 未决问题', ...questions.map((entry) => `- ${entry.id} ${entry.title}`)] : []),
    '',
    '## 详细检索',
    `调用 project_recall(query, module: "${module.id}") 取条目摘要；完整正文在 .dsh/project/entries/ 下。`,
    `模块卡：.dsh/project/modules/${module.id}.md — 需要改目标/下一步时用 project_module update。`,
    '',
  ]
  return { name: `module-${module.id}`, text: lines.join('\n') }
}

function contractsSkill(entries, modules) {
  const contracts = entries.filter((entry) => entry.type === 'contract')
  const lines = [
    skillFrontmatter(
      'project-contracts',
      '项目契约总览：各模块对外接口、状态与破坏性变更',
      '集成、跨模块改动或需要确认接口是否兼容时',
    ),
    '# 项目契约总览',
    '',
    ...(contracts.length === 0
      ? ['（暂无契约条目）']
      : contracts.map((entry) => {
          const module = modules.find((item) => item.id === entry.module)
          return `- [${entry.status}] ${entry.id} ${entry.title} · 模块：${entry.module ?? '项目级'}${
            module !== undefined ? `（${module.title}）` : ''
          } · ${entry.path}`
        })),
    '',
    '破坏性变更（breaking）需要在依赖模块的会话里确认迁移。',
    '',
  ]
  return { name: 'project-contracts', text: lines.join('\n') }
}

function projectSkill(project, modules, entries) {
  const counts = countByType(entries)
  const lines = [
    skillFrontmatter(
      'project-memory',
      '项目记忆库使用说明：模块、契约、决策、交接与检索方式',
      '开始新会话、需要了解项目状态或恢复上下文时',
    ),
    '# 项目记忆',
    `- 项目目录：${project.dir}`,
    `- 条目：${counts.total}（决策 ${counts.decision} / 约束 ${counts.constraint} / 契约 ${counts.contract} / 问题 ${counts.question}）`,
    `- 模块：${modules.length > 0 ? modules.map((module) => `${module.id}(${module.status})`).join(', ') : '（无）'}`,
    '',
    '## 怎么用',
    '- 检索：`project_recall(query, type?, module?, limit?)`，默认只看当前绑定模块；`module: "*"` 跨模块。',
    '- 记录：`project_remember(type, title, body, ...)`，type 可为 decision / constraint / glossary / question / contract / note。',
    '- 模块：`project_module` 的 list / get / update / bind / open；`/module use <id>` 切换绑定。',
    '- 交接：`project_handoff` 或 `/handoff`；压缩结束后会自动写 handoff 并注入 resume 简报。',
    '',
    '## 目录',
    '- `.dsh/project/brief.notes.md`：人工置顶的目标 / 铁律',
    '- `.dsh/project/entries/<type>/`：条目',
    '- `.dsh/project/modules/`：模块卡',
    '- `.dsh/project/handoff/latest.md`：最近交接',
    '',
  ]
  return { name: 'project-memory', text: lines.join('\n') }
}

async function exportSkills(project, modules, entries, options = {}) {
  const target = options.target ?? 'all'
  const skills = []
  if (target === 'modules' || target === 'all') {
    for (const module of modules) {
      if (options.module !== undefined && module.id !== options.module) continue
      skills.push(moduleSkill(module, entries))
    }
  }
  if (target === 'contracts' || target === 'all') skills.push(contractsSkill(entries, modules))
  if (target === 'project' || target === 'all') skills.push(projectSkill(project, modules, entries))
  const written = []
  for (const skill of skills) {
    const dir = join(project.root, SKILL_DIR, skill.name)
    const file = join(dir, 'SKILL.md')
    const path = relative(project.root, file).split('\\').join('/')
    if (options.dryRun !== true) {
      await mkdir(dir, { recursive: true })
      await writeFile(file, skill.text, 'utf8')
    }
    written.push({ name: skill.name, path })
  }
  return written
}

// ---------------------------------------------------------------------------
// auto export: debounced refresh of the generated skills after a write
// ---------------------------------------------------------------------------

const exportTimers = new Map()

async function runAutoExport(ctx, project) {
  if (!project.hasProject) return
  const modules = await modulesFor(project.dir)
  const entries = await readEntries(project.dir)
  if (modules.length === 0 && entries.length === 0) return
  const written = await exportSkills(project, modules, entries, { target: 'all' })
  try {
    ctx.logger.info?.(`dsh-project: auto-exported ${written.length} skill(s)`)
  } catch {
    // logging must never fail a write
  }
}

/** Coalesce bursts of writes into one export per project root. */
function scheduleAutoExport(ctx, config, project) {
  if (config.autoExport !== true) return
  const key = project.root
  const previous = exportTimers.get(key)
  if (previous !== undefined) clearTimeout(previous)
  const timer = setTimeout(() => {
    exportTimers.delete(key)
    void runAutoExport(ctx, project).catch((error) => {
      try {
        ctx.logger.warn('dsh-project: auto-export failed: %o', error)
      } catch {
        // logging must never fail a write
      }
    })
  }, config.autoExportDelayMs)
  if (typeof timer.unref === 'function') timer.unref()
  exportTimers.set(key, timer)
}

function clearAutoExports() {
  for (const timer of exportTimers.values()) clearTimeout(timer)
  exportTimers.clear()
}

// ---------------------------------------------------------------------------
// project discovery (cached; `.git` marker or an existing .dsh/project directory)
// ---------------------------------------------------------------------------

const rootCache = new Map()

async function discoverProject(cwd) {
  let dir = resolve(cwd)
  for (let depth = 0; depth < 64; depth += 1) {
    const gitKind = await pathKind(join(dir, '.git'))
    const projectKind = await pathKind(join(dir, PROJECT_DIR))
    if (gitKind !== null || projectKind !== null) {
      return { root: dir, dir: join(dir, PROJECT_DIR), hasProject: projectKind === 'dir' || projectKind !== null }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const fallback = resolve(cwd)
  const kind = await pathKind(join(fallback, PROJECT_DIR))
  return { root: fallback, dir: join(fallback, PROJECT_DIR), hasProject: kind !== null }
}

async function projectFor(cwd) {
  const key = resolve(cwd)
  const hit = rootCache.get(key)
  const now = Date.now()
  if (hit !== undefined && now - hit.at < ROOT_TTL_MS) return hit.value
  const value = await discoverProject(key)
  rootCache.set(key, { at: now, value })
  return value
}

// ---------------------------------------------------------------------------
// brief assembly
// ---------------------------------------------------------------------------

const briefCache = new Map()

function countByType(entries) {
  const counts = { total: entries.length, decision: 0, constraint: 0, glossary: 0, question: 0, contract: 0, note: 0 }
  for (const entry of entries) {
    if (entry.status !== 'active') continue
    if (Object.hasOwn(counts, entry.type)) counts[entry.type] += 1
  }
  return counts
}

/** Keep blocks by priority until the character budget is exhausted. */
function assembleBrief(blocks, maxChars) {
  const kept = []
  let total = 0
  for (const block of blocks) {
    if (block === null || block.text.length === 0) continue
    const cost = (kept.length === 0 ? 0 : 1) + block.text.length
    if (block.priority >= 9 || total + cost <= maxChars) {
      kept.push(block)
      total += cost
    }
  }
  return kept.map((block) => block.text).join('\n')
}

async function buildBrief(project, config, binding = null) {
  if (!project.hasProject) return null
  // Only the entry scan is cached; `brief.notes.md` is a human-pinned file that must be
  // picked up on the very next request, so it is read fresh every time.
  const cached = briefCache.get(project.dir)
  let entries
  if (cached !== undefined && Date.now() - cached.at < BRIEF_TTL_MS) {
    entries = cached.entries
  } else {
    entries = await readEntries(project.dir)
    briefCache.set(project.dir, { at: Date.now(), entries })
  }
  const modules = binding !== null && binding.modules !== undefined ? binding.modules : await modulesFor(project.dir)
  const bound = binding !== null ? binding.module : null
  if (entries.length === 0 && modules.length === 0) return null
  const notes = await readOptional(join(project.dir, 'brief.notes.md'))
  const active = entries.filter((entry) => entry.status === 'active')
  const counts = countByType(entries)
  const moduleId = bound !== null ? bound.id : null
  const scoped = (list) => (moduleId === null ? [] : list.filter((entry) => entry.module === moduleId))
  const global = (list) => list.filter((entry) => entry.module === null || entry.module === undefined)
  const moduleEntries = moduleId === null ? [] : active.filter((entry) => entry.module === moduleId)
  // Contracts are status-bearing (proposed/breaking), so they are read from every entry
  // rather than from the active-only slice.
  const moduleAllEntries = moduleId === null ? [] : entries.filter((entry) => entry.module === moduleId)

  const blocks = []
  const goal = notes === null ? '' : clip(notes, 200)
  if (goal.length > 0) {
    const labeled = /^(目标|铁律|目标\/铁律)[：:]/.test(goal)
    blocks.push({ priority: 0, text: labeled ? goal : `目标/铁律：${goal}` })
  }

  if (bound !== null) {
    const head = [`模块：${bound.id}${bound.title !== bound.id ? `（${clip(bound.title, 40)}）` : ''}`]
    if (bound.goal.length > 0) head.push(`模块目标：${clip(bound.goal, 120)}`)
    if (bound.nextStep.length > 0) head.push(`下一步：${clip(bound.nextStep, 100)}`)
    blocks.push({ priority: 1, text: head.join('\n') })

    const moduleConstraints = scoped(active).filter((entry) => entry.type === 'constraint').slice(0, 3)
    if (moduleConstraints.length > 0) {
      blocks.push({
        priority: 2,
        text: ['模块约束：', ...moduleConstraints.map((entry) => `- ${clip(entry.title, 80)}`)].join('\n'),
      })
    }
    const moduleDecisions = moduleEntries.filter((entry) => entry.type === 'decision').slice(0, 3)
    if (moduleDecisions.length > 0) {
      blocks.push({
        priority: 3,
        text: ['模块决策：', ...moduleDecisions.map((entry) => `- ${entry.id} ${clip(entry.title, 60)}`)].join('\n'),
      })
    }
    const moduleQuestions = moduleEntries.filter((entry) => entry.type === 'question').slice(0, 2)
    if (moduleQuestions.length > 0) {
      blocks.push({
        priority: 4,
        text: ['模块未决：', ...moduleQuestions.map((entry) => `- ${clip(entry.title, 70)}`)].join('\n'),
      })
    }

    const moduleContracts = moduleAllEntries.filter((entry) => entry.type === 'contract').slice(0, 3)
    if (moduleContracts.length > 0) {
      blocks.push({
        priority: 2,
        text: [
          '模块契约：',
          ...moduleContracts.map((entry) => `- ${entry.id} [${entry.status}] ${clip(entry.title, 60)}`),
        ].join('\n'),
      })
    }

    // A dependency's breaking contract is the integration risk the bound module
    // must know about before it changes anything.
    const depIds = Array.isArray(bound.deps) ? bound.deps : []
    const dependencyBreaking = entries.filter(
      (entry) =>
        entry.type === 'contract' &&
        entry.status === 'breaking' &&
        entry.module !== moduleId &&
        depIds.includes(entry.module ?? ''),
    )
    if (dependencyBreaking.length > 0) {
      blocks.push({
        priority: 2,
        text: [
          '依赖契约变更：',
          ...dependencyBreaking.slice(0, 3).map((entry) => `- ${entry.module} ${clip(entry.title, 60)}`),
        ].join('\n'),
      })
    }
  }

  const globalActive = moduleId === null ? active : global(active)
  const constraints = globalActive.filter((entry) => entry.type === 'constraint').slice(0, 5)
  if (constraints.length > 0) {
    blocks.push({
      priority: 5,
      text: ['硬约束：', ...constraints.map((entry) => `- ${clip(entry.title, 80)}`)].join('\n'),
    })
  }

  const decisions = globalActive.filter((entry) => entry.type === 'decision').slice(0, 3)
  if (decisions.length > 0) {
    blocks.push({
      priority: 6,
      text: ['最近决策：', ...decisions.map((entry) => `- ${entry.id} ${clip(entry.title, 60)}`)].join('\n'),
    })
  }

  const questions = globalActive.filter((entry) => entry.type === 'question').slice(0, 3)
  if (questions.length > 0) {
    blocks.push({
      priority: 7,
      text: ['未决问题：', ...questions.map((entry) => `- ${clip(entry.title, 70)}`)].join('\n'),
    })
  }

  if (moduleId === null) {
    const breaking = entries
      .filter((entry) => entry.type === 'contract' && entry.status === 'breaking')
      .slice(0, 5)
    if (breaking.length > 0) {
      blocks.push({
        priority: 5,
        text: [
          '契约告警：',
          ...breaking.map((entry) => `- ${entry.module ?? 'project'} ${clip(entry.title, 60)}`),
        ].join('\n'),
      })
    }
  }

  if (modules.length > 0 && bound === null) blocks.push({ priority: 8, text: moduleMapLine(modules) })

  blocks.push({
    priority: 9,
    text:
      `索引：${counts.total} 条（决策 ${counts.decision} / 约束 ${counts.constraint} / 术语 ${counts.glossary} / ` +
      `问题 ${counts.question}）· 用法：project_recall(query, type?, module?, limit?)`,
  })

  const text = assembleBrief(blocks, config.maxBriefChars)
  const scopedDecisions = moduleId === null ? decisions : moduleEntries.filter((entry) => entry.type === 'decision').slice(0, 3)
  const scopedQuestions = moduleId === null ? questions : moduleEntries.filter((entry) => entry.type === 'question').slice(0, 3)
  const depIds = bound !== null && Array.isArray(bound.deps) ? bound.deps : []
  const scopedContracts = entries.filter(
    (entry) =>
      entry.type === 'contract' &&
      (moduleId === null || entry.module === moduleId || depIds.includes(entry.module ?? '')),
  )
  return {
    text,
    digest: digestOf(text),
    counts,
    briefChars: text.length,
    notes: goal,
    module: moduleId,
    moduleTitle: bound !== null ? bound.title : null,
    moduleNextStep: bound !== null ? bound.nextStep : '',
    moduleStatus: bound !== null ? bound.status : null,
    modules: modules.map((module) => ({ id: module.id, title: module.title, status: module.status })),
    decisions: scopedDecisions.map((entry) => ({ id: entry.id, title: entry.title })),
    questions: scopedQuestions.map((entry) => ({ id: entry.id, title: entry.title })),
    contracts: scopedContracts.map((entry) => ({
      id: entry.id,
      module: entry.module,
      title: entry.title,
      status: entry.status,
    })),
  }
}

async function writeBriefFile(project, brief) {
  try {
    await writeFile(join(project.dir, 'brief.md'), `${brief.text}\n`, 'utf8')
  } catch {
    // brief.md is a human-readable mirror; failure is non-fatal
  }
}

function renderInjection(brief, alreadyInjected) {
  const form = alreadyInjected ? 'brief-update' : 'brief'
  const head = alreadyInjected ? '项目简报已更新（以下内容覆盖此前的项目简报）' : '项目简报（自动生成；细节用 project_recall 查询）'
  return [
    `<system-reminder data-dsh-project="${form}" data-digest="${brief.digest}">`,
    escapeFrame(head),
    '',
    escapeFrame(brief.text),
    '</system-reminder>',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// handoff: compaction continuity
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set(['read', 'write', 'edit'])
const handoffMemory = new Map()
const HANDOFF_RECENT_MS = 24 * 60 * 60 * 1000

function filePathFromArguments(raw) {
  try {
    const args = JSON.parse(raw)
    if (args !== null && typeof args === 'object') {
      for (const key of ['file_path', 'path']) {
        if (typeof args[key] === 'string' && args[key].trim().length > 0) return args[key].trim()
      }
    }
  } catch {
    // tool arguments are model-authored JSON; malformed input simply yields no path
  }
  return null
}

/** Derive the recent activity a compacted session cannot afford to lose. */
function displayProjectPath(filePath, cwd, projectRoot) {
  if (filePath === null) return null
  try {
    const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd ?? '.', filePath)
    if (typeof projectRoot === 'string' && projectRoot.length > 0) {
      const relativePath = relative(projectRoot, absolute)
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null
      return relativePath.split('\\').join('/')
    }
    return filePath
  } catch {
    return null
  }
}

function collectActivity(session, options = {}) {
  let lastUser = ''
  const activeFiles = []
  try {
    const messages = session.deriveMessages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      // Only direct human prompts count as "the last instruction"; runtime context and
      // plugin-injected reminders carry their own sources.
      if (message?.role === 'user' && lastUser === '' && message.source?.kind === 'user') {
        const text = (message.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(' ')
          .trim()
        if (text.length > 0) lastUser = clip(text, 200)
        continue
      }
      if (message?.role !== 'assistant' || activeFiles.length >= 5) continue
      for (const block of message.content ?? []) {
        if (block?.type !== 'tool-call' || !FILE_TOOLS.has(block.name)) continue
        const display = displayProjectPath(filePathFromArguments(block.arguments), options.cwd, options.projectRoot)
        if (display !== null && !activeFiles.includes(display)) activeFiles.push(display)
        if (activeFiles.length >= 5) break
      }
    }
  } catch {
    // activity is best-effort; a derivation failure yields an empty snapshot
  }
  return { lastUser, activeFiles }
}

/** Read the live goal objective when the optional goal service is composed. */
function readGoalObjective(ctx, agent) {
  try {
    const goals = ctx.get('goals')
    const view = goals?.get?.(agent)
    if (view === undefined || view === null) return ''
    for (const key of ['objective', 'title', 'text']) {
      if (typeof view[key] === 'string' && view[key].trim().length > 0) return clip(view[key], 200)
    }
  } catch {
    // the goal service is optional in some compositions
  }
  return ''
}

function parseHandoff(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const out = { generated: '', reason: '', nextStep: '', activeFiles: [] }
  const generated = /^generated:\s*(.+)$/m.exec(text)
  if (generated !== null) out.generated = generated[1].trim()
  const reason = /^reason:\s*(.+)$/m.exec(text)
  if (reason !== null) out.reason = reason[1].trim()
  const next = /## 下一步\n([\s\S]*?)(?=\n## |$)/.exec(text)
  if (next !== null) out.nextStep = clip(next[1], 200)
  const files = /## 活跃文件\n([\s\S]*?)(?=\n## |$)/.exec(text)
  if (files !== null) {
    out.activeFiles = files[1]
      .split('\n')
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((line) => line.length > 0 && line !== '（无）')
  }
  return out
}

function previousNextStep(handoff) {
  if (handoff === null || typeof handoff.nextStep !== 'string' || handoff.nextStep.length === 0) return ''
  if (handoff.nextStep === '（未设置）') return ''
  const stamp = Date.parse(handoff.generated ?? '')
  if (!Number.isFinite(stamp)) return ''
  return Date.now() - stamp < HANDOFF_RECENT_MS ? handoff.nextStep : ''
}

async function buildHandoff(ctx, project, brief, session, agent, options) {
  const activity = collectActivity(session, { cwd: options.cwd, projectRoot: project.root })
  const previous = parseHandoff(await readOptional(join(project.dir, 'handoff', 'latest.md')))
  const notes = brief?.notes ?? ''
  const decisions = brief?.decisions ?? []
  const questions = brief?.questions ?? []
  const goal = readGoalObjective(ctx, agent) || notes
  const moduleId = brief?.module ?? null
  const moduleTitle = brief?.moduleTitle ?? null
  const explicitNext = options.nextStep ?? previousNextStep(previous)
  const nextStep = clip(explicitNext.length > 0 ? explicitNext : (brief?.moduleNextStep ?? ''), 200)
  const reason = options.reason ?? 'manual'
  const lines = [
    '---',
    `generated: ${nowIso()}`,
    `session: ${session.id}`,
    `reason: ${reason}`,
    `module: ${moduleId ?? 'null'}`,
    '---',
    '',
    '## 目标',
    goal.length > 0 ? goal : '（未设置：编辑 brief.notes.md）',
    '',
    ...(moduleId !== null
      ? [
          '## 模块',
          `${moduleId}${moduleTitle !== null && moduleTitle !== moduleId ? `（${moduleTitle}）` : ''}${
            brief?.moduleStatus !== null && brief?.moduleStatus !== undefined ? ` · ${brief.moduleStatus}` : ''
          }`,
          '',
        ]
      : []),
    ...(Array.isArray(brief?.contracts) && brief.contracts.length > 0
      ? [
          '## 契约',
          ...brief.contracts
            .slice(0, 6)
            .map((item) => `- ${item.module ?? 'project'} [${item.status}] ${clip(item.title, 60)}`),
          '',
        ]
      : []),
    '## 下一步',
    nextStep.length > 0 ? nextStep : '（未设置）',
    '',
    '## 未决问题',
    ...(questions.length > 0 ? questions.map((item) => `- ${clip(item.title, 80)}`) : ['- （无）']),
    '',
    '## 最近决策',
    ...(decisions.length > 0 ? decisions.map((item) => `- ${item.id} ${clip(item.title, 60)}`) : ['- （无）']),
    '',
    '## 活跃文件',
    ...(activity.activeFiles.length > 0 ? activity.activeFiles.map((file) => `- ${file}`) : ['- （无）']),
    '',
    '## 最近指令',
    activity.lastUser.length > 0 ? clip(activity.lastUser, 200) : '（无）',
    '',
  ]
  return {
    text: lines.join('\n'),
    meta: {
      generated: nowIso(),
      reason,
      module: moduleId,
      nextStep: nextStep.length > 0 ? nextStep : '',
      activeFiles: activity.activeFiles,
      openQuestions: questions.length,
    },
  }
}

async function writeHandoff(projectDir, text) {
  const dir = join(projectDir, 'handoff')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'latest.md')
  const temp = `${file}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
  return file
}

async function performHandoff(ctx, config, session, agent, options = {}) {
  const cwd = sessionCwd(ctx, session)
  if (cwd === null) throw new Error('cannot resolve the session working directory')
  const project = await projectFor(cwd)
  await mkdir(join(project.dir, 'entries'), { recursive: true })
  const target = { ...project, hasProject: true }
  const binding = await resolveBinding(ctx, session, target)
  const brief = await buildBrief(target, config, binding)
  const result = await buildHandoff(ctx, target, brief, session, agent, { ...options, cwd, projectRoot: project.root })
  const file = await writeHandoff(project.dir, result.text)
  handoffMemory.set(session.id, result.meta)
  stateFor(session).turnsSinceHandoff = 0
  return {
    ...result.meta,
    path: relative(project.dir, file).split('\\').join('/'),
  }
}

function renderResume(brief, handoff, config) {
  const blocks = []
  if (brief.notes.length > 0) {
    const goal = clip(brief.notes, 70).replace(/^目标[：:]\s*/, '')
    blocks.push({ priority: 0, text: `目标：${goal}` })
  }
  if (brief.module !== null && brief.module !== undefined) {
    const title = brief.moduleTitle !== null && brief.moduleTitle !== brief.module ? `（${clip(brief.moduleTitle, 30)}）` : ''
    blocks.push({ priority: 1, text: `模块：${brief.module}${title}` })
  }
  const nextStepText =
    handoff !== null && handoff.nextStep.length > 0 && handoff.nextStep !== '（未设置）'
      ? handoff.nextStep
      : (brief.moduleNextStep ?? '')
  if (nextStepText.length > 0) {
    blocks.push({ priority: 2, text: `下一步：${clip(nextStepText, 80)}` })
  }
  if (handoff !== null && handoff.activeFiles.length > 0) {
    blocks.push({ priority: 3, text: `活跃文件：${clip(handoff.activeFiles.join(', '), 80)}` })
  }
  const decisions = brief.decisions.slice(0, 2).map((item) => clip(item.title, 36))
  if (decisions.length > 0) blocks.push({ priority: 4, text: `最近决策：${decisions.join(' / ')}` })
  const breaking = (brief.contracts ?? []).filter((item) => item.status === 'breaking').slice(0, 2)
  if (breaking.length > 0) {
    blocks.push({ priority: 4, text: `契约变更：${breaking.map((item) => clip(item.title, 30)).join(' / ')}` })
  }
  blocks.push({ priority: 9, text: '细节：project_recall("关键词") 或 read .dsh/project/handoff/latest.md' })
  const body = assembleBrief(blocks, config.resumeBriefChars)
  const digest = digestOf(body)
  return `<system-reminder data-dsh-project="resume" data-digest="${digest}">\n（上下文已压缩）继续工作所需的项目状态：\n${escapeFrame(body)}\n</system-reminder>`
}

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

function queryTokens(query) {
  const tokens = [query]
  for (const part of query.split(/[\s,，。;；、:：()（）[\]【】]+/)) {
    if (part.length > 0 && !tokens.includes(part)) tokens.push(part)
  }
  return tokens.filter((token) => token.length > 0)
}

function scoreEntry(entry, tokens) {
  const title = entry.title.toLowerCase()
  const body = String(entry.body ?? '').toLowerCase()
  const tags = entry.tags.map((tag) => tag.toLowerCase())
  let score = 0
  for (const token of tokens) {
    const needle = token.toLowerCase()
    if (title.includes(needle)) score += 5
    else if (tags.some((tag) => tag.includes(needle))) score += 3
    else if (body.includes(needle)) score += 1
  }
  if (entry.status === 'active') score += 2
  const stamp = Date.parse(entry.updated || entry.created || '')
  if (Number.isFinite(stamp)) {
    const age = Date.now() - stamp
    if (age < 30 * 86400000) score += 2
    else if (age < 90 * 86400000) score += 1
  }
  return score
}

function matchesFilters(entry, args) {
  if (args.type !== undefined && entry.type !== args.type) return false
  if (args.status !== undefined && entry.status !== args.status) return false
  if (Array.isArray(args.tags) && args.tags.length > 0) {
    const wanted = args.tags.map((tag) => String(tag).toLowerCase())
    const own = entry.tags.map((tag) => tag.toLowerCase())
    if (!wanted.some((tag) => own.some((ownTag) => ownTag.includes(tag)))) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// session state and injection
// ---------------------------------------------------------------------------

const sessionState = new WeakMap()

function stateFor(session) {
  let state = sessionState.get(session)
  if (state === undefined) {
    state = { digest: null, injected: false, pendingResume: false, turnsSinceHandoff: 0 }
    sessionState.set(session, state)
  }
  return state
}

/** The digest of the last injected brief still visible in derived history, if any. */
function visibleBriefDigest(session) {
  try {
    let found = null
    for (const message of session.deriveMessages()) {
      const source = message?.source
      if (source?.kind === SOURCE_KIND && typeof source.digest === 'string') found = source.digest
    }
    return found
  } catch {
    return null
  }
}

function makeInjectedMessage(text, digest, form) {
  const content = [{ type: 'text', text }]
  const source = { kind: SOURCE_KIND, form, digest }
  try {
    return createUserMessage({ content, source })
  } catch {
    return { role: 'user', content, source }
  }
}

function sessionCwd(ctx, session) {
  try {
    return ctx.workingDirectory.get(session)
  } catch {
    return session?.header?.cwd ?? null
  }
}

function emptyToolResult(name) {
  return { hits: [], total: 0, hint: `${name} requires an owning agent session.` }
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig) {
  const config = {
    maxBriefChars: clampInt(rawConfig?.maxBriefChars, 1200, 200, 4000),
    maxRecallHits: clampInt(rawConfig?.maxRecallHits, 5, 1, 10),
    resumeBriefChars: clampInt(rawConfig?.resumeBriefChars, 300, 120, 800),
    autoHandoff: rawConfig?.autoHandoff !== false,
    handoffEveryTurns: clampInt(rawConfig?.handoffEveryTurns, 10, 1, 100),
    autoExport: rawConfig?.autoExport !== false,
    autoExportDelayMs: clampInt(rawConfig?.autoExportDelayMs, 1500, 200, 10000),
    readOnly: rawConfig?.readOnly === true,
  }

  // Timers are plugin-scoped: unloading the plugin must not fire a late export.
  ctx.effect(() => () => clearAutoExports(), 'dsh-project.auto-export')

  // ---- injection -----------------------------------------------------------
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const agent = payload.agent
    const session = agent?.session
    if (session === undefined || session === null) return decision
    const header = session.header ?? {}
    if (header.parentSession !== undefined || header.origin === 'subagent') return decision
    // A first step with no entering message opens no step; injecting would fabricate one.
    if (payload.step === 1 && decision.messages.length === 0) return decision

    try {
      const cwd = sessionCwd(ctx, session)
      if (cwd === null) return decision
      const project = await projectFor(cwd)
      if (!project.hasProject) return decision
      const binding = await resolveBinding(ctx, session, project)
      const brief = await buildBrief(project, config, binding)
      if (brief === null) return decision

      const state = stateFor(session)
      if (state.pendingResume === true) {
        const handoff =
          handoffMemory.get(session.id) ?? parseHandoff(await readOptional(join(project.dir, 'handoff', 'latest.md')))
        const resumeText = renderResume(brief, handoff, config)
        state.pendingResume = false
        state.digest = brief.digest
        state.injected = true
        const resumeMessage = makeInjectedMessage(resumeText, digestOf(resumeText), 'resume')
        const claimedResume = payload.messages ?? []
        const lastClaimedResume = decision.messages.findLastIndex((candidate) => claimedResume.includes(candidate))
        const enteredResume =
          lastClaimedResume >= 0
            ? decision.messages.toSpliced(lastClaimedResume + 1, 0, resumeMessage)
            : decision.messages.concat(resumeMessage)
        return { ...decision, messages: enteredResume }
      }
      const visible = visibleBriefDigest(session)
      if (visible === brief.digest) {
        state.digest = brief.digest
        state.injected = true
        return decision
      }
      if (state.digest === brief.digest && state.injected) return decision

      const form = state.injected ? 'brief-update' : 'brief'
      const message = makeInjectedMessage(renderInjection(brief, state.injected), brief.digest, form)
      state.digest = brief.digest
      state.injected = true

      const claimed = payload.messages ?? []
      const lastClaimed = decision.messages.findLastIndex((candidate) => claimed.includes(candidate))
      const entered =
        lastClaimed >= 0
          ? decision.messages.toSpliced(lastClaimed + 1, 0, message)
          : decision.messages.concat(message)
      return { ...decision, messages: entered }
    } catch (error) {
      try {
        ctx.logger.warn('dsh-project: brief injection skipped: %o', error)
      } catch {
        // logging must never fail the step
      }
      return decision
    }
  })

  // ---- Web board JSON API --------------------------------------------------
  // Read-only HTTP surface for the client half. It reuses the same project
  // resolution as the tools; a session id is required so the API never guesses
  // which project a browser request means.
  ctx.inject(['webServer'], () => {
    const web = ctx.get('webServer')
    if (web === undefined) return
    const sendJson = (res, status, value) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(value))
    }
    const resolveRequest = async (req) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const session = sessionId.length > 0 ? ctx.sessions.get(sessionId) : undefined
      if (session === undefined) return null
      const cwd = sessionCwd(ctx, session)
      if (cwd === null) return null
      return { url, session, project: await projectFor(cwd) }
    }
    ctx.effect(() =>
      web.register({
        kind: 'exact',
        path: '/dsh-project/api/state',
        async handler(req, res) {
          try {
            const resolved = await resolveRequest(req)
            if (resolved === null) {
              sendJson(res, 404, { ok: false, error: 'unknown session' })
              return
            }
            const { project, session } = resolved
            if (!project.hasProject) {
              sendJson(res, 200, {
                ok: true,
                projectRoot: project.root,
                projectDir: project.dir,
                counts: { total: 0 },
                entries: [],
                modules: [],
                binding: { moduleId: null, source: 'none' },
                brief: null,
                handoff: null,
              })
              return
            }
            const entries = await readEntries(project.dir)
            const binding = await resolveBinding(ctx, session, project)
            const brief = await buildBrief(project, config, binding)
            const handoff = parseHandoff(await readOptional(join(project.dir, 'handoff', 'latest.md')))
            sendJson(res, 200, {
              ok: true,
              projectRoot: project.root,
              projectDir: project.dir,
              counts: countByType(entries),
              entries: entries.map((entry) => ({
                id: entry.id,
                type: entry.type,
                title: entry.title,
                status: entry.status,
                tags: entry.tags,
                summary: summaryOf(entry),
                path: entry.path,
                module: entry.module ?? null,
                updated: entry.updated,
              })),
              modules: binding.modules.map((module) => ({
                id: module.id,
                title: module.title,
                status: module.status,
                path: module.path,
                owner: module.owner,
                nextStep: module.nextStep,
              })),
              binding: {
                moduleId: binding.module === null ? null : binding.module.id,
                source: binding.source,
              },
              brief: brief === null ? null : { text: brief.text, chars: brief.briefChars, digest: brief.digest },
              handoff:
                handoff === null
                  ? null
                  : {
                      generated: handoff.generated,
                      reason: handoff.reason,
                      nextStep: handoff.nextStep,
                      activeFiles: handoff.activeFiles,
                    },
              config: { maxBriefChars: config.maxBriefChars },
            })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )
    ctx.effect(() =>
      web.register({
        kind: 'exact',
        path: '/dsh-project/api/entry',
        async handler(req, res) {
          try {
            const resolved = await resolveRequest(req)
            if (resolved === null) {
              sendJson(res, 404, { ok: false, error: 'unknown session' })
              return
            }
            const { project } = resolved
            if (!project.hasProject) {
              sendJson(res, 404, { ok: false, error: 'no project memory' })
              return
            }
            const requested = resolved.url.searchParams.get('path') ?? ''
            if (!/^entries\/[a-z]+\/[A-Za-z0-9_-]+\.md$/.test(requested)) {
              sendJson(res, 400, { ok: false, error: 'invalid entry path' })
              return
            }
            const target = join(project.dir, requested)
            const relativePath = relative(project.dir, target)
            if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
              sendJson(res, 400, { ok: false, error: 'path escapes the project' })
              return
            }
            const body = await readOptional(target)
            if (body === null) {
              sendJson(res, 404, { ok: false, error: 'entry not found' })
              return
            }
            sendJson(res, 200, { ok: true, path: requested, body })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )
  })

  // ---- compaction / turn handoff ------------------------------------------
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'compaction/end') {
        const state = stateFor(session)
        state.pendingResume = true
        state.turnsSinceHandoff = 0
        void performHandoff(ctx, config, session, ctx.agents.get(session.id), { reason: 'compaction' }).catch((error) => {
          try {
            ctx.logger.warn('dsh-project: compaction handoff failed: %o', error)
          } catch {
            // logging must never fail the event feed
          }
        })
        return
      }
      if (event.type !== 'turn/end' || config.autoHandoff !== true) return
      const state = stateFor(session)
      state.turnsSinceHandoff += 1
      if (state.turnsSinceHandoff < config.handoffEveryTurns) return
      state.turnsSinceHandoff = 0
      void performHandoff(ctx, config, session, ctx.agents.get(session.id), { reason: 'turns' }).catch((error) => {
        try {
          ctx.logger.warn('dsh-project: periodic handoff failed: %o', error)
        } catch {
          // logging must never fail the event feed
        }
      })
    } catch (error) {
      try {
        ctx.logger.warn('dsh-project: handoff hook failed: %o', error)
      } catch {
        // logging must never fail the event feed
      }
    }
  })

  // ---- project_remember ----------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'project_remember',
      description:
        'Persist one durable project memory entry under .dsh/project: a decision, constraint, glossary term, open question, or note. ' +
        'Use it whenever a durable fact would otherwise be lost to a new session or to context compaction. ' +
        'Write one fact per call with a one-line title and a structured body (decision / rationale / alternatives / impact).',
      parameters: {
        type: {
          type: 'string',
          required: true,
          enum: [...ENTRY_TYPES],
          description: 'Entry kind: decision | constraint | glossary | question | contract | note.',
        },
        title: {
          type: 'string',
          required: true,
          description: 'One-line conclusion, at most 80 characters.',
        },
        body: {
          type: 'string',
          required: true,
          description: 'Structured body in Markdown, at most 4000 characters.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 8 retrieval tags.',
        },
        status: {
          type: 'string',
          enum: ['active', 'rejected', 'proposed', 'breaking'],
          description:
            'Defaults to active. Contracts may be proposed or breaking; breaking surfaces a change notice in dependent modules. Rejected keeps the exploration on record.',
        },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Entry ids this entry replaces; they are marked superseded.',
        },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional module or path prefixes this entry applies to.',
        },
        module: {
          type: 'string',
          description:
            'Module id this entry belongs to; defaults to the session-bound module. Use "none" for a project-level entry.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            path: { type: 'string', required: true },
            type: { type: 'string', required: true },
            entries: { type: 'integer', required: true },
            briefChars: { type: 'integer', required: true },
            module: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Remembered ${value.type} ${value.id} at ${value.path} (${value.entries} entries; brief ${value.briefChars} chars).` +
              ` Module: ${value.module.length > 0 ? value.module : '(project-level)'}.`,
          },
        ],
      },
      async execute(args, exec) {
        if (config.readOnly) throw new Error('dsh-project is configured read-only; project_remember is disabled')
        const agent = exec.agent
        const session = agent?.session
        if (session === undefined || session === null) throw new Error('project_remember requires an owning agent session')
        const cwd = sessionCwd(ctx, session)
        if (cwd === null) throw new Error('project_remember cannot resolve the session working directory')
        const type = ENTRY_TYPES.includes(args.type) ? args.type : 'note'
        const project = await projectFor(cwd)
        const binding = await resolveBinding(ctx, session, project)
        const moduleId = chooseModuleId(binding, args.module)
        await mkdir(join(project.dir, 'entries', type), { recursive: true })

        const id = mintId(type)
        const now = nowIso()
        const record = {
          id,
          type,
          title: clip(args.title, MAX_TITLE_CHARS),
          status: ['active', 'rejected', 'proposed', 'breaking'].includes(args.status) ? args.status : 'active',
          tags: normalizedList(args.tags, MAX_TAGS),
          created: now,
          updated: now,
          supersedes: normalizedIdList(args.supersedes),
          superseded_by: null,
          scope: normalizedList(args.scope, 8),
          module: moduleId,
          body: String(args.body ?? '').slice(0, MAX_BODY_CHARS),
        }
        const file = join(project.dir, 'entries', type, `${id}.md`)
        await writeFile(file, renderEntry(record), 'utf8')

        if (record.supersedes.length > 0) await markSuperseded(project.dir, record.supersedes, id)

        const entries = await readEntries(project.dir)
        await writeCatalog(project.dir, entries)
        briefCache.delete(project.dir)
        rootCache.delete(resolve(cwd))

        const updatedProject = { ...project, hasProject: true }
        const updatedBinding = await resolveBinding(ctx, session, updatedProject)
        const brief = await buildBrief(updatedProject, config, updatedBinding)
        if (brief !== null) await writeBriefFile(updatedProject, brief)
        scheduleAutoExport(ctx, config, updatedProject)

        return {
          id,
          path: recordPath(project.dir, file),
          type,
          entries: entries.length,
          briefChars: brief?.briefChars ?? 0,
          module: moduleId ?? '',
        }
      },
    }),
  )

  // ---- project_recall ------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'project_recall',
      description:
        'Search durable project memory (decisions, constraints, glossary, open questions) stored under .dsh/project. ' +
        'Returns locations and short summaries, not full bodies: read the named file when the detail matters. ' +
        'Prefer this over re-deriving a past decision from conversation history.',
      parameters: {
        query: { type: 'string', description: 'Keywords; Chinese substrings work without tokenization.' },
        type: { type: 'string', enum: [...ENTRY_TYPES], description: 'Restrict to one entry kind.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Restrict to entries carrying any of these tags.' },
        status: { type: 'string', enum: ['active', 'rejected', 'superseded'], description: 'Defaults to any status.' },
        limit: { type: 'number', description: 'Maximum hits, 1-10; defaults to 5.' },
        includeBody: { type: 'boolean', description: 'Include up to 800 characters of body per hit.' },
        module: {
          type: 'string',
          description:
            'Module filter: a module id, "*" for all modules, or "none" for project-level entries. Defaults to the session-bound module.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hits: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  type: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  tags: { type: 'array', required: true, items: { type: 'string' } },
                  summary: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                  updated: { type: 'string', required: true },
                  module: { type: 'string' },
                  body: { type: 'string' },
                },
              },
            },
            total: { type: 'integer', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: (args, value) => {
          if (value.hits.length === 0) return [{ type: 'text', text: value.hint }]
          const lines = value.hits.map(
            (hit) => `- [${hit.module.length > 0 ? hit.module : 'project'}/${hit.type}/${hit.status}] ${hit.id} ${hit.title} — ${hit.summary} (${hit.path})`,
          )
          const header = args.query ? `Project memory hits for "${args.query}":` : 'Recent project memory entries:'
          return [{ type: 'text', text: `${header}\n${lines.join('\n')}\n${value.hint}` }]
        },
      },
      async execute(args, exec) {
        const agent = exec.agent
        const session = agent?.session
        if (session === undefined || session === null) return emptyToolResult('project_recall')
        const cwd = sessionCwd(ctx, session)
        if (cwd === null) return emptyToolResult('project_recall')
        const project = await projectFor(cwd)
        if (!project.hasProject) {
          return {
            hits: [],
            total: 0,
            hint: 'No .dsh/project memory in this project yet. Use project_remember to create the first entry.',
          }
        }
        const binding = await resolveBinding(ctx, session, project)
        const requestedModule = typeof args.module === 'string' ? args.module.trim() : undefined
        let moduleFilter
        if (requestedModule === undefined) {
          moduleFilter = binding.module === null ? undefined : binding.module.id
        } else if (requestedModule === '*' || requestedModule === '') {
          moduleFilter = undefined
        } else if (requestedModule === 'none') {
          moduleFilter = null
        } else {
          const found = binding.modules.find((module) => module.id === requestedModule)
          if (found === undefined) {
            const known = binding.modules.map((module) => module.id).join(', ')
            return {
              hits: [],
              total: 0,
              hint: `Unknown module "${requestedModule}"${known.length > 0 ? `; known modules: ${known}` : '; no modules defined yet'}.`,
            }
          }
          moduleFilter = found.id
        }
        const entries = await readEntries(project.dir)
        const filtered = entries.filter(
          (entry) => matchesFilters(entry, args) && (moduleFilter === undefined || (entry.module ?? null) === moduleFilter),
        )
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const limit = clampInt(args.limit, config.maxRecallHits, 1, 10)

        let ranked = filtered
        if (query.length > 0) {
          const tokens = queryTokens(query)
          ranked = filtered
            .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
            .filter((candidate) => candidate.score > 0)
            .sort((left, right) => right.score - left.score || String(right.entry.updated).localeCompare(String(left.entry.updated)))
            .map((candidate) => candidate.entry)
        }

        const hits = ranked.slice(0, limit).map((entry) => ({
          id: entry.id,
          type: entry.type,
          title: entry.title,
          status: entry.status,
          tags: entry.tags,
          summary: summaryOf(entry),
          path: entry.path,
          module: entry.module ?? '',
          updated: entry.updated,
          ...(args.includeBody === true ? { body: clip(entry.body, 800) } : {}),
        }))
        const scopeNote =
          moduleFilter === undefined ? '' : `Module: ${moduleFilter === null ? 'project-level' : moduleFilter}. `
        const hint =
          scopeNote +
          (hits.length === 0
            ? query.length > 0
              ? `No match for "${clip(query, 40)}" among ${filtered.length} entries. Try fewer keywords, or read ${PROJECT_DIR}/catalog.json for the full index.`
              : `No entries matched the filters (${filtered.length} scanned).`
            : ranked.length > hits.length
              ? `${ranked.length} matches; showing the top ${hits.length}.`
              : `${hits.length} match(es).`)
        return { hits, total: ranked.length, hint }
      },
    }),
  )

  // ---- project_handoff -----------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'project_handoff',
      description:
        'Write a durable handoff snapshot to .dsh/project/handoff/latest.md: goal, next step, open questions, recent decisions, active files, and the last instruction. ' +
        'Use it before a long pause, a manual summary, or a context switch, so another session can resume without replaying history. ' +
        'The next request receives a short resume brief only when injectResume is true (automatic injection follows a real compaction).',
      parameters: {
        nextStep: { type: 'string', description: 'The single next action, at most 200 characters.' },
        note: { type: 'string', description: 'Free-form context used as the next step when nextStep is absent.' },
        injectResume: { type: 'boolean', description: 'Force a resume brief on the next request.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            generated: { type: 'string', required: true },
            reason: { type: 'string', required: true },
            nextStep: { type: 'string', required: true },
            activeFiles: { type: 'array', required: true, items: { type: 'string' } },
            openQuestions: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Handoff written to ${value.path} (${value.reason}). ` +
              `Next step: ${value.nextStep.length > 0 ? value.nextStep : '(unset)'}. ` +
              `Active files: ${value.activeFiles.length > 0 ? value.activeFiles.join(', ') : '(none)'}.`,
          },
        ],
      },
      async execute(args, exec) {
        if (config.readOnly) throw new Error('dsh-project is configured read-only; project_handoff is disabled')
        const agent = exec.agent
        const session = agent?.session
        if (session === undefined || session === null) throw new Error('project_handoff requires an owning agent session')
        const result = await performHandoff(ctx, config, session, agent, {
          reason: 'manual',
          nextStep: args.nextStep ?? args.note,
        })
        if (args.injectResume === true) stateFor(session).pendingResume = true
        return result
      },
    }),
  )

  // ---- project_module ------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'project_module',
      description:
        'Manage the project decomposition used to keep each session scoped: list modules, read one module card, or upsert a card ' +
        '(goal, owned path, owner, status, dependencies, next step). A session binds to the module whose path contains its working ' +
        'directory (longest match); an explicit binding overrides that. Module cards live in .dsh/project/modules/<id>.md.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'get', 'update', 'bind', 'open'],
          description:
            'list all modules, get one card, upsert one card, bind this session to a module, or open a new session in a module.',
        },
        id: { type: 'string', description: 'Module id (required for get/update/bind/open), lowercase kebab-case.' },
        worktree: {
          type: 'boolean',
          description: 'For action "open": create an isolated Git worktree checkout for the new session.',
        },
        title: { type: 'string', description: 'Display title.' },
        path: { type: 'string', description: 'Project-relative directory this module owns; used for cwd binding.' },
        owner: { type: 'string', description: 'Owner label (person or agent).' },
        status: {
          type: 'string',
          enum: ['planned', 'active', 'paused', 'done'],
          description: 'Module status; defaults to active.',
        },
        deps: { type: 'array', items: { type: 'string' }, description: 'Module ids this module depends on.' },
        goal: { type: 'string', description: 'Module goal, kept in the brief for sessions bound to this module.' },
        contract: { type: 'string', description: 'What this module provides to other modules.' },
        nextStep: { type: 'string', description: 'Current next step, used by the brief and the resume snapshot.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            modules: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                  owner: { type: 'string', required: true },
                  nextStep: { type: 'string', required: true },
                  entries: { type: 'integer', required: true },
                },
              },
            },
            module: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true },
                path: { type: 'string', required: true },
                owner: { type: 'string', required: true },
                goal: { type: 'string', required: true },
                contract: { type: 'string', required: true },
                nextStep: { type: 'string', required: true },
                deps: { type: 'array', required: true, items: { type: 'string' } },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                entries: { type: 'integer', required: true },
              },
            },
            binding: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                moduleId: { type: 'string', required: true },
                source: { type: 'string', required: true },
              },
            },
            contracts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  module: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  updated: { type: 'string', required: true },
                },
              },
            },
            hint: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const lines = value.modules.map(
            (module) => `- ${module.id}${module.status === 'active' ? '' : `(${module.status})`} ${module.title} · ${module.entries} entries${module.path.length > 0 ? ` · ${module.path}` : ''}`,
          )
          const head =
            value.module !== undefined && value.module !== null
              ? `Module ${value.module.id}: ${value.module.title} [${value.module.status}]`
              : `Modules (${value.modules.length}):`
          const body = value.module !== undefined && value.module !== null
            ? [
                `path: ${value.module.path || '(unset)'} · owner: ${value.module.owner || '(unset)'} · deps: ${value.module.deps.join(', ') || '(none)'}`,
                `goal: ${value.module.goal || '(unset)'}`,
                `next: ${value.module.nextStep || '(unset)'}`,
              ]
            : lines
          const contractLines =
            Array.isArray(value.contracts) && value.contracts.length > 0
              ? [
                  'Contracts:',
                  ...value.contracts.map(
                    (contract) => `- ${contract.id} ${contract.module || 'project'} [${contract.status}] ${contract.title}`,
                  ),
                ]
              : []
          return [
            {
              type: 'text',
              text: [
                head,
                ...body,
                ...contractLines,
                `Binding: ${value.binding.moduleId || 'project-level'} (${value.binding.source}). ${value.hint}`,
              ].join('\n'),
            },
          ]
        },
      },
      async execute(args, exec) {
        const agent = exec.agent
        const session = agent?.session
        if (session === undefined || session === null) throw new Error('project_module requires an owning agent session')
        const cwd = sessionCwd(ctx, session)
        if (cwd === null) throw new Error('project_module cannot resolve the session working directory')
        const project = await projectFor(cwd)
        const target = { ...project, hasProject: true }
        const binding = await resolveBinding(ctx, session, target)
        const entries = await readEntries(project.dir)
        const countFor = (moduleId) => entries.filter((entry) => entry.module === moduleId).length
        const depIds = binding.module !== null && Array.isArray(binding.module.deps) ? binding.module.deps : []
        const scopedContracts = entries
          .filter((entry) => entry.type === 'contract')
          .filter(
            (entry) =>
              binding.module === null || entry.module === binding.module.id || depIds.includes(entry.module ?? ''),
          )
          .map((entry) => ({
            id: entry.id,
            module: entry.module ?? '',
            title: entry.title,
            status: entry.status,
            updated: entry.updated,
          }))
        const describe = (module) => ({
          id: module.id,
          title: module.title,
          status: module.status,
          path: module.path,
          owner: module.owner,
          goal: module.goal,
          contract: module.contract,
          nextStep: module.nextStep,
          deps: module.deps,
          tags: module.tags,
          entries: countFor(module.id),
        })
        const currentBinding = {
          moduleId: binding.module === null ? '' : binding.module.id,
          source: binding.source,
        }
        const action =
          args.action === 'get' || args.action === 'update' || args.action === 'bind' || args.action === 'open'
            ? args.action
            : 'list'

        if (action === 'list') {
          return {
            modules: binding.modules.map((module) => ({
              id: module.id,
              title: module.title,
              status: module.status,
              path: module.path,
              owner: module.owner,
              nextStep: module.nextStep,
              entries: countFor(module.id),
            })),
            binding: currentBinding,
            contracts: scopedContracts,
            hint:
              binding.modules.length === 0
                ? 'No modules yet. Create one with action "update" and an id plus path.'
                : 'A session binds by the longest module path containing its cwd; an explicit binding wins.',
          }
        }

        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error('module id must be lowercase kebab-case (2-32 chars)')
        const existing = binding.modules.find((module) => module.id === id)

        if (action === 'bind') {
          const moduleId = id === 'none' ? null : id
          if (moduleId !== null && existing === undefined) {
            throw new Error(`unknown module "${id}"; known: ${binding.modules.map((module) => module.id).join(', ') || '(none)'}`)
          }
          await writeSessionBinding(project.dir, session.id, moduleId)
          const rebound = await resolveBinding(ctx, session, target)
          return {
            modules: [],
            binding: {
              moduleId: rebound.module === null ? '' : rebound.module.id,
              source: rebound.source,
            },
            hint:
              moduleId === null
                ? 'Binding cleared; the cwd rule applies again.'
                : `Bound this session to ${moduleId}; its goal and next step enter the brief on the next request.`,
          }
        }

        if (action === 'open') {
          if (existing === undefined) {
            throw new Error(`unknown module "${id}"; known: ${binding.modules.map((module) => module.id).join(', ') || '(none)'}`)
          }
          const opened = await openModuleSession(ctx, { ...project, hasProject: true }, existing, {
            worktree: args.worktree === true,
            agent: exec.agent,
            signal: exec.signal,
          })
          const worktree = opened.worktree
          return {
            modules: [],
            binding: currentBinding,
            contracts: [],
            hint:
              `Opened ${opened.sessionId} at ${opened.cwd}; open it from the sidebar.` +
              (worktree !== null
                ? ` Isolated worktree ${worktree.branch} at ${worktree.path} (memory ${worktree.memory}).`
                : ` It binds to ${id} by its cwd.`),
          }
        }

        if (action === 'get') {
          if (existing === undefined) throw new Error(`unknown module "${id}"; known: ${binding.modules.map((module) => module.id).join(', ') || '(none)'}`)
          return {
            modules: [],
            module: describe(existing),
            binding: currentBinding,
            contracts: scopedContracts.filter((contract) => contract.module === id),
            hint: `Entries: ${countFor(id)}.`,
          }
        }

        if (config.readOnly) throw new Error('dsh-project is configured read-only; project_module update is disabled')
        if (typeof args.path === 'string' && args.path.trim().length > 0) {
          const modulePath = resolve(project.root, args.path.trim())
          const relativePath = relative(project.root, modulePath)
          if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('module path must stay inside the project')
        }
        const record = {
          id,
          title: clip(args.title ?? existing?.title ?? id, MAX_TITLE_CHARS),
          path: typeof args.path === 'string' ? args.path.trim() : (existing?.path ?? ''),
          owner: typeof args.owner === 'string' ? clip(args.owner, 40) : (existing?.owner ?? ''),
          status: args.status ?? existing?.status ?? 'active',
          deps: normalizedList(args.deps ?? existing?.deps ?? [], 16),
          tags: normalizedList(args.tags ?? existing?.tags ?? [], MAX_TAGS),
          goal: typeof args.goal === 'string' ? clip(args.goal, 400) : (existing?.goal ?? ''),
          contract: typeof args.contract === 'string' ? clip(args.contract, 600) : (existing?.contract ?? ''),
          nextStep: typeof args.nextStep === 'string' ? clip(args.nextStep, 200) : (existing?.nextStep ?? ''),
          updated: nowIso(),
        }
        await writeModuleCard(project.dir, record)
        briefCache.delete(project.dir)
        scheduleAutoExport(ctx, config, { ...project, hasProject: true })
        const refreshed = await resolveBinding(ctx, session, { ...project, hasProject: true })
        const written = refreshed.modules.find((module) => module.id === id) ?? record
        return {
          modules: [],
          module: {
            ...describe(written),
            goal: record.goal,
            contract: record.contract,
            nextStep: record.nextStep,
          },
          binding: {
            moduleId: refreshed.module === null ? '' : refreshed.module.id,
            source: refreshed.source,
          },
          hint: `Saved .dsh/project/modules/${id}.md. Bound sessions see this module's goal and next step in their brief.`,
        }
      },
    }),
  )

  // ---- project_export ------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'project_export',
      description:
        'Export project memory as on-demand skills under <projectRoot>/.dsh/skills: one skill per module, a contracts overview, and a project-memory usage guide. ' +
        'Skills keep only name/description resident and load their body through the skill tool, so project detail costs almost no context until it is needed.',
      parameters: {
        target: {
          type: 'string',
          enum: ['all', 'modules', 'contracts', 'project'],
          description: 'What to export; defaults to all.',
        },
        module: { type: 'string', description: 'Limit module skills to one module id.' },
        dryRun: { type: 'boolean', description: 'Return the file list without writing anything.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            written: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                },
              },
            },
            hint: { type: 'string', required: true },
          },
        },
        render: (_args, value) =>
          value.written.length === 0
            ? [{ type: 'text', text: value.hint }]
            : [
                {
                  type: 'text',
                  text: `Exported ${value.written.length} skill(s):\n${value.written
                    .map((item) => `- ${item.name} → ${item.path}`)
                    .join('\n')}\n${value.hint}`,
                },
              ],
      },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined || session === null) throw new Error('project_export requires an owning agent session')
        const cwd = sessionCwd(ctx, session)
        if (cwd === null) throw new Error('project_export cannot resolve the session working directory')
        const project = await projectFor(cwd)
        if (!project.hasProject) throw new Error('no .dsh/project memory yet; create entries or a module first')
        const modules = await modulesFor(project.dir)
        const entries = await readEntries(project.dir)
        const written = await exportSkills(project, modules, entries, args)
        return {
          written,
          hint: 'The skill filesystem provider watches its roots, so new skills join the catalog on the next request; reload the page only if a UI skill list lags.',
        }
      },
    }),
  )

  // ---- /project command ----------------------------------------------------
  ctx.commands.register({
    name: 'project',
    description: 'Show the dsh-project memory status for the current project',
    input: { hint: '[export [all|modules|contracts|project]]' },
    handler: async (invocation) => {
      const agent = invocation?.agent
      const session = agent?.session
      if (session === undefined || session === null) return { kind: 'error', text: 'No active session.' }
      const cwd = sessionCwd(ctx, session)
      if (cwd === null) return { kind: 'error', text: 'Cannot resolve the session working directory.' }
      const project = await projectFor(cwd)
      if (!project.hasProject) {
        return {
          kind: 'success',
          text: [
            `No project memory yet.`,
            `Expected directory: ${join(project.root, PROJECT_DIR)}`,
            `Create entries with project_remember; the agent sees a brief automatically on the next request.`,
          ].join('\n'),
        }
      }
      const entries = await readEntries(project.dir)
      const binding = await resolveBinding(ctx, session, project)
      const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
      if (raw === 'export' || raw.startsWith('export ')) {
        const targetArg = raw.split(/\s+/)[1] ?? 'all'
        try {
          const written = await exportSkills(project, binding.modules, entries, { target: targetArg })
          return {
            kind: 'success',
            text:
              written.length === 0
                ? 'Nothing to export.'
                : written.map((item) => `${item.name} → ${item.path}`).join('\n'),
          }
        } catch (error) {
          return { kind: 'error', text: `Export failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      const brief = await buildBrief(project, config, binding)
      const counts = countByType(entries)
      const lines = [
        `Project memory: ${project.dir}`,
        `Entries: ${counts.total} (decision ${counts.decision} / constraint ${counts.constraint} / glossary ${counts.glossary} / question ${counts.question})`,
        binding.module === null
          ? `Module: none (project-level session; modules: ${binding.modules.map((module) => module.id).join(', ') || 'none'})`
          : `Module: ${binding.module.id}${binding.module.title !== binding.module.id ? ` (${binding.module.title})` : ''} · bound by ${binding.source}`,
        brief === null ? 'Brief: none yet' : `Brief: ${brief.briefChars}/${config.maxBriefChars} chars, digest ${brief.digest}`,
      ]
      const recent = entries.filter((entry) => entry.status === 'active').slice(0, 5)
      if (recent.length > 0) {
        lines.push('Recent:')
        for (const entry of recent) {
          lines.push(`- ${entry.module === null ? '[project]' : `[${entry.module}]`} ${entry.id} ${entry.title}`)
        }
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  // ---- /handoff command ----------------------------------------------------
  ctx.commands.register({
    name: 'handoff',
    description: 'Write .dsh/project/handoff/latest.md so another session can resume the work',
    input: { hint: '[next step]' },
    handler: async (invocation) => {
      const agent = invocation?.agent
      const session = agent?.session
      if (session === undefined || session === null) return { kind: 'error', text: 'No active session.' }
      try {
        const note = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
        const result = await performHandoff(ctx, config, session, agent, {
          reason: 'manual',
          nextStep: note.length > 0 ? note : undefined,
        })
        const lines = [
          `Handoff written: ${result.path}`,
          `Next step: ${result.nextStep.length > 0 ? result.nextStep : '(unset)'}`,
          `Active files: ${result.activeFiles.length > 0 ? result.activeFiles.join(', ') : '(none)'}`,
          `Open questions: ${result.openQuestions}`,
        ]
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: `Handoff failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  // ---- /module command -----------------------------------------------------
  ctx.commands.register({
    name: 'module',
    description: 'List project modules or bind this session to one',
    input: { hint: '[list | use <id> | use none | open <id> [--worktree]]' },
    handler: async (invocation) => {
      const session = invocation?.agent?.session
      if (session === undefined || session === null) return { kind: 'error', text: 'No active session.' }
      const cwd = sessionCwd(ctx, session)
      if (cwd === null) return { kind: 'error', text: 'Cannot resolve the session working directory.' }
      const project = await projectFor(cwd)
      if (!project.hasProject) {
        return {
          kind: 'error',
          text: `No .dsh/project yet (expected ${join(project.root, PROJECT_DIR)}). Create a module with project_module first.`,
        }
      }
      const binding = await resolveBinding(ctx, session, project)
      const entries = await readEntries(project.dir)
      const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
      const [verb, arg] = raw.split(/\s+/)

      if (verb === 'use') {
        if (arg === undefined || arg.length === 0) {
          return { kind: 'error', text: 'Usage: /module use <id> | /module use none' }
        }
        if (arg === 'none') {
          await writeSessionBinding(project.dir, session.id, null)
          return { kind: 'success', text: 'Session binding cleared; the cwd rule applies again.' }
        }
        const found = binding.modules.find((module) => module.id === arg)
        if (found === undefined) {
          return {
            kind: 'error',
            text: `Unknown module "${arg}". Known: ${binding.modules.map((module) => module.id).join(', ') || '(none)'}`,
          }
        }
        await writeSessionBinding(project.dir, session.id, found.id)
        return { kind: 'success', text: `Bound this session to ${found.id} (${found.title}).` }
      }

      if (verb === 'open') {
        const parts = raw.split(/\s+/)
        const moduleId = parts[1] ?? ''
        const withWorktree = parts.includes('--worktree')
        if (moduleId.length === 0) return { kind: 'error', text: 'Usage: /module open <id> [--worktree]' }
        const found = binding.modules.find((module) => module.id === moduleId)
        if (found === undefined) {
          return {
            kind: 'error',
            text: `Unknown module "${moduleId}". Known: ${binding.modules.map((module) => module.id).join(', ') || '(none)'}`,
          }
        }
        try {
          const opened = await openModuleSession(ctx, project, found, {
            worktree: withWorktree,
            agent: invocation?.agent,
            signal: invocation?.signal,
          })
          const worktree = opened.worktree
          return {
            kind: 'success',
            text:
              `Opened ${opened.sessionId} at ${opened.cwd}.` +
              (worktree !== null
                ? ` Worktree ${worktree.branch} at ${worktree.path} (memory ${worktree.memory}).`
                : ` Open it from the sidebar; it binds to ${found.id} by cwd.`),
          }
        } catch (error) {
          return { kind: 'error', text: `Open failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }

      const lines = [
        `Modules: ${binding.modules.length}`,
        `Bound: ${binding.module === null ? 'none (project-level)' : `${binding.module.id} · ${binding.source}`}`,
      ]
      for (const module of binding.modules) {
        const count = entries.filter((entry) => entry.module === module.id).length
        lines.push(
          `- ${module.id} [${module.status}] ${module.title} · ${count} entries${module.path.length > 0 ? ` · ${module.path}` : ''}${
            module.nextStep.length > 0 ? ` · next: ${clip(module.nextStep, 60)}` : ''
          }`,
        )
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}

// helpers that need the resolved project path

function recordPath(projectDir, file) {
  return relative(projectDir, file).split('\\').join('/')
}

function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, number))
}

async function markSuperseded(projectDir, ids, newId) {
  const entries = await readEntries(projectDir)
  const now = nowIso()
  for (const entry of entries) {
    if (!ids.includes(entry.id)) continue
    try {
      const updated = { ...entry, status: 'superseded', updated: now, superseded_by: newId }
      await writeFile(entry.file, renderEntry(updated), 'utf8')
    } catch {
      // superseding is best-effort; the new entry is already durable
    }
  }
}
