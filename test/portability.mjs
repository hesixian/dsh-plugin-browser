/**
 * Portability test: the plugin must behave on a machine that is not the one it
 * was written on.
 *
 * Two bugs motivated this file, both invisible on a Windows desktop:
 *
 *   * `join(env.APPDATA ?? '', 'npm')` produced the relative path `npm` on
 *     macOS and Linux, so the Playwright lookup searched a `node_modules`
 *     directory next to the caller's working directory; and
 *   * a hard-coded `channel: 'msedge'` made the first tool call fail on any
 *     machine without Edge, with no fallback.
 *
 * Both are pure functions now, so both are testable without launching a
 * browser. No network, no profile, no display needed.
 *
 *   node test/portability.mjs
 *
 * @module dsh-plugin-browser/test/portability
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { dshHome, effectiveHeadless, effectiveVisibility, launchPlans, npmGlobalRoots, visibilityArgs } from '../lib/session.mjs'

const CHECK = '\u2713'
const isWindows = process.platform === 'win32'

/** Every global root must be absolute and must exist; a relative one is a bug. */
function checkGlobalRoots() {
  for (const env of [{}, { APPDATA: undefined, LOCALAPPDATA: undefined, NODE_PATH: undefined }]) {
    const roots = npmGlobalRoots(env)
    assert.ok(Array.isArray(roots), 'npmGlobalRoots must return an array')
    for (const root of roots) {
      assert.ok(isAbsolute(root), `npmGlobalRoots returned a relative path: ${JSON.stringify(root)}`)
      assert.ok(existsSync(root), `npmGlobalRoots returned a missing path: ${root}`)
    }
  }
  // NODE_PATH is a path-delimited list, and entries that are relative must be
  // rejected rather than silently opened against the working directory.
  const withNodePath = npmGlobalRoots({ NODE_PATH: ['relative/entry', process.cwd()].join(delimiter) })
  for (const root of withNodePath) assert.ok(isAbsolute(root), `relative NODE_PATH leaked through: ${root}`)
  process.stdout.write(`${CHECK} global npm roots are absolute on every platform\n`)
}

