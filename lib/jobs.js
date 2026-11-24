/**
 * 更新任务的登记簿。
 *
 * 每个包同时最多一个任务；不同包可以并行更新（宿主插件管理器用 profile
 * 写锁把真正的 pnpm/卸载/安装串起来，所以并行是安全的，页面上各看各的进度）。
 * 任务视图自带四步状态（检查上游 → 卸载 → 安装 → 校验）、每步起止与耗时、
 * 整体耗时和最近日志；`snapshot` 存的是开跑前的插件行，这样包被卸载、
 * 从 listBundles() 消失时，页面仍能保留那一行。
 */

import { randomUUID } from 'node:crypto'

/** 固定步骤顺序；client.js 的步骤条与它一致。 */
export const STEP_SEQUENCE = Object.freeze(['checking', 'removing', 'installing', 'verifying'])

/** 任务日志只留最近这么多条，避免长任务把内存和响应体撑大。 */
export const LOG_LIMIT = 50

/** 留多少个已完成任务，够设置页轮询到终态。 */
const RETAINED = 20

/**
 * 造一份四步状态。
 * @returns {Array<{ step: string, status: string, startedAt?: string, finishedAt?: string, durationMs?: number }>} 步骤。
 */
function initialSteps() {
  return STEP_SEQUENCE.map(step => ({ step, status: 'pending' }))
}

/**
 * 给一个步骤收尾（没开始过的按开始时刻补上）。
 * @param {any} step 步骤。
 * @param {string} status `done` / `failed`。
 * @param {number} startedMs 步骤开始的毫秒时间戳。
 * @returns {void}
 */
function finishStep(step, status, startedMs) {
  if (step.status === 'done' || step.status === 'failed') return
  if (typeof step.startedAt !== 'string') step.startedAt = new Date(startedMs).toISOString()
  step.status = status
  step.finishedAt = new Date().toISOString()
  step.durationMs = Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt))
}

/**
 * 任务运行器。
 */
export class JobRunner {
  /** @type {Map<string, any>} */
  #jobs = new Map()
  /** @type {Map<string, AbortController>} */
  #aborts = new Map()
  /** @type {Map<string, any>} requestId → 任务，用于把宿主流式日志接进来。 */
  #byRequest = new Map()

  /**
   * 当前仍在跑的第一任务（兼容旧调用；新代码用 `activeJobs()`）。
   * @returns {any | undefined} 任务。
   */
  active() {
    return this.activeJobs()[0]
  }

