import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDirectories = [
  'product-research-workbench',
  'context-switchboard',
  'plugin-preflight',
  'compatibility-radar',
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout ?? 120_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}\n${output}`)
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}\n${output}`)
  return output
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath
  const options = { env: { NPM_CONFIG_CACHE: join(temporaryRoot, 'npm-cache') } }
  if (npmCli && existsSync(npmCli)) return run(process.execPath, [npmCli, ...args], options)
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options)
}

async function resolveDshBin() {
  const candidates = [
    join(repositoryRoot, 'packages', 'dsh-switchboard-gui', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(repositoryRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  const manifestPath = candidates.find(existsSync)
  if (!manifestPath) throw new Error('Pinned @deepseek-ai/dsh is missing; run pnpm install --frozen-lockfile first')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (!bin) throw new Error('Pinned @deepseek-ai/dsh does not expose the dsh executable')
  return resolve(dirname(manifestPath), bin)
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-toolbox-cold-install-'))
try {
  const dist = join(temporaryRoot, 'dist')
  const dshHome = join(temporaryRoot, 'dsh-home')
  const dataRoot = join(temporaryRoot, 'data')
  await mkdir(dist, { recursive: true })

  const tarballs = []
  for (const directory of bundleDirectories) {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, 'packages', directory, 'package.json'), 'utf8'))
    runNpm(['pack', '--workspace', manifest.name, '--pack-destination', dist])
    const filename = `${manifest.name.slice(1).replaceAll('/', '-')}-${manifest.version}.tgz`
    const tarball = join(dist, filename)
    assert.equal(existsSync(tarball), true, `npm pack did not create ${filename}`)
    tarballs.push(tarball)
  }

  const dshBin = await resolveDshBin()
  const dshEnv = { DSH_HOME: dshHome, NO_COLOR: '1' }
  const installOutput = run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', ...tarballs], { env: dshEnv })
  assert.doesNotMatch(installOutput, /Issues with peer dependencies/i)

  const profileManifest = JSON.parse(await readFile(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.deepEqual(profileManifest.dsh?.profile?.bundles?.slice(0, 2), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  for (const directory of bundleDirectories) {
    assert.equal(profileManifest.dsh.profile.bundles.includes(`@dsh-toolbox/${directory}`), true)
  }

  const dump = run(process.execPath, [dshBin, '--profile', 'web', '--dump-config'], { env: dshEnv })
  for (const id of ['product-research-workbench', 'context-switchboard', 'plugin-preflight', 'compatibility-radar']) {
    assert.match(dump, new RegExp(`id: ${id}(?:\\n|\\r)`))
  }

  const patchPath = join(temporaryRoot, 'isolated-data.patch.yml')
  const patch = bundleDirectories.map(id => [
    `- id: ${id}`,
    '  config:',
    `    dataDir: ${JSON.stringify(join(dataRoot, id))}`,
  ].join('\n')).join('\n') + '\n'
  await writeFile(patchPath, patch, 'utf8')
  const help = run(process.execPath, [dshBin, '--profile', 'web', '--patch', patchPath, '--help'], { env: dshEnv })
  assert.match(help, /Serve the DeepSeek Harness browser UI/)

  process.stdout.write('Cold-install smoke passed: packed 4 bundles, installed a fresh Web profile, composed all bundles, and booted the real Web entry.\n')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
