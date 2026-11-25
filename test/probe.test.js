import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchForCommit, classifyFailure, gitEnv, matchRemoteRef, parseRemoteRefs, probeRefs, probeSource, runGit } from '../lib/probe.js'

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


test('parseRemoteRefs reads the default branch and every head', () => {
  const output = [
    'ref: refs/heads/main\tHEAD',
    '1111111111111111111111111111111111111111\tHEAD',
    '1111111111111111111111111111111111111111\trefs/heads/main',
    '2222222222222222222222222222222222222222\trefs/heads/dsh-plugin',
    '',
  ].join('\n')
  const listing = parseRemoteRefs(output)
  assert.equal(listing.head, '1'.repeat(40))
  assert.equal(listing.defaultBranch, 'main')
  assert.deepEqual(Array.from(listing.heads, head => head.name), ['main', 'dsh-plugin'])
})

test('branchForCommit finds the branch a pinned commit came from', () => {
  const listing = {
    defaultBranch: 'main',
    heads: [
      { name: 'main', commit: '1'.repeat(40) },
      { name: 'dsh-plugin', commit: '2'.repeat(40) },
      { name: 'mirror', commit: '2'.repeat(40) },
    ],
  }
  assert.equal(branchForCommit(listing, '2'.repeat(40)), 'dsh-plugin')
  assert.equal(branchForCommit(listing, '1'.repeat(40)), 'main')
  assert.equal(branchForCommit(listing, '3'.repeat(40)), undefined)
  assert.equal(branchForCommit(listing, undefined), undefined)
})

test('probeRefs answers an unsupported source instead of throwing', async () => {
  const result = await probeRefs(undefined, { cwd: tmpdir(), timeoutMs: 1000, sshFallback: true, command: 'git' })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unsupported')
})


/**
 * 造一个假的 git：按 URL 形态决定成功还是报哪种错，并把每次调用的参数记下来。
 * @param {string} dir 临时目录。
 * @param {{ https?: 'ok' | 'auth' | 'not-found', ssh?: 'ok' | 'auth' }} behavior 每种传输的行为。
 * @returns {Promise<{ command: string, calls: () => Promise<string[]> }>} 假 git。
 */
async function fakeGit(dir, behavior) {
  const sha = '1'.repeat(40)
  const script = [
    '#!/bin/sh',
    'log="$(dirname "$0")/calls.log"',
    'printf "%s\\n" "$*" >> "$log"',
    'case "$*" in',
    '  *git@*|*ssh://*)',
    behavior.ssh === 'ok'
      ? `    printf "%s\\tHEAD\\n%s\\trefs/heads/main\\n" "${sha}" "${sha}"; exit 0`
      : `    echo "git@github.com: Permission denied (publickey)." >&2; exit 128`,
    '    ;;',
    '  *)',
    behavior.https === 'ok'
      ? `    printf "%s\\tHEAD\\n" "${sha}"; exit 0`
      : behavior.https === 'not-found'
        ? `    echo "remote: Repository not found." >&2; echo "fatal: repository not found" >&2; exit 128`
        : `    echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2; exit 128`,
    '    ;;',
    'esac',
    '',
  ].join('\n')
  const command = join(dir, 'git')
  await writeFile(command, script, { encoding: 'utf8', mode: 0o755 })
  return {
    command,
    calls: async () => (await readFile(join(dir, 'calls.log'), 'utf8')).split('\n').filter(line => line !== ''),
  }
}

/** 一个最小可用的来源对象。 */
function source() {
  return {
    host: 'github.com',
    path: 'owner/repo',
    httpsUrl: 'https://github.com/owner/repo',
    sshUrl: 'git@github.com:owner/repo',
    ref: undefined,
    pinned: false,
  }
}

test('probeSource retries over SSH when GitHub hides a private repo as not-found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gu-probe-fake-'))
  try {
    const git = await fakeGit(dir, { https: 'not-found', ssh: 'ok' })
    const result = await probeSource(source(), { cwd: dir, timeoutMs: 5000, sshFallback: true, command: git.command })
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'ssh')
    // HTTPS 先失败一次，然后才换 SSH。
    assert.match((await git.calls())[0], /^.*https:\/\/github\.com/)
    assert.match((await git.calls())[1], /git@github\.com/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probeSource with a known-SSH repo tries SSH first and never touches HTTPS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gu-probe-fake-'))
  try {
    const git = await fakeGit(dir, { https: 'auth', ssh: 'ok' })
    const result = await probeSource(source(), {
      cwd: dir, timeoutMs: 5000, sshFallback: true, transport: 'ssh', command: git.command,
    })
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'ssh')
    const calls = await git.calls()
    assert.equal(calls.length, 1)
    assert.match(calls[0], /git@github\.com/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probeSource keeps HTTPS when it cannot read the repo for a non-credential reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gu-probe-fake-'))
  try {
    // not-found + SSH 也读不到：两边都失败，仍报出两种传输的原因。
    const git = await fakeGit(dir, { https: 'not-found', ssh: 'auth' })
    const result = await probeSource(source(), { cwd: dir, timeoutMs: 5000, sshFallback: true, command: git.command })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'auth')
    assert.match(result.message, /HTTPS：/)
    assert.match(result.message, /SSH：/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('probeRefs honours the known-SSH transport too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gu-probe-fake-'))
  try {
    const git = await fakeGit(dir, { https: 'auth', ssh: 'ok' })
    const result = await probeRefs(source(), {
      cwd: dir, timeoutMs: 5000, sshFallback: true, transport: 'ssh', command: git.command,
    })
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'ssh')
    // 假 git 不输出 --symref 的 ref: 行，所以这里只确认它走的是 SSH 而不是 HTTPS。
    const calls = await git.calls()
    assert.match(calls[0], /git@github\.com/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
