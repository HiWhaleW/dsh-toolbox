import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { DshAdapter } from '../index.js'

test('detect executes an npm-style .cmd shim on Windows without enabling a shell', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh switchboard windows-'))
  const bin = join(root, 'npm global bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'dsh-shim.cjs'), 'if (process.argv[2] === "--version") console.log("0.1.0-rc.6")\n')
  await writeFile(join(bin, 'dsh.cmd'), '@echo off\r\nnode "%~dp0dsh-shim.cjs" %*\r\n')
  const adapter = new DshAdapter({
    home: join(root, 'home'),
    dataDir: join(root, 'data'),
    env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  })
  t.after(async () => {
    adapter.close()
    await rm(root, { recursive: true, force: true })
  })

  const detected = await adapter.detect()
  assert.equal(detected.installed, true)
  assert.equal(detected.version, '0.1.0-rc.6')
})
