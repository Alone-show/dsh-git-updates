import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mutatePackageState, readState, recordCheck, stateFile, writeState } from '../lib/state.js'

async function tempProfile() {
  return mkdtemp(join(tmpdir(), 'gu-state-'))
}

test('missing state reads as empty', async () => {
  const dir = await tempProfile()
  try {
    assert.deepEqual(await readState(dir), { version: 1, packages: {} })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writes are atomic, private and readable again', async () => {
  const dir = await tempProfile()
  try {
    await writeState(dir, { version: 1, packages: { pkg: { lastCheck: { at: 'now' } } } })
    const file = stateFile(dir)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.deepEqual(await readState(dir), { version: 1, packages: { pkg: { lastCheck: { at: 'now' } } } })
    assert.match(await readFile(file, 'utf8'), /"at": "now"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt or version-mismatched file reads as empty', async () => {
  const dir = await tempProfile()
  try {
    await writeState(dir, { version: 1, packages: { pkg: {} } })
    const file = stateFile(dir)
    await import('node:fs/promises').then(fs => fs.writeFile(file, '{not json', 'utf8'))
    assert.deepEqual(await readState(dir), { version: 1, packages: {} })
    await import('node:fs/promises').then(fs => fs.writeFile(file, JSON.stringify({ version: 99, packages: { x: 1 } }), 'utf8'))
    assert.deepEqual(await readState(dir), { version: 1, packages: {} })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mutatePackageState and recordCheck keep other entries', async () => {
  const dir = await tempProfile()
  try {
    await mutatePackageState(dir, 'a', () => ({ ref: 'main' }))
    await recordCheck(dir, 'a', { at: 't1', state: 'behind', latest: 'b'.repeat(40) })
    await mutatePackageState(dir, 'b', current => ({ ...current, ref: 'dev' }))
    const state = await readState(dir)
    assert.equal(state.packages.a.ref, 'main')
    assert.equal(state.packages.a.lastCheck.state, 'behind')
    assert.equal(state.packages.b.ref, 'dev')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parallel mutations for different packages do not overwrite each other', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gu-state-'))
  try {
    const names = ['a', 'b', 'c', 'd', 'e']
    await Promise.all(names.map(name => recordCheck(dir, name, {
      at: new Date().toISOString(), state: 'behind', latest: 'b'.repeat(40),
    })))
    const state = await readState(dir)
    for (const name of names) assert.equal(state.packages[name].lastCheck.state, 'behind')
    assert.equal(Object.keys(state.packages).length, names.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
