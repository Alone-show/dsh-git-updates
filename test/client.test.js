import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/**
 * 在最小 VM 里求值 client.js：只桩掉 __ModuleLoader__ 与 react，
 * 拿到工厂导出的纯函数（渲染部分不在这里跑）。
 * @returns {any} client.js 的 exports。
 */
function loadClient() {
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
    fetch: async () => { throw new Error('fetch not stubbed') },
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
  assert.equal(summary.active, null)
  assert.equal(client.__test.summarize(views, { packageName: 'a' }).active, 'a')
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

test('the settings section renders its loading state without a browser', () => {
  const tree = client.__test.PluginUpdatesSection({ t: key => key, resolveText: value => String(value) })
  assert.equal(tree.type, 'div')
  const kinds = Array.from(tree.children[0], child => child.type)
  assert.deepEqual(kinds, ['style', 'header', 'div', 'p'])
  const icon = client.__test.PluginUpdatesIcon({ size: 16 })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 16)
})
