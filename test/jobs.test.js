import { strict as assert } from 'node:assert'
import test from 'node:test'
import { JobRunner, STEP_SEQUENCE } from '../lib/jobs.js'

/**
 * 等到任务不再处于 running / cancelling。
 * @param {JobRunner} runner 运行器。
 * @param {string} id 任务 id。
 * @returns {Promise<any>} 任务视图。
 */
async function settled(runner, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = runner.view(id)
    if (job !== undefined && job.status !== 'running' && job.status !== 'cancelling') return job
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('job did not settle')
}

test('a new job exposes the four steps with the first one running', () => {
  const runner = new JobRunner()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const job = runner.start('pkg', async () => { await gate; return { verified: true } })
  assert.equal(job.status, 'running')
  assert.equal(job.step, 'checking')
  assert.deepEqual(job.steps.map(step => step.step), [...STEP_SEQUENCE])
  assert.equal(job.steps[0].status, 'running')
  assert.equal(job.steps[1].status, 'pending')
  assert.equal(typeof job.steps[0].startedAt, 'string')
  assert.equal(job.elapsedMs >= 0, true)
  assert.equal(runner.active().id, job.id)
  release()
})

test('each step records its end time and duration', async () => {
  const runner = new JobRunner()
  const job = runner.start('pkg', async ({ onStep }) => {
    onStep('removing', '正在卸载 pkg')
    await new Promise(resolve => setTimeout(resolve, 5))
    onStep('installing', '正在安装 pkg')
    onStep('verifying', '正在校验')
    return { verified: true }
  })
  const done = await settled(runner, job.id)
  assert.equal(done.status, 'done')
  assert.equal(done.step, 'done')
  const [checking, removing, installing, verifying] = done.steps
  assert.equal(checking.status, 'done')
  assert.equal(removing.status, 'done')
  assert.equal(installing.status, 'done')
  assert.equal(verifying.status, 'done')
  assert.equal(typeof removing.durationMs, 'number')
  assert.equal(removing.durationMs >= 0, true)
  assert.equal(done.elapsedMs >= 0, true)
  assert.equal(done.logs.some(entry => entry.message === '正在卸载 pkg'), true)
})

test('a failed job marks the running step failed and keeps the error message', async () => {
  const runner = new JobRunner()
  const job = runner.start('pkg', async () => { throw Object.assign(new Error('安装失败'), { code: 'INSTALL_FAILED' }) })
  const failed = await settled(runner, job.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.step, 'failed')
  assert.equal(failed.error.code, 'INSTALL_FAILED')
  assert.equal(failed.steps[0].status, 'failed')
  assert.equal(failed.logs.at(-1).level, 'error')
})

test('a result that did not verify settles the job as failed', async () => {
  const runner = new JobRunner()
  const job = runner.start('pkg', async () => ({ verified: false, error: { code: 'VERIFY_FAILED', message: '校验未通过' } }))
  const failed = await settled(runner, job.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.message, '更新失败')
})

test('logs keep only the newest entries', async () => {
  const runner = new JobRunner()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const job = runner.start('pkg', async ({ log }) => {
    for (let index = 0; index < 80; index += 1) log(index % 10 === 0 ? 'warn' : 'info', `line ${index}`)
    await gate
    return { verified: true }
  })
  release()
  const done = await settled(runner, job.id)
  assert.equal(done.logs.length, 50)
  assert.equal(done.logs.at(-1).message, '更新完成')
  assert.equal(done.logs.some(entry => entry.message === 'line 79'), true)
  assert.equal(done.logs.some(entry => entry.message === 'line 0'), false)
  assert.equal(done.logs.some(entry => entry.level === 'warn'), true)
})

test('cancelling flips the job to failed once the run settles', async () => {
  const runner = new JobRunner()
  const job = runner.start('pkg', async ({ signal }) => {
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(signal.aborted, true)
    return { verified: false, error: { code: 'CANCELLED', message: '已取消' } }
  })
  assert.equal(runner.cancel(), true)
  assert.equal(runner.view(job.id).status, 'cancelling')
  const done = await settled(runner, job.id)
  assert.equal(done.status, 'failed')
  assert.equal(done.result.error.code, 'CANCELLED')
  assert.equal(runner.cancel(), false)
})

test('a second job is refused while one runs', async () => {
  const runner = new JobRunner()
  let release
  const gate = new Promise(resolve => { release = resolve })
  runner.start('pkg', async () => { await gate; return { verified: true } })
  assert.throws(() => runner.start('other', async () => ({ verified: true })), error => error.code === 'JOB_RUNNING')
  release()
})

test('old finished jobs are dropped once the retained window is exceeded', async () => {
  const runner = new JobRunner()
  const ids = []
  for (let index = 0; index < 22; index += 1) {
    const job = runner.start(`pkg-${index}`, async () => ({ verified: true }))
    ids.push(job.id)
    await settled(runner, job.id)
  }
  assert.equal(runner.view(ids[0]), undefined)
  assert.notEqual(runner.view(ids.at(-1)), undefined)
})
