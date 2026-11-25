/**
 * 只读探测上游仓库：`git ls-remote` 取跟踪 ref 的最新 commit。
 *
 * 加固方式和宿主安装链路一致：禁掉一切交互（askpass/终端提示），固定超时，
 * 超时连子进程组一起杀，stdin 断开——绝不弹窗向人要用户名/密码，只用本机
 * 已有的 Git 配置与凭据。私有仓库常见「HTTPS 要 token、SSH 用本机 key 就能读」：
 * HTTPS 被挡住时按配置改试 SSH；而一旦确认只能走 SSH，之后就直接先走 SSH，
 * 不再去碰那条会要凭据的 HTTPS 路径。
 */

import { spawn } from 'node:child_process'

/** 输出上限，防止异常仓库刷爆内存。 */
const MAX_OUTPUT_BYTES = 256 * 1024

/** 凭据类失败的判据；命中且开了 sshFallback 就换 SSH 再试。 */
const AUTH_FAILURE = /could not read Username|Authentication failed|Permission denied|terminal prompts disabled|Host key verification failed/i

/**
 * 值得换另一种传输再试的失败类别。
 *
 * `not-found` 必须算进来：GitHub 对匿名访问的私有仓库返回的是
 * `remote: Repository not found.`，而不是认证失败。只按 auth 回退会让
 * 「本地 SSH 明明能拉」的私有仓库被判成「仓库不存在」。
 */
const SSH_FALLBACK_KINDS = Object.freeze(['auth', 'not-found'])

/**
 * 构造子进程环境：禁交互、固定语言，其余沿用宿主环境（含代理与 Git 配置）。
 * @param {NodeJS.ProcessEnv} [base] 基础环境。
 * @returns {NodeJS.ProcessEnv} 子进程环境。
 */
export function gitEnv(base = process.env) {
  return {
    ...base,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
  }
}

/**
 * 跑一条只读 Git 命令，带超时与子进程组清理。
 * @param {string} command git 可执行文件。
 * @param {readonly string[]} args 参数。
 * @param {{ cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv }} options 运行参数。
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, timedOut: boolean }>} 运行结果。
 */
export function runGit(command, args, options) {
  return new Promise(resolve => {
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? gitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8')
      return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next
    }
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk) })

    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* 进程已经退出 */
      }
    }, options.timeoutMs)

    child.on('error', error => {
      finish({ exitCode: null, stdout, stderr: `${stderr}${String(error?.message ?? error)}`, timedOut })
    })
    child.on('close', code => {
      finish({ exitCode: code, stdout, stderr, timedOut })
    })
  })
}

/**
 * 解析 `git ls-remote` 输出里的目标 ref。
 * @param {string} stdout 命令输出。
 * @param {string | undefined} ref 跟踪的分支/标签；undefined 表示远端 HEAD。
 * @returns {{ commit: string, ref: string } | undefined} 认出的 commit。
 */
export function matchRemoteRef(stdout, ref) {
  const lines = String(stdout).split(/\r?\n/).filter(line => line.trim() !== '')
  /** @type {{ sha: string, name: string }[]} */
  const entries = []
  for (const line of lines) {
    const match = /^([0-9a-f]{40})\s+(.+)$/i.exec(line.trim())
    if (match !== null) entries.push({ sha: match[1].toLowerCase(), name: match[2] })
  }
  if (entries.length === 0) return undefined
  if (ref === undefined || ref === '') {
    const head = entries.find(entry => entry.name === 'HEAD')
    return head === undefined ? undefined : { commit: head.sha, ref: 'HEAD' }
  }
  // 标签的 peeled 行（`^{}`）才是 commit，优先它。
  const peeled = entries.find(entry => entry.name === `refs/tags/${ref}^{}`)
  if (peeled !== undefined) return { commit: peeled.sha, ref }
  const exact = [ `refs/heads/${ref}`, `refs/tags/${ref}`, ref ].map(name => entries.find(entry => entry.name === name))
  for (const entry of exact) if (entry !== undefined) return { commit: entry.sha, ref }
  const suffix = entries.find(entry => entry.name.endsWith(`/${ref}`))
  return suffix === undefined ? undefined : { commit: suffix.sha, ref }
}

/**
 * 判定一次探测失败的原因。
 * @param {{ stderr: string, stdout: string, exitCode: number | null, timedOut: boolean }} result 命令结果。
 * @returns {'auth' | 'timeout' | 'not-found' | 'network' | 'unknown'} 失败分类。
 */
