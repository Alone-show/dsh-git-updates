/**
 * 插件配置：不做 schema 校验（bundle 以 link:/git 安装时不带第三方依赖），
 * 只把 profile 里那一行的 config 归一成一份确定形状，非法值退回默认。
 */

/** 默认值；cordis.patch.yml 的注释与 README 必须和这里保持一致。 */
export const DEFAULTS = Object.freeze({
  probeTimeoutMs: 15000,
  sshFallback: true,
  pinCommits: true,
  cacheTtlMs: 600000,
  // 设置页打开时会自动检查，后台巡检默认关闭，避免无人在看时也走网络。
  backgroundCheckMs: 0,
  backgroundCheckStartMs: 60000,
  maxBodyBytes: 8192,
  gitCommand: 'git',
  // 包名 → 跟踪分支。保存的 spec 被钉成 commit 后，用它指明插件真正在哪个分支上。
  trackedRefs: Object.freeze({}),
})

/**
 * 取一个有限数值，越界夹到区间里，非法值退回默认。
 * @param {unknown} value 配置里写的值。
 * @param {number} fallback 默认值。
 * @param {number} min 下限。
 * @param {number} max 上限。
 * @returns {number} 归一后的数值。
 */
function number(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 取一个布尔值，只有明确写 false 才关掉。
 * @param {unknown} value 配置里写的值。
 * @param {boolean} fallback 默认值。
 * @returns {boolean} 归一后的布尔值。
 */
function boolean(value, fallback) {
  if (value === undefined || value === null) return fallback
  return value !== false
}

/**
 * 把「包名 → 分支」的配置收成干净的普通对象。
 * @param {unknown} value profile 里的 trackedRefs。
 * @returns {Record<string, string>} 包名 → 分支。
 */
function trackedRefs(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  for (const [name, ref] of Object.entries(value)) {
    if (typeof name !== 'string' || name === '' || typeof ref !== 'string') continue
    const trimmed = ref.trim()
    if (trimmed !== '') normalized[name] = trimmed
  }
  return normalized
}

/**
 * 把 Loader 传进来的 config 归一。
 * @param {unknown} raw profile 补丁行里的 config。
 * @returns {typeof DEFAULTS} 归一后的配置。
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const command = typeof input.gitCommand === 'string' ? input.gitCommand.trim() : ''
  return {
    probeTimeoutMs: number(input.probeTimeoutMs, DEFAULTS.probeTimeoutMs, 1000, 120000),
    sshFallback: boolean(input.sshFallback, DEFAULTS.sshFallback),
    pinCommits: boolean(input.pinCommits, DEFAULTS.pinCommits),
    cacheTtlMs: number(input.cacheTtlMs, DEFAULTS.cacheTtlMs, 0, 24 * 60 * 60 * 1000),
    backgroundCheckMs: number(input.backgroundCheckMs, DEFAULTS.backgroundCheckMs, 0, 7 * 24 * 60 * 60 * 1000),
    backgroundCheckStartMs: number(input.backgroundCheckStartMs, DEFAULTS.backgroundCheckStartMs, 0, 24 * 60 * 60 * 1000),
    maxBodyBytes: number(input.maxBodyBytes, DEFAULTS.maxBodyBytes, 256, 1024 * 1024),
    gitCommand: command === '' ? DEFAULTS.gitCommand : command,
    trackedRefs: trackedRefs(input.trackedRefs),
  }
}
