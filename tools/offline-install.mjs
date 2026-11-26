/**
 * Offline, dependency-free install of this plugin into a DSH profile.
 *
 * Why not `dsh plugin add`: that forwards to pnpm, and pnpm re-resolves **every**
 * dependency in the profile — including `github:` specs — before it adds
 * anything. On a machine that cannot reach github.com the add fails for reasons
 * that have nothing to do with this plugin. This plugin has zero runtime
 * dependencies, so nothing needs resolving: a directory link plus the
 * `dsh.profile.bundles` entry `dsh plugin` would have written *is* the whole
 * install.
 *
 * Unlike a pnpm install, this tool writes into your profile first and verifies
 * afterwards, so a failed verification rolls the profile back from the backups
 * it just made. Verification mounts the plugin through the profile's own module
 * resolution and asserts that eight tools reach the registry — it does not boot
 * a web server, open a port, or touch a tunnel.
 *
 *   node tools/offline-install.mjs --profile web
 *   node tools/offline-install.mjs --profile web --no-verify
 *   node tools/offline-install.mjs --profile web --package /path/to/checkout
 *
 * @module dsh-plugin-browser/tools/offline-install
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveFrom } from '../lib/dsh-paths.mjs'

const argv = process.argv.slice(2)
const argument = (flag, fallback) => {
  const index = argv.indexOf(`--${flag}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const profileName = argument('profile', 'web')
const packageDir = resolve(argument('package', dirname(dirname(fileURLToPath(import.meta.url)))))
const skipVerify = argv.includes('--no-verify')

const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profileName)
const manifestPath = join(packageDir, 'package.json')

if (!existsSync(profileDir)) throw new Error(`no such profile directory: ${profileDir}`)
if (!existsSync(manifestPath)) throw new Error(`no package.json in ${packageDir}`)

const ownManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const packageName = ownManifest.name
const specifier = `link:${packageDir.replaceAll('\\', '/')}`

/** Create a directory link, preferring the symlink pnpm itself would create. */
async function linkDirectory(target, linkPath) {
  await mkdir(dirname(linkPath), { recursive: true })
  await rm(linkPath, { recursive: true, force: true })
  try {
    await symlink(target, linkPath, 'dir')
  } catch {
    // A directory symlink needs Developer Mode or elevation; a junction never does
    // and Node resolves it the same way.
    await symlink(target, linkPath, 'junction')
  }
}

/**
 * Write the dependency, the link, and the bundle entry — the three things
 * `dsh plugin add` leaves behind — into one profile directory.
 * @param targetProfile - profile directory to modify.
 * @returns what changed.
 */
async function materialize(targetProfile) {
  const targetManifest = join(targetProfile, 'package.json')
  const json = JSON.parse(await readFile(targetManifest, 'utf8'))
  const changed = json.dependencies?.[packageName] !== specifier
  json.dependencies = { ...json.dependencies, [packageName]: specifier }
  const bundles = new Set(json.dsh?.profile?.bundles ?? [])
  const addedBundle = !bundles.has(packageName)
  if (addedBundle) bundles.add(packageName)
  json.dsh = { ...json.dsh, profile: { ...json.dsh?.profile, bundles: [...bundles] } }
  await writeFile(targetManifest, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  await linkDirectory(packageDir, join(targetProfile, 'node_modules', packageName))
  return { dependency: specifier, addedBundle, changed }
}

/**
 * Record the link in the profile lockfile, in the same shape pnpm uses, so a
 * later frozen-lockfile install still agrees with package.json. pnpm itself
 * cannot be asked to do this offline, so the importer block is edited textually
 * and then re-parsed to prove the file is still valid YAML.
 * @param targetProfile - profile directory.
 * @returns what happened to the lockfile.
 */
async function recordInLockfile(targetProfile) {
  const lockfile = join(targetProfile, 'pnpm-lock.yaml')
  if (!existsSync(lockfile)) return 'no lockfile'
  // A profile lockfile written by pnpm on Windows may carry CRLF; `$` in a
  // multiline pattern does not match before CRLF, so normalize first. The file
  // is written back with LF either way, which is what pnpm itself emits.
  const text = (await readFile(lockfile, 'utf8')).replaceAll('\r\n', '\n')
  const guard = new RegExp(`^      '?${packageName}'?:$`, 'm')
  if (guard.test(text)) return 'already recorded'
  const lines = text.split('\n')
  const importers = lines.indexOf('importers:')
  const root = lines.findIndex((line, index) => index > importers && line === '  .:')
  const dependencies = lines.findIndex((line, index) => index > root && line === '    dependencies:')
  if (importers < 0 || root < 0 || dependencies < 0) return 'unrecognized importer block; left alone'

  const entries = []
  for (let index = dependencies + 1; index < lines.length; index += 1) {
    const key = /^ {6}'?([^\s'].*?)'?:$/.exec(lines[index])
    if (key !== null) {
      entries.push({ index, name: key[1] })
      continue
    }
    if (/^ {8}/.test(lines[index])) {
      if (entries.length > 0) entries[entries.length - 1].end = index + 1
      continue
    }
    break
  }
  const successor = entries.find(entry => entry.name > packageName)
  const at = successor?.index ?? entries.at(-1)?.end ?? dependencies + 1
  // A scoped name starts with `@`, which YAML treats as a reserved character:
  // pnpm quotes exactly these keys, and an unquoted one makes the whole file
  // unparseable. The guard above already accepts both spellings.
  const key = packageName.startsWith('@') ? `'${packageName}'` : packageName
  lines.splice(at, 0, `      ${key}:`, `        specifier: ${specifier}`, `        version: ${specifier}`)
  const edited = lines.join('\n')
  // A guard that cannot see its own write would duplicate the entry on the next
  // run — which is exactly the failure this line exists to make impossible.
  assert.ok(guard.test(edited), 'the entry must be findable after insertion')
  await writeFile(lockfile, edited, 'utf8')
  try {
    const require = createRequire(join(targetProfile, 'package.json'))
    const yaml = await import(pathToFileURL(require.resolve('yaml', { paths: [join(targetProfile, 'node_modules')] })).href)
    const parsed = (yaml.default ?? yaml).parse(edited)
    assert.equal(
      parsed.importers['.'].dependencies[packageName].specifier,
      specifier,
      'the edited lockfile must parse back with the new dependency',
    )
    return 'recorded and re-parsed as valid YAML'
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return 'recorded (yaml unavailable to re-parse)'
    throw error
  }
}

