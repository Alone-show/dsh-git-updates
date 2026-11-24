/**
 * 读一个已安装依赖的保存 spec，拆出 Git 仓库地址、跟踪的 ref、是否已钉 commit。
 *
 * 支持 pnpm 认的几种写法：
 *   github:owner/repo#main          gitlab: / bitbucket: / gist: 同形
 *   git+https://host/owner/repo.git#v1
 *   https://github.com/owner/repo
 *   git@github.com:owner/repo.git   git+ssh://git@host/owner/repo
 *
 * registry 名、tarball、file:/link:/workspace: 一律返回 undefined——本插件只管 Git。
 */

/** pnpm 的宿主简写。 */
const SHORTHANDS = Object.freeze({
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  gist: 'gist.github.com',
})

/** 一个完整 commit 的 sha-1；fragment 里是这个形状就当「已钉住」，不再当 ref。 */
const FULL_COMMIT = /^[0-9a-f]{40}$/i

/** 不是 Git 来源的前缀。 */
const NON_GIT = /^(?:file|link|workspace|catalog|npm|jsr):/i

/** tarball spec：.tgz / .tar.gz，可能带 fragment。 */
const TARBALL = /\.(?:tgz|tar\.gz)(?:[#?].*)?$/i

/** 带协议的地址。 */
const PROTOCOL = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * 规范仓库路径：去掉首尾斜杠、结尾 `.git`，保留多段（GitLab 子组）。
 * @param {string} value URL 的 pathname 或简写后面的部分。
 * @returns {string} 规范后的路径；`''` 表示不像仓库。
 */
function normalizePath(value) {
  return String(value)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
}

/**
 * 解析一个保存的依赖 spec。
 * @param {unknown} spec profile manifest 里记录的值，或 detail 页展示的 source。
 * @returns {undefined | {
 *   kind: 'git', host: string, path: string, owner: string, repo: string,
 *   ref: string | undefined, pinned: boolean, baseSpec: string,
 *   httpsUrl: string, sshUrl: string, compareUrl: string | undefined,
 * }} Git 来源的解析结果；不是 Git 时返回 undefined。
 */
export function parseGitSource(spec) {
  if (typeof spec !== 'string') return undefined
  const text = spec.trim()
  if (text === '' || NON_GIT.test(text) || TARBALL.test(text)) return undefined
  // 相对/绝对路径不是 Git。
  if (text.startsWith('/') || /^\.{0,2}[\\/]/.test(text)) return undefined

  const hash = text.indexOf('#')
  const address = hash === -1 ? text : text.slice(0, hash)
  const fragment = hash === -1 ? '' : text.slice(hash + 1)
  if (address === '') return undefined

  let host
  let path
  const shorthand = /^([a-z]+):(.+)$/i.exec(address)
  if (shorthand !== null && Object.hasOwn(SHORTHANDS, shorthand[1].toLowerCase())) {
    host = SHORTHANDS[shorthand[1].toLowerCase()]
    path = normalizePath(shorthand[2])
  } else if (!PROTOCOL.test(address) && /^[^@/\s]+@[^:/\s]+:/.test(address)) {
    const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(address)
    if (scp === null) return undefined
    host = scp[1].toLowerCase()
    path = normalizePath(scp[2])
  } else if (/^(?:git\+)?(?:https?|ssh):\/\//i.test(address)) {
    let url
    try {
      url = new URL(address.replace(/^git\+/i, ''))
    } catch {
      return undefined
    }
    host = url.host.toLowerCase()
    path = normalizePath(decodeURIComponent(url.pathname))
  } else {
    return undefined
  }

  const segments = path.split('/').filter(segment => segment !== '')
  if (host === '' || segments.length < 2) return undefined

  // fragment 里只认一个非 `path:` 参数当 ref；`#ref&path:sub` 这种也兼容。
  const parameters = fragment.split('&').filter(part => part !== '' && !part.startsWith('path:'))
  if (parameters.length > 1) return undefined
  const raw = parameters[0] === undefined ? '' : decodeURIComponent(parameters[0])
  const pinned = FULL_COMMIT.test(raw)
  const ref = pinned || raw === '' ? undefined : raw

  const owner = segments[0]
  const repo = segments[1]
  const ownerPath = segments.join('/')
  const baseSpec = address
  return {
    kind: 'git',
    host,
    path: ownerPath,
    owner,
    repo,
    ref,
    pinned,
    baseSpec,
    httpsUrl: `https://${host}/${ownerPath}`,
    sshUrl: `git@${host}:${ownerPath}`,
    compareUrl: host === 'github.com' ? `https://github.com/${ownerPath}/compare` : undefined,
  }
}

/**
 * 安装 spec：把仓库地址钉到某个 commit，或者保持原样（分支跟随）。
 * @param {{ baseSpec: string }} source 解析过的来源。
 * @param {string | undefined} commit 目标 commit；undefined 表示不钉。
 * @returns {string} 交给 pnpm 的 spec。
 */
export function pinnedSpec(source, commit) {
  return commit === undefined ? source.baseSpec : `${source.baseSpec}#${commit}`
}
