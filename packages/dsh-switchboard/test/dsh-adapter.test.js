import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshAdapter, assertProfileName, resolveDshHome } from '../index.js'

const BASE = '@deepseek-ai/dsh-base'
const EXAMPLE = '@example/research-bundle'

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-switchboard-'))
  const home = join(root, 'home')
  const dataDir = join(root, 'data')
  const profileDir = join(home, 'profiles', 'toolbox')
  const packageDir = join(profileDir, 'node_modules', '@example', 'research-bundle')
  await mkdir(packageDir, { recursive: true })
  const manifest = {
    name: 'dsh-profile-toolbox',
    private: true,
    dependencies: { [EXAMPLE]: 'file:fixture' },
    dsh: { profile: { bundles: options.bundles ?? [BASE] } },
  }
  await writeFile(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: EXAMPLE,
    version: '1.2.3',
    type: 'module',
    main: './index.js',
    files: ['index.js', 'cordis.patch.yml', 'LICENSE'],
    license: 'MIT',
    engines: { node: '>=22.19.0' },
    dependencies: { '@deepseek-ai/dsh-tools': '0.1.1-rc.2' },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n')
  await writeFile(join(packageDir, 'index.js'), 'export function apply() {}\n')
  await writeFile(join(packageDir, 'cordis.patch.yml'), `- insert:\n    - id: research\n      name: '${EXAMPLE}'\n`)
  await writeFile(join(packageDir, 'LICENSE'), 'MIT\n')
  const calls = []
  const commandRunner = options.commandRunner ?? (async request => {
    calls.push(request)
    return { ok: true, code: 0, stdout: request.args[0] === '--version' ? '0.1.1-rc.2\n' : '# valid config\n', stderr: '' }
  })
  const adapter = new DshAdapter({ home, dataDir, commandRunner })
  return { root, home, dataDir, profileDir, packageDir, manifest, adapter, calls }
}

test('resolves DSH_HOME with official precedence and rejects unsafe profile names', () => {
  assert.equal(resolveDshHome('/explicit', { DSH_HOME: '/environment' }), '/explicit')
  assert.equal(resolveDshHome(undefined, { DSH_HOME: '/environment' }), '/environment')
  assert.match(resolveDshHome(undefined, { DSH_HOME: '   ' }), /\.dsh$/)
  for (const name of ['', '.', '..', 'node_modules', '../escape', 'a/b', 'a\\b']) assert.throws(() => assertProfileName(name))
  assert.equal(assertProfileName('toolbox'), 'toolbox')
})

test('discovers profiles without following a symlinked profile directory', async t => {
  const setup = await fixture()
  t.after(() => setup.adapter.close())
  await symlink(setup.profileDir, join(setup.home, 'profiles', 'linked'))
  const result = await setup.adapter.discoverProfiles()
  assert.deepEqual(result.profiles.map(item => item.name), ['toolbox'])
  assert.deepEqual(result.skipped, [{ name: 'linked', reason: 'symlink-profile-not-followed' }])
  const profile = await setup.adapter.readProfile('toolbox')
  assert.deepEqual(profile.bundles, [BASE])
  assert.equal(profile.inactiveBundleDependencies[0].packageName, EXAMPLE)
})