export function classifyFailure(result) {
  if (result.timedOut) return 'timeout'
  const text = `${result.stderr}\n${result.stdout}`
  if (AUTH_FAILURE.test(text)) return 'auth'
  if (/could not resolve host|Could not resolve host|Connection refused|Connection timed out|network is unreachable/i.test(text)) return 'network'
  if (/not found|does not appear to be a git repository|repository .* not found/i.test(text)) return 'not-found'
  return 'unknown'
}

/**
 * 探测一个来源的一次尝试。
 * @param {{ url: string, ref: string | undefined }} target 要读的地址与 ref。
 * @param {{ cwd: string, timeoutMs: number, command: string }} options 运行参数。
 * @returns {Promise<{ ok: true, commit: string, ref: string, url: string }
 *   | { ok: false, kind: string, message: string, url: string }>} 结果。
 */
async function attempt(target, options) {
  const ref = target.ref
  const result = await runGit(options.command, [
    '-c', 'core.askPass=',
    'ls-remote', '--exit-code', '--', target.url, ref === undefined ? 'HEAD' : ref,
  ], { cwd: options.cwd, timeoutMs: options.timeoutMs })
  if (result.exitCode === 0 && !result.timedOut) {
    const matched = matchRemoteRef(result.stdout, ref)
    if (matched !== undefined) return { ok: true, ...matched, url: target.url }
    return { ok: false, kind: 'not-found', message: `远端没有可解析的 ${ref ?? 'HEAD'}`, url: target.url }
  }
  const message = (result.timedOut ? '探测超时' : result.stderr.trim() || result.stdout.trim() || '未知错误').slice(-500)
  return { ok: false, kind: classifyFailure(result), message, url: target.url }
}

/**
 * 两种传输的尝试顺序。
 *
 * 已经记录过「只有 SSH 读得到」的包（私有仓库）先走 SSH：省掉一次必然失败的
 * HTTPS 尝试，也彻底不碰那些会向人要密码的 HTTPS 凭据路径。
 * @param {{ transport?: 'https' | 'ssh', sshFallback: boolean }} options 运行参数。
 * @returns {{ primary: 'https' | 'ssh', secondary: 'https' | 'ssh' | undefined }} 顺序。
 */
function transports(options) {
  if (options.transport === 'ssh') return { primary: 'ssh', secondary: 'https' }
  return { primary: 'https', secondary: options.sshFallback ? 'ssh' : undefined }
}

/**
 * 一种传输的地址。
 * @param {any} source 解析过的来源。
 * @param {'https' | 'ssh'} transport 传输。
 * @returns {string} 地址。
 */
function urlOf(source, transport) {
  return transport === 'ssh' ? source.sshUrl : source.httpsUrl
}

/**
 * 按 HTTPS →（凭据失败时）SSH 的顺序读上游 commit。
 *
 * `options.transport === 'ssh'`（上次检查/锁文件已经证明这个仓库只能走 SSH）
 * 时反过来：先 SSH，再拿 HTTPS 当兜底。
 * @param {ReturnType<typeof import('./git-source.js').parseGitSource>} source 解析过的来源。
 * @param {{ cwd: string, timeoutMs: number, sshFallback: boolean, command: string,
 *   transport?: 'https' | 'ssh', ref?: string }} options 运行参数；`ref` 可覆盖来源里的分支。
 * @returns {Promise<{ ok: true, commit: string, ref: string, transport: 'https' | 'ssh'
 *   } | { ok: false, kind: string, message: string, transport?: 'https' | 'ssh' }>} 探测结果。
 */
export async function probeSource(source, options) {
  if (source === undefined) return { ok: false, kind: 'unsupported', message: '不是 Git 来源' }
  const ref = options.ref ?? source.ref
  const { primary, secondary } = transports(options)
  const first = await attempt({ url: urlOf(source, primary), ref }, options)
  if (first.ok) return { ...first, transport: primary }
  // HTTPS 先失败、但失败原因不是「可能只是缺凭据/私有仓库」时不换传输。
  if (primary === 'https' && (secondary === undefined || !SSH_FALLBACK_KINDS.includes(first.kind))) return first
  if (secondary === undefined) return first
  const second = await attempt({ url: urlOf(source, secondary), ref }, options)
  if (second.ok) return { ...second, transport: secondary }
  return {
    ok: false,
    kind: second.kind === 'auth' || first.kind === 'auth' ? 'auth' : second.kind,
    message: `${label(primary)}：${first.message}；${label(secondary)}：${second.message}`,
    transport: primary,
  }
}

/**
 * 失败信息里的传输名字。
 * @param {'https' | 'ssh'} transport 传输。
 * @returns {string} 展示用名字。
 */
