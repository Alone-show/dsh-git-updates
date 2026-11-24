/**
 * 「那一行不能消失」：更新要先卸载再安装，包在卸载阶段会从
 * `pluginManager.listBundles()` 里消失，页面如果只按实时列表渲染，
 * 正在更新的那一行会直接没了，进度也无处显示。
 *
 * 这里把「实时行 + 任务开跑前的快照」合成一份稳定列表：
 *   · 实时行还在 → 用它，并挂上该包最近的任务（进度）；
 *   · 实时行暂时消失、但该包有任务在跑（或刚结束不久）→ 用快照补一行，
 *     标 `sticky: true`，进度照常显示；
 *   · 没有任务、也没有实时行 → 不补，避免把用户已卸载的插件一直挂着。
 *
 * 纯函数：不读写文件、不碰网络，单测直接覆盖。
 */

/** 完成后还保留多久的粘性行，够页面轮询到终态并展示结论。 */
export const STICKY_KEEP_MS = 30 * 60 * 1000

/** 日志与步骤这些字段原样给前端，但裁掉宿主返回到大对象。 */
const RESULT_KEYS = ['verified', 'application', 'restartReason', 'spec', 'specifier']

/**
 * 把一次更新的结果压成前端要用的摘要。
 * @param {any} result `runUpdate` 的返回值。
 * @returns {any | undefined} 摘要。
 */
export function summarizeResult(result) {
  if (result === null || typeof result !== 'object') return undefined
  const summary = {}
  for (const key of RESULT_KEYS) if (result[key] !== undefined) summary[key] = result[key]
  if (result.from !== undefined) summary.from = { version: result.from.version, commit: result.from.commit }
  if (result.to !== undefined) summary.to = { version: result.to.version, commit: result.to.commit }
  if (result.error !== undefined) {
    summary.error = { code: result.error.code, message: result.error.message }
  }
  if (result.restore !== undefined) {
    summary.restore = {
      spec: result.restore.spec,
      application: result.restore.result?.application,
      verified: result.restore.verified,
      error: result.restore.result?.error === undefined
        ? undefined
        : { code: result.restore.result.error.code, message: result.restore.result.error.diagnostic },
    }
  }
  return summary
}

/**
 * 一个任务给前端看的进度摘要。
 * @param {any} job 任务。
 * @returns {any} 摘要。
 */
export function summarizeJob(job) {
  if (job === null || typeof job !== 'object') return undefined
  return {
    id: job.id,
    package: job.packageName,
    step: job.step,
    status: job.status,
    message: job.message,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: job.elapsedMs,
    steps: Array.isArray(job.steps)
      ? job.steps.map(step => ({
        step: step.step,
        status: step.status,
        durationMs: step.durationMs,
      }))
      : [],
    logs: Array.isArray(job.logs) ? job.logs.slice(-50) : [],
    result: summarizeResult(job.result),
    error: job.error === undefined || job.error === null
      ? undefined
      : { code: job.error.code, message: job.error.message },
  }
}

/**
 * 合并实时行与任务快照。
 * @param {any[]} liveViews 本次 `listBundles()` 得到的行。
 * @param {any[]} jobs 任务登记簿里的任务（含已完成的）。
 * @param {{ now?: number, keepMs?: number }} [options] 保留窗口。
 * @returns {any[]} 稳定列表，每行可能带 `job`，补出来的行带 `sticky: true`。
 */
export function mergeSticky(liveViews, jobs, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const keepMs = typeof options.keepMs === 'number' ? options.keepMs : STICKY_KEEP_MS
  /** @type {Map<string, any>} */
  const rows = new Map()
  for (const view of liveViews) {
    if (view === null || typeof view !== 'object' || typeof view.package !== 'string') continue
    rows.set(view.package, { ...view })
  }

  // 同一个包可能有多个历史任务；后面的覆盖前面的，取最近一次。
  for (const job of jobs) {
    if (job === null || typeof job !== 'object' || typeof job.packageName !== 'string') continue
    const live = rows.get(job.packageName)
    const running = job.status === 'running' || job.status === 'cancelling'
    const finishedAt = typeof job.finishedAt === 'string' ? Date.parse(job.finishedAt) : Number.NaN
    const recent = Number.isFinite(finishedAt) && now - finishedAt <= keepMs
    if (live !== undefined) {
      live.job = summarizeJob(job)
      continue
    }
    if (!running && !recent) continue
    const snapshot = job.snapshot
    if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.package !== 'string') continue
    rows.set(job.packageName, {
      ...snapshot,
      // 快照是开跑前的状态；包此刻确实不在 listBundles() 里。
      installedMissing: true,
      sticky: true,
      job: summarizeJob(job),
    })
  }
  return [...rows.values()].sort((left, right) => String(left.package).localeCompare(String(right.package)))
}
