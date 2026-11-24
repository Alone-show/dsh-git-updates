/**
 * 业务层：把「插件管理器列出的包 + 锁文件 + 上游探测 + 状态文件」粘起来，
 * 给设置页的路由提供 list / view / check / update / job / cancel。
 *
 * 设置页只需要一份稳定列表：正在更新的包会先被卸载、从 listBundles()
 * 消失，这里用任务快照把它补回来（见 lib/sticky.js），所以页面上的那一行
 * 不会在更新开始后凭空消失。
 *
 * 所有可替换的边界（读文件、探测、任务体）都通过参数注入，便于单元测试。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseGitSource } from './git-source.js'
import { toView, managedByGit } from './inventory.js'
import { probeSource as defaultProbe } from './probe.js'
import { JobRunner } from './jobs.js'
import { mergeSticky, summarizeJob } from './sticky.js'
import {
  clearRestartPending, currentBootId, readState, reconcileBoot, recordCheck, recordRestartPending, recordUpdate,
} from './state.js'
import { runUpdate } from './update.js'

/** 锁文件读取缓存时长：一个请求周期内多个视图复用同一份。 */
const LOCK_CACHE_MS = 500

/** 安装阶段的中文说明。 */
const INSTALL_PHASE_TEXT = Object.freeze({
  installing: '正在安装依赖',
  cancelling: '正在取消安装',
  applying: '正在应用安装结果',
})

/**
 * 造业务层。
 * @param {{
 *   manager: any,
 *   profileDir: string,
 *   config: ReturnType<typeof import('./config.js').resolveConfig>,
 *   probe?: typeof defaultProbe,
 *   readFileImpl?: (path: string, encoding: string) => Promise<string>,
 *   logger?: { warn?: (message: string) => void, info?: (message: string) => void },
 *   hmr?: boolean,
 *   bootId?: string,
 *   ownPackage?: string,
 * }} options 依赖。
 * @returns {any} 业务对象（`ready` 是启动对账完成后的 Promise）。
 */