function label(transport) {
  return transport === 'ssh' ? 'SSH' : 'HTTPS'
}

/**
 * 解析 `git ls-remote --symref` 的完整输出：远端 HEAD、默认分支与所有分支。
 * @param {string} stdout 命令输出。
 * @returns {{ head?: string, defaultBranch?: string, heads: Array<{ name: string, commit: string }> }} 列表。
 */
export function parseRemoteRefs(stdout) {
  let head
  let defaultBranch
  /** @type {Array<{ name: string, commit: string }>} */
  const heads = []
  for (const line of String(stdout).split(/\r?\n/)) {
    const text = line.trim()
    if (text === '') continue
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(text)
    if (symref !== null) {
      defaultBranch = symref[1]
      continue
    }
    const entry = /^([0-9a-f]{40})\s+(.+)$/i.exec(text)
    if (entry === null) continue
    const commit = entry[1].toLowerCase()
    const name = entry[2]
    if (name === 'HEAD') head = commit
    else if (name.startsWith('refs/heads/')) heads.push({ name: name.slice('refs/heads/'.length), commit })
  }
  return {
    ...(head === undefined ? {} : { head }),
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    heads,
  }
}

/**
 * 一次「列出全部分支」的尝试。
 * @param {string} url 仓库地址。
 * @param {{ cwd: string, timeoutMs: number, command: string }} options 运行参数。
 * @returns {Promise<{ ok: true, head?: string, defaultBranch?: string, heads: Array<{ name: string, commit: string }>, url: string }
 *   | { ok: false, kind: string, message: string, url: string }>} 结果。
 */
async function attemptRefs(url, options) {
  const result = await runGit(options.command, [
    '-c', 'core.askPass=',
    'ls-remote', '--symref', '--exit-code', '--', url,
  ], { cwd: options.cwd, timeoutMs: options.timeoutMs })
  if (result.exitCode === 0 && !result.timedOut) {
    const listing = parseRemoteRefs(result.stdout)
    if (listing.head !== undefined || listing.heads.length > 0) return { ok: true, ...listing, url }
    return { ok: false, kind: 'not-found', message: '远端没有可解析的分支', url }
  }
  const message = (result.timedOut ? '探测超时' : result.stderr.trim() || result.stdout.trim() || '未知错误').slice(-500)
  return { ok: false, kind: classifyFailure(result), message, url }
}

/**
 * 读出远端所有分支（HTTPS → 凭据失败时 SSH；`transport:'ssh'` 时反过来）。
 * 用于「保存的是 commit、不知道跟踪哪个分支」时，按已装 commit 反查分支。
 * @param {ReturnType<typeof import('./git-source.js').parseGitSource>} source 解析过的来源。
 * @param {{ cwd: string, timeoutMs: number, sshFallback: boolean, command: string,
 *   transport?: 'https' | 'ssh' }} options 运行参数。
 * @returns {Promise<{ ok: true, head?: string, defaultBranch?: string, heads: Array<{ name: string, commit: string }>,
 *   transport: 'https' | 'ssh' } | { ok: false, kind: string, message: string, transport?: 'https' | 'ssh' }>} 结果。
 */
export async function probeRefs(source, options) {
  if (source === undefined) return { ok: false, kind: 'unsupported', message: '不是 Git 来源' }
  const { primary, secondary } = transports(options)
  const first = await attemptRefs(urlOf(source, primary), options)
  if (first.ok) return { ...first, transport: primary }
  if (primary === 'https' && (secondary === undefined || !SSH_FALLBACK_KINDS.includes(first.kind))) return first
  if (secondary === undefined) return first
  const second = await attemptRefs(urlOf(source, secondary), options)
  if (second.ok) return { ...second, transport: secondary }
  return {
    ok: false,
    kind: second.kind === 'auth' || first.kind === 'auth' ? 'auth' : second.kind,
    message: `${label(primary)}：${first.message}；${label(secondary)}：${second.message}`,
    transport: primary,
  }
}

/**
 * 按已装 commit 反查它当时对应的分支；多个分支同 commit 时优先非默认分支。
 * @param {{ defaultBranch?: string, heads: Array<{ name: string, commit: string }> }} listing 分支列表。
 * @param {string | undefined} installedCommit 已装 commit。
 * @returns {string | undefined} 分支名。
 */
export function branchForCommit(listing, installedCommit) {
  if (typeof installedCommit !== 'string' || installedCommit === '') return undefined
  const matches = listing.heads.filter(head => head.commit === installedCommit.toLowerCase())
  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0].name
  return (matches.find(head => head.name !== listing.defaultBranch) ?? matches[0]).name
}
