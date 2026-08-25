import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DshAdapter } from './dsh-adapter.js'

const HELP = `DSH Switchboard — local profile and plugin control plane

Usage:
  dsh-switchboard detect [--home PATH]
  dsh-switchboard profiles [--home PATH]
  dsh-switchboard inspect PROFILE [--home PATH]
  dsh-switchboard health PROFILE [--home PATH]
  dsh-switchboard bundle enable PROFILE PACKAGE [--apply] [--skip-runtime-validation]
  dsh-switchboard bundle disable PROFILE PACKAGE [--apply] [--skip-runtime-validation]
  dsh-switchboard bundle move PROFILE PACKAGE --index N [--apply] [--skip-runtime-validation]
  dsh-switchboard plan PROFILE --bundles PACKAGE[,PACKAGE...] [--out FILE]
  dsh-switchboard apply PLAN.json [--skip-runtime-validation]
  dsh-switchboard preflight PATH [--dsh-tools VERSION --cordis VERSION] [--node VERSION]
  dsh-switchboard report PROFILE [--audit] [--dsh-tools VERSION --cordis VERSION] [--node VERSION]
  dsh-switchboard history [--limit N]
  dsh-switchboard backup PROFILE
  dsh-switchboard rollback TRANSACTION [--force] [--skip-runtime-validation]

Mutating bundle commands print a plan by default. Add --apply only after reviewing it.
DSH_HOME defaults to the environment value, then ~/.dsh. Output is JSON.
`

function parse(argv) {
  const positionals = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) { positionals.push(token); continue }
    const key = token.slice(2)
    if (['apply', 'force', 'audit', 'skip-runtime-validation', 'help'].includes(key)) { options[key] = true; continue }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value`)
    options[key] = value
    index += 1
  }
  return { positionals, options }
}

function targetFrom(options) {
  const requested = options['dsh-tools'] || options.cordis || options.node
  if (!requested) return null
  if (!options['dsh-tools'] || !options.cordis) throw new Error('--dsh-tools and --cordis must be provided together')
  return { dshToolsVersion: options['dsh-tools'], cordisVersion: options.cordis, nodeVersion: options.node ?? process.versions.node }
}

function print(value, stdout) {
  stdout.write(JSON.stringify(value, null, 2) + '\n')
}

async function bundlePlan(adapter, verb, profileName, packageName, options) {
  if (!profileName || !packageName) throw new Error(`bundle ${verb} requires PROFILE and PACKAGE`)
  const profile = await adapter.readProfile(profileName)
  let bundles = [...profile.bundles]
  if (verb === 'enable') {
    if (!bundles.includes(packageName)) bundles.push(packageName)
  } else if (verb === 'disable') {
    bundles = bundles.filter(value => value !== packageName)
  } else if (verb === 'move') {
    if (!bundles.includes(packageName)) throw new Error(`${packageName} is not an active bundle`)
    const targetIndex = Number(options.index)
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= bundles.length) throw new Error('--index must be a zero-based active bundle index')
    bundles.splice(bundles.indexOf(packageName), 1)
    bundles.splice(targetIndex, 0, packageName)
  } else throw new Error(`Unknown bundle action: ${verb}`)
  return adapter.planBundleChange(profileName, bundles, { reason: `CLI bundle ${verb}` })
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout
  const { positionals, options } = parse(argv)
  const [command, ...args] = positionals
  if (!command || command === 'help' || options.help) { stdout.write(HELP); return 0 }
  const adapter = new DshAdapter({ home: options.home, dataDir: options['data-dir'], commandRunner: io.commandRunner, env: io.env })
  try {
    if (command === 'detect') print(await adapter.detect(), stdout)
    else if (command === 'profiles') print(await adapter.discoverProfiles(), stdout)
    else if (command === 'inspect') print(await adapter.readProfile(args[0]), stdout)
    else if (command === 'health') print(await adapter.healthCheck(args[0]), stdout)
    else if (command === 'bundle') {
      const plan = await bundlePlan(adapter, args[0], args[1], args[2], options)
      print(options.apply ? await adapter.apply(plan, { validateRuntime: !options['skip-runtime-validation'] }) : plan, stdout)
    } else if (command === 'plan') {
      if (!args[0] || options.bundles === undefined) throw new Error('plan requires PROFILE and --bundles')
      const bundles = options.bundles === '' ? [] : options.bundles.split(',').map(value => value.trim())
      const plan = await adapter.planBundleChange(args[0], bundles, { reason: options.reason })
      if (options.out) {
        const outputPath = resolve(options.out)
        await writeFile(outputPath, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 })
        print({ plan: outputPath, id: plan.id, changes: plan.changes, warnings: plan.warnings }, stdout)
      } else print(plan, stdout)
    } else if (command === 'apply') {
      if (!args[0]) throw new Error('apply requires a plan JSON path')
      const plan = JSON.parse(await readFile(resolve(args[0]), 'utf8'))
      print(await adapter.apply(plan, { validateRuntime: !options['skip-runtime-validation'] }), stdout)
    } else if (command === 'preflight') {
      if (!args[0]) throw new Error('preflight requires a local plugin path')
      print(await adapter.preflightPlugin(resolve(args[0]), targetFrom(options)), stdout)
    } else if (command === 'report') {
      if (!args[0]) throw new Error('report requires PROFILE')
      print(await adapter.writeProfileReport(args[0], { audit: Boolean(options.audit), target: targetFrom(options), outputDir: options.out }), stdout)
    } else if (command === 'history') {
      print(adapter.history({ limit: options.limit === undefined ? 20 : Number(options.limit) }), stdout)
    } else if (command === 'backup') {
      if (!args[0]) throw new Error('backup requires PROFILE')
      print(await adapter.backup(args[0], { reason: 'CLI manual backup' }), stdout)
    } else if (command === 'rollback') {
      if (!args[0]) throw new Error('rollback requires a transaction id')
      print(await adapter.rollback(args[0], { force: Boolean(options.force), validateRuntime: !options['skip-runtime-validation'] }), stdout)
    } else throw new Error(`Unknown command: ${command}`)
    return 0
  } finally {
    adapter.close()
  }
}

export { HELP }
