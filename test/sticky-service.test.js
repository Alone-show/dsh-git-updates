import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { createService } from '../lib/service.js'
import { mergeSticky } from '../lib/sticky.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'gu-sticky-'))
  await mkdir(join(dir, 'node_modules', name), { recursive: true })
  await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({
    name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }), 'utf8')
  await writeFile(join(dir, 'pnpm-lock.yaml'), lockFor(name, commit), 'utf8')
  return dir
}

function bundle(name = 'pkg') {
  return {
    name,
    version: '1.0.0',
    installed: true,
    availability: 'profile',
    official: false,
    enabled: true,
    removable: true,
    source: 'github:owner/repo',
    rows: [],
    overrides: [],
  }
}

/**
 * 会「卸载后从 listBundles 消失」的假插件管理器。
 * @param {string} dir profile 目录。
 * @param {{ gate?: Promise<void>, failInstall?: boolean }} [options] 行为。
 * @returns {any} 假管理器。
 */
function fakeManager(dir, options = {}) {
  const calls = { remove: 0, install: [], cancelled: 0 }
  let installed = true
  return {
    calls,
    async listBundles() {
      return installed ? [bundle()] : []
    },
    async removeBundle(name) {
      calls.remove += 1
      installed = false
      return { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async installBundle(spec, installOptions = {}) {
      calls.install.push({ spec, options: installOptions })
      if (options.gate !== undefined) await options.gate
      if (options.failInstall === true) {
        return {
          changed: false, application: 'failed', stage: 'install', target: spec,
          error: { code: 'INSTALL_FAILED', diagnostic: 'pnpm failed' },
        }
      }
      const commit = /#([0-9a-f]{40})/.exec(spec)?.[1] ?? OLD
      await writeFile(join(dir, 'pnpm-lock.yaml'), lockFor('pkg', commit), 'utf8')
      await writeFile(join(dir, 'node_modules', 'pkg', 'package.json'), JSON.stringify({
        name: 'pkg', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
      }), 'utf8')
      installed = true
      return { changed: true, application: 'applied', stage: 'install', target: spec }
    },
    async cancelInstall() {
      calls.cancelled += 1
      return { status: 'cancelled' }
    },
  }
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function waitJob(service, id) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = service.job(id)
    if (job !== undefined && job.status !== 'running' && job.status !== 'cancelling') return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('job did not settle')
}

test('the updated package keeps its row while it is uninstalled', async () => {
  const dir = await makeProfile()
  let release
  const gate = new Promise(resolve => { release = resolve })
  try {
    const manager = fakeManager(dir, { gate })
    const service = createService({ manager, profileDir: dir, config: resolveConfig({}), hmr: true })
    await service.ready
    assert.equal((await service.list()).length, 1)

    const started = await service.update('pkg', { expectedCommit: OLD, targetCommit: NEW })
    await waitFor(() => manager.calls.install.length === 1, 'installation to start')

    // 包已经被卸载，listBundles() 里没有它了，但页面必须还看得到这一行。
    const during = await service.list()
    assert.equal(during.length, 1)
    assert.equal(during[0].package, 'pkg')
    assert.equal(during[0].sticky, true)
    assert.equal(during[0].installedMissing, true)
    assert.equal(during[0].job.status, 'running')
    assert.equal(during[0].job.step, 'installing')
    assert.equal(during[0].installed.commit, OLD)
    // 前端侧的兜底合并也能保住这一行。
    assert.deepEqual(mergeSticky(during, [], { now: Date.now() }).map(row => row.package), ['pkg'])

    // 宿主流式日志进入任务视图。
    const requestId = manager.calls.install[0].options.requestId
    assert.equal(typeof requestId, 'string')
    service.onInstallLog({ requestId, stream: 'stdout', text: 'Resolving dependencies\nDone in 3s' })
    service.onInstallState({ requestId, phase: 'applying' })
    const running = service.job(started.jobId)
    assert.equal(running.logs.some(entry => entry.message === 'Resolving dependencies'), true)
    assert.equal(running.logs.some(entry => entry.message === 'Done in 3s'), true)
    assert.equal(running.logs.some(entry => entry.message.includes('应用')), true)

    release()
    const job = await waitJob(service, started.jobId)
    assert.equal(job.status, 'done')
    assert.equal(job.result.verified, true)
    assert.equal(job.steps.every(step => step.status === 'done'), true)

    const after = await service.list()
    assert.equal(after.length, 1)
    assert.equal(after[0].sticky, undefined)
    assert.equal(after[0].installed.commit, NEW)
    assert.equal(after[0].job.status, 'done')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed rollback keeps the row with an explicit not-installed state', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, { failInstall: true })
    const service = createService({ manager, profileDir: dir, config: resolveConfig({}), hmr: true })
    await service.ready
    const started = await service.update('pkg', { expectedCommit: OLD, targetCommit: NEW })
    const job = await waitJob(service, started.jobId)
    assert.equal(job.status, 'failed')
    assert.equal(job.result.restore.application, 'failed')

    const rows = await service.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].package, 'pkg')
    assert.equal(rows[0].sticky, true)
    assert.equal(rows[0].installedMissing, true)
    assert.equal(rows[0].job.status, 'failed')
    assert.equal(rows[0].job.result.restore.application, 'failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('this tool refuses to update itself and marks its own row', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir)
    const service = createService({
      manager, profileDir: dir, config: resolveConfig({}), ownPackage: 'pkg',
    })
    await service.ready
    const rows = await service.list()
    assert.equal(rows[0].self, true)
    await assert.rejects(
      () => service.update('pkg', { expectedCommit: OLD, targetCommit: NEW }),
      error => error.code === 'SELF_UPDATE',
    )
    assert.equal(manager.calls.remove, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a job starts with the four steps and records timings and logs', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir)
    const service = createService({ manager, profileDir: dir, config: resolveConfig({}), hmr: true })
    await service.ready
    const started = await service.update('pkg', { expectedCommit: OLD, targetCommit: NEW })
    const job = await waitJob(service, started.jobId)
    assert.equal(job.steps.length, 4)
    assert.equal(job.steps.every(step => step.status === 'done'), true)
    assert.equal(typeof job.elapsedMs, 'number')
    assert.equal(job.logs.some(entry => entry.message.includes('更新完成')), true)
    assert.equal(job.logs.some(entry => entry.message.includes('卸载')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
