/**
 * 本插件的落盘状态：<profile>/.git-updates/state.json。
 *
 * 只记「上次检查/上次更新」这类可重建的信息，不存任何凭据或带 token 的 URL。
 * 写入统一走临时文件 + rename，避免半截 JSON；权限 0600。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 状态文件版本；结构变了就加一，读到别的版本直接当空状态。 */
const VERSION = 1

/** 同一进程里串行化写入，避免两个请求互相覆盖。 */
let writeChain = Promise.resolve()

/** 串行化「读-改-写」整个周期，避免两个检查结果互相覆盖。 */
let mutateChain = Promise.resolve()

/**
 * 状态文件路径。
 * @param {string} profileDir profile 目录。
 * @returns {string} 绝对路径。
 */
export function stateFile(profileDir) {
  return join(profileDir, '.git-updates', 'state.json')
}

/**
 * 读状态；文件缺失或损坏都当空状态，不影响插件的其它功能。
 * @param {string} profileDir profile 目录。
 * @returns {Promise<{ version: number, packages: Record<string, any> }>} 状态。
 */
export async function readState(profileDir) {
  try {
    const text = await readFile(stateFile(profileDir), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== VERSION) {
      return { version: VERSION, packages: {} }
    }
    const packages = parsed.packages !== null && typeof parsed.packages === 'object' ? parsed.packages : {}
    return { version: VERSION, packages }
  } catch {
    return { version: VERSION, packages: {} }
  }
}

/**
 * 原子写状态。
 * @param {string} profileDir profile 目录。
 * @param {{ version: number, packages: Record<string, any> }} state 完整状态。
 * @returns {Promise<void>} 写完后返回。
 */
export async function writeState(profileDir, state) {
  writeChain = writeChain.then(async () => {
    const file = stateFile(profileDir)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  })
  return writeChain
}

/**
 * 读改写一个包的状态条目。
 * @param {string} profileDir profile 目录。
 * @param {string} name 包名。
 * @param {(current: any) => any} mutate 返回新的条目。
 * @returns {Promise<any>} 写入后的条目。
 */
export async function mutatePackageState(profileDir, name, mutate) {
  const run = mutateChain.then(async () => {
    const state = await readState(profileDir)
    const current = state.packages[name] ?? {}
    const next = mutate(current) ?? current
    state.packages[name] = next
    await writeState(profileDir, state)
    return next
  })
  // 失败不阻断后续的读改写。
  mutateChain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 记一次检查结果。
 *
 * `transport` 额外记在条目顶层：它表示「这个仓库到底该怎么读」，一旦确认只能
 * 走 SSH（私有仓库），后续探测和安装都据此直接走 SSH，不停在会要密码的
 * HTTPS 上。检查本身失败时不覆盖它。
 * @param {string} profileDir profile 目录。
 * @param {string} name 包名。
 * @param {{ at: string, state: string, latest?: string, transport?: string, ref?: string, error?: { kind: string, message: string } }} check 检查结果。
 * @returns {Promise<void>} 写完后返回。
 */
export async function recordCheck(profileDir, name, check) {
  await mutatePackageState(profileDir, name, current => ({
    ...current,
    ...(typeof check.transport === 'string' ? { transport: check.transport } : {}),
    lastCheck: check,
  }))
}

/**
 * 记住一个包实际跟踪的分支（保存的 spec 被钉成 commit 后，靠它继续跟上游）。
 * @param {string} profileDir profile 目录。
 * @param {string} name 包名。
 * @param {string} ref 分支名。
 * @returns {Promise<void>} 写完后返回。
 */
export async function recordTrackedRef(profileDir, name, ref) {
  await mutatePackageState(profileDir, name, current => (
    current.trackedRef === ref ? current : { ...current, trackedRef: ref }
  ))
}

/**
 * 记一次更新结果。
 * @param {string} profileDir profile 目录。
 * @param {string} name 包名。
 * @param {Record<string, any>} outcome 结果摘要。
 * @returns {Promise<void>} 写完后返回。
 */
export async function recordUpdate(profileDir, name, outcome) {
  await mutatePackageState(profileDir, name, current => ({ ...current, lastUpdate: outcome }))
}

/**
 * 当前宿主进程的启动标识：pid + 进程启动时刻（秒）。
 *
 * 用进程级的稳定值而不是每次求值都变的随机串：本插件被 HMR 重新求值、或
 * 同一进程里被重装后再挂载，标识都不变；只有真正重启宿主才会换一个。
 * @returns {string} 启动标识。
 */
export function currentBootId() {
  const startedAt = Math.round((Date.now() - process.uptime() * 1000) / 1000)
  return `${process.pid}-${startedAt}`
}

/**
 * 记下「这次更新要重启才生效」。
 * @param {string} profileDir profile 目录。
 * @param {string} name 包名。
 * @param {{ commit: string, at?: string, bootId: string, reason?: string }} pending 待重启信息。
 * @returns {Promise<void>} 写完后返回。
 */
export async function recordRestartPending(profileDir, name, pending) {
  await mutatePackageState(profileDir, name, current => ({
    ...current,
    restartPending: {
      commit: pending.commit,
      at: pending.at ?? new Date().toISOString(),
      bootId: pending.bootId,
      ...(pending.reason === undefined ? {} : { reason: pending.reason }),
    },
  }))
}

/**
 * 清掉一个包的待重启标记（重启已完成，或这次更新其实不需要重启）。
 * @param {string} profileDir profile 目录。
 * @param {string} name 包名。
 * @param {string} [restartedAt] 记到 `lastUpdate.restartedAt` 的时间戳。
 * @returns {Promise<void>} 写完后返回。
 */
export async function clearRestartPending(profileDir, name, restartedAt = new Date().toISOString()) {
  await mutatePackageState(profileDir, name, current => {
    if (current.restartPending === undefined) return current
    const next = { ...current }
    delete next.restartPending
    if (next.lastUpdate !== undefined) next.lastUpdate = { ...next.lastUpdate, restartedAt }
    return next
  })
}

/**
 * 启动时对账：上一个宿主进程留下的待重启标记，说明重启已经发生过，清掉它们。
 *
 * 按 `bootId` 判断：同一进程（HMR 重载、重装本插件）不会被误清；只有换了
 * 进程才清，页面因此不会在重启后还挂着过期的「需重启」横幅。
 * @param {string} profileDir profile 目录。
 * @param {string} bootId 当前进程的启动标识。
 * @returns {Promise<string[]>} 被清掉的包名。
 */
export async function reconcileBoot(profileDir, bootId) {
  const state = await readState(profileDir)
  const cleared = []
  let changed = false
  for (const [name, entry] of Object.entries(state.packages)) {
    if (entry === null || typeof entry !== 'object') continue
    const pending = entry.restartPending
    if (pending === null || typeof pending !== 'object') continue
    if (typeof pending.bootId === 'string' && pending.bootId === bootId) continue
    const next = { ...entry }
    delete next.restartPending
    if (next.lastUpdate !== null && typeof next.lastUpdate === 'object') {
      next.lastUpdate = { ...next.lastUpdate, restartedAt: new Date().toISOString() }
    }
    state.packages[name] = next
    cleared.push(name)
    changed = true
  }
  if (changed) await writeState(profileDir, state)
  return cleared
}