/**
 * Resolve a package the way the DSH loader would: from the profile first, then
 * from whatever layout this machine uses for the shipped DSH packages.
 * @param targetProfile - profile directory.
 * @param specifier - the package to resolve.
 * @returns the resolved entry file.
 */
function resolveForProfile(targetProfile, specifier) {
  return resolveFrom(specifier, process.env, [join(targetProfile, 'node_modules'), targetProfile])
}

/**
 * Mount the installed plugin through the profile's own resolution and assert
 * that its tools reach the registry. This is the check that a `link:` plus a
 * bundle entry actually composes — without starting a web server.
 * @param targetProfile - profile directory.
 * @returns the tool names the plugin registered.
 */
async function verifyMount(targetProfile) {
  const entry = resolveForProfile(targetProfile, packageName)
  const plugin = await import(pathToFileURL(entry).href)
  const { Context } = await import(pathToFileURL(resolveForProfile(targetProfile, '@deepseek-ai/cordis')).href)
  const toolsPlugin = (
    await import(pathToFileURL(resolveForProfile(targetProfile, '@deepseek-ai/dsh-tools')).href)
  ).default
  const ctx = new Context()
  ctx.provide('systemPrompt', new Proxy({}, { get: () => () => undefined }))
  await ctx.plugin(toolsPlugin)
  // The browser launches lazily, so mounting proves the layer composes without
  // needing a browser, a display, or a network.
  const fiber = ctx.plugin(plugin, { headless: true })
  await fiber
  const names = ctx.tools
    .schemas()
    .map(schema => schema.name)
    .sort()
  await fiber.dispose().catch(() => {})
  return names
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const report = { profile: profileName, package: packageName, specifier }

const backups = []
for (const file of ['package.json', 'pnpm-lock.yaml']) {
  const source = join(profileDir, file)
  if (existsSync(source)) {
    const backup = `${source}.bak-${stamp}-dsh-browser`
    await cp(source, backup, { force: true })
    backups.push({ backup, original: source })
  }
}

/** Put the profile back exactly as it was before this run. */
async function rollback() {
  for (const { backup, original } of backups) {
    await cp(backup, original, { force: true })
  }
  await rm(join(profileDir, 'node_modules', packageName), { recursive: true, force: true })
  process.stdout.write(`\nrolled back from ${backups.length} backup(s); the profile is unchanged.\n`)
}

process.stdout.write(`• commit: writing to ${profileDir}\n`)
try {
  report.host = { ...(await materialize(profileDir)), lockfile: await recordInLockfile(profileDir) }
} catch (error) {
  // A half-written profile is worse than no install: put it back and say so.
  report.host = { error: error instanceof Error ? error.message : String(error) }
  process.stdout.write(`• commit: FAILED — ${report.host.error}\n`)
  await rollback()
  process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`)
  process.exit(1)
}

if (skipVerify) {
  report.verify = 'skipped on request'
  process.stdout.write('• verify: skipped on request\n')
} else {
  process.stdout.write('• verify: mounting the installed plugin through the profile\n')
  try {
    const names = await verifyMount(profileDir)
    report.verify = { ok: true, tools: names }
    process.stdout.write(`• verify: ${names.length} tools registered (${names.join(', ')})\n`)
  } catch (error) {
    report.verify = { ok: false, error: error instanceof Error ? error.message : String(error) }
    process.stdout.write(`• verify: FAILED — ${report.verify.error}\n`)
    await rollback()
    process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`)
    process.exit(1)
  }
}

process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(
  `\ninstalled. the new layer loads on the NEXT ${profileName} profile start — restart \`dsh web\` (or whatever serves this profile) to get the eight browser tools.\n`,
)
process.stdout.write(`backups: ${backups.map(entry => entry.backup).join(', ') || '(nothing to back up)'}\n`)