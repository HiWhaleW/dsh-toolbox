import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import spawn from 'cross-spawn'
import { scanPlugin } from '../../plugin-preflight/src/preflight.js'
import { CompatibilityRadar } from '../../compatibility-radar/src/radar.js'
import { formatProfileHtml, formatProfileMarkdown } from './report.js'
import { SwitchboardStore } from './store.js'

const PROFILE_MANIFEST = 'package.json'
const PROFILE_PATCH = 'cordis.patch.yml'
const PLAN_SCHEMA = 'dsh-switchboard/change-plan/v1'
const BACKUP_SCHEMA = 'dsh-switchboard/manual-backup/v1'
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function resolveDshHome(configured, env = process.env) {
  const selected = configured ?? (String(env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh'))
  const expanded = selected === '~'
    ? homedir()
    : selected.startsWith('~/') || selected.startsWith('~\\')
      ? join(homedir(), selected.slice(2))
      : selected
  return resolve(expanded)
}

export function assertProfileName(value) {
  const name = String(value ?? '')
  if (!name || name === '.' || name === '..' || name === 'node_modules' || name.includes('/') || name.includes('\\') || /[\0\r\n]/.test(name)) {
    throw new Error(`Invalid DSH profile name: ${JSON.stringify(name)}`)
  }
  return name
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function optionalLstat(path) {
  try { return await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function readManagedFile(path, { required = true, maxBytes = MAX_MANIFEST_BYTES } = {}) {
  const info = await optionalLstat(path)
  if (!info) {
    if (required) throw new Error(`Required file does not exist: ${path}`)
    return null
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Managed path must be a regular file, not a symlink: ${path}`)
  if (info.size > maxBytes) throw new Error(`Managed file exceeds ${maxBytes} bytes: ${path}`)
  return { info, raw: await readFile(path) }
}

function parseManifest(file) {
  let value
  try { value = JSON.parse(file.raw.toString('utf8')) } catch (error) {
    throw new Error(`Profile manifest is not valid JSON: ${error.message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profile manifest must contain a JSON object')
  return value
}

function normalizedBundles(manifest) {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('dsh.profile.bundles must be an array of non-empty package names')
  }
  const duplicates = bundles.filter((value, index) => bundles.indexOf(value) !== index)
  if (duplicates.length) throw new Error(`dsh.profile.bundles contains duplicates: ${[...new Set(duplicates)].join(', ')}`)
  return [...bundles]
}

function validBundleName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 214 && !/[\0\r\n\s]/.test(value)
}

function assertPlan(plan) {
  if (!plan || plan.schema !== PLAN_SCHEMA || plan.adapter !== 'dsh' || plan.action !== 'set-bundle-order') {
    throw new Error('Unsupported or invalid DSH Switchboard plan')
  }
  if (!TRANSACTION_ID.test(String(plan.id ?? ''))) throw new Error('Plan transaction id must be a generated UUID')
  if (!/^[0-9a-f]{64}$/i.test(String(plan.baseStateHash ?? ''))) throw new Error('Plan base state hash is invalid')
  if (!Array.isArray(plan.nextBundles)) throw new Error('Plan bundle list is invalid')
  return plan
}

function packageSegments(packageName) {
  return packageName.startsWith('@') ? packageName.split('/') : [packageName]
}

async function resolveBundleManifest(home, profileDir, packageName) {
  if (!validBundleName(packageName)) return null
  const segments = packageSegments(packageName)
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null
  const candidates = [
    { source: 'installation-fallback', path: join(home, 'profiles', 'node_modules', ...segments) },
    { source: 'profile', path: join(profileDir, 'node_modules', ...segments) },
  ]
  for (const candidate of candidates) {
    try {
      const packageDir = await realpath(candidate.path)
      const manifestFile = await readManagedFile(join(packageDir, PROFILE_MANIFEST))
      const manifest = parseManifest(manifestFile)
      return { ...candidate, packageDir, manifest }
    } catch (error) {
      if (error.code !== 'ENOENT') continue
    }
  }
  return null
}

async function defaultCommandRunner({ command, args, cwd, env, timeoutMs = 30_000 }) {
  return new Promise(resolveResult => {
    const maxBuffer = 4 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let failure = null
    let settled = false
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true })
    const finish = (code, error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const cause = failure ?? error
      resolveResult({
        ok: !cause && code === 0,
        code: cause?.code === 'ENOENT' ? 127 : Number.isInteger(code) ? code : Number.isInteger(cause?.code) ? cause.code : 1,
        stdout,
        stderr: stderr || cause?.message || '',
        notFound: cause?.code === 'ENOENT',
      })
    }
    const append = (stream, chunk) => {
      const text = chunk.toString('utf8')
      outputBytes += Buffer.byteLength(text)
      if (outputBytes > maxBuffer) {
        if (!failure) {
          failure = new Error(`DSH command output exceeded ${maxBuffer} bytes`)
          child.kill()
        }
        return stream
      }
      return stream + text
    }
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk) })
    child.once('error', error => finish(null, error))
    child.once('close', code => finish(code))
    const timer = setTimeout(() => {
      failure = new Error(`DSH command timed out after ${timeoutMs}ms`)
      child.kill()
    }, timeoutMs)
    timer.unref?.()
  })
}

