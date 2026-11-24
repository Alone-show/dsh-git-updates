import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyFailure, gitEnv, matchRemoteRef, probeSource, runGit } from '../lib/probe.js'

test('matchRemoteRef picks HEAD, branches, tags and peeled tags', () => {
  const output = [
    '1111111111111111111111111111111111111111\tHEAD',
    '1111111111111111111111111111111111111111\trefs/heads/main',
    '2222222222222222222222222222222222222222\trefs/tags/v1',
    '3333333333333333333333333333333333333333\trefs/tags/v1^{}',
    '',
  ].join('\n')
  assert.deepEqual(matchRemoteRef(output, undefined), {
    commit: '1111111111111111111111111111111111111111', ref: 'HEAD',
  })
  assert.deepEqual(matchRemoteRef(output, 'main'), {
    commit: '1111111111111111111111111111111111111111', ref: 'main',
  })
  // 注释标签要取 peeled 行（真正的 commit）。
  assert.deepEqual(matchRemoteRef(output, 'v1'), {
    commit: '3333333333333333333333333333333333333333', ref: 'v1',
  })
  assert.equal(matchRemoteRef('', 'main'), undefined)
  assert.equal(matchRemoteRef(output, 'nope'), undefined)
})

test('classifyFailure separates timeout, auth, network and not-found', () => {
  const base = { stdout: '', exitCode: 1, timedOut: false }
  assert.equal(classifyFailure({ ...base, timedOut: true, stderr: '' }), 'timeout')
  assert.equal(classifyFailure({ ...base, stderr: "fatal: could not read Username for 'https://github.com'" }), 'auth')
  assert.equal(classifyFailure({ ...base, stderr: 'ssh: Could not resolve hostname github.com' }), 'network')
  assert.equal(classifyFailure({ ...base, stderr: 'remote: Repository not found.' }), 'not-found')
  assert.equal(classifyFailure({ ...base, stderr: 'fatal: something odd' }), 'unknown')
})

test('gitEnv disables every interactive prompt', () => {
  const env = gitEnv({ PATH: '/usr/bin', HOME: '/home/x' })
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_ASKPASS, '')
  assert.equal(env.SSH_ASKPASS, '')
  assert.equal(env.LC_ALL, 'C')
  assert.equal(env.PATH, '/usr/bin')
})

test('runGit reads a local repository and enforces the deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gu-probe-'))
  try {
    const repo = join(dir, 'repo')
    execFileSync('git', ['init', '--bare', '--initial-branch=main', repo], { stdio: 'ignore' })
    const result = await runGit('git', ['ls-remote', '--', repo, 'HEAD'], { cwd: dir, timeoutMs: 10000 })
    // 空仓库没有 HEAD，但命令本身成功。
    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)

    const started = Date.now()
    const stopped = await runGit('sleep', ['5'], { cwd: dir, timeoutMs: 200 })
    assert.equal(stopped.timedOut, true)
    assert.ok(Date.now() - started < 4000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probeSource reports an unsupported source instead of throwing', async () => {
  const result = await probeSource(undefined, { cwd: tmpdir(), timeoutMs: 1000, sshFallback: true, command: 'git' })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unsupported')
})

test('probeSource maps every command failure to a probe result', async () => {
  const source = {
    host: 'github.com',
    path: 'owner/repo',
    httpsUrl: 'https://127.0.0.1:1/owner/repo',
    sshUrl: 'git@127.0.0.1:owner/repo',
    ref: 'main',
  }
  const result = await probeSource(source, { cwd: tmpdir(), timeoutMs: 3000, sshFallback: false, command: 'git' })
  assert.equal(result.ok, false)
  assert.equal(typeof result.message, 'string')
  assert.ok(result.kind !== undefined)
})
