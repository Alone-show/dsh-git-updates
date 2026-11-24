/**
 * 更新的执行体：卸载 → 安装目标 commit → 校验 → 失败回滚。
 *
 * 语义和宿主 plugin-manager 自带更新保持一致：
 *   · 有 HMR 时先 removeBundle 再 installBundle（installBundle 会拒绝覆盖已装包）；
 *   · 目标安装失败或校验不过时，把原来的 spec 装回去（优先钉回原 commit）；
 *   · 结果里保留每一步的宿主返回值，便于页面展示和事后排查。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pinnedSpec } from './git-source.js'
import { readInstalledEntry } from './lockfile.js'

/**
 * 读 profile 里的 pnpm-lock.yaml；读不到就返回空串（校验会因此失败，触发回滚）。
 * @param {string} profileDir profile 目录。
 * @returns {Promise<string>} 锁文件全文。
 */
async function readLock(profileDir) {
  try {
    return await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
  } catch {
    return ''
  }
}

/**
 * 校验一次安装：锁文件里的 commit 与目标一致，且包清单仍是同一个带 bundle 补丁的包。
 * @param {string} profileDir profile 目录。
 * @param {string} name 包名。
 * @param {string} commit 目标 commit。
 * @returns {Promise<{ ok: boolean, version?: string, commit?: string, problems: string[] }>} 校验结果。
 */
export async function verifyInstall(profileDir, name, commit) {
  const problems = []
  const lockText = await readLock(profileDir)
  const installed = readInstalledEntry(lockText, name)
  if (installed === undefined) problems.push('锁文件里没有这个依赖')
  else if (installed.commit !== undefined && installed.commit !== commit) {
    problems.push(`锁文件记录的 commit 是 ${installed.commit.slice(0, 7)}，不是目标 ${commit.slice(0, 7)}`)
  } else if (installed.commit === undefined) {
    problems.push('锁文件里读不到这个依赖的 commit')
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
  } catch {
    problems.push('装好的包读不到 package.json')
  }
  if (manifest !== undefined) {
    if (manifest.name !== name) problems.push(`装好的包名是 ${String(manifest.name)}，不是 ${name}`)
    const patch = manifest.dsh?.bundle?.patch
    if (patch === undefined || (Array.isArray(patch) ? patch.length === 0 : typeof patch !== 'string')) {
      problems.push('装好的包没有 dsh.bundle.patch，不是 DSH bundle')
    }
  }
  return {
    ok: problems.length === 0,
    version: manifest?.version,
    commit: installed?.commit,
    problems,
  }
}

/**
 * 执行一次更新。
 * @param {{
 *   manager: any,
 *   profileDir: string,
 *   name: string,
 *   source: any,
 *   enabled: boolean,
 *   previous: { version?: string, commit?: string },
 *   targetCommit: string,
 *   pinCommits: boolean,
 *   hmr: boolean,
 *   requestId?: string,
 *   signal?: AbortSignal,
 *   onStep: (step: string, message: string) => void,
 *   onLog?: (level: 'info'|'warn'|'error', message: string) => void,
 * }} options 更新参数。
 * @returns {Promise<{
 *   from: { version?: string, commit?: string }, to: { commit: string },
 *   spec: string, remoteSpec: string, steps: any[], verified: boolean,
 *   application?: string, restartReason?: string, error?: { code: string, message: string },
 *   restore?: { spec: string, result: any, verified?: { ok: boolean, problems: string[] } },
 * }>} 更新结果。
 */