async function atomicWrite(path, bytes, mode, transactionId) {
  const targetInfo = await optionalLstat(path)
  if (targetInfo?.isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${path}`)
  const temporary = join(dirname(path), `.${basename(path)}.dsh-switchboard-${transactionId}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', mode)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, path)
    try { await chmod(path, mode) } catch {}
  } catch (error) {
    try { await handle?.close() } catch {}
    try { await unlink(temporary) } catch {}
    throw error
  }
}

function isWithin(root, target) {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export class DshAdapter {
  constructor(config = {}) {
    this.name = 'dsh'
    this.home = resolveDshHome(config.home, config.env)
    this.profilesDir = join(this.home, 'profiles')
    this.command = config.command ?? 'dsh'
    this.commandRunner = config.commandRunner ?? defaultCommandRunner
    this.env = { ...process.env, ...(config.env ?? {}), DSH_HOME: this.home }
    this.store = config.store ?? new SwitchboardStore({ dataDir: config.dataDir })
    this.dataDir = this.store.dataDir
    this.closed = false
  }

  async detect() {
    const result = await this.commandRunner({ command: this.command, args: ['--version'], cwd: process.cwd(), env: this.env })
    return {
      adapter: this.name,
      installed: result.ok,
      command: this.command,
      version: result.ok ? String(result.stdout || result.stderr).trim() || null : null,
      home: this.home,
      ...(result.ok ? {} : { reason: result.notFound ? 'dsh command was not found on PATH' : String(result.stderr).trim().slice(0, 2_000) }),
    }
  }

  async discoverProfiles() {
    const profiles = []
    const skipped = []
    let entries
    try { entries = await readdir(this.profilesDir, { withFileTypes: true }) } catch (error) {
      if (error.code === 'ENOENT') return { home: this.home, profiles, skipped }
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'node_modules') continue
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        skipped.push({ name: entry.name, reason: entry.isSymbolicLink() ? 'symlink-profile-not-followed' : 'not-a-directory' })
        continue
      }
      try {
        const profile = await this.readProfile(entry.name)
        profiles.push({ name: profile.name, bundles: profile.bundles.length, dependencies: Object.keys(profile.dependencies).length, stateHash: profile.stateHash })
      } catch (error) {
        profiles.push({ name: entry.name, error: error.message })
      }
    }
    return { home: this.home, profiles, skipped }
  }

  async readProfile(inputName) {
    const name = assertProfileName(inputName)
    const dir = join(this.profilesDir, name)
    const directoryInfo = await optionalLstat(dir)
    if (!directoryInfo) throw new Error(`DSH profile does not exist: ${name}`)
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error(`Profile path must be a real directory, not a symlink: ${dir}`)
    const manifestPath = join(dir, PROFILE_MANIFEST)
    const manifestFile = await readManagedFile(manifestPath)
    const manifest = parseManifest(manifestFile)
    const bundles = normalizedBundles(manifest)
    const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies)
      ? { ...manifest.dependencies }
      : {}
    const patchPath = join(dir, PROFILE_PATCH)
    const patchFile = await readManagedFile(patchPath, { required: false, maxBytes: 8 * 1024 * 1024 })
    const bundleDetails = []
    for (const [index, packageName] of bundles.entries()) {
      const installed = await resolveBundleManifest(this.home, dir, packageName)
      bundleDetails.push({
        packageName,
        position: index,
        resolved: Boolean(installed),
        source: installed?.source ?? 'unresolved',
        packageDir: installed?.packageDir ?? null,
        version: installed?.manifest?.version ?? null,
        patch: installed?.manifest?.dsh?.bundle?.patch ?? null,
      })
    }
    const inactiveBundleDependencies = []
    for (const packageName of Object.keys(dependencies)) {
      if (bundles.includes(packageName)) continue
      const installed = await resolveBundleManifest(this.home, dir, packageName)
      if (installed?.manifest?.dsh?.bundle?.patch) inactiveBundleDependencies.push({
        packageName,
        version: installed.manifest.version ?? null,
        packageDir: installed.packageDir,
        patch: installed.manifest.dsh.bundle.patch,
      })
    }
    const patchRaw = patchFile?.raw ?? Buffer.alloc(0)
    return {
      adapter: this.name,
      name,
      dir,
      manifestPath,
      patchPath,
      manifest,
      dependencies,
      bundles,
      bundleDetails,
      inactiveBundleDependencies,
      manifestMode: manifestFile.info.mode & 0o777,
      manifestHash: hash(manifestFile.raw),
      patch: patchFile ? { exists: true, bytes: patchRaw.length, hash: hash(patchRaw) } : { exists: false, bytes: 0, hash: null },
      stateHash: hash(Buffer.concat([manifestFile.raw, Buffer.from('\0'), patchRaw])),
    }
  }

  async planBundleChange(inputName, inputBundles, options = {}) {
    const profile = await this.readProfile(inputName)
    if (!Array.isArray(inputBundles)) throw new Error('bundles must be an array')
    if (inputBundles.length > 100) throw new Error('bundles is capped at 100 entries')
    const nextBundles = inputBundles.map(value => String(value))
    if (nextBundles.some(value => !validBundleName(value))) throw new Error('Every bundle must be a non-empty package name without whitespace')
    const duplicates = nextBundles.filter((value, index) => nextBundles.indexOf(value) !== index)
    if (duplicates.length) throw new Error(`Bundle plan contains duplicates: ${[...new Set(duplicates)].join(', ')}`)
    const additions = nextBundles.filter(value => !profile.bundles.includes(value))
    for (const packageName of additions) {
      const candidate = profile.inactiveBundleDependencies.find(item => item.packageName === packageName)
      if (!candidate && !options.allowUnresolved) throw new Error(`${packageName} is not an installed inactive DSH bundle dependency`)
    }
    const removals = profile.bundles.filter(value => !nextBundles.includes(value))
    const moved = nextBundles.filter((value, index) => profile.bundles.includes(value) && profile.bundles.indexOf(value) !== index)
    const warnings = []
    if (removals.length) warnings.push('Disabled bundles remain installed and may be reactivated by a later successful `dsh plugin` reconciliation.')
    if (!nextBundles.some(value => value === '@deepseek-ai/dsh-base')) warnings.push('The plan does not include @deepseek-ai/dsh-base; the resulting profile may not boot a standard Harness surface.')
    return {
      schema: PLAN_SCHEMA,
      id: randomUUID(),
      adapter: this.name,
      action: 'set-bundle-order',
      profile: profile.name,
      baseStateHash: profile.stateHash,
      previousBundles: profile.bundles,
      nextBundles,
      changes: { additions, removals, moved },
      warnings,
      reason: String(options.reason ?? '').trim().slice(0, 500) || null,
      createdAt: new Date().toISOString(),
    }
  }

  async acquireLock(profileDir, transactionId) {
    const path = join(profileDir, '.dsh-switchboard.lock')
    let handle
    try {
      handle = await open(path, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ transactionId, pid: process.pid, createdAt: new Date().toISOString() }) + '\n')
      await handle.close()
      return path
    } catch (error) {
      try { await handle?.close() } catch {}
      if (error.code === 'EEXIST') throw new Error(`Another Switchboard change may be active; inspect and remove the stale lock if safe: ${path}`)
      throw error
    }
  }

  async createBackup(profile, transactionId) {
    const backups = join(this.dataDir, 'backups')
    const parent = join(backups, profile.name)
    const backupDir = join(parent, transactionId)
    for (const directory of [backups, parent]) {
      let info = await optionalLstat(directory)
      if (!info) {
        try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
        info = await lstat(directory)
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Backup path must be a real directory, not a symlink: ${directory}`)
      try { await chmod(directory, 0o700) } catch {}
    }
    await mkdir(backupDir, { mode: 0o700 })
    const manifest = await readManagedFile(profile.manifestPath)
    const patch = await readManagedFile(profile.patchPath, { required: false, maxBytes: 8 * 1024 * 1024 })
    await writeFile(join(backupDir, PROFILE_MANIFEST), manifest.raw, { mode: 0o600 })
    if (patch) await writeFile(join(backupDir, PROFILE_PATCH), patch.raw, { mode: 0o600 })
    await writeFile(join(backupDir, 'backup.json'), JSON.stringify({
      schema: 'dsh-switchboard/backup/v1',
      transactionId,
      profile: profile.name,
      manifestHash: hash(manifest.raw),
      patchHash: patch ? hash(patch.raw) : null,
      createdAt: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 })
    return backupDir
  }

  async recordManualBackup(profile, reason = 'Manual backup') {
    const id = randomUUID()
    const backupDir = await this.createBackup(profile, id)
    const verified = await this.readProfile(profile.name)
    if (verified.stateHash !== profile.stateHash) {
      await rm(backupDir, { recursive: true, force: true })
      throw new Error('Profile changed while the manual backup was being created')
    }
    const plan = {
      schema: BACKUP_SCHEMA,
      id,
      adapter: this.name,
      action: 'manual-backup',
      profile: profile.name,
      baseStateHash: profile.stateHash,
      previousBundles: profile.bundles,
      nextBundles: profile.bundles,
      changes: { additions: [], removals: [], moved: [] },
      reason,
      createdAt: new Date().toISOString(),
    }
    this.store.create({ plan, status: 'available', backupDir })
    return this.store.update(id, {
      result: {
        snapshotStateHash: profile.stateHash,
        bundles: profile.bundles,
        backedUpAt: new Date().toISOString(),
      },
    })
  }

  async backup(profileName, options = {}) {
    let profile = await this.readProfile(profileName)
    const lockId = randomUUID()
    const lockPath = await this.acquireLock(profile.dir, `${lockId}-backup`)
    try {
      profile = await this.readProfile(profile.name)
      return await this.recordManualBackup(profile, String(options.reason ?? 'Manual backup').slice(0, 500))
    } finally {
      try { await unlink(lockPath) } catch {}
    }
  }

  async restoreManualBackup(transaction, options = {}) {
    const backupDir = resolve(String(transaction.backupDir ?? ''))
    const backupsRoot = resolve(this.dataDir, 'backups')
    if (!transaction.backupDir || !isWithin(backupsRoot, backupDir)) throw new Error('Transaction backup path is outside the Switchboard backup root')
    let current = await this.readProfile(transaction.profile)
    const lockPath = await this.acquireLock(current.dir, `${transaction.id}-restore`)
    let recovery = null
    try {
      current = await this.readProfile(transaction.profile)
      recovery = await this.recordManualBackup(current, `Automatic recovery point before restoring ${transaction.id}`)
      const metadataFile = await readManagedFile(join(backupDir, 'backup.json'))
      const metadata = JSON.parse(metadataFile.raw.toString('utf8'))
      if (metadata.schema !== 'dsh-switchboard/backup/v1' || metadata.transactionId !== transaction.id || metadata.profile !== transaction.profile) {
        throw new Error('Backup metadata does not match the selected transaction')
      }
      const manifest = await readManagedFile(join(backupDir, PROFILE_MANIFEST))
      if (hash(manifest.raw) !== metadata.manifestHash) throw new Error('Backup manifest integrity check failed')
      const patch = metadata.patchHash ? await readManagedFile(join(backupDir, PROFILE_PATCH), { maxBytes: 8 * 1024 * 1024 }) : null
      if (patch && hash(patch.raw) !== metadata.patchHash) throw new Error('Backup patch integrity check failed')
      await atomicWrite(current.manifestPath, manifest.raw, current.manifestMode, `${transaction.id}-manual-restore`)
      if (patch) await atomicWrite(current.patchPath, patch.raw, 0o600, `${transaction.id}-manual-restore-patch`)
      else {
        const currentPatch = await optionalLstat(current.patchPath)
        if (currentPatch?.isSymbolicLink() || (currentPatch && !currentPatch.isFile())) throw new Error(`Managed path must be a regular file, not a symlink: ${current.patchPath}`)
        if (currentPatch) await unlink(current.patchPath)
      }
      const restored = await this.readProfile(transaction.profile)
      let runtime = { ok: null, skipped: true }
      if (options.validateRuntime !== false) {
        runtime = await this.validateRuntime(transaction.profile)
        if (!runtime.ok) throw new Error(`Restored profile failed DSH validation: ${runtime.diagnostic ?? 'dsh command was not found'}`)
      }
      return this.store.update(transaction.id, {
        status: 'restored',
        result: {
          ...transaction.result,
          restoredStateHash: restored.stateHash,
          restoreRuntime: runtime,
          restoredAt: new Date().toISOString(),
          recoveryTransactionId: recovery.id,
        },
        error: null,
      })
    } catch (error) {
      if (recovery?.backupDir) {
        try {
          const manifest = await readManagedFile(join(recovery.backupDir, PROFILE_MANIFEST))
          await atomicWrite(current.manifestPath, manifest.raw, current.manifestMode, `${transaction.id}-manual-restore-reverse`)
          const metadata = JSON.parse((await readManagedFile(join(recovery.backupDir, 'backup.json'))).raw.toString('utf8'))
          const patch = metadata.patchHash ? await readManagedFile(join(recovery.backupDir, PROFILE_PATCH), { maxBytes: 8 * 1024 * 1024 }) : null
          if (patch) await atomicWrite(current.patchPath, patch.raw, 0o600, `${transaction.id}-manual-restore-reverse-patch`)
          else if (await optionalLstat(current.patchPath)) await unlink(current.patchPath)
        } catch (recoveryError) {
          error = new Error(`${error.message}; automatic recovery also failed: ${recoveryError.message}`)
        }
      }
      this.store.update(transaction.id, { status: 'restore-failed', error: error.message })
      throw error
    } finally {
      try { await unlink(lockPath) } catch {}
    }
  }

  async validateRuntime(profileName) {
    const result = await this.commandRunner({
      command: this.command,
      args: ['--profile', profileName, '--dump-config'],
      cwd: this.home,
      env: this.env,
    })
    return {
      ok: result.ok,
      code: result.code,
      outputBytes: Buffer.byteLength(String(result.stdout ?? '')),
      diagnostic: result.ok ? null : String(result.stderr || 'DSH config validation failed').trim().slice(0, 4_000),
      notFound: Boolean(result.notFound),
    }
  }

  async apply(plan, options = {}) {
    assertPlan(plan)
    assertProfileName(plan.profile)
    if (this.store.get(plan.id)) throw new Error(`Transaction already exists: ${plan.id}`)
    let before = await this.readProfile(plan.profile)
    if (before.stateHash !== plan.baseStateHash) throw new Error('Stale plan: the profile changed after this plan was created')
    const checkedPlan = await this.planBundleChange(plan.profile, plan.nextBundles, { reason: plan.reason })
    if (JSON.stringify(checkedPlan.nextBundles) !== JSON.stringify(plan.nextBundles)) throw new Error('Plan bundle list failed validation')
    const lockPath = await this.acquireLock(before.dir, plan.id)
    let backupDir
    try {
      before = await this.readProfile(plan.profile)
      if (before.stateHash !== plan.baseStateHash) throw new Error('Stale plan: the profile changed while the change lock was being acquired')
      backupDir = await this.createBackup(before, plan.id)
      this.store.create({ plan, status: 'applying', backupDir })
      const nextManifest = {
        ...before.manifest,
        dsh: {
          ...(before.manifest.dsh ?? {}),
          profile: {
            ...(before.manifest.dsh?.profile ?? {}),
            bundles: [...plan.nextBundles],
          },
        },
      }
      const bytes = Buffer.from(JSON.stringify(nextManifest, null, 2) + '\n')
      await atomicWrite(before.manifestPath, bytes, before.manifestMode, plan.id)
      const after = await this.readProfile(plan.profile)
      let runtime = { ok: null, skipped: true }
      if (options.validateRuntime !== false) {
        runtime = await this.validateRuntime(plan.profile)
        if (!runtime.ok) throw new Error(runtime.notFound
          ? 'DSH runtime validation is required but the dsh command was not found'
          : `DSH runtime validation failed: ${runtime.diagnostic}`)
      }
      const result = {
        beforeStateHash: before.stateHash,
        afterStateHash: after.stateHash,
        bundles: after.bundles,
        runtime,
        appliedAt: new Date().toISOString(),
      }
      return this.store.update(plan.id, { status: 'applied', result })
    } catch (error) {
      if (backupDir) {
        try {
          const backup = await readManagedFile(join(backupDir, PROFILE_MANIFEST))
          await atomicWrite(before.manifestPath, backup.raw, 0o600, `${plan.id}-restore`)
        } catch (restoreError) {
          const message = `${error.message}; automatic restore also failed: ${restoreError.message}`
          try { this.store.update(plan.id, { status: 'restore-failed', error: message }) } catch {}
          const failure = new Error(message)
          failure.transactionId = plan.id
          throw failure
        }
      }
      try { this.store.update(plan.id, { status: 'rolled-back', error: error.message }) } catch {}
      const failure = new Error(error.message)
      failure.transactionId = plan.id
      throw failure
    } finally {
      try { await unlink(lockPath) } catch {}
    }
  }

  async rollback(transactionId, options = {}) {
    const transaction = this.store.get(transactionId)
    if (!transaction) throw new Error(`Unknown transaction: ${transactionId}`)
    if (transaction.action === 'manual-backup') {
      if (transaction.status !== 'available' && transaction.status !== 'restore-failed') throw new Error(`Manual backup cannot be restored from status ${transaction.status}`)
      return this.restoreManualBackup(transaction, options)
    }
    if (transaction.status !== 'applied' && transaction.status !== 'rollback-failed') throw new Error(`Transaction cannot be rolled back from status ${transaction.status}`)
    const backupDir = resolve(String(transaction.backupDir ?? ''))
    const backupsRoot = resolve(this.dataDir, 'backups')
    if (!transaction.backupDir || !isWithin(backupsRoot, backupDir)) throw new Error('Transaction backup path is outside the Switchboard backup root')
    let current = await this.readProfile(transaction.profile)
    if (!options.force && transaction.result?.afterStateHash && current.stateHash !== transaction.result.afterStateHash) {
      throw new Error('Rollback refused: the profile changed after this transaction was applied')
    }
    const lockPath = await this.acquireLock(current.dir, `${transactionId}-rollback`)
    current = await this.readProfile(transaction.profile)
    if (!options.force && transaction.result?.afterStateHash && current.stateHash !== transaction.result.afterStateHash) {
      try { await unlink(lockPath) } catch {}
      throw new Error('Rollback refused: the profile changed while the change lock was being acquired')
    }
    const currentManifest = await readManagedFile(current.manifestPath)
    try {
      const backup = await readManagedFile(join(backupDir, PROFILE_MANIFEST))
      await atomicWrite(current.manifestPath, backup.raw, 0o600, `${transactionId}-rollback`)
      const restored = await this.readProfile(transaction.profile)
      let runtime = { ok: null, skipped: true }
      if (options.validateRuntime !== false) {
        runtime = await this.validateRuntime(transaction.profile)
        if (!runtime.ok) throw new Error(`Restored profile failed DSH validation: ${runtime.diagnostic ?? 'dsh command was not found'}`)
      }
      return this.store.update(transactionId, {
        status: 'rolled-back',
        result: { ...transaction.result, rollbackStateHash: restored.stateHash, rollbackRuntime: runtime, rolledBackAt: new Date().toISOString() },
        error: null,
      })
    } catch (error) {
      try { await atomicWrite(current.manifestPath, currentManifest.raw, 0o600, `${transactionId}-rollback-reverse`) } catch {}
      this.store.update(transactionId, { status: 'rollback-failed', error: error.message })
      throw error
    } finally {
      try { await unlink(lockPath) } catch {}
    }
  }

  async healthCheck(profileName) {
    let profile
    try { profile = await this.readProfile(profileName) } catch (error) {
      return { profile: String(profileName), ok: false, static: { ok: false, error: error.message }, runtime: null }
    }
    const findings = []
    for (const bundle of profile.bundleDetails) {
      if (!bundle.resolved) findings.push({ severity: 'warning', code: 'bundle-unresolved', packageName: bundle.packageName })
      else if (!bundle.patch) findings.push({ severity: 'error', code: 'bundle-patch-missing', packageName: bundle.packageName })
    }
    const runtime = await this.validateRuntime(profile.name)
    return { profile: profile.name, ok: !findings.some(item => item.severity === 'error') && runtime.ok, static: { ok: !findings.some(item => item.severity === 'error'), findings }, runtime }
  }

  async preflightPlugin(path, target = null) {
    const preflight = await scanPlugin(path)
    let compatibility = null
    if (target) {
      for (const key of ['dshToolsVersion', 'cordisVersion']) if (!target[key]) throw new Error(`${key} is required for compatibility checking`)
      const radar = new CompatibilityRadar({ dataDir: join(this.dataDir, 'compatibility-radar') })
      try { compatibility = await radar.check({ ...target, pluginPaths: [path] }) } finally { radar.close() }
    }
    return { preflight, compatibility }
  }

  async auditProfile(profileName, target = null) {
    const profile = await this.readProfile(profileName)
    const pluginPaths = [...new Set(profile.bundleDetails.filter(item => item.resolved && item.packageDir).map(item => item.packageDir))]
    const scans = []
    for (const path of pluginPaths) {
      try { scans.push(await scanPlugin(path)) } catch (error) { scans.push({ pluginPath: path, verdict: 'error', error: error.message }) }
    }
    let compatibility = null
    if (target && pluginPaths.length) {
      const radar = new CompatibilityRadar({ dataDir: join(this.dataDir, 'compatibility-radar') })
      try { compatibility = await radar.check({ ...target, pluginPaths }) } finally { radar.close() }
    }
    return { profile: profile.name, scans, compatibility, unresolved: profile.bundleDetails.filter(item => !item.resolved).map(item => item.packageName) }
  }

  async writeProfileReport(profileName, options = {}) {
    const profile = await this.readProfile(profileName)
    const health = options.health === false ? null : await this.healthCheck(profileName)
    const audit = options.audit ? await this.auditProfile(profileName, options.target ?? null) : null
    const directory = resolve(options.outputDir ?? join(this.dataDir, 'reports'))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = `profile_${profile.name}_${stamp}`
    const markdownPath = join(directory, `${base}.md`)
    const htmlPath = join(directory, `${base}.html`)
    await writeFile(markdownPath, formatProfileMarkdown(profile, health, audit), { mode: 0o600 })
    await writeFile(htmlPath, formatProfileHtml(profile, health, audit), { mode: 0o600 })
    return { profile: profile.name, reports: [{ format: 'markdown', path: markdownPath }, { format: 'html', path: htmlPath }] }
  }

  history(options) { return { transactions: this.store.list(options) } }

  addActivity(activity) { return this.store.addActivity(activity) }

  activities(options) {
    return {
      activities: this.store.listActivities(options),
      total: this.store.countActivities(options),
    }
  }

  clearActivitiesForSession(sessionId) { return this.store.clearActivitiesForSession(sessionId) }

  close() {
    if (this.closed) return
    this.closed = true
    this.store.close()
  }
}
