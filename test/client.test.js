import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/**
 * 在最小 VM 里求值 client.js：只桩掉 __ModuleLoader__ 与 react，
 * 拿到工厂导出的纯函数（渲染部分不在这里跑）。
 * @param {(url: string, init: any) => Promise<any>} [fetchImpl] fetch 桩。
 * @returns {any} client.js 的 exports。
 */
function loadClient(fetchImpl = async () => { throw new Error('fetch not stubbed') }) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let factory
  const context = {
    window: {
      __ModuleLoader__: {
        load: definition => { factory = definition.factory },
      },
      location: { reload: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ setAttribute: () => {}, appendChild: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
      visibilityState: 'visible',
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchImpl,
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.equal(typeof factory, 'function', 'factory should be registered')
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  return factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
}

const client = loadClient()

test('formatDuration renders seconds and minutes', () => {
  assert.equal(client.__test.formatDuration(0), '0.0s')
  assert.equal(client.__test.formatDuration(1500), '1.5s')
  assert.equal(client.__test.formatDuration(65200), '1m 05s')
  assert.equal(client.__test.formatDuration(undefined), '')
})

test('summarize counts the plugins behind and pending a restart', () => {
  const views = [
    { package: 'a', check: { state: 'behind' } },
    { package: 'b', check: { state: 'current' }, pendingRestart: { commit: 'b'.repeat(40) } },
    { package: 'c', check: { state: 'current' } },
  ]
  const summary = client.__test.summarize(views, null)
  assert.deepEqual(Array.from(summary.behind), ['a'])
  assert.deepEqual(Array.from(summary.pending), ['b'])
  assert.equal(summary.total, 2)
  const overlap = client.__test.summarize([
    { package: 'a', check: { state: 'behind' }, pendingRestart: { commit: 'a'.repeat(40) } },
  ], null)
  assert.equal(overlap.total, 1)
  assert.deepEqual(Array.from(summary.active), [])
  assert.deepEqual(Array.from(client.__test.summarize(views, [{ packageName: 'a' }, { package: 'b' }]).active), ['a', 'b'])
})

test('stepRows labels every step and shows durations', () => {
  const job = {
    status: 'done',
    steps: [
      { step: 'checking', status: 'done', durationMs: 400 },
      { step: 'removing', status: 'done', durationMs: 1200 },
      { step: 'installing', status: 'done', durationMs: 0 },
      { step: 'verifying', status: 'done', durationMs: 300 },
    ],
  }
  const rows = client.__test.stepRows(job, client.__test.interpolate ? (key => key) : (key => key), Date.now())
  assert.deepEqual(Array.from(rows, row => row.step), ['checking', 'removing', 'installing', 'verifying'])
  assert.equal(rows[1].duration, '1.2s')
  assert.equal(rows[2].duration, '')
})

test('phaseOf distinguishes loading, busy, behind, current and hidden', () => {
  assert.equal(client.__test.phaseOf({ phase: 'idle', view: null, job: null }), 'loading')
  assert.equal(client.__test.phaseOf({ phase: 'updating', view: { applicable: true }, job: null }), 'busy')
  assert.equal(client.__test.phaseOf({
    phase: 'ready', job: { status: 'running' }, view: { applicable: true, check: { state: 'behind' } },
  }), 'busy')
  assert.equal(client.__test.phaseOf({ phase: 'ready', job: null, view: { applicable: true, check: { state: 'behind' } } }), 'behind')
  assert.equal(client.__test.phaseOf({ phase: 'ready', job: null, view: { applicable: true, check: { state: 'current' } } }), 'current')
  assert.equal(client.__test.phaseOf({ phase: 'ready', job: null, view: { applicable: false } }), 'hidden')
  assert.equal(client.__test.phaseOf({ phase: 'error', job: null, view: { applicable: true } }), 'error')
})

test('restartReasonText maps known codes and hides unknown ones', () => {
  const t = (key, params) => {
    if (key === 'reason.no-hmr') return 'no HMR'
    return client.__test.interpolate(key, params)
  }
  assert.equal(client.__test.restartReasonText('no-hmr', t), 'no HMR')
  assert.equal(client.__test.restartReasonText('whatever', t), '')
  assert.equal(client.__test.restartReasonText(undefined, t), '')
})

test('busyLabel names the running step', () => {
  const t = (key, params) => {
    if (key === 'step.installing') return '安装目标版本'
    if (key === 'action.busyStep') return `${params.step}…`
    if (key === 'action.busy') return '更新中…'
    return key
  }
  assert.equal(client.__test.busyLabel({ step: 'installing' }, t), '安装目标版本…')
  assert.equal(client.__test.busyLabel({ step: 'done' }, t), '更新中…')
  assert.equal(client.__test.busyLabel(null, t), '更新中…')
})

test('formatClock and formatDate tolerate junk', () => {
  assert.equal(client.__test.formatClock('nonsense'), '')
  assert.equal(client.__test.formatDate('nonsense'), 'nonsense')
  assert.equal(client.__test.formatDate(undefined), '—')
})

test('zh and en dictionaries stay in sync and cover the keys used in code', () => {
  const { zh, en } = client.__test.dicts
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const used = new Set()
  for (const match of source.matchAll(/\bt\(\s*'([a-z][a-z0-9.-]*)'/g)) used.add(match[1])
  for (const match of source.matchAll(/key:\s*'([a-z][a-z0-9.-]*)'/g)) used.add(match[1])
  for (const key of [...used].filter(key => key.includes('.')).sort()) {
    if (!(key in zh)) throw new Error(`missing zh key: ${key}`)
    if (!(key in en)) throw new Error(`missing en key: ${key}`)
  }
})

test('dictionary placeholders match between languages', () => {
  const { zh, en } = client.__test.dicts
  const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const key of Object.keys(zh)) {
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `placeholder mismatch: ${key}`)
  }
})

test('errorText maps known Host codes and falls back to the original message', () => {
  const { zh } = client.__test.dicts
  const t = (key, params) => (zh[key] === undefined ? key : client.__test.interpolate(zh[key], params))
  assert.equal(client.__test.errorText('JOB_RUNNING', '已有更新任务在运行', t), zh['err.jobRunning'])
  assert.equal(client.__test.errorText('no-commit', 'x', t), zh['err.noCommit'])
  assert.equal(client.__test.errorText('WHATEVER', 'raw host text', t), 'raw host text')
  assert.equal(client.__test.errorText(undefined, 'raw', t), 'raw')
})

test('mergeViews keeps a busy row across one missing poll', () => {
  const { mergeViews } = client.__test
  const busy = { package: 'b', applicable: true, job: { status: 'running' } }
  const idle = { package: 'a', applicable: true }
  assert.deepEqual(Array.from(mergeViews([busy, idle], [idle], Date.now()), view => view.package), ['a', 'b'])
  const stale = { package: 'c', applicable: true, __seenAt: 1000 }
  assert.equal(mergeViews([stale], [], 2000).some(view => view.package === 'c'), true)
  assert.equal(mergeViews([stale], [], 1000 + 6000).some(view => view.package === 'c'), false)
})

test('compareHref only links GitHub repositories', () => {
  const { compareHref } = client.__test
  assert.equal(
    compareHref({
      host: 'github.com',
      repository: 'owner/repo',
      installed: { commit: 'a'.repeat(40) },
      check: { latest: 'b'.repeat(40) },
    }),
    `https://github.com/owner/repo/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`,
  )
  assert.equal(compareHref({ host: 'gitlab.com', repository: 'g/r' }), undefined)
})

test('non-Git plugins render as a plain list with no controls', () => {
  const t = (key, params) => {
    if (key === 'kind.link') return '本地链接'
    if (key === 'kind.registry') return '注册表'
    if (key === 'state.disabled') return '已停用'
    if (key === 'meta.version') return `版本 ${params.version}`
    return client.__test.interpolate(key, params)
  }
  const rows = client.__test.otherRows([
    { package: 'dsh-mdm-ssh', version: '0.0.0', kind: 'link', enabled: true },
    { package: 'dsh-knowledge-base-local', title: '知识库', version: '1.2.6', kind: 'registry', enabled: false },
  ], t, value => String(value))
  assert.equal(rows.length, 2)
  // 只有文本：不检查、不更新，所以一个按钮都不该有。
  assert.equal(nodesOf(rows, 'button').length, 0)
  const texts = row => Array.from(nodesOf(row, 'span'), node => String(node.children?.[0] ?? ''))
  assert.deepEqual(texts(rows[0]), ['dsh-mdm-ssh', '版本 0.0.0', '本地链接'])
  // 标题和包名不同：两个都显示；停用的单独标出来。
  assert.deepEqual(texts(rows[1]), ['知识库', 'dsh-knowledge-base-local', '版本 1.2.6', '注册表', '已停用'])
})

test('apply registers exactly the settings page and its icon', () => {
  const registrations = []
  const ctx = {
    effect: callback => callback(),
    locale: {
      register: () => () => {},
      bind: () => key => key,
      resolveText: value => (typeof value === 'string' ? value : ''),
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)
  assert.deepEqual(Array.from(registrations, entry => entry.options.name), ['settings.section', 'settings.section.icon'])
  assert.equal(registrations[0].options.id, 'plugin-updates')
  assert.equal(registrations[1].options.id, 'plugin-updates')
  assert.equal(registrations[0].options.order, 20)
  assert.equal(registrations[0].options.locale, 'git-updates')
})

/**
 * 深度遍历 React 元素树，收集指定 type 的节点。
 * @param {any} tree 元素、元素数组或文本。
 * @param {string} type 要收集的元素类型（如 'button'）。
 * @param {any[]} [out] 累积结果。
 * @returns {any[]} 匹配的节点。
 */
function nodesOf(tree, type, out = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) nodesOf(child, type, out)
    return out
  }
  if (tree === null || typeof tree !== 'object') return out
  if (tree.type === type) out.push(tree)
  nodesOf(tree.children, type, out)
  return out
}

