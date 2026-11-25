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
    // 非 Git 来源的第三方插件只列出来（official 不算）；按包名排序。
    const others = await service.others()
    assert.deepEqual(others.map(item => item.package), ['local', 'reg'])
    assert.deepEqual(others.map(item => item.kind), ['link', 'registry'])
    assert.equal(others[1].version, '1.0.0')
    assert.equal(others[1].source, '^1.0.0')
    // 本工具自己不混进「其他插件」。
    const withSelf = createService({ manager, profileDir: dir, config: resolveConfig({}), ownPackage: 'reg' })
    assert.deepEqual((await withSelf.others()).map(item => item.package), ['local'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check records the upstream commit time and reuses it for the same commit', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const calls = []
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      // 时间来自一次性浅抓取；这里只验证「抓一次、记下来、同一 commit 复用」。
      commitTime: async (source, options) => {
        calls.push(options)
        return '2026-11-01T02:03:04.000Z'
      },
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    const first = await service.check('pkg', { force: true })
    assert.equal(first.check.latestAt, '2026-11-01T02:03:04.000Z')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].commit, NEW)
    assert.equal(calls[0].ref, 'main')
    const state = await readState(dir)
    assert.equal(state.packages.pkg.lastCheck.latestAt, '2026-11-01T02:03:04.000Z')
    // 同一个 commit：再强制检查也不重复抓时间，视图照样带着它。
    const again = await service.check('pkg', { force: true })
    assert.equal(again.check.latestAt, '2026-11-01T02:03:04.000Z')
    assert.equal(calls.length, 1)
    assert.equal((await service.view('pkg')).check.latestAt, '2026-11-01T02:03:04.000Z')
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
      commitTime: async () => undefined,
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

test('an unavailable commit time is recorded once and not retried for the same commit', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    let calls = 0
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      commitTime: async () => { calls += 1; return undefined },
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    const first = await service.check('pkg', { force: true })
    // 试过但读不到：记 null，页面显示 —，缓存不再因为缺时间而反复重查。
    assert.equal(first.check.latestAt, null)
    assert.equal(calls, 1)
    const again = await service.check('pkg', { force: true })
    assert.equal(again.check.latestAt, null)
    assert.equal(calls, 1)
    assert.equal((await service.view('pkg')).check.latestAt, null)
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
      commitTime: async () => undefined,
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
      commitTime: async () => undefined,
      hmr: true,
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    const started = await service.update('pkg', { expectedCommit: OLD })
    const job = await waitJob(service, started.jobId)
    assert.equal(job.status, 'done')
    assert.equal(job.result.verified, true)
    assert.equal(manager.calls.install[0].spec, `pkg@github:owner/repo#${NEW}`)
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
      commitTime: async () => undefined,
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    await assert.rejects(() => service.update('pkg', { expectedCommit: NEW }), error => error.code === 'STALE_VIEW')

    const currentService = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      commitTime: async () => undefined,
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
      commitTime: async () => undefined,
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
      commitTime: async () => undefined,
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
      commitTime: async () => undefined,
      hmr: true,
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'https' }),
    })
    service.cancel({ jobId: 'missing' })
    assert.equal(manager.calls.cancelled, undefined)

    const started = await service.update('pkg', {})
    const cancelled = service.cancel({ jobId: started.jobId })
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
      commitTime: async () => undefined,
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
      commitTime: async () => undefined,
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
      commitTime: async () => undefined,
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
      commitTime: async () => undefined,
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
      commitTime: async () => undefined,
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
      commitTime: async () => undefined,
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
    await recordCheck(dir, 'pkg', { at: new Date().toISOString(), state: 'current', latest: OLD, latestAt: '2026-11-01T00:00:00.000Z' })
    const fresh = await service.view('pkg')
    assert.equal(fresh.check.stale, false)
    // 老状态文件：记了上游 commit 却没有提交时间，缓存再新也要重查一次把时间补齐。
    await recordCheck(dir, 'pkg', { at: new Date().toISOString(), state: 'current', latest: OLD })
    assert.equal((await service.view('pkg')).check.stale, true)
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
      commitTime: async () => undefined,
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
    assert.equal(manager.calls.install[0].spec, `pkg@github:owner/repo#${third}`)
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
      commitTime: async () => undefined,
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

