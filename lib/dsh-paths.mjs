/**
 * Locate the shipped DSH packages.
 *
 * Three callers need this: the two offline tests (`test/verify-tools.mjs`,
 * `test/registry.mjs`) import `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis`
 * to check the plugin against the real runtime, and `tools/offline-install.mjs`
 * mounts an installed copy through the profile's own resolution to verify it.
 * A contributor's machine may have DSH in a profile, in a global npm prefix, or
 * behind an explicit override — and a global install nests its dependencies
 * under `@deepseek-ai/dsh/node_modules`, which a plain `node_modules` probe
 * never sees. That is why the roots are expanded, not merely listed.
 *
 * @module dsh-plugin-browser/lib/dsh-paths
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { npmGlobalRoots } from './session.mjs'

const require = createRequire(import.meta.url)

/**
 * The DSH home, resolved exactly like the plugin resolves it at runtime.
 * @param env - environment supplying an optional DSH_HOME.
 * @returns the DSH home directory.
 */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Directories worth probing for the shipped DSH packages.
 * @param env - environment supplying DSH_TOOLS_ROOT and the global roots.
 * @returns existing absolute directories, most specific first.
 */
export function dshRoots(env = process.env) {
  const home = dshHome(env)
  const candidates = [
    env.DSH_TOOLS_ROOT?.trim(),
    join(home, 'profiles', 'node_modules'),
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh'),
    ...npmGlobalRoots(env),
  ]
  return candidates.filter(root => root !== undefined && root !== '' && existsSync(root))
}

/**
 * Expand one root into every directory from which the package may actually
 * resolve: the root itself, a sibling `node_modules`, and the `dsh` package's
 * own nested tree.
 * @param root - a root from {@link dshRoots}.
 * @returns existing candidates for `require.resolve({ paths })`.
 */
function probesFor(root) {
  return [root, join(root, 'node_modules'), join(root, '@deepseek-ai', 'dsh'), join(root, 'node_modules', '@deepseek-ai', 'dsh')]
}

/**
 * Resolve a package the way the DSH loader would, from any of those roots.
 * @param specifier - the package to resolve, e.g. `@deepseek-ai/dsh-tools`.
 * @param env - environment used for the roots.
 * @param extraRoots - roots to try before the discovered ones (a profile dir).
 * @returns the absolute path of the package entry file.
 */
export function resolveFrom(specifier, env = process.env, extraRoots = []) {
  const tried = []
  const seen = new Set()
  for (const root of [...extraRoots, ...dshRoots(env)]) {
    if (root === undefined || root === '') continue
    for (const probe of probesFor(root)) {
      if (seen.has(probe) || !existsSync(probe)) continue
      seen.add(probe)
      try {
        return require.resolve(specifier, { paths: [probe] })
      } catch (error) {
        tried.push(`${probe}: ${error.message.split('\n')[0]}`)
      }
    }
  }
  throw new Error(
    `cannot resolve ${specifier}. Install DSH (\`npm i -g @deepseek-ai/dsh\`), or point DSH_TOOLS_ROOT at a ` +
      `directory that contains it. Tried:\n${tried.join('\n')}`,
  )
}