/** The DSH home must follow DSH_HOME and fall back to the platform's home. */
function checkDshHome() {
  const configured = join(homedir(), 'custom-dsh-home')
  assert.equal(dshHome({ DSH_HOME: configured }), configured)
  assert.equal(dshHome({}), join(homedir(), '.dsh'), 'unset DSH_HOME must fall back to ~/.dsh')
  assert.equal(dshHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'), 'blank DSH_HOME must fall back too')
  process.stdout.write(`${CHECK} DSH_HOME resolution\n`)
}

/**
 * `visibility` is the foreground policy: `hidden` must win by default, and an
 * explicit `headless` must still be able to override it.
 */
function checkVisibility() {
  assert.equal(effectiveVisibility({}), 'hidden', 'the shipped default must be a windowless browser')
  assert.equal(effectiveVisibility({ visibility: 'visible' }), 'visible')
  assert.equal(effectiveVisibility({ visibility: 'foreground' }), 'visible', 'the old spelling still works')
  assert.equal(effectiveVisibility({ visibility: 'offscreen' }), 'offscreen')
  assert.equal(effectiveVisibility({ visibility: 'OFFSCREEN' }), 'offscreen', 'values are case-insensitive')
  assert.equal(effectiveVisibility({ visibility: 'nonsense' }), 'hidden', 'unknown values fall back to hidden')

  assert.deepEqual(visibilityArgs('hidden', true), [], 'a headless browser needs no window flags')
  assert.deepEqual(visibilityArgs('visible', false), [], 'an on-screen window needs no special flags')
  const offscreen = visibilityArgs('offscreen', false)
  assert.ok(
    offscreen.some(argument => argument.startsWith('--window-position=-')),
    'offscreen must park the window outside the desktop',
  )
  assert.ok(
    offscreen.some(argument => argument.includes('--disable-renderer-backgrounding')),
    'offscreen must keep an unviewed page running',
  )
  assert.deepEqual(visibilityArgs('offscreen', true), [], 'headless wins over the offscreen flags')
  process.stdout.write(`${CHECK} visibility policy (hidden / offscreen / visible)\n`)
}

/** `headless: 'auto'` must ask the machine, and an explicit boolean must win. */
function checkHeadlessPolicy() {
  assert.equal(effectiveHeadless({ headless: true }, {}), true)
  assert.equal(effectiveHeadless({ headless: false }, {}), false)
  assert.equal(effectiveHeadless({ headless: true }, { DISPLAY: ':0' }), true, 'explicit true beats a display')
  assert.equal(effectiveHeadless({ headless: false }, {}), false, 'explicit false beats a missing display')

  // The shipped default is `visibility: hidden`: no window, on every platform.
  assert.equal(effectiveHeadless({}, {}), true, 'the default must be a windowless browser')
  assert.equal(effectiveHeadless({}, { DISPLAY: ':0' }), true, 'hidden ignores an available display')

  const desktop = process.platform === 'linux' ? { DISPLAY: ':0' } : {}
  assert.equal(effectiveHeadless({ visibility: 'visible' }, desktop), false, 'visible with a display is headed')
  assert.equal(effectiveHeadless({ visibility: 'offscreen' }, desktop), false, 'offscreen with a display is headed')
  assert.equal(
    effectiveHeadless({ visibility: 'visible' }, {}),
    process.platform === 'linux',
    'without a display, even a requested window cannot be headed',
  )
  // An explicit boolean still outranks the visibility policy, which is what an
  // operator who asked for a headed browser on a server is relying on.
  assert.equal(effectiveHeadless({ headless: false, visibility: 'hidden' }, {}), false)
  assert.equal(effectiveHeadless({ headless: true, visibility: 'visible' }, {}), true)
  process.stdout.write(`${CHECK} headless auto-detection\n`)
}

/** Probing order, pinning, the bundled fallback, and the headed retry. */
function checkLaunchPlans() {
  const auto = launchPlans({ channel: 'auto', headless: true }, {})
  const first = isWindows ? 'msedge' : 'chrome'
  assert.equal(auto[0].channel, first, `auto probing must start with ${first} on ${process.platform}`)
  assert.ok(
    auto.some(plan => plan.channel === ''),
    'auto must end with a bundled-chromium attempt',
  )
  for (const plan of auto) {
    assert.equal(typeof plan.channel, 'string', `plan channel must be a string: ${JSON.stringify(plan)}`)
    assert.equal(typeof plan.headless, 'boolean', 'plan headless must be a boolean')
    assert.ok(
      ['hidden', 'offscreen', 'visible'].includes(plan.visibility),
      `every plan must carry its visibility: ${JSON.stringify(plan)}`,
    )
  }

  const bundled = launchPlans({ channel: 'bundled', headless: true }, {})
  assert.equal(bundled.length, 1, 'bundled must be a single attempt')
  assert.equal(bundled[0].channel, '', 'bundled must carry no channel')
  assert.equal(bundled[0].headless, true)

  const pinned = launchPlans({ channel: 'chrome', headless: true }, {})
  assert.equal(pinned.length, 1, 'a pinned channel must not probe')
  assert.equal(pinned[0].channel, 'chrome')

  const fromEnv = launchPlans({ channel: 'auto', headless: true }, { DSH_BROWSER_CHANNEL: 'bundled' })
  assert.equal(fromEnv.length, 1, 'DSH_BROWSER_CHANNEL must override auto')
  assert.equal(fromEnv[0].channel, '')

  const configWins = launchPlans({ channel: 'chrome', headless: true }, { DSH_BROWSER_CHANNEL: 'bundled' })
  assert.equal(configWins[0].channel, 'chrome', 'config must win over the environment')

  const headedRetry = launchPlans({ channel: 'chrome', headless: false }, {})
  assert.equal(headedRetry.length, 2, 'a headed launch gets one headless retry')
  assert.equal(headedRetry[1].headless, true)
  assert.equal(headedRetry[1].channel, 'chrome')

  // The default config must produce a single-attempt-free, windowless plan set:
  // nothing a user does with the agent should ever raise a window.
  const shipped = launchPlans({}, {})
  assert.ok(
    shipped.every(plan => plan.headless === true),
    `the shipped default must launch no window at all: ${JSON.stringify(shipped)}`,
  )
  process.stdout.write(`${CHECK} launch plans (probe, pin, bundled, env override, headed retry)\n`)
}

checkGlobalRoots()
checkDshHome()
checkVisibility()
checkHeadlessPolicy()
checkLaunchPlans()
process.stdout.write('\nportability: the plugin is not tied to the machine it was written on\n')