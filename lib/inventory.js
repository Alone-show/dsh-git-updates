/**
 * 把 pluginManager.listBundles() 的条目和 pnpm-lock.yaml 的解析结果合成
 * 「详情页要显示的视图」。纯函数，不碰网络、不碰文件。
 */

import { parseGitSource } from './git-source.js'
import { readInstalledEntry } from './lockfile.js'

/**
 * 一个 bundle 是否归本插件管。
 * @param {any} bundle listBundles() 的条目。
 * @returns {boolean} 是否为 profile 里装的第三方 Git 依赖。
 */
export function managedByGit(bundle) {
  return bundle !== undefined
    && bundle !== null
    && bundle.installed === true
    && bundle.availability === 'profile'
    && bundle.official !== true
    && bundle.readOnlyReason === undefined
    && typeof bundle.source === 'string'
}

/**
 * 造一个视图。
 * @param {any} bundle listBundles() 的条目。
 * @param {string} lockText pnpm-lock.yaml 全文。
 * @param {any} [state] 本插件记录的状态条目。
 * @param {{ cacheTtlMs?: number }} [options] 检查结果的保鲜期，用来标 `check.stale`。
 * @returns {any} 视图；非 Git 来源时只有 `{ package, applicable: false }`。
 */
export function toView(bundle, lockText, state, options = {}) {
  const name = bundle.name
  const source = managedByGit(bundle) ? parseGitSource(bundle.source) : undefined
  if (source === undefined) {
    return { package: name, applicable: false, installed: { version: bundle.version } }
  }
  const entry = readInstalledEntry(lockText, name)
  const installedCommit = entry?.commit
  // 锁文件里的解析地址说明当时是怎么拉下来的：git+ssh 表示这个仓库只能走 SSH。
  const installedTransport = typeof entry?.versionValue === 'string' && /^git\+ssh:|^ssh:/i.test(entry.versionValue)
    ? 'ssh'
    : undefined
  const lastCheck = state?.lastCheck
  const lastUpdate = summarizeUpdate(state?.lastUpdate)
  const pendingRestart = summarizeRestart(state?.restartPending)
  const cacheTtlMs = typeof options.cacheTtlMs === 'number' ? options.cacheTtlMs : 0
  const stale = checkStale(lastCheck?.at, cacheTtlMs)
  return {
    package: name,
    applicable: true,
    // 显示文案原样给前端，由浏览器侧按当前语言解析（LocalizedText / 字符串）。
    title: bundle.meta?.title,
    description: bundle.meta?.description ?? bundle.description,
    source: bundle.source,
    host: source.host,
    repository: source.path,
    ref: source.ref ?? (typeof state?.trackedRef === 'string' ? state.trackedRef : undefined) ?? lastCheck?.ref ?? undefined,
    trackedRef: typeof state?.trackedRef === 'string' ? state.trackedRef : undefined,
    pinned: source.pinned,
    installed: {
      version: bundle.version,
      commit: installedCommit,
      ...(installedTransport === undefined ? {} : { transport: installedTransport }),
    },
    enabled: bundle.enabled === true,
    ...(lastUpdate === undefined ? {} : { lastUpdate }),
    ...(pendingRestart === undefined ? {} : { pendingRestart }),
    check: lastCheck === undefined
      ? { at: null, state: 'unknown', stale: false }
      : {
        at: lastCheck.at,
        state: lastCheck.state,
        latest: lastCheck.latest,
        transport: lastCheck.transport,
        error: lastCheck.error,
        stale,
      },
  }
}

/**
 * 上次检查是否已经过了保鲜期。
 * @param {unknown} at 上次检查的时间戳。
 * @param {number} cacheTtlMs 保鲜期（毫秒）；0 表示不判过期。
 * @returns {boolean} 是否过期。
 */
function checkStale(at, cacheTtlMs) {
  if (typeof at !== 'string' || at === '' || cacheTtlMs <= 0) return false
  const parsed = Date.parse(at)
  if (!Number.isFinite(parsed)) return false
  return Date.now() - parsed >= cacheTtlMs
}

/**
 * 把状态文件里的上次更新收成视图里的一小块；形状不对就丢掉。
 * @param {any} lastUpdate 状态里的条目。
 * @returns {any | undefined} 摘要。
 */
function summarizeUpdate(lastUpdate) {
  if (lastUpdate === null || typeof lastUpdate !== 'object') return undefined
  const from = lastUpdate.from !== null && typeof lastUpdate.from === 'object' ? lastUpdate.from : undefined
  const to = lastUpdate.to !== null && typeof lastUpdate.to === 'object' ? lastUpdate.to : undefined
  const error = lastUpdate.error !== null && typeof lastUpdate.error === 'object' ? lastUpdate.error : undefined
  return {
    at: lastUpdate.at,
    from: from === undefined ? undefined : { version: from.version, commit: from.commit },
    to: to === undefined ? undefined : { version: to.version, commit: to.commit },
    verified: lastUpdate.verified === true,
    application: lastUpdate.application,
    ...(typeof lastUpdate.restartReason === 'string' ? { restartReason: lastUpdate.restartReason } : {}),
    ...(error === undefined ? {} : { error: { code: error.code, message: error.message } }),
    ...(lastUpdate.restore === undefined ? {} : { restore: lastUpdate.restore }),
    ...(typeof lastUpdate.restartedAt === 'string' ? { restartedAt: lastUpdate.restartedAt } : {}),
  }
}

/**
 * 把状态文件里的待重启标记收成视图里的 `pendingRestart`；不暴露 bootId。
 * @param {any} restartPending 状态里的条目。
 * @returns {{ commit: string, at: string, reason?: string } | undefined} 摘要。
 */
function summarizeRestart(restartPending) {
  if (restartPending === null || typeof restartPending !== 'object') return undefined
  if (typeof restartPending.commit !== 'string' || restartPending.commit === '') return undefined
  return {
    commit: restartPending.commit,
    at: typeof restartPending.at === 'string' ? restartPending.at : new Date(0).toISOString(),
    ...(typeof restartPending.reason === 'string' ? { reason: restartPending.reason } : {}),
  }
}

/**
 * 比较已装 commit 与上游最新 commit，给出展示状态。
 * @param {string | undefined} installed 已装 commit。
 * @param {string} latest 上游 commit。
 * @returns {'current' | 'behind'} 状态。
 */
export function compareCommits(installed, latest) {
  if (installed === undefined || installed === null) return 'behind'
  return installed.toLowerCase() === latest.toLowerCase() ? 'current' : 'behind'
}
