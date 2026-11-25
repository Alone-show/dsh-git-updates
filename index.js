/**
 * dsh-git-updates —— 宿主半侧。
 *
 * 做四件事，别的都在 lib/ 里：
 *   1. 认领 profile 里 github: / git+https: / git@host: 安装的插件（来源解析见 lib/git-source.js）；
 *   2. 读 pnpm-lock.yaml 拿到「实际装的是哪个 commit」；
 *   3. 注册同源路由 /api/dsh-git-updates，把「检查上游」「更新到目标 commit」
 *      「取消」暴露给设置页（见 lib/route.js 与 client.js）；
 *   4. 把宿主 plugin-manager 的安装日志/阶段转给任务，让设置页的进度看得见。
 *
 * 真正的包变更全部委托给宿主插件管理器（ctx.pluginManager）：
 * removeBundle → installBundle → 校验 → 失败时把原 spec 装回去，
 * 不自己跑 pnpm。浏览器半侧只拿到结果，拿不到任何凭据。
 */

import { readFileSync } from 'node:fs'
import { resolveConfig } from './lib/config.js'
import { createRoute, ROUTE_PATH } from './lib/route.js'
import { createService } from './lib/service.js'

/** 插件名，便于诊断与日志前缀。 */
export const name = 'git-updates'

/** 宿主服务依赖：插件管理器做包变更，profileContext 给出 profile 目录。 */
export const inject = ['pluginManager', 'profileContext']

/**
 * 读本包名字：设置页会列出所有 Git 来源插件，本工具自己不允许在自身页面更新。
 * @returns {string | undefined} 包名。
 */
function readOwnPackageName() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof manifest.name === 'string' ? manifest.name : undefined
  } catch {
    return undefined
  }
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {Record<string, unknown>} [config] profile 补丁行里的 config。
 */
export async function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const profileDir = ctx.profileContext?.dir
  if (typeof profileDir !== 'string' || profileDir === '') {
    ctx.logger?.warn?.('[git-updates] 读不到 profile 目录，插件不启用')
    return
  }
  if (ctx.pluginManager === undefined) {
    ctx.logger?.warn?.('[git-updates] 没有 pluginManager 服务，插件不启用')
    return
  }

  const service = createService({
    manager: ctx.pluginManager,
    profileDir,
    config: resolved,
    ownPackage: readOwnPackageName(),
    logger: ctx.logger,
  })
  // 启动对账先完成，页面第一次读到的就是「重启后已清掉待重启」的干净状态。
  await service.ready

  // 安装日志与阶段事件：只收当前任务的 requestId，写进任务日志。
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return
    const offLog = ctx.on('plugin-manager/install-log', chunk => { service.onInstallLog(chunk) })
    const offState = ctx.on('plugin-manager/install-state', progress => { service.onInstallState(progress) })
    return () => {
      offLog()
      offState()
    }
  }, 'git-updates: 安装日志')

  // 后台巡检默认关闭（backgroundCheckMs: 0）；设置页打开时会自行检查。
  ctx.effect(() => {
    if (resolved.backgroundCheckMs <= 0) return
    const start = setTimeout(() => { void service.sweep() }, resolved.backgroundCheckStartMs)
    const timer = setInterval(() => { void service.sweep() }, resolved.backgroundCheckMs)
    return () => {
      clearTimeout(start)
      clearInterval(timer)
    }
  }, 'git-updates: 后台巡检')

  ctx.inject(['connection'], child => {
    if (typeof child.connection?.fetch?.register !== 'function') {
      ctx.logger?.warn?.('[git-updates] 没有 connection.fetch，路由未注册')
      return
    }
    child.effect(
      () => child.connection.fetch.register(createRoute(service, resolved)),
      `git-updates: ${ROUTE_PATH}`,
    )
    ctx.logger?.info?.(`[git-updates] 已挂载 ${ROUTE_PATH}（profile: ${profileDir}）`)
  })
}