test('the settings section renders its loading state without a browser', () => {
  const tree = client.__test.PluginUpdatesSection({ t: key => key, resolveText: value => String(value) })
  assert.equal(tree.type, 'div')
  const kinds = Array.from(tree.children[0], child => child.type)
  assert.deepEqual(kinds, ['style', 'header', 'div', 'p'])
  // 按钮按原生 Button 的变体分层：检查类是描边，加载中禁用。
  const buttons = nodesOf(tree, 'button')
  assert.deepEqual(Array.from(buttons, button => button.props.className), ['gu-btn gu-outline'])
  assert.equal(buttons[0].props.disabled, true)
  const icon = client.__test.PluginUpdatesIcon({ size: 16 })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 16)
})

test('clicking a plugin name opens its detail page and then closes settings', () => {
  const calls = []
  const props = {
    openBundle: name => { calls.push(name); return true },
    close: () => calls.push('close'),
  }
  assert.equal(client.__test.openBundleDetail(props, 'pkg'), true)
  assert.deepEqual(calls, ['pkg', 'close'])

  // 宿主没有插件页导航时，不能把设置白关掉。
  const failed = []
  assert.equal(client.__test.openBundleDetail({
    openBundle: () => false,
    close: () => failed.push('close'),
  }, 'pkg'), false)
  assert.deepEqual(failed, [])
  assert.equal(client.__test.openBundleDetail({}, 'pkg'), false)
  assert.equal(client.__test.openBundleDetail(props, ''), false)
  assert.equal(client.__test.openBundleDetail({
    openBundle: () => { throw new Error('boom') },
    close: () => failed.push('close'),
  }, 'pkg'), false)
  assert.deepEqual(failed, [])
})

