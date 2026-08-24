import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url)
const rootManifest = JSON.parse(await readFile(join(root.pathname, 'package.json'), 'utf8'))
const packages = [
  'product-research-workbench',
  'context-switchboard',
  'plugin-preflight',
  'compatibility-radar',
]

for (const packageName of packages) {
  const directory = join(root.pathname, 'packages', packageName)
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== `@dsh-toolbox/${packageName}`) {
    throw new Error(`${packageName}: unexpected package name`)
  }
  if (manifest.version !== rootManifest.version) {
    throw new Error(`${packageName}: version ${manifest.version} does not match workspace ${rootManifest.version}`)
  }
  if (manifest.dependencies?.['@deepseek-ai/dsh-tools']) {
    throw new Error(`${packageName}: DSH Tools must not be a production dependency; a duplicate runtime breaks scheduler symbol identity`)
  }
  if (manifest.peerDependencies?.['@deepseek-ai/dsh-tools'] !== '0.1.1-rc.2') {
    throw new Error(`${packageName}: must peer-pin the loader-smoked DSH Tools runtime`)
  }
  if (manifest.devDependencies?.['@deepseek-ai/dsh-tools'] !== '0.1.1-rc.2') {
    throw new Error(`${packageName}: must keep DSH Tools available for local development only`)
  }
  if (manifest.license !== 'SEE LICENSE IN LICENSE') {
    throw new Error(`${packageName}: must point users to the packaged noncommercial license`)
  }
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error(`${packageName}: missing DSH profile bundle patch`)
  }
  for (const path of ['index.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    await access(join(directory, path))
  }
  const patch = await readFile(join(directory, 'cordis.patch.yml'), 'utf8')
  if (!patch.includes(`name: '${manifest.name}'`)) throw new Error(`${packageName}: bundle patch does not mount its package name`)
  if ((manifest.scripts ?? {}).preinstall || (manifest.scripts ?? {}).install || (manifest.scripts ?? {}).postinstall || (manifest.scripts ?? {}).prepare) {
    throw new Error(`${packageName}: install lifecycle scripts require an explicit security review`)
  }
}

const switchboardDir = join(root.pathname, 'packages', 'dsh-switchboard')
const switchboard = JSON.parse(await readFile(join(switchboardDir, 'package.json'), 'utf8'))
if (switchboard.name !== '@dsh-toolbox/dsh-switchboard' || switchboard.private !== true) {
  throw new Error('dsh-switchboard: control plane must remain a private workspace package during technical preview')
}
if (switchboard.dsh?.bundle) throw new Error('dsh-switchboard: external control plane must not declare itself as an in-process DSH bundle')
if (switchboard.scripts?.preinstall || switchboard.scripts?.install || switchboard.scripts?.postinstall || switchboard.scripts?.prepare) {
  throw new Error('dsh-switchboard: install lifecycle scripts require an explicit security review')
}
for (const path of ['index.js', 'bin/dsh-switchboard.js', 'src/dsh-adapter.js', 'README.md', 'LICENSE']) {
  await access(join(switchboardDir, path))
}
if (await readFile(join(switchboardDir, 'LICENSE'), 'utf8') !== await readFile(join(root.pathname, 'LICENSE'), 'utf8')) {
  throw new Error('dsh-switchboard: packaged noncommercial license must match the repository license exactly')
}

console.log(`Validated ${packages.length} DSH profile bundles and the external Switchboard control plane.`)
