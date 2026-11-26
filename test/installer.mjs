/**
 * Installer test: `tools/offline-install.mjs` against a throwaway DSH home.
 *
 * This script exists because the first real install found a defect that no unit
 * test would have: pnpm's lockfile keys for a scoped package must be quoted
 * (`'@scope/name':`), because `@` is a reserved character at the start of a YAML
 * plain scalar. An unquoted key turns the whole lockfile into a parse error, and
 * the installer wrote it *before* noticing.
 *
 * So this test drives the real script, then asserts the resulting profile is
 * consistent and the lockfile entry is quoted — and that a second run is a
 * no-op rather than a duplicate entry.
 *
 * No browser, no network, no DSH install needed (`--no-verify` skips the mount,
 * which `test/registry.mjs` already covers against the real runtime).
 *
 *   node test/installer.mjs
 *
 * @module dsh-plugin-browser/test/installer
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECK = '\u2713'
const here = dirname(fileURLToPath(import.meta.url))
const installer = join(dirname(here), 'tools', 'offline-install.mjs')
const manifest = JSON.parse(await readFile(join(dirname(here), 'package.json'), 'utf8'))
const packageName = manifest.name

/** A profile manifest shaped like a real one, plus an importer block to edit. */
const PROFILE_MANIFEST = {
  name: 'dsh-profile-test',
  private: true,
  dependencies: { 'some-other-plugin': '^1.0.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'some-other-plugin'] } },
}

const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      some-other-plugin:
        specifier: ^1.0.0
        version: 1.0.0
`

/** Run the installer inside the sandbox home. */
function install(home) {
  const result = spawnSync(process.execPath, [installer, '--profile', 'web', '--no-verify'], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `installer failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-browser-install-'))
try {
  const profileDir = join(home, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(PROFILE_MANIFEST, null, 2)}\n`, 'utf8')
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), LOCKFILE, 'utf8')

  install(home)

  const after = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(after.dependencies[packageName], `link:${dirname(here).replaceAll('\\', '/')}`)
  assert.ok(after.dsh.profile.bundles.includes(packageName), 'the bundle entry must be appended')
  assert.ok(after.dsh.profile.bundles.includes('some-other-plugin'), 'existing bundles must survive')
  assert.ok(after.dependencies['some-other-plugin'] === '^1.0.0', 'existing dependencies must survive')
  process.stdout.write(`${CHECK} profile manifest: dependency added, existing entries kept\n`)

  const lockfile = await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
  assert.ok(
    lockfile.includes(`      '${packageName}':`),
    `a scoped lockfile key must be quoted:\n${lockfile}`,
  )
  assert.ok(
    !new RegExp(`^ {6}${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm').test(lockfile),
    `an unquoted scoped key makes the lockfile unparseable:\n${lockfile}`,
  )
  process.stdout.write(`${CHECK} lockfile: the scoped key is quoted\n`)

  const second = install(home)
  assert.match(second, /"addedBundle": false/, 'a second run must not duplicate the bundle entry')
  const entries = lockfile.split(`'${packageName}':`).length - 1
  const rerun = await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
  assert.equal(rerun.split(`'${packageName}':`).length - 1, entries, 'a second run must not duplicate the key')
  process.stdout.write(`${CHECK} idempotent: a second run adds nothing\n`)
} finally {
  await rm(home, { recursive: true, force: true })
}

process.stdout.write('\ninstaller: the offline install writes a consistent profile\n')