  /**
   * 所有仍在跑的任务。
   * @returns {any[]} 任务数组（按创建顺序）。
   */
  activeJobs() {
    return [...this.#jobs.values()].filter(job => job.status === 'running' || job.status === 'cancelling')
  }

  /**
   * 正在跑的任务数。
   * @returns {number} 数量。
   */
  runningCount() {
    return this.activeJobs().length
  }

  /**
   * 取一个任务（含已完成的）。
   * @param {string} id 任务 id。
   * @returns {any | undefined} 任务。
   */
  view(id) {
    return this.#jobs.get(id)
  }

  /**
   * 全部登记的任务，供「粘性行」判断哪些包正在/刚刚更新过。
   * @returns {any[]} 任务数组（按创建顺序）。
   */
  entries() {
    return [...this.#jobs.values()]
  }

  /**
   * 启动一个任务；同一个包已有任务时拒绝，超过并发上限也拒绝。
   * @param {string} packageName 包名。
   * @param {(context: {
   *   requestId: string,
   *   onStep: (step: string, message: string) => void,
   *   log: (level: 'info'|'warn'|'error', message: string) => void,
   *   signal: AbortSignal,
   * }) => Promise<any>} run 任务体。
   * @param {{ snapshot?: any, maxConcurrent?: number }} [options] snapshot 是开跑前的插件行；
   *   maxConcurrent 是同时允许的任务数。
   * @returns {any} 任务。
   */
  start(packageName, run, options = {}) {
    const samePackage = this.activeJobs().find(job => job.packageName === packageName)
    if (samePackage !== undefined) {
      const error = new Error('这个插件已经有一个更新任务在运行')
      error.code = 'JOB_RUNNING'
      throw error
    }
    const maxConcurrent = typeof options.maxConcurrent === 'number' ? options.maxConcurrent : Number.POSITIVE_INFINITY
    if (this.runningCount() >= maxConcurrent) {
      const error = new Error('同时更新的插件太多了，等一个完成后再试')
      error.code = 'JOB_LIMIT'
      throw error
    }
    const id = randomUUID()
    const requestId = `git-updates-${randomUUID()}`
    const abort = new AbortController()
    const startedMs = Date.now()
    const steps = initialSteps()
    steps[0].status = 'running'
    steps[0].startedAt = new Date(startedMs).toISOString()
    /** @type {any} */
    const job = {
      id,
      packageName,
      requestId,
      step: 'checking',
      status: 'running',
      message: '正在检查上游',
      startedAt: steps[0].startedAt,
      finishedAt: null,
      steps,
      logs: [],
      result: undefined,
      error: undefined,
      snapshot: options.snapshot,
    }
    Object.defineProperty(job, 'elapsedMs', {
      enumerable: true,
      get() {
        const end = typeof job.finishedAt === 'string' ? Date.parse(job.finishedAt) : Date.now()
        return Math.max(0, end - startedMs)
      },
    })
    this.#jobs.set(id, job)
    this.#aborts.set(id, abort)
    this.#byRequest.set(requestId, job)

    const currentStep = () => steps.find(step => step.status === 'running') ?? steps.at(-1)
    const log = (level, message) => this.#append(job, level, message)
    const onStep = (step, message) => {
      const index = STEP_SEQUENCE.indexOf(step)
      if (index >= 0) {
        const now = Date.now()
        for (let cursor = 0; cursor < index; cursor += 1) finishStep(steps[cursor], 'done', startedMs)
        const target = steps[index]
        if (target.status === 'done' || target.status === 'failed') return
        for (let cursor = index; cursor < steps.length; cursor += 1) {
          if (steps[cursor].status === 'running' && cursor !== index) finishStep(steps[cursor], 'done', startedMs)
        }
        if (target.status !== 'running') {
          target.status = 'running'
          target.startedAt = new Date(now).toISOString()
        }
        job.step = step
      }
      job.message = String(message)
      log('info', message)
    }

    Promise.resolve()
      .then(() => run({ requestId, onStep, log, signal: abort.signal }))
      .then(result => {
        job.result = result
        if (result?.verified === false) {
          const failed = currentStep()
          if (failed !== undefined) finishStep(failed, 'failed', startedMs)
          job.status = 'failed'
          job.step = 'failed'
          job.message = '更新失败'
          const reason = result?.error?.message ?? '校验未通过'
          log('error', `更新失败：${reason}`)
          job.error = result?.error ?? { code: 'UPDATE_FAILED', message: reason }
        } else {
          for (const step of steps) finishStep(step, 'done', startedMs)
          job.status = 'done'
          job.step = 'done'
          job.message = '更新完成'
          log('info', '更新完成')
        }
      }, error => {
        const failed = currentStep()
        if (failed !== undefined) finishStep(failed, 'failed', startedMs)
        job.status = 'failed'
        job.step = 'failed'
        job.error = { code: error?.code ?? 'UPDATE_FAILED', message: String(error?.message ?? error) }
        job.message = job.error.message
        log('error', `更新失败：${job.error.message}`)
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString()
        this.#aborts.delete(id)
        this.#byRequest.delete(requestId)
        this.#trim()
      })
    return job
  }

  /**
   * 把宿主流式输出（pnpm / git）追加到对应任务的日志里。
   * @param {string} requestId 安装请求 id。
   * @param {'info'|'warn'|'error'} level 级别。
   * @param {string} message 一行文本。
   * @returns {void}
   */
  addLog(requestId, level, message) {
    const job = this.#byRequest.get(requestId)
    if (job === undefined) return
    this.#append(job, level, message)
  }

  /**
   * 追加一条日志，超过上限丢最旧的。
   * @param {any} job 任务。
   * @param {'info'|'warn'|'error'} level 级别。
   * @param {string} message 文本。
   * @returns {void}
   */
  #append(job, level, message) {
    job.logs.push({ at: new Date().toISOString(), level, message: String(message) })
    if (job.logs.length > LOG_LIMIT) job.logs.splice(0, job.logs.length - LOG_LIMIT)
  }

  /**
   * 请求取消一个任务；真正停止由任务体调用宿主的 cancelInstall 完成。
   * @param {string} jobId 任务 id。
   * @returns {any | undefined} 被请求取消的任务；任务不存在或已结束返回 undefined。
   */
  cancel(jobId) {
    const job = this.#jobs.get(jobId)
    if (job === undefined || (job.status !== 'running' && job.status !== 'cancelling')) return undefined
    job.status = 'cancelling'
    job.message = '正在取消'
    this.#aborts.get(jobId)?.abort()
    return job
  }

  /** 只留最近若干个已完成任务；运行中的任务永远保留。 */
  #trim() {
    const finished = [...this.#jobs.values()].filter(job => job.status !== 'running' && job.status !== 'cancelling')
    for (const job of finished.slice(0, Math.max(0, finished.length - RETAINED))) {
      this.#jobs.delete(job.id)
      this.#aborts.delete(job.id)
      this.#byRequest.delete(job.requestId)
    }
  }
}
