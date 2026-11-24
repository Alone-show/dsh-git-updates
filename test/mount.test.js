import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTE_PATH } from '../lib/route.js'
import { apply } from '../index.js'

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

/**
 * 造一个可挂载的临时 profile。
 * @returns {Promise<string>} profile 目录。
 */
async function makeProfile() {
  const dir = await mkdtemp(join(tmpdir(), 'gu-mount-'))
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'pkg', 'package.json'), JSON.stringify({
    name: 'pkg', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }), 'utf8')
  await writeFile(join(dir, 'pnpm-lock.yaml'), lockFor('pkg', OLD), 'utf8')
  return dir
}

/**
 * 造一个只实现本插件用到的面的宿主上下文。
 * @param {string} profileDir profile 目录。
 * @param {any} manager 假插件管理器。
 * @param {any[]} disposers 收集 effect 清理函数。
 * @returns {any} 上下文。
 */
function fakeContext(profileDir, manager, disposers) {
  const ctx = {
    profileContext: { dir: profileDir },
    pluginManager: manager,
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    effect: callback => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject: (_services, callback) => { callback(ctx) },
    connection: { fetch: { register: route => { ctx.route = route; return () => {} } } },
  }
  return ctx
}

function bundle() {
  return {
    name: 'pkg',
    version: '1.0.0',
    installed: true,
    availability: 'profile',
    official: false,
    enabled: true,
    source: 'github:owner/repo',
    rows: [],
  }
}

test('mounting registers the route, serves a view and reconciles the restart marker', async () => {
  const dir = await makeProfile()
  const disposers = []
  try {
    // 上一个宿主进程留下的待重启标记。
    await mkdir(join(dir, '.git-updates'), { recursive: true })
    await writeFile(join(dir, '.git-updates', 'state.json'), JSON.stringify({
      version: 1,
      packages: {
        pkg: {
          lastUpdate: { at: new Date().toISOString(), from: { commit: OLD }, to: { commit: NEW }, verified: true, application: 'restart-required' },
          restartPending: { commit: NEW, at: new Date().toISOString(), bootId: 'previous-boot' },
        },
      },
    }), 'utf8')

    const manager = {
      async listBundles() { return [bundle()] },
    }
    const ctx = fakeContext(dir, manager, disposers)
    await apply(ctx, { backgroundCheckMs: 0 })
    assert.equal(typeof ctx.route, 'object')
    assert.equal(ctx.route.path, ROUTE_PATH)

    const response = await ctx.route.fetch(new Request(`http://localhost${ROUTE_PATH}?package=pkg`))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.package.applicable, true)
    assert.equal(body.package.installed.commit, OLD)
    // 启动对账已经把上一进程的待重启标记清掉。
    assert.equal(body.package.pendingRestart, undefined)
    assert.equal(typeof body.package.lastUpdate.restartedAt, 'string')

    const state = JSON.parse(await readFile(join(dir, '.git-updates', 'state.json'), 'utf8'))
    assert.equal(state.packages.pkg.restartPending, undefined)
  } finally {
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') dispose()
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test('mounting schedules the background sweep when it is enabled', async () => {
  const dir = await makeProfile()
  const disposers = []
  const timers = []
  const originalSetTimeout = globalThis.setTimeout
  const originalSetInterval = globalThis.setInterval
  try {
    globalThis.setTimeout = (callback, delay, ...rest) => {
      const handle = originalSetTimeout(callback, delay, ...rest)
      timers.push({ kind: 'timeout', delay })
      return handle
    }
    globalThis.setInterval = (callback, delay, ...rest) => {
      const handle = originalSetInterval(callback, delay, ...rest)
      timers.push({ kind: 'interval', delay })
      return handle
    }
    const ctx = fakeContext(dir, { async listBundles() { return [bundle()] } }, disposers)
    await apply(ctx, { backgroundCheckMs: 3600000, backgroundCheckStartMs: 5000 })
    assert.equal(timers.some(timer => timer.kind === 'timeout' && timer.delay === 5000), true)
    assert.equal(timers.some(timer => timer.kind === 'interval' && timer.delay === 3600000), true)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.setInterval = originalSetInterval
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') dispose()
    }
    await rm(dir, { recursive: true, force: true })
  }
})
