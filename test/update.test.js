import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runUpdate, verifyInstall } from '../lib/update.js'

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
 * 造一个有锁文件、有已装包清单的 profile。
 */
async function makeProfile(name = 'pkg') {
  const dir = await mkdtemp(join(tmpdir(), 'gu-update-'))
  await mkdir(join(dir, 'node_modules', name), { recursive: true })
  await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({
    name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }), 'utf8')
  await writeFile(join(dir, 'pnpm-lock.yaml'), lockFor(name, OLD), 'utf8')
  return dir
}

/**
 * 造一个假插件管理器：安装时改写锁文件和包清单，模拟 pnpm 的结果。
 */
function fakeManager(profileDir, options = {}) {
  const calls = { remove: [], install: [] }
  return {
    calls,
    async removeBundle(name) {
      calls.remove.push(name)
      return options.removeResult ?? { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async installBundle(spec, installOptions = {}) {
      calls.install.push({ spec, options: installOptions })
      const commit = /#([0-9a-f]{40})/.exec(spec)?.[1] ?? OLD
      const target = options.installCommit ?? commit
      if (options.onInstall !== undefined) await options.onInstall(spec, installOptions)
      await writeFile(join(profileDir, 'pnpm-lock.yaml'), lockFor('pkg', target), 'utf8')
      await writeFile(join(profileDir, 'node_modules', 'pkg', 'package.json'), JSON.stringify({
        name: options.installedName ?? 'pkg',
        version: '2.0.0',
        ...(options.dropBundle === true ? {} : { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      }), 'utf8')
      return options.installResult ?? { changed: true, application: 'applied', stage: 'install', target: spec }
    },
  }
}

const source = {
  baseSpec: 'github:owner/repo', host: 'github.com', path: 'owner/repo', owner: 'owner', repo: 'repo', ref: 'main',
}
const previous = { version: '1.0.0', commit: OLD }

test('verifyInstall accepts a matching commit and bundle manifest', async () => {
  const dir = await makeProfile()
  try {
    const result = await verifyInstall(dir, 'pkg', OLD)
    assert.equal(result.ok, true)
    assert.equal(result.version, '1.0.0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verifyInstall rejects a missing bundle patch and a mismatched commit', async () => {
  const dir = await makeProfile()
  try {
    assert.equal((await verifyInstall(dir, 'pkg', NEW)).ok, false)
    await writeFile(join(dir, 'node_modules', 'pkg', 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }), 'utf8')
    const result = await verifyInstall(dir, 'pkg', OLD)
    assert.equal(result.ok, false)
    assert.match(result.problems.join('；'), /dsh\.bundle\.patch/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a successful update removes, installs a pinned spec and verifies', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir)
    const steps = []
    const result = await runUpdate({
      manager, profileDir: dir, name: 'pkg', source, enabled: true, previous,
      targetCommit: NEW, pinCommits: true, hmr: true, requestId: 'req-1',
      onStep: (step, message) => steps.push(step),
    })
    assert.deepEqual(manager.calls.remove, ['pkg'])
    assert.equal(manager.calls.install[0].spec, `github:owner/repo#${NEW}`)
    assert.equal(manager.calls.install[0].options.enabled, true)
    assert.equal(manager.calls.install[0].options.requestId, 'req-1')
    assert.equal(result.verified, true)
    assert.equal(result.application, 'applied')
    assert.deepEqual(steps, ['removing', 'installing', 'verifying'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pinCommits false keeps the branch spec', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, { installCommit: NEW })
    const result = await runUpdate({
      manager, profileDir: dir, name: 'pkg', source, enabled: false, previous,
      targetCommit: NEW, pinCommits: false, hmr: false, onStep: () => {},
    })
    assert.equal(manager.calls.install[0].spec, 'github:owner/repo')
    assert.equal(manager.calls.install[0].options.enabled, false)
    assert.deepEqual(manager.calls.remove, [])
    assert.equal(result.verified, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed install restores the previous pinned commit', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, {
      installResult: { changed: false, application: 'failed', stage: 'install', target: 'x', error: { code: 'operation-error', diagnostic: 'boom' } },
    })
    const result = await runUpdate({
      manager, profileDir: dir, name: 'pkg', source, enabled: true, previous,
      targetCommit: NEW, pinCommits: true, hmr: true, onStep: () => {},
    })
    assert.equal(result.verified, false)
    assert.equal(result.error.code, 'INSTALL_FAILED')
    assert.equal(manager.calls.install.length, 2)
    assert.equal(manager.calls.install[1].spec, `github:owner/repo#${OLD}`)
    assert.equal(result.restore.spec, `github:owner/repo#${OLD}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed verification restores the previous commit', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, { installCommit: OLD })
    const result = await runUpdate({
      manager, profileDir: dir, name: 'pkg', source, enabled: true, previous,
      targetCommit: NEW, pinCommits: true, hmr: true, onStep: () => {},
    })
    assert.equal(result.verified, false)
    assert.equal(result.error.code, 'VERIFY_FAILED')
    assert.equal(manager.calls.install[1].spec, `github:owner/repo#${OLD}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failure before installing anything does not restore', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, {
      removeResult: { changed: false, application: 'failed', stage: 'remove', target: 'pkg', error: { code: 'operation-error', diagnostic: 'locked' } },
    })
    const result = await runUpdate({
      manager, profileDir: dir, name: 'pkg', source, enabled: true, previous,
      targetCommit: NEW, pinCommits: true, hmr: true, onStep: () => {},
    })
    assert.equal(result.verified, false)
    assert.equal(result.error.code, 'REMOVE_FAILED')
    assert.equal(manager.calls.install.length, 0)
    assert.equal(result.restore, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancelling after removal reinstalls the previous version', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir)
    const controller = new AbortController()
    const result = await runUpdate({
      manager, profileDir: dir, name: 'pkg', source, enabled: true, previous,
      targetCommit: NEW, pinCommits: true, hmr: true, signal: controller.signal,
      onStep: step => { if (step === 'removing') controller.abort() },
    })
    assert.equal(result.verified, false)
    assert.equal(result.error.code, 'CANCELLED')
    assert.equal(manager.calls.install.length, 1)
    assert.equal(manager.calls.install[0].spec, `github:owner/repo#${OLD}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the result carries the restart reason and the steps are logged', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, {
      installResult: { changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'install', target: 'pkg' },
    })
    const steps = []
    const logs = []
    const result = await runUpdate({
      manager, profileDir: dir, name: 'pkg', source, enabled: true, previous,
      targetCommit: NEW, pinCommits: true, hmr: true,
      onStep: (step, message) => { steps.push({ step, message }) },
      onLog: (level, message) => { logs.push({ level, message }) },
    })
    assert.equal(result.verified, true)
    assert.equal(result.application, 'restart-required')
    assert.equal(result.restartReason, 'no-hmr')
    assert.deepEqual(steps.map(entry => entry.step), ['removing', 'installing', 'verifying'])
    assert.equal(logs.some(entry => entry.level === 'info' && entry.message.includes('安装结果')), true)
    assert.equal(logs.some(entry => entry.level === 'warn' && entry.message.includes('需要重启')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed install logs the diagnostic and the rollback', async () => {
  const dir = await makeProfile()
  try {
    const manager = fakeManager(dir, {
      installResult: { changed: false, application: 'failed', stage: 'install', target: 'x', error: { code: 'operation-error', diagnostic: 'boom' } },
    })
    const logs = []
    const result = await runUpdate({
      manager, profileDir: dir, name: 'pkg', source, enabled: true, previous,
      targetCommit: NEW, pinCommits: true, hmr: true,
      onStep: () => {},
      onLog: (level, message) => { logs.push({ level, message }) },
    })
    assert.equal(result.error.code, 'INSTALL_FAILED')
    assert.notEqual(result.restore, undefined)
    assert.equal(logs.some(entry => entry.level === 'error' && entry.message.includes('boom')), true)
    assert.equal(logs.some(entry => entry.level === 'warn' && entry.message.includes('已回滚')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
