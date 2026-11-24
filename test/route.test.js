import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createRoute, ROUTE_PATH } from '../lib/route.js'

const config = { maxBodyBytes: 512 }

/**
 * 造一个记录调用的假业务层。
 */
function fakeService(overrides = {}) {
  const calls = []
  const view = { package: 'pkg', applicable: true, installed: { version: '1.0.0', commit: 'a'.repeat(40) } }
  return {
    calls,
    profileDir: '/tmp/profile',
    list: async options => { calls.push(['list', options]); return [view] },
    view: async name => { calls.push(['view', name]); return name === 'pkg' ? view : undefined },
    check: async (name, options) => { calls.push(['check', name, options]); return { ...view, check: { state: 'behind', latest: 'b'.repeat(40) } } },
    update: async (name, options) => { calls.push(['update', name, options]); return { jobId: 'job-1', package: name, targetCommit: 'b'.repeat(40) } },
    job: id => (id === 'job-1'
      ? {
        id,
        status: 'running',
        step: 'installing',
        steps: [{ step: 'checking', status: 'done' }, { step: 'removing', status: 'done' }, { step: 'installing', status: 'running' }, { step: 'verifying', status: 'pending' }],
        logs: [{ at: '2026-11-24T08:00:00.000Z', level: 'info', message: '正在安装' }],
        elapsedMs: 1200,
      }
      : undefined),
    cancel: target => { calls.push(['cancel', target]); return { cancelled: true } },
    activeJobs: () => [],
    ...overrides,
  }
}

function post(body, headers = { 'content-type': 'application/json' }) {
  return new Request(`http://localhost${ROUTE_PATH}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

test('GET a package view and the whole list', async () => {
  const service = fakeService()
  const route = createRoute(service, config)
  assert.equal(route.path, ROUTE_PATH)
  assert.deepEqual(route.methods, ['GET', 'POST'])

  const single = await route.fetch(new Request(`http://localhost${ROUTE_PATH}?package=pkg`))
  assert.equal(single.status, 200)
  const singleBody = await single.json()
  assert.equal(singleBody.ok, true)
  assert.equal(singleBody.package.package, 'pkg')

  const list = await route.fetch(new Request(`http://localhost${ROUTE_PATH}`))
  const listBody = await list.json()
  assert.equal(listBody.packages.length, 1)
  assert.deepEqual(listBody.activeJobs, [])

  const missing = await route.fetch(new Request(`http://localhost${ROUTE_PATH}?package=nope`))
  assert.equal(missing.status, 404)
})

test('GET a job and an unknown job', async () => {
  const route = createRoute(fakeService(), config)
  const found = await route.fetch(new Request(`http://localhost${ROUTE_PATH}?jobId=job-1`))
  assert.equal(found.status, 200)
  const foundBody = await found.json()
  assert.equal(foundBody.job.id, 'job-1')
  assert.equal(foundBody.job.steps.length, 4)
  assert.equal(foundBody.job.steps[2].status, 'running')
  assert.equal(foundBody.job.logs[0].message, '正在安装')
  assert.equal(foundBody.job.elapsedMs, 1200)
  const missing = await route.fetch(new Request(`http://localhost${ROUTE_PATH}?jobId=zzz`))
  assert.equal(missing.status, 404)
})

test('POST check and probe query', async () => {
  const service = fakeService()
  const route = createRoute(service, config)
  const response = await route.fetch(post({ action: 'check', package: 'pkg' }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).package.check.state, 'behind')
  assert.deepEqual(service.calls.at(-1), ['check', 'pkg', { force: false }])

  const probed = await route.fetch(new Request(`http://localhost${ROUTE_PATH}?package=pkg&probe=1`))
  assert.equal(probed.status, 200)
})

test('POST update requires confirm and passes the expected commit', async () => {
  const service = fakeService()
  const route = createRoute(service, config)
  const refused = await route.fetch(post({ action: 'update', package: 'pkg' }))
  assert.equal(refused.status, 400)

  const accepted = await route.fetch(post({ action: 'update', package: 'pkg', confirm: true, expectedCommit: 'a'.repeat(40) }))
  assert.equal(accepted.status, 200)
  assert.equal((await accepted.json()).jobId, 'job-1')
  assert.deepEqual(service.calls.at(-1), ['update', 'pkg', { expectedCommit: 'a'.repeat(40), targetCommit: undefined, force: false }])
  const withTarget = await route.fetch(post({ action: 'update', package: 'pkg', confirm: true, targetCommit: 'b'.repeat(40) }))
  assert.equal(withTarget.status, 200)
  assert.deepEqual(service.calls.at(-1), ['update', 'pkg', { expectedCommit: undefined, targetCommit: 'b'.repeat(40), force: false }])
})

test('POST cancel, invalid action and missing fields', async () => {
  const service = fakeService()
  const route = createRoute(service, config)
  const cancelled = await route.fetch(post({ action: 'cancel', confirm: true, jobId: 'job-1' }))
  assert.equal(cancelled.status, 200)
  assert.equal((await cancelled.json()).cancelled, true)
  assert.deepEqual(service.calls.at(-1), ['cancel', { jobId: 'job-1' }])

  const invalid = await route.fetch(post({ action: 'nope', package: 'pkg' }))
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'INVALID_ACTION')

  const missing = await route.fetch(post({ action: 'check' }))
  assert.equal(missing.status, 400)
})

test('POST rejects a non-JSON content type, oversized and malformed bodies', async () => {
  const route = createRoute(fakeService(), config)
  const wrongType = await route.fetch(post({ action: 'check', package: 'pkg' }, { 'content-type': 'text/plain' }))
  assert.equal(wrongType.status, 415)

  const huge = await route.fetch(post({ action: 'check', package: 'x'.repeat(600) }))
  assert.equal(huge.status, 413)

  const malformed = await route.fetch(post('{nope'))
  assert.equal(malformed.status, 400)
})

test('an error from the service maps to its HTTP status', async () => {
  const service = fakeService({
    update: async () => {
      const error = new Error('已经是最新 commit')
      error.code = 'ALREADY_LATEST'
      throw error
    },
  })
  const route = createRoute(service, config)
  const response = await route.fetch(post({ action: 'update', package: 'pkg', confirm: true }))
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'ALREADY_LATEST')
})

test('unsupported methods are refused', async () => {
  const route = createRoute(fakeService(), config)
  const response = await route.fetch(new Request(`http://localhost${ROUTE_PATH}`, { method: 'DELETE' }))
  assert.equal(response.status, 405)
})

test('a self update refusal maps to 409', async () => {
  const service = fakeService({
    update: async () => {
      const error = new Error('不能在自身页面更新本工具，请到插件页处理')
      error.code = 'SELF_UPDATE'
      throw error
    },
  })
  const route = createRoute(service, config)
  const response = await route.fetch(post({ action: 'update', package: 'pkg', confirm: true }))
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'SELF_UPDATE')
})