test('the settings section injects a guarded plugin-detail opener', () => {
  const opened = []
  const registrations = []
  const ctx = {
    effect: callback => callback(),
    get: name => (name === 'pluginNavigation' ? { openBundle: packageName => { opened.push(packageName) } } : undefined),
    locale: {
      register: () => () => {},
      bind: () => key => key,
      resolveText: value => (typeof value === 'string' ? value : ''),
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)
  const face = registrations[0].options.inject()
  assert.equal(face.openBundle('pkg'), true)
  assert.deepEqual(opened, ['pkg'])
  assert.equal(typeof face.resolveText, 'function')
})

test('a missing plugin navigation makes the opener return false', () => {
  const registrations = []
  const ctx = {
    effect: callback => callback(),
    get: () => undefined,
    locale: {
      register: () => () => {},
      bind: () => key => key,
      resolveText: value => (typeof value === 'string' ? value : ''),
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)
  assert.equal(registrations[0].options.inject().openBundle('pkg'), false)
})

test('logs are cleared after settings closes, and a quick reopen keeps them', async () => {
  const calls = []
  const scheduled = loadClient(async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, cleared: 0 }) }
  })
  scheduled.__test.scheduleLogClear()
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/dsh-git-updates')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'clearLogs' })

  // 关掉又很快重开：挂载时会取消还没发出去的清理。
  scheduled.__test.scheduleLogClear()
  scheduled.__test.cancelScheduledLogClear()
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(calls.length, 1)
})

test('rowActions gates only the row itself, never the whole page', () => {
  const { rowActions } = client.__test
  const behind = {
    package: 'a',
    installed: { commit: 'a'.repeat(40) },
    check: { state: 'behind', latest: 'b'.repeat(40) },
  }
  assert.deepEqual({ ...rowActions(behind) }, { canCheck: true, canUpdate: true, canCancel: false })
  // 这一行自己在检查：只影响这一行。
  assert.equal(rowActions(behind, { checking: true }).canUpdate, false)
  // 这一行自己在更新：只影响这一行，别的行照常可以检查/更新。
  assert.equal(rowActions({ ...behind, job: { status: 'running' } }).canUpdate, false)
  assert.equal(rowActions({ ...behind, job: { status: 'running' } }).canCheck, false)
  assert.equal(rowActions({ ...behind, job: { status: 'running' } }).canCancel, true)
  // 其它行的检查/更新状态不在这个函数的输入里，因此不会连带禁用。
  assert.equal(rowActions({ ...behind, job: { status: 'done' } }).canUpdate, true)
  assert.equal(rowActions({ ...behind, installedMissing: true }).canCheck, false)
  assert.equal(rowActions({ ...behind, self: true }).canUpdate, false)
  assert.equal(rowActions({ ...behind, check: { state: 'current' } }).canUpdate, false)
})

test('summarize lists every concurrent job', () => {
  const { summarize } = client.__test
  const summary = summarize([], [{ package: 'a' }, { package: 'b' }])
  assert.deepEqual(Array.from(summary.active), ['a', 'b'])
})
