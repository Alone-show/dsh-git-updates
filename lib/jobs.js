/**
 * 更新任务的登记簿：同一时刻只允许一个更新在跑。
 *
 * 任务视图自带四步状态（检查上游 → 卸载 → 安装 → 校验）、每步起止与耗时、
 * 整体耗时和最近日志，设置页直接照着画进度，不需要额外拼装。
 * 已完成的保留最近若干个，供轮询到终态；`snapshot` 存的是开跑前的插件行，
 * 这样包被卸载、从 listBundles() 消失时，页面仍能保留那一行。
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
  /** @type {any | undefined} */
  #active
  /** @type {AbortController | undefined} */
  #abort

  /**
   * 当前正在跑的任务。
   * @returns {any | undefined} 任务。
   */
  active() {
    return this.#active
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
   * 启动一个任务。
   * @param {string} packageName 包名。
   * @param {(context: {
   *   requestId: string,
   *   onStep: (step: string, message: string) => void,
   *   log: (level: 'info'|'warn'|'error', message: string) => void,
   *   signal: AbortSignal,
   * }) => Promise<any>} run 任务体。
   * @param {{ snapshot?: any }} [options] snapshot 是开跑前的插件行。
   * @returns {any} 任务。
   */
  start(packageName, run, options = {}) {
    if (this.#active !== undefined) {
      const error = new Error('已有更新任务在运行')
      error.code = 'JOB_RUNNING'
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
    this.#active = job
    this.#abort = abort

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
        if (this.#active === job) this.#active = undefined
        this.#abort = undefined
        this.#trim()
      })
    return job
  }

  /**
   * 把宿主流式输出（pnpm / git）追加到当前任务的日志里。
   * 只有 requestId 与当前任务一致才收，避免把别的安装写进来。
   * @param {string} requestId 安装请求 id。
   * @param {'info'|'warn'|'error'} level 级别。
   * @param {string} message 一行文本。
   * @returns {void}
   */
  addLog(requestId, level, message) {
    const job = this.#active
    if (job === undefined || job.requestId !== requestId) return
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
   * 请求取消当前任务；真正停止由任务体调用宿主的 cancelInstall 完成。
   * @returns {boolean} 是否有任务被请求取消。
   */
  cancel() {
    if (this.#active === undefined || this.#abort === undefined) return false
    this.#active.status = 'cancelling'
    this.#active.message = '正在取消'
    this.#abort.abort()
    return true
  }

  /** 只留最近若干个已完成任务（包括仍在 cancelling 的）。 */
  #trim() {
    const finished = [...this.#jobs.values()].filter(job => job.status !== 'running' && job.status !== 'cancelling')
    for (const job of finished.slice(0, Math.max(0, finished.length - RETAINED))) this.#jobs.delete(job.id)
  }
}
