import { strict as assert } from 'node:assert'
import test from 'node:test'
import { parseGitSource, pinnedSpec } from '../lib/git-source.js'

test('parses a GitHub shorthand without a ref', () => {
  const source = parseGitSource('github:Alone-show/dsh-quota-widget')
  assert.equal(source.host, 'github.com')
  assert.equal(source.path, 'Alone-show/dsh-quota-widget')
  assert.equal(source.owner, 'Alone-show')
  assert.equal(source.repo, 'dsh-quota-widget')
  assert.equal(source.ref, undefined)
  assert.equal(source.pinned, false)
  assert.equal(source.baseSpec, 'github:Alone-show/dsh-quota-widget')
  assert.equal(source.httpsUrl, 'https://github.com/Alone-show/dsh-quota-widget')
  assert.equal(source.sshUrl, 'git@github.com:Alone-show/dsh-quota-widget')
})

test('keeps a branch and recognises a pinned commit', () => {
  assert.equal(parseGitSource('github:Alone-show/wechat_wroklog#dsh-plugin').ref, 'dsh-plugin')
  const sha = 'a'.repeat(40)
  const pinned = parseGitSource(`github:owner/repo#${sha}`)
  assert.equal(pinned.pinned, true)
  assert.equal(pinned.ref, undefined)
  assert.equal(pinnedSpec(pinned, undefined), 'github:owner/repo')
  assert.equal(pinnedSpec(pinned, sha), `github:owner/repo#${sha}`)
})

test('parses git+https, plain https and scp-like addresses', () => {
  const https = parseGitSource('git+https://github.com/owner/repo.git#v1')
  assert.equal(https.host, 'github.com')
  assert.equal(https.path, 'owner/repo')
  assert.equal(https.ref, 'v1')

  const plain = parseGitSource('https://github.com/owner/repo')
  assert.equal(plain.path, 'owner/repo')

  const scp = parseGitSource('git@github.com:owner/repo.git')
  assert.equal(scp.host, 'github.com')
  assert.equal(scp.path, 'owner/repo')

  const ssh = parseGitSource('git+ssh://git@github.com/owner/repo.git#main')
  assert.equal(ssh.host, 'github.com')
  assert.equal(ssh.ref, 'main')
})

test('keeps GitLab subgroups', () => {
  const source = parseGitSource('gitlab:group/sub/repo#release')
  assert.equal(source.host, 'gitlab.com')
  assert.equal(source.path, 'group/sub/repo')
  assert.equal(source.owner, 'group')
  assert.equal(source.repo, 'sub')
  assert.equal(source.ref, 'release')
})

test('refuses non-Git specs', () => {
  for (const spec of [
    'dsh-quota-widget', '@local/dsh-kb', 'dsh-kb@1.2.3', 'dsh-kb@^1.0.0',
    'link:/home/my/Downloads/dsh-kb', 'file:../x', '/abs/path', './rel',
    'https://example.com/pkg-1.0.0.tgz', 'npm:other@1.0.0', 'workspace:*',
    '', undefined, null, 42,
  ]) {
    assert.equal(parseGitSource(spec), undefined, String(spec))
  }
})

test('treats a fragment with two refs as unsupported', () => {
  assert.equal(parseGitSource('github:owner/repo#a&b'), undefined)
  assert.equal(parseGitSource('github:owner/repo#main&path:sub').ref, 'main')
})