test('a lockfile resolved over SSH makes the update install through SSH', async () => {
  const dir = await makeProfile()
  try {
    // 模拟 pnpm 对私有仓库的落盘：importers 里是 git+ssh 地址。
    await writeFile(join(dir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      pkg:',
      '        specifier: github:owner/repo#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      `        version: git+ssh://git@github.com/owner/repo.git#${OLD}`,
      '',
      'packages:',
      '',
    ].join('\n'), 'utf8')
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      commitTime: async () => undefined,
      hmr: true,
      probe: async () => ({ ok: true, commit: NEW, ref: 'main', transport: 'ssh' }),
    })
    await service.ready
    const view = (await service.list())[0]
    assert.equal(view.installed.transport, 'ssh')
    const started = await service.update('pkg', { expectedCommit: OLD, targetCommit: NEW })
    await waitJob(service, started.jobId)
    assert.equal(
      manager.calls.install[0].spec,
      `pkg@git+ssh://git@github.com/owner/repo.git#${NEW}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a pinned spec discovers the branch its installed commit belongs to', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg', `github:owner/repo#${OLD}`)])
    let listed = 0
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      commitTime: async () => undefined,
      probeRefs: async () => {
        listed += 1
        return {
          ok: true,
          head: NEW,
          defaultBranch: 'main',
          heads: [{ name: 'main', commit: NEW }, { name: 'dsh-plugin', commit: OLD }],
          transport: 'ssh',
        }
      },
      probe: async () => { throw new Error('不应该按 HEAD 探测') },
    })
    await service.ready
    const view = await service.check('pkg', { force: true })
    assert.equal(listed, 1)
    assert.equal(view.check.ref, 'dsh-plugin')
    assert.equal(view.check.state, 'current')
    assert.equal(view.check.latest, OLD)
    const state = await readState(dir)
    assert.equal(state.packages.pkg.trackedRef, 'dsh-plugin')
    // 之后的视图直接显示真实跟踪分支。
    assert.equal((await service.view('pkg')).ref, 'dsh-plugin')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('without a matching branch or configured ref, discovery falls back to HEAD', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg', `github:owner/repo#${OLD}`)])
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      commitTime: async () => undefined,
      probeRefs: async () => ({
        ok: true,
        head: NEW,
        defaultBranch: 'main',
        heads: [{ name: 'main', commit: NEW }, { name: 'dsh-plugin', commit: 'c'.repeat(40) }],
        transport: 'https',
      }),
    })
    await service.ready
    const view = await service.check('pkg', { force: true })
    assert.equal(view.check.ref, 'HEAD')
    assert.equal(view.check.state, 'behind')
    assert.equal(view.check.latest, NEW)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a configured trackedRef overrides HEAD for a pinned spec', async () => {
  const dir = await makeProfile()
  const latest = 'c'.repeat(40)
  try {
    const manager = fakeManager(dir, [bundleFor('pkg', `github:owner/repo#${OLD}`)])
    const seen = []
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({ trackedRefs: { pkg: 'dsh-plugin' } }),
      commitTime: async () => undefined,
      probe: async (source, options) => {
        seen.push(options.ref)
        return { ok: true, commit: latest, ref: options.ref, transport: 'ssh' }
      },
    })
    await service.ready
    const view = await service.check('pkg', { force: true })
    assert.deepEqual(seen, ['dsh-plugin'])
    assert.equal(view.check.ref, 'dsh-plugin')
    assert.equal(view.check.state, 'behind')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * 造一个能同时装两个包的临时 profile。
 * @returns {Promise<string>} 目录。
 */
async function makeTwoPackageProfile() {
  const dir = await mkdtemp(join(tmpdir(), 'gu-concurrent-'))
  for (const name of ['pkg', 'pkg2']) {
    await mkdir(join(dir, 'node_modules', name), { recursive: true })
    await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({
      name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }), 'utf8')
  }
  const lock = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      pkg:',
    '        specifier: github:owner/pkg',
    `        version: https://codeload.github.com/owner/pkg/tar.gz/${OLD}`,
    '      pkg2:',
    '        specifier: github:owner/pkg2',
    `        version: https://codeload.github.com/owner/pkg2/tar.gz/${OLD}`,
    '',
    'packages:',
    '',
  ].join('\n')
  await writeFile(join(dir, 'pnpm-lock.yaml'), lock, 'utf8')
  return dir
}

/**
 * 同时管理两个包的假插件管理器。
 * @param {string} dir profile 目录。
 * @param {Map<string, Promise<void>>} gates 包名 → 安装闸门。
 * @returns {any} 假管理器。
 */
