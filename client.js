/**
 * dsh-project · Web board (client half).
 *
 * Registers one Conversation View tab, "Project memory", that reads the Host
 * JSON API (`/dsh-project/api/state` and `/dsh-project/api/entry`). The panel
 * is read-only: writes stay with the model tools and commands.
 *
 * Loader contract: a lazy factory whose id equals the package name; React comes
 * from the browser module table.
 */
window.__ModuleLoader__.load({
  id: '@echothesky/dsh-project',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useState } = React

    const EN = {
      tab: 'Project',
      title: 'Project memory',
      subtitle: 'Durable state from .dsh/project',
      refresh: 'Refresh',
      loading: 'Loading…',
      emptyTitle: 'No project entries yet',
      emptyBody: 'Ask the agent to remember a decision, or run project_remember. Entries appear here immediately.',
      noMatch: 'No entries match the filter.',
      errorTitle: 'Could not load project memory',
      retry: 'Retry',
      handoffTitle: 'Latest handoff',
      nextStep: 'Next step',
      activeFiles: 'Active files',
      generated: 'Generated',
      brief: 'Brief',
      chars: 'chars',
      entries: 'entries',
      decisions: 'decisions',
      constraints: 'constraints',
      questions: 'questions',
      modules: 'Modules',
      bound: 'Bound',
      projectLevel: 'project-level',
      allModules: 'All modules',
      search: 'Search title, tags, summary…',
      all: 'All',
      typeDecision: 'decision',
      typeConstraint: 'constraint',
      typeGlossary: 'glossary',
      typeQuestion: 'question',
      typeContract: 'contract',
      typeNote: 'note',
      statusActive: 'active',
      statusSuperseded: 'superseded',
      statusRejected: 'rejected',
      statusProposed: 'proposed',
      statusBreaking: 'breaking',
      entryBodyError: 'Could not load the entry body.',
      clickHint: 'Select an entry to read its full text',
      files: 'files',
      unset: '(unset)',
      none: '(none)',
    }

    const ZH = {
      tab: '项目记忆',
      title: '项目记忆',
      subtitle: '来自 .dsh/project 的持久化项目状态',
      refresh: '刷新',
      loading: '加载中…',
      emptyTitle: '还没有项目条目',
      emptyBody: '让 agent 记录一条决策，或调用 project_remember；条目会立即出现在这里。',
      noMatch: '没有匹配的条目。',
      errorTitle: '项目记忆加载失败',
      retry: '重试',
      handoffTitle: '最近交接',
      nextStep: '下一步',
      activeFiles: '活跃文件',
      generated: '生成于',
      brief: '简报',
      chars: '字',
      entries: '条目',
      decisions: '决策',
      constraints: '约束',
      questions: '问题',
      modules: '模块',
      bound: '绑定',
      projectLevel: '项目级',
      allModules: '全部模块',
      search: '搜索标题、标签、摘要…',
      all: '全部',
      typeDecision: '决策',
      typeConstraint: '约束',
      typeGlossary: '术语',
      typeQuestion: '问题',
      typeContract: '契约',
      typeNote: '笔记',
      statusActive: '生效',
      statusSuperseded: '已取代',
      statusRejected: '否决',
      statusProposed: '提议中',
      statusBreaking: '破坏性变更',
      entryBodyError: '条目正文加载失败。',
      clickHint: '点击条目查看完整正文',
      files: '文件',
      unset: '（未设置）',
      none: '（无）',
    }

    const COLORS = {
      decision: 'var(--dsw-alias-brand-primary)',
      constraint: 'var(--dsw-alias-state-warn-primary)',
      glossary: 'var(--dsw-alias-label-secondary)',
      question: 'var(--dsw-alias-state-idle-primary)',
      contract: 'var(--dsw-alias-state-success-primary)',
      note: 'var(--dsw-alias-border-l2)',
    }
    const STATUS_COLORS = {
      active: 'var(--dsw-alias-state-success-primary)',
      superseded: 'var(--dsw-alias-state-idle-primary)',
      rejected: 'var(--dsw-alias-state-error-primary)',
      proposed: 'var(--dsw-alias-state-warn-primary)',
      breaking: 'var(--dsw-alias-state-error-primary)',
    }

    const styles = {
      root: {
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '20px 24px 48px',
        font: 'inherit',
      },
      header: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 16, fontWeight: 600 },
      subtitle: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      spacer: { flex: 1 },
      button: {
        fontSize: 12,
        padding: '4px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      panel: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 12,
        padding: '14px 16px',
        marginTop: 16,
      },
      panelTitle: { margin: '0 0 8px', fontSize: 13, fontWeight: 600 },
      chips: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 },
      chip: {
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      chipActive: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      search: {
        marginTop: 12,
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        outline: 'none',
      },
      list: { marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 },
      row: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
        padding: '10px 12px',
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
      },
      rowTop: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      rowTitle: { fontSize: 13, fontWeight: 600, flex: 1, minWidth: 160 },
      badge: {
        fontSize: 10,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 6,
        border: '1px solid currentColor',
      },
      meta: {
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        alignItems: 'center',
        marginTop: 6,
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
      },
      summary: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      body: {
        marginTop: 10,
        paddingTop: 10,
        borderTop: '1px dashed var(--dsw-alias-border-l1)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-primary)',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11 },
      muted: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      errorText: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
      empty: { textAlign: 'center', padding: '40px 16px' },
      emptyTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 6px' },
      footer: { marginTop: 18, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
    }

    async function fetchJson(url, signal) {
      const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
      const value = await response.json().catch(() => null)
      if (!response.ok || value === null || value.ok !== true) {
        const detail = value && typeof value.error === 'string' ? value.error : `HTTP ${response.status}`
        throw new Error(detail)
      }
      return value
    }

    function makeView(t) {
      const typeLabel = (type) => t(`type${type.charAt(0).toUpperCase()}${type.slice(1)}`)
      const statusLabel = (status) => t(`status${status.charAt(0).toUpperCase()}${status.slice(1)}`)
      const typeFilters = ['', 'decision', 'constraint', 'glossary', 'question', 'contract', 'note']

      return function ProjectMemoryView(props) {
        const sessionId = props && props.sessionId ? props.sessionId : ''
        const [reloadKey, setReloadKey] = useState(0)
        const [state, setState] = useState({ status: 'loading', data: null, error: '' })
        const [query, setQuery] = useState('')
        const [typeFilter, setTypeFilter] = useState('')
        const [moduleFilter, setModuleFilter] = useState('')
        const [expandedPath, setExpandedPath] = useState('')
        const [bodies, setBodies] = useState({})
        const [bodyError, setBodyError] = useState('')

        useEffect(() => {
          if (!sessionId) {
            setState({ status: 'error', data: null, error: 'No session id' })
            return undefined
          }
          const controller = new AbortController()
          let alive = true
          setState((previous) => ({
            status: previous.data ? 'refreshing' : 'loading',
            data: previous.data,
            error: '',
          }))
          fetchJson(`/dsh-project/api/state?sessionId=${encodeURIComponent(sessionId)}`, controller.signal)
            .then((data) => {
              if (alive) setState({ status: 'ready', data, error: '' })
            })
            .catch((error) => {
              if (alive && error && error.name !== 'AbortError') {
                setState({ status: 'error', data: null, error: String(error.message || error) })
              }
            })
          return () => {
            alive = false
            controller.abort()
          }
        }, [sessionId, reloadKey])

        const entries = useMemo(() => {
          const data = state.data
          if (!data || !Array.isArray(data.entries)) return []
          const needle = query.trim().toLowerCase()
          return data.entries.filter((entry) => {
            if (typeFilter && entry.type !== typeFilter) return false
            if (moduleFilter !== '' && (entry.module || '') !== moduleFilter) return false
            if (!needle) return true
            const haystack = [entry.id, entry.title, entry.summary, ...(entry.tags || [])]
              .join(' ')
              .toLowerCase()
            return haystack.includes(needle)
          })
        }, [state.data, query, typeFilter, moduleFilter])

        const openEntry = (entry) => {
          if (expandedPath === entry.path) {
            setExpandedPath('')
            return
          }
          setExpandedPath(entry.path)
          if (bodies[entry.path] !== undefined) return
          fetchJson(
            `/dsh-project/api/entry?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(entry.path)}`,
            undefined,
          )
            .then((value) => setBodies((previous) => ({ ...previous, [entry.path]: value.body })))
            .catch((error) => setBodyError(String((error && error.message) || error)))
        }

        const data = state.data
        const counts = data && data.counts ? data.counts : { total: 0 }
        const brief = data && data.brief ? data.brief : null
        const handoff = data && data.handoff ? data.handoff : null
        const modules = data && Array.isArray(data.modules) ? data.modules : []
        const bound = data && data.binding ? data.binding : { moduleId: '', source: 'none' }

        const stats = [
          `${counts.total || 0} ${t('entries')}`,
          modules.length > 0 ? `${modules.length} ${t('modules')}` : null,
          brief ? `${t('brief')} ${brief.chars} ${t('chars')}` : null,
          `${t('bound')}: ${bound.moduleId || t('projectLevel')}${bound.moduleId ? ` (${bound.source})` : ''}`,
        ].filter(Boolean)

        return h(
          'div',
          { style: styles.root },
          h(
            'div',
            { style: styles.header },
            h('h2', { style: styles.title }, t('title')),
            h('span', { style: styles.subtitle }, t('subtitle')),
            h('span', { style: styles.spacer }),
            h(
              'button',
              {
                type: 'button',
                style: styles.button,
                onClick: () => setReloadKey((key) => key + 1),
                title: t('refresh'),
              },
              state.status === 'refreshing' ? t('loading') : t('refresh'),
            ),
          ),
          h(
            'div',
            { style: styles.meta },
            stats.map((text, index) => h('span', { key: `stat-${index}`, style: styles.muted }, text)),
          ),
          handoff
            ? h(
                'section',
                { style: styles.panel },
                h('h3', { style: styles.panelTitle }, t('handoffTitle')),
                h(
                  'div',
                  { style: styles.muted },
                  `${t('generated')} ${handoff.generated || '—'}`,
                  handoff.reason ? ` · ${handoff.reason}` : '',
                ),
                h(
                  'div',
                  { style: { ...styles.muted, marginTop: 8 } },
                  `${t('nextStep')}: ${handoff.nextStep || t('unset')}`,
                ),
                handoff.activeFiles && handoff.activeFiles.length > 0
                  ? h(
                      'div',
                      { style: { ...styles.muted, marginTop: 6 } },
                      `${t('activeFiles')}: `,
                      handoff.activeFiles.map((file, index) =>
                        h('span', { key: `file-${index}`, style: styles.mono }, `${index > 0 ? ', ' : ''}${file}`),
                      ),
                    )
                  : null,
              )
            : null,
          state.status === 'error'
            ? h(
                'section',
                { style: styles.panel },
                h('h3', { style: styles.panelTitle }, t('errorTitle')),
                h('div', { style: styles.errorText }, state.error),
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...styles.button, marginTop: 10 },
                    onClick: () => setReloadKey((key) => key + 1),
                  },
                  t('retry'),
                ),
              )
            : null,
          h('input', {
            style: styles.search,
            type: 'search',
            value: query,
            placeholder: t('search'),
            onChange: (event) => setQuery(event.target.value),
            'aria-label': t('search'),
          }),
          h(
            'div',
            { style: styles.chips },
            typeFilters.map((value) =>
              h(
                'button',
                {
                  key: `filter-${value || 'all'}`,
                  type: 'button',
                  style: { ...styles.chip, ...(typeFilter === value ? styles.chipActive : {}) },
                  onClick: () => setTypeFilter(value),
                },
                value ? typeLabel(value) : t('all'),
              ),
            ),
          ),
          modules.length > 0
            ? h(
                'div',
                { style: { ...styles.chips, marginTop: 8 } },
                [
                  { id: '', label: t('allModules') },
                  ...modules.map((module) => ({
                    id: module.id,
                    label: `${module.id}${module.status === 'active' ? '' : `(${module.status})`}`,
                  })),
                ].map((option) =>
                  h(
                    'button',
                    {
                      key: `module-${option.id || 'all'}`,
                      type: 'button',
                      style: { ...styles.chip, ...(moduleFilter === option.id ? styles.chipActive : {}) },
                      onClick: () => setModuleFilter(option.id),
                    },
                    option.label,
                  ),
                ),
              )
            : null,
          data && counts.total === 0
            ? h(
                'div',
                { style: styles.empty },
                h('h3', { style: styles.emptyTitle }, t('emptyTitle')),
                h('div', { style: styles.muted }, t('emptyBody')),
              )
            : null,
          h(
            'div',
            { style: styles.list },
            entries.map((entry) =>
              h(
                'div',
                {
                  key: entry.id,
                  style: styles.row,
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => openEntry(entry),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openEntry(entry)
                    }
                  },
                },
                h(
                  'div',
                  { style: styles.rowTop },
                  h('span', { style: styles.rowTitle }, entry.title),
                  h(
                    'span',
                    { style: { ...styles.badge, color: COLORS[entry.type] || COLORS.note } },
                    typeLabel(entry.type),
                  ),
                  h(
                    'span',
                    { style: { ...styles.badge, color: STATUS_COLORS[entry.status] || STATUS_COLORS.active } },
                    statusLabel(entry.status),
                  ),
                ),
                h(
                  'div',
                  { style: styles.meta },
                  entry.module
                    ? h('span', { style: { ...styles.badge, color: 'var(--dsw-alias-brand-primary)' } }, entry.module)
                    : h('span', { style: { ...styles.badge, color: 'var(--dsw-alias-label-secondary)' } }, t('projectLevel')),
                  h('span', { style: styles.mono }, entry.id),
                  entry.updated ? h('span', null, entry.updated.slice(0, 16).replace('T', ' ')) : null,
                  entry.tags && entry.tags.length > 0
                    ? h('span', null, entry.tags.map((tag) => `#${tag}`).join(' '))
                    : null,
                ),
                h('div', { style: styles.summary }, entry.summary),
                expandedPath === entry.path
                  ? h(
                      'div',
                      { style: styles.body },
                      bodyError
                        ? h('span', { style: styles.errorText }, `${t('entryBodyError')} ${bodyError}`)
                        : bodies[entry.path] !== undefined
                          ? bodies[entry.path]
                          : t('loading'),
                    )
                  : null,
              ),
            ),
          ),
          data && counts.total > 0 && entries.length === 0
            ? h('div', { style: { ...styles.muted, marginTop: 14 } }, t('noMatch'))
            : null,
          h(
            'div',
            { style: styles.footer },
            h('span', { style: { ...styles.mono, color: 'var(--dsw-alias-label-secondary)' } }, data && data.projectDir ? data.projectDir : ''),
            h('span', { style: { ...styles.muted, flex: '1 1 auto', textAlign: 'right' } }, t('clickHint')),
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.locale.register('dsh-project', 'en', EN)
          ctx.locale.register('dsh-project', 'zh', ZH)
        } catch {
          // a host without the locale service still renders the fallback keys
        }
        const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind('dsh-project') : (key) => key
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'project',
              order: 40,
              label: () => t('tab'),
            },
            makeView(t),
          ),
        )
      },
    }
  },
})
