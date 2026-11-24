/**
 * 读 profile 的 pnpm-lock.yaml，拿到一个依赖「实际装的是哪个 commit」。
 *
 * pnpm 对 Git 依赖会把解析结果记在 importers 段：
 *   dsh-quota-widget:
 *     specifier: github:Alone-show/dsh-quota-widget
 *     version: https://codeload.github.com/Alone-show/dsh-quota-widget/tar.gz/7bbbfe4...
 *
 * 这里只做只读文本解析，不引 YAML 库（bundle 以 link:/git 安装时不带第三方依赖）。
 */

/** 一个完整 commit 的 sha-1。 */
const FULL_COMMIT = /^[0-9a-f]{40}$/i

/**
 * 去掉 pnpm 记在 version 后面的 peer 后缀，如 `(ws@8.23.0)`。
 * @param {string} value version 字段。
 * @returns {string} 去掉后缀的值。
 */
function stripPeerSuffix(value) {
  return value.replace(/\([^)]*\)\s*$/, '').trim()
}

/**
 * 从一行 version 值里认出 commit。
 * @param {string} value 已去掉 peer 后缀的 version。
 * @returns {string | undefined} 40 位 commit，认不出时 undefined。
 */
export function commitFromVersion(value) {
  const text = stripPeerSuffix(String(value))
  const tarball = /\/tar\.gz\/([0-9a-f]{40})(?![0-9a-f])/i.exec(text)
  if (tarball !== null) return tarball[1].toLowerCase()
  const fragment = /#([0-9a-f]{40})(?![0-9a-f])/i.exec(text)
  if (fragment !== null) return fragment[1].toLowerCase()
  const bare = /^([0-9a-f]{40})$/i.exec(text)
  if (bare !== null) return bare[1].toLowerCase()
  return undefined
}

/**
 * 读 importers 段里每个依赖的 `specifier` / `version`。
 * @param {string} lockText pnpm-lock.yaml 全文。
 * @returns {Map<string, { specifier?: string, version?: string }>} 依赖名 → 记录。
 */
export function readImporterDependencies(lockText) {
  /** @type {Map<string, { specifier?: string, version?: string }>} */
  const result = new Map()
  if (typeof lockText !== 'string' || lockText === '') return result
  const lines = lockText.split(/\r?\n/)
  const start = lines.findIndex(line => line === 'importers:')
  if (start === -1) return result

  let depth = 0
  let current
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === 'packages:' || line === 'snapshots:' || line === 'settings:') break
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 2) {
      // importers 下的 key，通常只有 `.`；保留一层，但依赖都在它里面。
      depth = 1
      current = undefined
      continue
    }
    if (depth === 1 && indent === 4) {
      // importer 名（`.`），其下才是依赖。
      continue
    }
    if (indent === 6) {
      const match = /^\s{6}(\S.*):\s*$/.exec(line)
      current = match === null ? undefined : match[1].replace(/^['"]|['"]$/g, '')
      if (current !== undefined) result.set(current, result.get(current) ?? {})
      continue
    }
    if (current === undefined) continue
    const entry = /** @type {{ specifier?: string, version?: string }} */ (result.get(current))
    const specifier = /^\s+specifier:\s*(.+?)\s*$/.exec(line)
    if (specifier !== null) {
      entry.specifier = specifier[1]
      continue
    }
    const version = /^\s+version:\s*(.+?)\s*$/.exec(line)
    if (version !== null) entry.version = version[1]
  }
  return result
}

/**
 * 一个已装依赖的实际 commit。
 * @param {string} lockText pnpm-lock.yaml 全文。
 * @param {string} name 依赖名（profile manifest 的 key）。
 * @returns {undefined | { commit?: string, versionValue?: string, specifier?: string }} 记录。
 */
export function readInstalledEntry(lockText, name) {
  const dependencies = readImporterDependencies(lockText)
  const entry = dependencies.get(name)
  if (entry === undefined) return undefined
  return {
    commit: entry.version === undefined ? undefined : commitFromVersion(entry.version),
    versionValue: entry.version,
    specifier: entry.specifier,
  }
}

/**
 * 判断一个字符串是不是完整 commit。
 * @param {unknown} value 待查值。
 * @returns {boolean} 是否完整 commit。
 */
export function isCommit(value) {
  return typeof value === 'string' && FULL_COMMIT.test(value)
}