export function createService(options) {
  const { manager, profileDir, config, logger, hmr, ownPackage } = options
  const bootId = options.bootId ?? currentBootId()
  const probe = options.probe ?? defaultProbe
  const readText = options.readFileImpl ?? ((path, encoding) => readFile(path, encoding))
  const runner = new JobRunner()
  /** @type {{ at: number, text: string } | undefined} */
  let lockCache
  /** @type {Map<string, Promise<any>>} */
  const inflightChecks = new Map()

  /** 启动对账：上一个宿主进程留下的「待重启」标记说明重启已经发生过。 */
  const ready = reconcileBoot(profileDir, bootId).catch(error => {
    logger?.warn?.(`[git-updates] 启动对账失败：${String(error?.message ?? error)}`)
    return []
  })

  /**
   * 读锁文件（带很短的缓存）。
   * @returns {Promise<string>} 锁文件全文，读不到时为空串。
   */
  const lockText = async () => {
    if (lockCache !== undefined && Date.now() - lockCache.at < LOCK_CACHE_MS) return lockCache.text
    let text = ''
    try {
      text = await readText(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    } catch {
      text = ''
    }
    lockCache = { at: Date.now(), text }
    return text
  }

  /**
   * 取某个包的 bundle 条目与已装事实。
   * @param {string} name 包名。
   * @returns {Promise<{ bundle?: any, view?: any, source?: any }>} 现状。
   */
  const describe = async name => {
    const bundles = await manager.listBundles()
    const bundle = bundles.find(item => item.name === name)
    if (bundle === undefined) return {}
    const text = await lockText()
    const state = (await readState(profileDir)).packages[name]
    const view = toView(bundle, text, state, { cacheTtlMs: config.cacheTtlMs })
    if (ownPackage !== undefined && bundle.name === ownPackage) view.self = true
    return {
      bundle,
      view,
      source: managedByGit(bundle) ? parseGitSource(bundle.source) : undefined,
    }
  }

  /**
   * 向上游探测一次并落状态。
   * @param {string} name 包名。
   * @param {any} source 解析过的来源。
   * @param {any} view 视图（取已装 commit）。
   * @returns {Promise<any>} 检查结果。
   */
  const checkOne = async (name, source, view) => {
    const result = await probe(source, {
      cwd: profileDir,
      timeoutMs: config.probeTimeoutMs,
      sshFallback: config.sshFallback,
      command: config.gitCommand,
    })
    const at = new Date().toISOString()
    if (result.ok === true) {
      const installedCommit = typeof view.installed.commit === 'string' ? view.installed.commit.toLowerCase() : ''
      if (installedCommit === '') {
        const missing = {
          at,
          state: 'unknown',
          latest: result.commit,
          transport: result.transport,
          ref: source.ref ?? 'HEAD',
          error: { kind: 'no-commit', message: '读不到已安装的 commit，无法判断是否落后' },
        }
        await recordCheck(profileDir, name, missing)
        return missing
      }
      const state = result.commit.toLowerCase() === installedCommit ? 'current' : 'behind'
      const check = {
        at,
        state,
        latest: result.commit,
        transport: result.transport,
        ref: source.ref ?? 'HEAD',
      }
      await recordCheck(profileDir, name, check)
      return check
    }
    const check = { at, state: 'unknown', error: { kind: result.kind, message: result.message } }
    await recordCheck(profileDir, name, check)
    return check
  }

  /**
   * 检查一个包；同一包的并发请求共用一个探测。
   * @param {string} name 包名。
   * @param {{ force?: boolean }} [options] force 为真时忽略缓存。
   * @returns {Promise<any>} 视图（含 check）。
   */
  const check = async (name, opts = {}) => {
    const { bundle, source, view } = await describe(name)
    if (bundle === undefined) return { package: name, applicable: false, error: { code: 'NOT_FOUND', message: '没有这个包' } }
    if (source === undefined || view?.applicable !== true) return view
    const fresh = view.check?.at !== null && Date.now() - Date.parse(view.check.at) < config.cacheTtlMs
    if (fresh && opts.force !== true) return view
    let pending = inflightChecks.get(name)
    if (pending === undefined) {
      pending = checkOne(name, source, view).finally(() => inflightChecks.delete(name))
      inflightChecks.set(name, pending)
    }
    const check = await pending
    return { ...view, check }
  }

  /**
   * 全部受管包的现状：实时行 + 正在/刚刚更新过的粘性行。
   * @param {{ probe?: boolean }} [opts] probe 为真时对过期缓存触发探测。
   * @returns {Promise<any[]>} 视图数组。
   */
  const list = async (opts = {}) => {
    const bundles = await manager.listBundles()
    const text = await lockText()
    const state = await readState(profileDir)
    const views = []
    for (const bundle of bundles) {
      if (!managedByGit(bundle)) continue
      const source = parseGitSource(bundle.source)
      if (source === undefined) continue
      const view = toView(bundle, text, state.packages[bundle.name], { cacheTtlMs: config.cacheTtlMs })
      if (ownPackage !== undefined && bundle.name === ownPackage) view.self = true
      views.push(opts.probe === true ? await check(bundle.name) : view)
    }
    return mergeSticky(views, runner.entries())
  }

  /**
   * 客户端确认框里已经看过目标 commit；更新时直接装这个 commit。
   * 没带目标（脚本调用/旧客户端）才在任务里探测一次，进度条上看得见。
   * @param {string} name 包名。
   * @param {{ expectedCommit?: string, targetCommit?: string, force?: boolean }} [opts] 客户端上报的已装/目标 commit。
   * @returns {Promise<any>} 任务视图（jobId、package、targetCommit）。
   */
  const update = async (name, opts = {}) => {
    if (ownPackage !== undefined && name === ownPackage) {
      const error = new Error('不能在自身页面更新本工具，请到插件页处理')
      error.code = 'SELF_UPDATE'
      throw error
    }
    const { bundle, source, view } = await describe(name)
    if (bundle === undefined || source === undefined || view?.applicable !== true) {
      const error = new Error(`${name} 不是本插件管理的 Git 依赖`)
      error.code = 'NOT_MANAGED'
      throw error
    }
    const installedCommit = view.installed.commit
    if (typeof installedCommit !== 'string' || installedCommit === '') {
      const error = new Error('读不到已安装的 commit，无法安全更新（可先在插件管理器里重装一次该插件）')
      error.code = 'UNKNOWN_INSTALLED_COMMIT'
      throw error
    }
    if (typeof opts.expectedCommit === 'string' && opts.expectedCommit !== '' && opts.expectedCommit !== installedCommit) {
      const error = new Error('已安装的版本已经变化，请重新检查后再更新')
      error.code = 'STALE_VIEW'
      throw error
    }
    const confirmed = typeof opts.targetCommit === 'string' && /^[0-9a-f]{40}$/i.test(opts.targetCommit)
      ? opts.targetCommit.toLowerCase()
      : undefined
    if (confirmed !== undefined && confirmed === installedCommit.toLowerCase()) {
      const error = new Error('已经是最新 commit')
      error.code = 'ALREADY_LATEST'
      throw error
    }
    // 没带目标（脚本调用/老客户端）先按缓存规则检查一次；带了就直接装，
    // 免得「点确认」之后先盲等一次最长 15s 的探测。
    let checked
    if (confirmed === undefined) {
      checked = await check(name, { force: opts.force === true })
      if (checked.check?.state === 'unknown') {
        const error = new Error(`检查上游失败：${checked.check?.error?.message ?? '未知原因'}`)
        error.code = 'CHECK_FAILED'
        throw error
      }
      if (checked.check.state === 'current') {
        const error = new Error('已经是最新 commit')
        error.code = 'ALREADY_LATEST'
        throw error
      }
    }
    const targetCommit = confirmed ?? checked.check.latest
    const previous = { version: view.installed.version, commit: installedCommit }
    const snapshot = { ...view }
    const job = runner.start(name, async ({ requestId, onStep, log, signal }) => {
      onStep('checking', `已确认目标 ${targetCommit.slice(0, 7)}`)
      onStep('removing', `正在卸载 ${name}`)
      const result = await runUpdate({
        manager,
        profileDir,
        name,
        source,
        enabled: bundle.enabled === true,
        previous,
        targetCommit,
        pinCommits: config.pinCommits,
        hmr: hmr === true,
        requestId,
        signal,
        onStep,
        onLog: log,
      })
      // 安装/回滚都可能改写锁文件；下一次读列表必须看到新内容。
      lockCache = undefined
      if (result.verified === true) {
        await recordCheck(profileDir, name, {
          at: new Date().toISOString(),
          state: 'current',
          latest: targetCommit,
          transport: checked?.check?.transport,
          ref: checked?.check?.ref ?? source.ref ?? 'HEAD',
        })
      }
      const at = new Date().toISOString()
      await recordUpdate(profileDir, name, {
        at,
        from: previous,
        to: { commit: targetCommit, version: result.to?.version },
        spec: result.spec,
        verified: result.verified,
        application: result.application,
        ...(result.restartReason === undefined ? {} : { restartReason: result.restartReason }),
        error: result.error,
        restore: result.restore === undefined ? undefined : { spec: result.restore.spec, application: result.restore.result?.application },
      })
      // 只有装完且宿主明说要重启，才留下「待重启」；否则清掉本包可能残留的旧标记。
      if (result.verified === true && result.application === 'restart-required') {
        await recordRestartPending(profileDir, name, {
          commit: targetCommit,
          at,
          bootId,
          ...(result.restartReason === undefined ? {} : { reason: result.restartReason }),
        })
        log('warn', '安装完成，重启 DSH 后生效')
      } else if (result.verified === true) {
        await clearRestartPending(profileDir, name)
      } else if (result.restore !== undefined) {
        log('warn', `已回滚：${result.restore.spec}`)
      }
      if (result.verified !== true) logger?.warn?.(`[git-updates] ${name} 更新失败：${result.error?.message ?? '未知原因'}`)
      return result
    }, { snapshot })
    return { jobId: job.id, package: name, targetCommit, job: summarizeJob(job) }
  }

  /**
   * 后台巡检：把所有受管 Git 插件顺序查一遍（有更新任务在跑时跳过）。
   * 默认关闭；profile 里显式配置 backgroundCheckMs 才启用。
   * @returns {Promise<{ skipped: boolean, checked: number, behind: number, failed: number }>} 巡检结果。
   */
  let sweeping = false
  const sweep = async () => {
    if (runner.active() !== undefined) return { skipped: true, checked: 0, behind: 0, failed: 0 }
    if (sweeping) return { skipped: true, checked: 0, behind: 0, failed: 0 }
    sweeping = true
    const summary = { skipped: false, checked: 0, behind: 0, failed: 0 }
    try {
      for (const view of await list()) {
        if (runner.active() !== undefined) break
        if (typeof view.source !== 'string' || view.sticky === true) continue
        try {
          const checked = await check(view.package, { force: true })
          summary.checked += 1
          if (checked.check?.state === 'behind') summary.behind += 1
        } catch {
          summary.failed += 1
        }
      }
    } finally {
      sweeping = false
    }
    logger?.info?.(`[git-updates] 后台巡检：检查 ${summary.checked} 个包，${summary.behind} 个有更新，${summary.failed} 个失败`)
    return summary
  }

  /**
   * 取任务状态。
   * @param {string} id 任务 id。
   * @returns {any} 任务视图或 undefined。
   */
  const job = id => {
    const found = runner.view(id)
    return found === undefined ? undefined : summarizeJob(found)
  }

  /**
   * 取消当前任务（真正停止交给宿主 cancelInstall）。
   * @returns {{ cancelled: boolean }} 是否请求了取消。
   */
  const cancel = () => {
    const active = runner.active()
    const cancelled = runner.cancel()
    if (cancelled && active?.requestId !== undefined) {
      Promise.resolve(manager.cancelInstall?.(active.requestId)).catch(() => {})
    }
    return { cancelled }
  }

  /**
   * 宿主流式日志：只收当前任务 requestId 的输出，按行追加。
   * @param {{ requestId?: string, stream?: string, text?: string }} chunk 安装日志块。
   * @returns {void}
   */
  const onInstallLog = chunk => {
    const requestId = chunk?.requestId
    if (typeof requestId !== 'string') return
    const text = typeof chunk?.text === 'string' ? chunk.text : ''
    const level = chunk?.stream === 'stderr' ? 'warn' : 'info'
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed !== '') runner.addLog(requestId, level, trimmed.slice(0, 500))
    }
  }

  /**
   * 宿主的安装阶段：写进任务日志，让「安装中」不是一句干等。
   * @param {{ requestId?: string, phase?: string, attempt?: { index?: number, total?: number } }} progress 阶段。
   * @returns {void}
   */
  const onInstallState = progress => {
    const requestId = progress?.requestId
    if (typeof requestId !== 'string') return
    const phase = INSTALL_PHASE_TEXT[progress.phase] ?? '正在安装'
    const attempt = progress.attempt
    const suffix = phase === INSTALL_PHASE_TEXT.installing && attempt !== undefined && attempt.total > 1
      ? `（源 ${String(attempt.index)}/${String(attempt.total)}）`
      : ''
    runner.addLog(requestId, 'info', `${phase}${suffix}`)
  }

  return {
    profileDir,
    config,
    bootId,
    ready,
    sweep,
    list,
    view: async name => (await describe(name)).view,
    check,
    update,
    job,
    cancel,
    activeJob: () => (runner.active() === undefined ? null : summarizeJob(runner.active())),
    onInstallLog,
    onInstallState,
  }
}
