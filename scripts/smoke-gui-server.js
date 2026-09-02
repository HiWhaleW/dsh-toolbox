import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const guiRoot = join(repositoryRoot, 'packages', 'dsh-switchboard-gui')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-switchboard-gui-smoke-'))
const blocker = createServer((_request, response) => response.writeHead(204).end())
let ownsBlocker = false
let child

async function occupyDefaultPort() {
  await new Promise((resolvePromise, reject) => {
    blocker.once('error', error => {
      if (error.code === 'EADDRINUSE') resolvePromise()
      else reject(error)
    })
    blocker.listen(4173, '127.0.0.1', () => {
      ownsBlocker = true
      resolvePromise()
    })
  })
}

async function waitForUrl() {
  let output = ''
  return await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`GUI server did not report a URL\n${output}`)), 10_000)
    const append = chunk => {
      output += chunk.toString('utf8')
      const match = output.match(/DSH Switchboard GUI: (http:\/\/127\.0\.0\.1:(\d+))/)
      if (!match) return
      clearTimeout(timer)
      resolvePromise({ url: match[1], port: Number(match[2]), output })
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`GUI server exited with ${code}\n${output}`))
    })
  })
}

try {
  await occupyDefaultPort()
  child = spawn(process.execPath, [join(guiRoot, 'server', 'index.js')], {
    cwd: guiRoot,
    env: {
      ...process.env,
      DSH_HOME: join(temporaryRoot, 'dsh-home'),
      DSH_SWITCHBOARD_DATA_DIR: join(temporaryRoot, 'switchboard-data'),
      PATH: `${join(guiRoot, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const started = await waitForUrl()
  assert.notEqual(started.port, 4173)
  assert.match(started.output, /port 4173 is busy/)

  const page = await fetch(`${started.url}/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/)
  assert.match(await page.text(), /<div id="root"><\/div>/)

  const bootstrap = await fetch(`${started.url}/api/bootstrap`)
  assert.equal(bootstrap.status, 200)
  const payload = await bootstrap.json()
  assert.equal(payload.localOnly, true)
  assert.equal(payload.dshHome, join(temporaryRoot, 'dsh-home'))

  process.stdout.write(`GUI smoke passed: default-port conflict recovered at ${started.url}; page and bootstrap API returned 200.\n`)
} finally {
  child?.kill('SIGTERM')
  if (ownsBlocker) await new Promise(resolvePromise => blocker.close(resolvePromise))
  await rm(temporaryRoot, { recursive: true, force: true })
}