export async function runUpdate(options) {
  const { manager, profileDir, name, source, enabled, previous, targetCommit, pinCommits, hmr, onStep } = options
  const spec = pinnedSpec(source, pinCommits ? targetCommit : undefined)
  const remoteSpec = pinnedSpec(source, targetCommit)
  const steps = []
  const record = (step, message) => {
    onStep(step, message)
    steps.push({ step, message })
  }
  const note = (step, message, extra) => {
    steps.push({ step, message, ...extra })
  }
  const log = (level, message) => {
    options.onLog?.(level, message)
  }

  if (options.signal?.aborted === true) {
    return { from: previous, to: { commit: targetCommit }, spec, remoteSpec, steps, verified: false,
      error: { code: 'CANCELLED', message: '已取消' } }
  }

  record('removing', `正在卸载 ${name}`)
  let removed
  if (hmr) {
    removed = await manager.removeBundle(name)
    note('removing', '已卸载原版本', { result: removed })
    log('info', `卸载结果：${String(removed?.application ?? 'unknown')}`)
    if (removed?.application === 'failed' || removed?.application === 'cancelled') {
      return {
        from: previous, to: { commit: targetCommit }, spec, remoteSpec, steps, verified: false,
        application: removed.application,
        ...(removed?.restartReason === undefined ? {} : { restartReason: removed.restartReason }),
        error: { code: 'REMOVE_FAILED', message: removed?.error?.diagnostic ?? '卸载失败' },
      }
    }
  }

  if (options.signal?.aborted === true) {
    // 卸载已经发生，取消也必须把原版本装回去。
    const restore = await restorePrevious({ manager, name, source, previous, enabled, pinCommits, onLog: options.onLog })
    return { from: previous, to: { commit: targetCommit }, spec, remoteSpec, steps, verified: false,
      error: { code: 'CANCELLED', message: '已取消' }, ...(restore === undefined ? {} : { restore }) }
  }

  record('installing', `正在安装 ${spec}`)
  let installed
  try {
    installed = await manager.installBundle(spec, {
      enabled,
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    })
  } catch (error) {
    installed = {
      changed: false, application: 'failed', stage: 'install', target: spec,
      error: { code: 'INSTALL_FAILED', diagnostic: String(error?.message ?? error) },
    }
    log('error', `安装抛错：${String(error?.message ?? error)}`)
  }
  note('installing', '安装步骤已结束', { result: installed })
  log('info', `安装结果：${String(installed?.application ?? 'unknown')}`)
  if (installed?.application === 'failed') {
    log('error', `安装失败：${installed?.error?.diagnostic ?? installed?.error?.code ?? '未知原因'}`)
  } else if (installed?.application === 'cancelled') {
    log('warn', '安装已取消')
  }
  if (installed?.restartReason !== undefined) log('warn', `需要重启：${installed.restartReason}`)

  const installedOk = installed?.application === 'applied' || installed?.application === 'restart-required'
  if (!installedOk) {
    const restore = await restorePrevious({ manager, name, source, previous, enabled, pinCommits, onLog: options.onLog })
    return {
      from: previous, to: { commit: targetCommit }, spec, remoteSpec, steps, verified: false,
      application: installed?.application,
      ...(installed?.restartReason === undefined ? {} : { restartReason: installed.restartReason }),
      error: {
        code: installed?.application === 'cancelled' ? 'CANCELLED' : 'INSTALL_FAILED',
        message: installed?.error?.diagnostic ?? '安装失败',
      },
      ...(restore === undefined ? {} : { restore }),
    }
  }

  record('verifying', '正在校验安装结果')
  const verified = await verifyInstall(profileDir, name, targetCommit)
  note('verifying', verified.ok ? '校验通过' : `校验未通过：${verified.problems.join('；')}`, { verified })
  log(verified.ok ? 'info' : 'warn', verified.ok
    ? `校验通过（${verified.commit ?? targetCommit}）`
    : `校验未通过：${verified.problems.join('；')}`)
  if (!verified.ok) {
    const restore = await restorePrevious({ manager, name, source, previous, enabled, pinCommits, onLog: options.onLog })
    return {
      from: previous, to: { commit: targetCommit }, spec, remoteSpec, steps, verified: false,
      application: installed.application,
      ...(installed?.restartReason === undefined ? {} : { restartReason: installed.restartReason }),
      error: { code: 'VERIFY_FAILED', message: verified.problems.join('；') },
      ...(restore === undefined ? {} : { restore }),
    }
  }

  return {
    from: previous,
    to: { commit: targetCommit, version: verified.version },
    spec,
    remoteSpec,
    steps,
    verified: true,
    application: installed.application,
    ...(installed?.restartReason === undefined ? {} : { restartReason: installed.restartReason }),
  }
}

/**
 * 把原版本装回去：优先钉回原 commit（没有就退回原 spec）。
 * @param {{ manager: any, name: string, source: any, previous: { version?: string, commit?: string },
 *   enabled: boolean, pinCommits: boolean,
 *   onLog?: (level: 'info'|'warn'|'error', message: string) => void }} options 回滚参数。
 * @returns {Promise<{ spec: string, result: any, verified?: { ok: boolean, problems: string[] } } | undefined>} 回滚结果。
 */
async function restorePrevious(options) {
  const { manager, name, source, previous, enabled } = options
  const spec = previous.commit === undefined ? source.baseSpec : pinnedSpec(source, previous.commit)
  try {
    const result = await manager.installBundle(spec, { enabled })
    options.onLog?.('warn', `已回滚到 ${spec}`)
    return { spec, result }
  } catch (error) {
    options.onLog?.('error', `回滚失败：${String(error?.message ?? error)}`)
    return {
      spec,
      result: {
        changed: false, application: 'failed', stage: 'install', target: spec,
        error: { code: 'RESTORE_FAILED', diagnostic: String(error?.message ?? error) },
      },
    }
  }
}
