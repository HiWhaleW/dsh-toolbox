import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CompatibilityRadar } from '../src/radar.js'
import { registerRadarTools } from '../src/tools.js'
import { satisfiesRange } from '../src/semver.js'

const packagesRoot = new URL('../../', import.meta.url).pathname
const pluginPaths = ['product-research-workbench', 'context-switchboard', 'plugin-preflight', 'compatibility-radar'].map(name => join(packagesRoot, name))

test('supports the common current DSH plugin semver ranges', () => {
  assert.equal(satisfiesRange('0.1.1-rc.2', '>=0.1.0-rc.5 <0.2.0'), true)
  assert.equal(satisfiesRange('0.2.0', '>=0.1.0-rc.5 <0.2.0'), false)
  assert.equal(satisfiesRange('4.0.1', '^4.0.1'), true)
  assert.equal(satisfiesRange('5.0.0', '^4.0.1'), false)
  assert.equal(satisfiesRange('24.1.0', '^22.19.0 || >=24.0.0'), true)
  assert.equal(satisfiesRange('22.19.1', '>=22.19'), true)
  assert.equal(satisfiesRange('22.18.9', '>=22.19'), false)
})

test('saves and diffs compatibility snapshots without upgrading anything', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-radar-'))
  const radar = new CompatibilityRadar({ dataDir })
  try {
    const before = await radar.snapshot({ label: 'rc2', dshToolsVersion: '0.1.1-rc.2', cordisVersion: '4.0.1', nodeVersion: '24.1.0', pluginPaths })
    assert.equal(before.summary.compatible, 4)
    const after = await radar.snapshot({ label: 'breaking', dshToolsVersion: '0.2.0', cordisVersion: '5.0.0', nodeVersion: '24.1.0', pluginPaths })
    assert.equal(after.summary.incompatible, 4)
    const diff = radar.diff({ beforeId: before.id, afterId: after.id })
    assert.equal(diff.upgradeRisk, 'review-required')
    assert.equal(diff.regressions.length, 4)
    assert.equal(diff.recommendations.length, 4)
    const report = await radar.report({ beforeId: before.id, afterId: after.id, format: 'both' })
    assert.equal(report.reports.length, 2)
    const discovered = await radar.discover({ roots: [packagesRoot], maxDepth: 2 })
    assert.equal(discovered.plugins.length, 4)
    assert.ok(discovered.scannedDirectories >= 4)
    const inferred = await radar.inferTarget({ manifestPath: join(packagesRoot, 'compatibility-radar', 'package.json') })
    assert.equal(inferred.dshToolsVersion, '0.1.1-rc.2')
    assert.equal(inferred.cordisVersion, '4.0.1')
  } finally {
    radar.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('DSH infer tool honors the session cwd for relative manifest paths', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-radar-tool-'))
  const radar = new CompatibilityRadar({ dataDir })
  try {
    const registered = []
    registerRadarTools({ tools: { register: tool => registered.push(tool) } }, radar)
    const tool = registered.find(item => item.name === 'compatibility_infer_target')
    const result = await tool.execute({ manifestPath: 'compatibility-radar/package.json' }, { agent: { session: { header: { cwd: packagesRoot } } } })
    assert.equal(result.dshToolsVersion, '0.1.1-rc.2')
    await assert.rejects(tool.execute({ manifestPath: '../package.json' }, { agent: { session: { header: { cwd: packagesRoot } } } }), /outside allowed roots/)
  } finally {
    radar.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('escapes snapshot labels in HTML reports', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-radar-html-'))
  const radar = new CompatibilityRadar({ dataDir })
  try {
    const args = { dshToolsVersion: '0.1.1-rc.2', cordisVersion: '4.0.1', nodeVersion: '24.1.0', pluginPaths }
    const before = await radar.snapshot({ ...args, label: '<img src=x onerror=alert(1)>' })
    const after = await radar.snapshot({ ...args, label: 'safe' })
    const report = await radar.report({ beforeId: before.id, afterId: after.id, format: 'html' })
    const html = await readFile(report.reports[0].path, 'utf8')
    assert.doesNotMatch(html, /<img src=x/i)
    assert.match(html, /&lt;img src=x/)
  } finally {
    radar.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
