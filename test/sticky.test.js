import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mergeSticky, summarizeJob, summarizeResult, STICKY_KEEP_MS } from '../lib/sticky.js'

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)

function view(name, extra = {}) {
  return {
    package: name,
    applicable: true,
    source: 'github:owner/repo',
    host: 'github.com',
    repository: `owner/${name}`,
    installed: { version: '1.0.0', commit: OLD },
    installedMissing: false,
    ...extra,
  }
}

function job(packageName, status, extra = {}) {
  return {
    id: `job-${packageName}`,
    packageName,
    step: status === 'done' ? 'done' : 'installing',
    status,
    message: '正在安装',
    startedAt: new Date().toISOString(),
    finishedAt: status === 'running' ? null : new Date().toISOString(),
    elapsedMs: 1200,
    steps: [{ step: 'installing', status: 'running', durationMs: 900 }],
    logs: [{ at: new Date().toISOString(), level: 'info', message: 'pnpm add' }],
    result: undefined,
    error: undefined,
    snapshot: view(packageName),
    ...extra,
  }
}

test('a running update keeps the row whose package was uninstalled', () => {
  const rows = mergeSticky([view('other')], [job('pkg', 'running')], { now: Date.now() })
  assert.deepEqual(rows.map(row => row.package), ['other', 'pkg'])
  const sticky = rows.find(row => row.package === 'pkg')
  assert.equal(sticky.sticky, true)
  assert.equal(sticky.installedMissing, true)
  assert.equal(sticky.job.status, 'running')
  assert.equal(sticky.installed.commit, OLD)
})

test('a recently finished update keeps its row, an old one is dropped', () => {
  const now = Date.now()
  const recent = job('recent', 'failed', { finishedAt: new Date(now - 60_000).toISOString() })
  const old = job('old', 'failed', { finishedAt: new Date(now - STICKY_KEEP_MS - 1000).toISOString() })
  const rows = mergeSticky([], [old, recent], { now })
  assert.deepEqual(rows.map(row => row.package), ['recent'])
})

test('a live row wins over the snapshot and still carries the job', () => {
  const live = view('pkg', { installed: { version: '2.0.0', commit: NEW } })
  const rows = mergeSticky([live], [job('pkg', 'running')], { now: Date.now() })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].installed.commit, NEW)
  assert.equal(rows[0].sticky, undefined)
  assert.equal(rows[0].job.status, 'running')
})

test('a job without a snapshot does not invent a row', () => {
  const rows = mergeSticky([], [job('pkg', 'running', { snapshot: undefined })], { now: Date.now() })
  assert.deepEqual(rows, [])
})

test('summarizeJob trims host results to browser-sized facts', () => {
  const summary = summarizeJob(job('pkg', 'done', {
    status: 'done',
    step: 'done',
    result: {
      verified: true,
      application: 'restart-required',
      restartReason: 'host-module',
      spec: `github:owner/repo#${NEW}`,
      from: { version: '1.0.0', commit: OLD },
      to: { version: '2.0.0', commit: NEW },
      steps: [{ step: 'installing', result: { packageResult: { output: 'x'.repeat(10000) } } }],
      restore: {
        spec: `github:owner/repo#${OLD}`,
        result: { application: 'applied' },
        verified: { ok: true, problems: [] },
      },
    },
  }))
  assert.equal(summary.status, 'done')
  assert.equal(summary.result.to.commit, NEW)
  assert.equal(summary.result.restartReason, 'host-module')
  assert.equal(summary.result.restore.spec, `github:owner/repo#${OLD}`)
  assert.equal(summary.result.steps, undefined)
  assert.equal(JSON.stringify(summary).includes('packageResult'), false)
})

test('summarizeResult tolerates junk', () => {
  assert.equal(summarizeResult(undefined), undefined)
  assert.deepEqual(summarizeResult({ verified: false, error: { code: 'X', message: 'y' } }), {
    verified: false,
    error: { code: 'X', message: 'y' },
  })
})
