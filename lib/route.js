/**
 * 同源路由：GET /api/dsh-git-updates 与 POST /api/dsh-git-updates。
 *
 * 只暴露六个动作，且 `package` 必须是插件管理器里真实存在的受管包，
 * 不接受任意包名——这里不是通用包管理器。
 */

/** 路由路径；client.js 里的 ENDPOINT 必须与它一致。 */
export const ROUTE_PATH = '/api/dsh-git-updates'

/** 失败码到 HTTP 状态。 */
const STATUS = Object.freeze({
  NOT_FOUND: 404,
  NOT_MANAGED: 404,
  UNKNOWN_INSTALLED_COMMIT: 409,
  STALE_VIEW: 409,
  ALREADY_LATEST: 409,
  JOB_RUNNING: 409,
  SELF_UPDATE: 409,
  CHECK_FAILED: 502,
  INVALID_BODY: 400,
  INVALID_ACTION: 400,
  BODY_TOO_LARGE: 413,
  INTERNAL: 500,
})

/**
 * 造一个 JSON 响应。
 * @param {number} status HTTP 状态。
 * @param {unknown} body 响应体。
 * @returns {Response} 响应。
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 造错误响应。
 * @param {unknown} error 抛出的错误。
 * @returns {Response} 响应。
 */
function failure(error) {
  const code = typeof error?.code === 'string' && Object.hasOwn(STATUS, error.code) ? error.code : 'INTERNAL'
  return json(STATUS[code] ?? 500, { ok: false, error: { code, message: String(error?.message ?? error) } })
}

/**
 * 造路由描述对象，交给 `ctx.connection.fetch.register`。
 * @param {any} service 业务层。
 * @param {{ maxBodyBytes: number }} config 配置。
 * @returns {{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }} 路由。
 */
export function createRoute(service, config) {
  /**
   * 处理 GET。
   * @param {Request} request 请求。
   * @returns {Promise<Response>} 响应。
   */
  const get = async request => {
    const url = new URL(request.url)
    const jobId = url.searchParams.get('jobId')
    if (jobId !== null) {
      const job = service.job(jobId)
      if (job === undefined) return json(404, { ok: false, error: { code: 'JOB_NOT_FOUND', message: '没有这个任务' } })
      return json(200, { ok: true, job })
    }
    const name = url.searchParams.get('package')
    const probe = url.searchParams.get('probe') === '1'
    if (name === null || name === '') {
      const views = await service.list({ probe })
      return json(200, { ok: true, packages: views, activeJob: service.activeJob() ?? null })
    }
    const view = probe ? await service.check(name, { force: url.searchParams.get('force') === '1' }) : await service.view(name)
    if (view === undefined) return json(404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个包' } })
    return json(200, { ok: true, package: view, activeJob: service.activeJob() ?? null })
  }

  /**
   * 处理 POST。
   * @param {Request} request 请求。
   * @returns {Promise<Response>} 响应。
   */
  const post = async request => {
    const type = request.headers.get('content-type') ?? ''
    if (!type.toLowerCase().includes('application/json')) {
      return json(415, { ok: false, error: { code: 'INVALID_BODY', message: '请求体必须是 application/json' } })
    }
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > config.maxBodyBytes) {
      return json(413, { ok: false, error: { code: 'BODY_TOO_LARGE', message: '请求体过大' } })
    }
    /** @type {any} */
    let body
    try {
      body = text === '' ? {} : JSON.parse(text)
    } catch {
      return json(400, { ok: false, error: { code: 'INVALID_BODY', message: '请求体不是合法 JSON' } })
    }
    const action = typeof body?.action === 'string' ? body.action : ''
    const name = typeof body?.package === 'string' ? body.package.trim() : ''
    if (action === 'cancel') {
      if (body?.confirm !== true) return json(400, { ok: false, error: { code: 'INVALID_BODY', message: '取消也需要 confirm:true' } })
      return json(200, { ok: true, ...service.cancel() })
    }
    if (name === '') return json(400, { ok: false, error: { code: 'INVALID_BODY', message: '缺少 package' } })
    if (action === 'check') {
      const view = await service.check(name, { force: body?.force === true })
      return json(200, { ok: true, package: view })
    }
    if (action === 'update') {
      if (body?.confirm !== true) {
        return json(400, { ok: false, error: { code: 'INVALID_BODY', message: '更新需要 confirm:true' } })
      }
      const started = await service.update(name, {
        expectedCommit: typeof body?.expectedCommit === 'string' ? body.expectedCommit : undefined,
        targetCommit: typeof body?.targetCommit === 'string' ? body.targetCommit : undefined,
        force: body?.force === true,
      })
      return json(200, { ok: true, ...started })
    }
    return json(400, { ok: false, error: { code: 'INVALID_ACTION', message: 'action 必须是 check / update / cancel' } })
  }

  return {
    path: ROUTE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') return await get(request)
        if (request.method === 'POST') return await post(request)
        return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET/POST' } })
      } catch (error) {
        return failure(error)
      }
    },
  }
}