test('resolves bundle manifests from the DSH installation fallback before profile-local copies', async t => {
  const setup = await fixture({ bundles: [EXAMPLE] })
  t.after(() => setup.adapter.close())
  const installedDir = join(setup.home, 'profiles', 'node_modules', '@example', 'research-bundle')
  await mkdir(installedDir, { recursive: true })
  await writeFile(join(installedDir, 'package.json'), JSON.stringify({
    name: EXAMPLE,
    version: '9.9.9',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n')

  const profile = await setup.adapter.readProfile('toolbox')
  assert.equal(profile.bundleDetails[0].source, 'installation-fallback')
  assert.equal(profile.bundleDetails[0].version, '9.9.9')
})

test('plans, atomically applies, records, validates, and rolls back a bundle change', async t => {
  const setup = await fixture()
  t.after(() => setup.adapter.close())
  const plan = await setup.adapter.planBundleChange('toolbox', [BASE, EXAMPLE])
  assert.deepEqual(plan.changes.additions, [EXAMPLE])
  assert.deepEqual((await setup.adapter.readProfile('toolbox')).bundles, [BASE])

  const receipt = await setup.adapter.apply(plan)
  assert.equal(receipt.status, 'applied')
  assert.deepEqual((await setup.adapter.readProfile('toolbox')).bundles, [BASE, EXAMPLE])
  assert.equal(setup.calls.at(-1).args.join(' '), '--profile toolbox --dump-config')
  assert.match(await readFile(join(receipt.backupDir, 'package.json'), 'utf8'), /dsh-profile-toolbox/)
  assert.equal(setup.adapter.history().transactions[0].id, plan.id)

  const rolledBack = await setup.adapter.rollback(plan.id)
  assert.equal(rolledBack.status, 'rolled-back')
  assert.deepEqual((await setup.adapter.readProfile('toolbox')).bundles, [BASE])
})

test('rejects a stale plan without writing a transaction', async t => {
  const setup = await fixture()
  t.after(() => setup.adapter.close())
  const plan = await setup.adapter.planBundleChange('toolbox', [BASE, EXAMPLE])
  const changed = { ...setup.manifest, description: 'edited elsewhere' }
  await writeFile(join(setup.profileDir, 'package.json'), JSON.stringify(changed, null, 2) + '\n')
  await assert.rejects(setup.adapter.apply(plan), /Stale plan/)
  assert.equal(setup.adapter.history().transactions.length, 0)
  assert.match(await readFile(join(setup.profileDir, 'package.json'), 'utf8'), /edited elsewhere/)
})

test('rejects a tampered transaction id before it can affect backup paths', async t => {
  const setup = await fixture()
  t.after(() => setup.adapter.close())
  const plan = await setup.adapter.planBundleChange('toolbox', [BASE, EXAMPLE])
  plan.id = '../../outside'
  await assert.rejects(setup.adapter.apply(plan), /generated UUID/)
  assert.equal(setup.adapter.history().transactions.length, 0)
})

test('automatically restores the manifest after runtime validation fails', async t => {
  const setup = await fixture({ commandRunner: async () => ({ ok: false, code: 1, stdout: '', stderr: 'invalid patch' }) })
  t.after(() => setup.adapter.close())
  const before = await readFile(join(setup.profileDir, 'package.json'), 'utf8')
  const plan = await setup.adapter.planBundleChange('toolbox', [BASE, EXAMPLE])
  await assert.rejects(setup.adapter.apply(plan), /runtime validation failed/i)
  assert.equal(await readFile(join(setup.profileDir, 'package.json'), 'utf8'), before)
  assert.equal(setup.adapter.history().transactions[0].status, 'rolled-back')
})

test('rollback refuses to overwrite a later user edit', async t => {
  const setup = await fixture()
  t.after(() => setup.adapter.close())
  const plan = await setup.adapter.planBundleChange('toolbox', [BASE, EXAMPLE])
  await setup.adapter.apply(plan)
  const manifestPath = join(setup.profileDir, 'package.json')
  const current = JSON.parse(await readFile(manifestPath, 'utf8'))
  current.description = 'keep this edit'
  await writeFile(manifestPath, JSON.stringify(current, null, 2) + '\n')
  await assert.rejects(setup.adapter.rollback(plan.id), /changed after this transaction/)
  assert.match(await readFile(manifestPath, 'utf8'), /keep this edit/)
})

test('integrates Preflight and Compatibility Radar and writes private local reports', async t => {
  const setup = await fixture({ bundles: [EXAMPLE] })
  t.after(() => setup.adapter.close())
  const result = await setup.adapter.preflightPlugin(setup.packageDir, {
    dshToolsVersion: '0.1.1-rc.2',
    cordisVersion: '4.0.1',
    nodeVersion: process.versions.node,
  })
  assert.equal(result.preflight.package, EXAMPLE)
  assert.equal(result.compatibility.summary.compatible, 1)

  const report = await setup.adapter.writeProfileReport('toolbox', { audit: true, target: {
    dshToolsVersion: '0.1.1-rc.2',
    cordisVersion: '4.0.1',
    nodeVersion: process.versions.node,
  } })
  assert.equal(report.reports.length, 2)
  assert.match(await readFile(report.reports[0].path, 'utf8'), /DSH Profile: toolbox/)
  assert.match(await readFile(report.reports[1].path, 'utf8'), /<!doctype html>/)
})
