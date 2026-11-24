import { strict as assert } from 'node:assert'
import test from 'node:test'
import { commitFromVersion, isCommit, readImporterDependencies, readInstalledEntry } from '../lib/lockfile.js'

const LOCK = [
  "lockfileVersion: '9.0'",
  '',
  'settings:',
  '  autoInstallPeers: false',
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      dsh-quota-widget:',
  '        specifier: github:Alone-show/dsh-quota-widget',
  '        version: https://codeload.github.com/Alone-show/dsh-quota-widget/tar.gz/7bbbfe44be018feefbadce000b7a1dd472d8a94c',
  '      dsh-codex-connect:',
  '        specifier: github:franksong2702/dsh-codex-connect',
  '        version: https://codeload.github.com/franksong2702/dsh-codex-connect/tar.gz/ada191aa960b80a1c26472d37a64438c66173e07(ws@8.23.0)',
  '      plain:',
  '        specifier: ^1.0.0',
  '        version: 1.2.3',
  '',
  'packages:',
  '',
  '  dsh-quota-widget@https://codeload.github.com/x/y/tar.gz/ffffffffffffffffffffffffffffffffffffffff:',
  '    resolution: {integrity: sha512-abc}',
].join('\n')

test('reads every importer dependency and its version value', () => {
  const dependencies = readImporterDependencies(LOCK)
  assert.equal(dependencies.size, 3)
  assert.equal(dependencies.get('dsh-quota-widget').specifier, 'github:Alone-show/dsh-quota-widget')
  assert.equal(dependencies.get('plain').version, '1.2.3')
})

test('extracts commits from codeload tarball URLs, peer suffixes and fragments', () => {
  assert.equal(commitFromVersion(
    'https://codeload.github.com/o/r/tar.gz/7bbbfe44be018feefbadce000b7a1dd472d8a94c',
  ), '7bbbfe44be018feefbadce000b7a1dd472d8a94c')
  assert.equal(commitFromVersion(
    'https://codeload.github.com/o/r/tar.gz/ada191aa960b80a1c26472d37a64438c66173e07(ws@8.23.0)',
  ), 'ada191aa960b80a1c26472d37a64438c66173e07')
  assert.equal(commitFromVersion(
    'git+ssh://git@github.com/Alone-show/mdm-ssh.git#dsh-plugin',
  ), undefined)
  assert.equal(commitFromVersion('1.2.3'), undefined)
})

test('readInstalledEntry reports the resolved commit', () => {
  const entry = readInstalledEntry(LOCK, 'dsh-codex-connect')
  assert.equal(entry.commit, 'ada191aa960b80a1c26472d37a64438c66173e07')
  assert.equal(entry.specifier, 'github:franksong2702/dsh-codex-connect')
  assert.equal(readInstalledEntry(LOCK, 'plain').commit, undefined)
  assert.equal(readInstalledEntry(LOCK, 'missing'), undefined)
})

test('ignores a lockfile without an importers section', () => {
  assert.equal(readImporterDependencies('').size, 0)
  assert.equal(readImporterDependencies('packages: {}').size, 0)
})

test('isCommit checks full sha only', () => {
  assert.equal(isCommit('a'.repeat(40)), true)
  assert.equal(isCommit('A'.repeat(40)), true)
  assert.equal(isCommit('a'.repeat(39)), false)
  assert.equal(isCommit(undefined), false)
})