function multiManager(dir, gates) {
  const calls = { remove: [], install: [], cancelled: [], commits: new Map([['pkg', OLD], ['pkg2', OLD]]) }
  const installed = new Set(['pkg', 'pkg2'])
  const lock = () => [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    ...['pkg', 'pkg2'].flatMap(name => [
      `      ${name}:`,
      `        specifier: github:owner/${name}`,
      `        version: https://codeload.github.com/owner/${name}/tar.gz/${calls.commits.get(name)}`,
    ]),
    '',
    'packages:',
    '',
  ].join('\n')
  return {
    calls,
    async listBundles() {
      return [...installed].map(name => bundleFor(name, `github:owner/${name}`))
    },
    async removeBundle(name) {
      calls.remove.push(name)
      installed.delete(name)
      return { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async installBundle(spec, options = {}) {
      const name = spec.startsWith('pkg2@') ? 'pkg2' : 'pkg'
      calls.install.push({ name, spec, options })
      const gate = gates.get(name)
      if (gate !== undefined) await gate
      const commit = /#([0-9a-f]{40})/.exec(spec)?.[1] ?? OLD
      calls.commits.set(name, commit)
      installed.add(name)
      await writeFile(join(dir, 'pnpm-lock.yaml'), lock(), 'utf8')
      await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({
        name, version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
      }), 'utf8')
      return { changed: true, application: 'applied', stage: 'install', target: spec }
    },
    async cancelInstall(requestId) {
      calls.cancelled.push(requestId)
      return { status: 'cancelled' }
    },
  }
}

test('two different plugins update at the same time', async () => {
  const dir = await makeTwoPackageProfile()
  const gates = new Map()
  for (const name of ['pkg', 'pkg2']) {
    let release
    gates.set(name, new Promise(resolve => { release = resolve }))
    gates.set(`${name}:release`, release)
  }
  try {
    const manager = multiManager(dir, gates)
    const service = createService({
      manager, profileDir: dir, config: resolveConfig({ maxConcurrentUpdates: 3 }), hmr: true,
    })
    await service.ready
    const first = await service.update('pkg', { expectedCommit: OLD, targetCommit: NEW })
    const second = await service.update('pkg2', { expectedCommit: OLD, targetCommit: 'd'.repeat(40) })
    assert.equal(service.activeJobs().length, 2)
    // 同一个包仍只允许一个任务。
    await assert.rejects(
      () => service.update('pkg', { expectedCommit: OLD, targetCommit: NEW }),
      error => error.code === 'JOB_RUNNING',
    )
    gates.get('pkg:release')()
    gates.get('pkg2:release')()
    const [jobA, jobB] = await Promise.all([
      waitJob(service, first.jobId),
      waitJob(service, second.jobId),
    ])
    assert.equal(jobA.result.verified, true)
    assert.equal(jobB.result.verified, true)
    assert.equal(service.activeJobs().length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a concurrency limit and targeted cancel only affect their own job', async () => {
  const dir = await makeTwoPackageProfile()
  let releaseA
  let releaseB
  const gates = new Map([
    ['pkg', new Promise(resolve => { releaseA = resolve })],
    ['pkg2', new Promise(resolve => { releaseB = resolve })],
  ])
  try {
    const manager = multiManager(dir, gates)
    const service = createService({
      manager, profileDir: dir, config: resolveConfig({ maxConcurrentUpdates: 1 }), hmr: true,
    })
    await service.ready
    const first = await service.update('pkg', { expectedCommit: OLD, targetCommit: NEW })
    await assert.rejects(
      () => service.update('pkg2', { expectedCommit: OLD, targetCommit: 'd'.repeat(40) }),
      error => error.code === 'JOB_LIMIT',
    )
    releaseA()
    await waitJob(service, first.jobId)
    releaseB()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancelling one job leaves the other running', async () => {
  const dir = await makeTwoPackageProfile()
  let releaseA
  let releaseB
  const gates = new Map([
    ['pkg', new Promise(resolve => { releaseA = resolve })],
    ['pkg2', new Promise(resolve => { releaseB = resolve })],
  ])
  try {
    const manager = multiManager(dir, gates)
    const service = createService({
      manager, profileDir: dir, config: resolveConfig({ maxConcurrentUpdates: 3 }), hmr: true,
    })
    await service.ready
    const first = await service.update('pkg', { expectedCommit: OLD, targetCommit: NEW })
    const second = await service.update('pkg2', { expectedCommit: OLD, targetCommit: 'd'.repeat(40) })
    const cancelled = service.cancel({ jobId: first.jobId })
    assert.equal(cancelled.cancelled, true)
    assert.equal(manager.calls.cancelled.length, 1)
    assert.equal(service.job(second.jobId).status, 'running')
    releaseA()
    releaseB()
    await Promise.all([waitJob(service, first.jobId), waitJob(service, second.jobId)])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('once a repo is known to need SSH, later checks and updates keep using SSH', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, [bundleFor('pkg')])
    const probed = []
    const service = createService({
      manager,
      profileDir: dir,
      config: resolveConfig({}),
      commitTime: async () => undefined,
      hmr: true,
      probe: async (source, options) => {
        probed.push(options.transport ?? 'https')
        return { ok: true, commit: NEW, ref: 'main', transport: 'ssh' }
      },
    })
    await service.ready

    // 第一次检查只读得到 SSH：锁文件是 HTTPS tarball 形态，也要把结论记成粘性的。
    await service.check('pkg', { force: true })
    assert.equal((await readState(dir)).packages.pkg.transport, 'ssh')

    // 客户端带上目标 commit 时不会重新探测；安装仍必须走 SSH，而不是 HTTPS 简写。
    const started = await service.update('pkg', { expectedCommit: OLD, targetCommit: NEW })
    await waitJob(service, started.jobId)
    assert.equal(manager.calls.install[0].spec, `pkg@git+ssh://git@github.com/owner/repo.git#${NEW}`)

    // 更新成功后仍然记着「只能走 SSH」，下次检查直接先走 SSH。
    const state = await readState(dir)
    assert.equal(state.packages.pkg.transport, 'ssh')
    assert.equal(state.packages.pkg.lastCheck.transport, 'ssh')
    await service.check('pkg', { force: true })
    assert.equal(probed.at(-1), 'ssh')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
