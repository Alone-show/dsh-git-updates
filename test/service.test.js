import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { createService } from '../lib/service.js'
import { readState } from '../lib/state.js'

const sha = char => char.repeat(40)
const OLD = sha('a')
const NEW = sha('b')

function lockFor(name, commit) {
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    `      ${name}:`,
    '        specifier: github:owner/repo',
    `        version: https://codeload.github.com/owner/repo/tar.gz/${commit}`,
    '',
    'packages:',
    '',
  ].join('\n')
}

async function makeProfile(name = 'pkg', commit = OLD) {
  const dir = await mkdtemp(join(tmpdir(), 'gu-service-'))
  await mkdir(join(dir, 'node_modules', name), { recursive: true })
  await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({
    name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }), 'utf8')
  await writeFile(join(dir, 'pnpm-lock.yaml'), lockFor(name, commit), 'utf8')
  return dir
}

function bundleFor(name, source = 'github:owner/repo') {
  return {
    name,
    version: '1.0.0',
    installed: true,
    availability: 'profile',
    official: false,
    enabled: true,
    removable: true,
    source,
    rows: [],
    overrides: [],
  }
}

function fakeManager(dir, bundles, options = {}) {
  const calls = { remove: [], install: [] }
  return {
    calls,
    async listBundles() {
      return bundles
    },
    async removeBundle(name) {
      calls.remove.push(name)
      return { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async installBundle(spec, installOptions = {}) {
      calls.install.push({ spec, options: installOptions })
      if (options.onInstall !== undefined) await options.onInstall(spec)
      const commit = /#([0-9a-f]{40})/.exec(spec)?.[1] ?? OLD
      await writeFile(join(dir, 'pnpm-lock.yaml'), lockFor('pkg', commit), 'utf8')
      await writeFile(join(dir, 'node_modules', 'pkg', 'package.json'), JSON.stringify({
        name: 'pkg', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
      }), 'utf8')
      return options.installResult ?? { changed: true, application: 'applied', stage: 'install', target: spec }
    },
    async cancelInstall() {
      calls.cancelled = (calls.cancelled ?? 0) + 1
      return { status: 'cancelled' }
    },
  }
}

async function waitJob(service, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = service.job(id)
    if (job !== undefined && job.status !== 'running' && job.status !== 'cancelling') return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('job did not settle')
}

test('list and view expose the installed commit for Git bundles only', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [
      bundleFor('pkg'),
      bundleFor('reg', '^1.0.0'),
      { ...bundleFor('official'), official: true },
      { ...bundleFor('local'), source: 'link:/home/my/Downloads/x' },
    ])
    const service = createService({ manager, profileDir: dir, config: resolveConfig({}) })
    const views = await service.list()
    assert.deepEqual(views.map(view => view.package), ['pkg'])
    assert.equal(views[0].installed.commit, OLD)
    assert.equal(views[0].host, 'github.com')
    assert.equal((await service.view('pkg')).applicable, true)
    assert.equal((await service.view('reg')).applicable, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check probes upstream and persists the result', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const probed = []
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      probe: async (source, options) => {
        probed.push({ source, options })
        return { ok: true, commit: NEW, ref: 'main', transport: 'https' }
      },
    })
    const view = await service.check('pkg', { force: true })
    assert.equal(probed.length, 1)
    assert.equal(probed[0].source.host, 'github.com')
    assert.equal(probed[0].options.timeoutMs, 15000)
    assert.equal(view.check.state, 'behind')
    assert.equal(view.check.latest, NEW)
    const state = await readState(dir)
    assert.equal(state.packages.pkg.lastCheck.state, 'behind')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check records an unreachable upstream without throwing', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      probe: async () => ({ ok: false, kind: 'auth', message: 'fatal: could not read Username' }),
    })
    const view = await service.check('pkg', { force: true })
    assert.equal(view.check.state, 'unknown')
    assert.equal(view.check.error.kind, 'auth')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('update runs to completion and pins the upstream commit', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      hmr: true,
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    const started = await service.update('pkg', { expectedCommit: OLD })
    const job = await waitJob(service, started.jobId)
    assert.equal(job.status, 'done')
    assert.equal(job.result.verified, true)
    assert.equal(manager.calls.install[0].spec, `github:owner/repo#${NEW}`)
    const state = await readState(dir)
    assert.equal(state.packages.pkg.lastCheck.state, 'current')
    assert.equal(state.packages.pkg.lastUpdate.verified, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('update refuses a stale view, an unchanged commit and an unknown installed commit', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    await assert.rejects(() => service.update('pkg', { expectedCommit: NEW }), error => error.code === 'STALE_VIEW')

    const currentService = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      probe: async () => ({ ok: true, commit: OLD, ref: 'main', transport: 'https' }),
    })
    await assert.rejects(() => currentService.update('pkg', {}), error => error.code === 'ALREADY_LATEST')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const empty = await mkdtemp(join(tmpdir(), 'gu-service-empty-'))
  try {
    const manager = fakeManager(empty, [bundleFor('pkg')])
    const service = createService({
      manager,
      profileDir: empty,
      config: resolveConfig({}),
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    await assert.rejects(() => service.update('pkg', {}), error => error.code === 'UNKNOWN_INSTALLED_COMMIT')
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('a second update while one runs is refused', async () => {
  const dir = await makeProfile()
  try {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const manager = fakeManager(dir, [bundleFor('pkg')], { onInstall: () => gate })
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      hmr: true,
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    const started = await service.update('pkg', {})
    await assert.rejects(() => service.update('pkg', {}), error => error.code === 'JOB_RUNNING')
    release()
    const job = await waitJob(service, started.jobId)
    assert.equal(job.status, 'done')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancel asks the host to stop the running installation', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      hmr: true,
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    service.cancel()
    assert.equal(manager.calls.cancelled, undefined)

    const started = await service.update('pkg', {})
    const cancelled = service.cancel()
    assert.equal(cancelled.cancelled, true)
    assert.equal(manager.calls.cancelled, 1)
    await waitJob(service, started.jobId)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the job view carries steps, logs and timings', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      hmr: true,
      bootId: 'boot-a',
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    await service.ready
    const started = await service.update('pkg', {})
    const job = await waitJob(service, started.jobId)
    assert.equal(job.steps.length, 4)
    assert.equal(job.steps.every(step => step.status === 'done'), true)
    assert.equal(typeof job.elapsedMs, 'number')
    assert.equal(job.logs.length > 0, true)
    assert.equal(job.logs.some(entry => entry.message.includes('安装')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a restart-required update is remembered until the next Host boot', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')], {
      installResult: { changed: true, application: 'restart-required', restartReason: 'host-module', stage: 'install', target: 'pkg' },
    })
    const first = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      hmr: true,
      bootId: 'boot-a',
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    await first.ready
    const started = await first.update('pkg', {})
    await waitJob(first, started.jobId)
    const view = await first.view('pkg')
    assert.equal(view.pendingRestart.commit, NEW)
    assert.equal(view.pendingRestart.reason, 'host-module')
    assert.equal(view.lastUpdate.restartReason, 'host-module')
    const state = await readState(dir)
    assert.equal(state.packages.pkg.restartPending.bootId, 'boot-a')

    // 同一进程再挂载：待重启应保留。
    const again = createService({ manager, profileDir: dir, config: resolveConfig({}), bootId: 'boot-a' })
    await again.ready
    assert.equal((await again.view('pkg')).pendingRestart.commit, NEW)

    // 换了进程（重启过）：标记被清掉，并记下 restartedAt。
    const next = createService({ manager, profileDir: dir, config: resolveConfig({}), bootId: 'boot-b' })
    await next.ready
    const after = await next.view('pkg')
    assert.equal(after.pendingRestart, undefined)
    assert.equal(typeof after.lastUpdate.restartedAt, 'string')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an update applied by HMR leaves no pending restart', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      hmr: true,
      bootId: 'boot-a',
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    await service.ready
    const started = await service.update('pkg', {})
    await waitJob(service, started.jobId)
    assert.equal((await service.view('pkg')).pendingRestart, undefined)
    const state = await readState(dir)
    assert.equal(state.packages.pkg.restartPending, undefined)
    assert.equal(state.packages.pkg.lastUpdate.application, 'applied')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sweep checks every managed Git bundle and counts the ones behind', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [
      { ...bundleFor('pkg'), name: 'pkg' },
      { ...bundleFor('other', 'github:owner/other'), name: 'other' },
      bundleFor('reg', '^1.0.0'),
    ])
    // other 的锁文件条目
    const lock = [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      pkg:',
      '        specifier: github:owner/repo',
      `        version: https://codeload.github.com/owner/repo/tar.gz/${OLD}`,
      '      other:',
      '        specifier: github:owner/other',
      `        version: https://codeload.github.com/owner/other/tar.gz/${OLD}`,
      '',
      'packages:',
      '',
    ].join('\n')
    await writeFile(join(dir, 'pnpm-lock.yaml'), lock, 'utf8')
    const probed = []
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      probe: async source => {
        probed.push(source.path)
        return { ok: true, commit: NEW, ref: 'main', transport: 'https' }
      },
    })
    await service.ready
    const summary = await service.sweep()
    assert.equal(summary.skipped, false)
    assert.equal(summary.checked, 2)
    assert.equal(summary.behind, 2)
    assert.deepEqual(probed.sort(), ['owner/other', 'owner/repo'])
    const state = await readState(dir)
    assert.equal(state.packages.pkg.lastCheck.state, 'behind')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sweep skips while an update job is running and survives probe failures', async () => {
  const dir = await makeProfile()
  try {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const manager = fakeManager(dir, [bundleFor('pkg')], { onInstall: () => gate })
    const probed = []
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      hmr: true,
      probe: async () => {
        probed.push('probe')
        return { ok: true, commit: NEW, ref: 'main', transport: 'https' }
      },
    })
    await service.ready
    const started = await service.update('pkg', {})
    const skipped = await service.sweep()
    assert.equal(skipped.skipped, true)
    release()
    await waitJob(service, started.jobId)

    const failing = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      probe: async () => ({ ok: false, kind: 'network', message: 'offline' }),
    })
    await failing.ready
    const summary = await failing.sweep()
    assert.equal(summary.checked, 1)
    assert.equal(summary.behind, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an old check is flagged stale in the view', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const service = createService({ manager, profileDir: dir, config: resolveConfig({}), bootId: 'boot-a' })
    await service.ready
    await writeFile(join(dir, 'pnpm-lock.yaml'), lockFor('pkg', OLD), 'utf8')
    const { recordCheck } = await import('../lib/state.js')
    await recordCheck(dir, 'pkg', { at: new Date(Date.now() - 3600000).toISOString(), state: 'current', latest: OLD })
    const view = await service.view('pkg')
    assert.equal(view.check.stale, true)
    await recordCheck(dir, 'pkg', { at: new Date().toISOString(), state: 'current', latest: OLD })
    const fresh = await service.view('pkg')
    assert.equal(fresh.check.stale, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a confirmed target commit skips the upstream probe and installs exactly that commit', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    let probes = 0
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      hmr: true,
      bootId: 'boot-a',
      probe: async () => {
        probes += 1
        return { ok: true, commit: NEW, ref: 'main', transport: 'https' }
      },
    })
    await service.ready
    const third = sha('c')
    const started = await service.update('pkg', { expectedCommit: OLD, targetCommit: third })
    assert.equal(started.targetCommit, third)
    const job = await waitJob(service, started.jobId)
    assert.equal(job.status, 'done')
    assert.equal(probes, 0)
    assert.equal(manager.calls.install[0].spec, `github:owner/repo#${third}`)
    const view = await service.view('pkg')
    assert.equal(view.check.state, 'current')
    assert.equal(view.check.latest, third)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a confirmed target equal to the installed commit is refused as already latest', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const service = createService({ manager, profileDir: dir, config: resolveConfig({}), bootId: 'boot-a' })
    await service.ready
    await assert.rejects(() => service.update('pkg', { expectedCommit: OLD, targetCommit: OLD }), error => error.code === 'ALREADY_LATEST')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a probe that cannot read the installed commit reports unknown instead of behind', async () => {
  const dir = await makeProfile('pkg', '')
  try {
    // 锁文件里没有可解析的 commit。
    await writeFile(join(dir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      pkg:',
      '        specifier: github:owner/repo',
      '        version: link:../local-pkg',
      '',
      'packages:',
      '',
    ].join('\n'), 'utf8')
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    await service.ready
    const view = await service.check('pkg', { force: true })
    assert.equal(view.check.state, 'unknown')
    assert.equal(view.check.error.kind, 'no-commit')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
