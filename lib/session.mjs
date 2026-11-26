/**
 * dsh-plugin-browser session: one resident Playwright browser owned by the DSH host
 * process, plus the compact page digest and the line diff the tools return.
 *
 * Nothing here talks to a child process, a JSON-RPC pipe, or a model context
 * protocol: the Playwright library is imported in-process on first use, the
 * browser is reused across every call, and a page is described by a small
 * ref-indexed digest instead of a full accessibility tree.
 *
 * @module dsh-plugin-browser/session
 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter as pathDelimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** Every knob a profile row may override, with the shipped defaults. */
export const DEFAULTS = {
  /**
   * `auto` probes the channels a typical desktop already has, then falls back to
   * a bundled chromium. Pin a channel name, or `bundled`, to skip the probing.
   */
  channel: 'auto',
  /**
   * `auto` is headed where a display exists (a resident browser the user can
   * watch and log into) and headless where none does. `true`/`false` pin it.
   */
  headless: 'auto',
  /**
   * Where the browser lives. An explicit `headless` still wins over this.
   *
   * - `hidden`    no window at all: the only mode that cannot steal the
   *               foreground, the mouse or the IME (headless).
   * - `offscreen` a real window parked outside every monitor, with the
   *               backgrounding flags off so pages keep running. Visually out
   *               of the way, but Windows can still hand it focus for a moment.
   * - `visible`   on screen, the classic behaviour: watchable, log-in-able,
   *               and it will take the foreground.
   */
  visibility: 'hidden',
  /** Activate a tab in the OS window when `browser_tab` selects it. */
  activateOnSelect: false,
  /** Accept any TLS certificate. Off by default: this runs against real sites. */
  ignoreHTTPSErrors: false,
  /** Let pages trigger downloads into the persistent profile. */
  acceptDownloads: true,
  /** Extra browser args. */
  args: [],
  /** Persistent profile directory; empty means `<DSH_HOME>/browser/profile`. */
  userDataDir: '',
  /** Where `browser_screenshot` writes; empty means `<DSH_HOME>/browser/shots`. */
  screenshotDir: '',
  viewport: { width: 1440, height: 900 },
  navTimeoutMs: 30_000,
  actionTimeoutMs: 15_000,
  /** Quiet period after an action before the digest is taken. */
  settleMs: 400,
  /** Digest budget: the whole point of this plugin is a few hundred tokens. */
  maxDigestChars: 3_500,
  /** Cap on interactive elements listed in one digest. */
  maxElements: 120,
  /** Visible-text lines kept in the digest (single lines, for diff granularity). */
  maxTextLines: 24,
  /** Console ring-buffer size. */
  consoleLimit: 200,
}

/** Resolve the DSH home the same way every other DSH component does. */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Global npm roots that may hold a Playwright install, for every platform.
 *
 * A global install lives beside the interpreter on unix-shaped prefixes
 * (`<prefix>/bin/node` → `<prefix>/lib/node_modules`) and under `%APPDATA%\npm`
 * on Windows. Nothing here may be a relative path: an unresolved `npm` beside
 * the working directory would let an unrelated `node_modules` win.
 * @param env - environment supplying NODE_PATH, APPDATA and LOCALAPPDATA.
 * @returns existing absolute roots, most specific first.
 */
export function npmGlobalRoots(env = process.env) {
  const roots = []
  const push = candidate => {
    if (typeof candidate !== 'string') return
    const value = candidate.trim()
    if (value === '' || !isAbsolute(value) || roots.includes(value)) return
    roots.push(value)
  }
  for (const entry of String(env.NODE_PATH ?? '').split(pathDelimiter)) push(entry)
  const executableDir = dirname(process.execPath)
  push(join(executableDir, '..', 'lib', 'node_modules'))
  push(join(executableDir, 'node_modules'))
  for (const variable of ['APPDATA', 'LOCALAPPDATA']) {
    const base = env[variable]
    if (base === undefined || base.trim() === '') continue
    // npm puts the global prefix itself on %APPDATA%\npm, so both the prefix and
    // its node_modules directory are worth probing.
    push(join(base, 'npm'))
    push(join(base, 'npm', 'node_modules'))
  }
  push('/usr/local/lib/node_modules')
  push('/opt/homebrew/lib/node_modules')
  push(join(homedir(), '.npm-global', 'lib', 'node_modules'))
  return roots.filter(root => existsSync(root))
}

/** Whether this machine can show a browser window at all. */
export function hasDisplay(env = process.env) {
  if (process.platform !== 'linux') return true
  return (env.DISPLAY ?? '').trim() !== '' || (env.WAYLAND_DISPLAY ?? '').trim() !== ''
}

/**
 * Flags that make a real window behave like a background one.
 *
 * The position parks it outside every monitor: this machine's virtual desktop
 * is far smaller than 32000 px, and Chromium clamps nothing on Windows or macOS.
 * The three `--disable-*backgrounding` flags stop Chromium from throttling a
 * window it believes nobody is looking at — without them an off-screen page
 * stops running timers and animations, and `browser_wait` starts timing out.
 * `CalculateNativeWinOcclusion` is the Windows-specific detection that would
 * otherwise mark the window occluded for the same reason.
 */
export const OFFSCREEN_ARGS = [
  '--window-position=-32000,-32000',
  '--window-size=1440,900',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
]

/**
 * Resolve `visibility` to one of the three supported modes.
 * @param config - the session config.
 * @returns `hidden`, `offscreen`, or `visible`.
 */
export function effectiveVisibility(config) {
  const requested = String(config.visibility ?? '').trim().toLowerCase()
  if (requested === 'visible' || requested === 'foreground' || requested === 'headed') return 'visible'
  if (requested === 'offscreen' || requested === 'background-window') return 'offscreen'
  return 'hidden'
}

/**
 * The extra browser arguments a mode needs.
 * A headless browser has no window, so the window flags would be noise there.
 * @param visibility - the resolved mode.
 * @param headless - whether the launch is headless.
 * @returns arguments to append to the launch.
 */
export function visibilityArgs(visibility, headless) {
  if (headless === true) return []
  return visibility === 'offscreen' ? [...OFFSCREEN_ARGS] : []
}

/**
 * Resolve `headless: 'auto'` against the machine and the requested visibility.
 *
 * An explicit boolean always wins, so a server operator who wants a headed
 * browser still gets the launch error that explains why it cannot work.
 * Otherwise `visibility` decides: only `hidden` guarantees that the browser
 * never takes the foreground.
 * @param config - the session config.
 * @param env - environment used for the display probe.
 * @returns whether to launch headless.
 */
export function effectiveHeadless(config, env = process.env) {
  const requested = config.headless
  if (requested === true || requested === 'headless') return true
  if (requested === false || requested === 'headed') return false
  if (effectiveVisibility(config) === 'hidden') return true
  // `offscreen` and `visible` both need a window, and a window needs a display.
  return !hasDisplay(env)
}

/**
 * The launch attempts to make, in order.
 *
 * Probing beats asking: most desktops already have Edge or Chrome, so trying
 * them means no download, and the last attempt (`channel: ''`) uses whatever
 * `playwright install chromium` provided. A headed-only failure (a container
 * whose display probe lied) gets one headless retry instead of a hard error.
 * @param config - the session config.
 * @param env - environment used for the channel and display probes.
 * @returns channel/headless pairs to try in sequence.
 */
export function launchPlans(config, env = process.env) {
  const configured = String(config.channel ?? '').trim()
  const fromEnv = String(env.DSH_BROWSER_CHANNEL ?? '').trim()
  const requested = configured !== '' && configured !== 'auto' ? configured : fromEnv !== '' ? fromEnv : 'auto'
  const headless = effectiveHeadless(config, env)
  const visibility = effectiveVisibility(config)
  const plans = []
  if (requested === 'bundled') {
    plans.push({ channel: '', headless, visibility })
  } else if (requested === 'auto') {
    const preferred = process.platform === 'win32' ? ['msedge', 'chrome', 'chromium'] : ['chrome', 'msedge', 'chromium']
    for (const channel of preferred) plans.push({ channel, headless, visibility })
    plans.push({ channel: '', headless, visibility })
  } else {
    plans.push({ channel: requested, headless, visibility })
  }
  if (headless === false) plans.push({ channel: plans[0].channel, headless: true, visibility })
  return plans
}

/**
 * The persistent profile a session uses when the config leaves it empty.
 * @param env - environment specifying the DSH home.
 * @returns the default user-data directory.
 */
export function defaultUserDataDir(env = process.env) {
  return join(dshHome(env), 'browser', 'profile')
}

/**
 * One-line error text for a launch attempt. Playwright attaches long multi-line
 * call logs that would drown the aggregated message.
 * @param error - whatever the attempt threw.
 * @returns a single readable line.
 */
function describeError(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim().slice(0, 300)
}

let playwrightPromise

/**
 * Normalize a loaded Playwright module.
 *
 * `playwright-core`'s entry is CommonJS, so a dynamic import may hand back the
 * namespace with the real exports only under `default`; callers always want the
 * object that owns `chromium`.
 * @param namespace - whatever `import()` returned.
 * @returns the Playwright module with browser type constructors.
 */
function pickPlaywright(namespace) {
  if (namespace !== null && typeof namespace === 'object' && namespace.chromium !== undefined) return namespace
  const fallback = namespace?.default
  if (fallback !== null && typeof fallback === 'object' && fallback.chromium !== undefined) return fallback
  throw new Error('dsh-plugin-browser: the resolved Playwright module exposes no `chromium` export')
}

/**
 * Import the Playwright library in-process.
 *
 * Resolution is deliberately forgiving: an explicit `DSH_BROWSER_PLAYWRIGHT`
 * override wins, then a plugin-local dependency, then the copy the Playwright
 * MCP server already installed under the DSH home, then every global npm root
 * for this platform, then a bare specifier. The browser itself comes from an
 * installed Chromium-based browser or from `playwright install chromium`, so
 * this never downloads anything on its own.
 * @param env - environment used for the override and the DSH home.
 * @returns the resolved Playwright module namespace.
 */
export function loadPlaywright(env = process.env) {
  playwrightPromise ??= (async () => {
    const tried = []
    const override = env.DSH_BROWSER_PLAYWRIGHT?.trim()
    if (override !== undefined && override !== '') {
      if (existsSync(override) && override.endsWith('.js')) {
        return pickPlaywright(await import(pathToFileURL(override).href))
      }
      tried.push(override)
    }
    const roots = [
      env.DSH_BROWSER_PLAYWRIGHT?.trim(),
      join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules'),
      join(dshHome(env), 'mcp', 'playwright'),
      ...npmGlobalRoots(env),
      process.cwd(),
    ]
    for (const root of roots) {
      if (root === undefined || root === '' || !existsSync(root)) continue
      for (const specifier of ['playwright-core', 'playwright']) {
        try {
          const entry = require.resolve(specifier, { paths: [root] })
          return pickPlaywright(await import(pathToFileURL(entry).href))
        } catch {
          tried.push(`${specifier} from ${root}`)
        }
      }
    }
    for (const specifier of ['playwright-core', 'playwright']) {
      try {
        return pickPlaywright(await import(specifier))
      } catch {
        tried.push(specifier)
      }
    }
    throw new Error(
      `dsh-plugin-browser: no Playwright library found. Install one (\`pnpm add playwright-core\`) or point ` +
        `DSH_BROWSER_PLAYWRIGHT at it. Tried: ${tried.join(', ')}`,
    )
  })()
  return playwrightPromise
}

/**
 * Line diff by longest common subsequence, so a change deep in a long page
 * shows up as one `+`/`-` pair instead of shifting every later line.
 * @param before - previous digest text.
 * @param after - current digest text.
 * @returns added and removed lines, in order, plus the unchanged count.
 */
export function diffLines(before, after) {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  const n = a.length
  const m = b.length
  // The DP table stays small: digests are budgeted to a few hundred lines.
  if (n * m > 500_000) {
    const beforeSet = new Set(a)
    const afterSet = new Set(b)
    return {
      added: b.filter(line => !beforeSet.has(line)),
      removed: a.filter(line => !afterSet.has(line)),
      kept: b.filter(line => beforeSet.has(line)).length,
    }
  }
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const added = []
  const removed = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      removed.push(a[i])
      i += 1
    } else {
      added.push(b[j])
      j += 1
    }
  }
  for (; i < n; i += 1) removed.push(a[i])
  for (; j < m; j += 1) added.push(b[j])
  return { added, removed, kept: n - removed.length }
}

/** Render one diff as the short block a tool returns instead of a whole page. */
export function renderDiff(diff, header) {
  const { added, removed } = diff
  const lines = [header]
  if (added.length === 0 && removed.length === 0) {
    lines.push('no visible change')
    return lines.join('\n')
  }
  lines.push(`Δ +${added.length} −${removed.length}`)
  for (const line of added.slice(0, 80)) lines.push(`+ ${line}`)
  for (const line of removed.slice(0, 80)) lines.push(`- ${line}`)
  if (added.length > 80 || removed.length > 80) lines.push('… diff truncated')
  return lines.join('\n')
}

/**
 * Build the page digest inside the page. Playwright serializes this function,
 * so it must not close over module state: everything arrives in `options`, and
 * anything remembered between calls hangs off one namespaced window slot.
 * @param options - digest budget and element cap.
 * @returns title, url, and the digest body lines.
 */
function digestInPage(options) {
  const { maxElements, maxTextLines, maxLineChars, budget } = options
  const state = (window.__dshBrowserSession ??= { seq: 0, refs: [], map: null })
  state.map ??= new WeakMap()
  if (!Array.isArray(state.refs)) state.refs = []

  const INTERACTIVE_ROLES = [
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider',
    'switch', 'spinbutton',
  ]
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[contenteditable="true"]', '[onclick]', '[tabindex]',
    ...INTERACTIVE_ROLES.map(role => `[role="${role}"]`),
  ].join(',')

  const collapse = value => String(value ?? '').replace(/\s+/g, ' ').trim()
  const clip = (value, limit) => {
    const text = collapse(value)
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
  }
  const visible = element => {
    if (element.closest('[aria-hidden="true"]') !== null) return false
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    const style = window.getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0.05
  }
  const labelOf = element => {
    const tag = element.tagName.toLowerCase()
    if (element.getAttribute('aria-label') !== null) return clip(element.getAttribute('aria-label'), 60)
    if (element.labels !== undefined && element.labels.length > 0) return clip(element.labels[0].innerText, 60)
    const placeholder = element.getAttribute('placeholder')
    if (placeholder !== null && collapse(placeholder) !== '') return clip(placeholder, 60)
    const text = clip(element.innerText || element.textContent || '', 60)
    if (text !== '') return text
    return clip(element.getAttribute('title') || element.getAttribute('name') || element.getAttribute('value') || '', 60)
  }
  const kindOf = element => {
    const tag = element.tagName.toLowerCase()
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      return type === 'text' ? 'input' : `input:${type}`
    }
    if (['a', 'button', 'select', 'textarea', 'summary'].includes(tag)) {
      return tag === 'a' ? 'link' : tag
    }
    const role = (element.getAttribute('role') || '').toLowerCase()
    return role !== '' ? `role:${role}` : tag
  }
  const refOf = element => {
    const known = state.map.get(element)
    if (known !== undefined) return known
    state.seq += 1
    const ref = `e${state.seq}`
    state.map.set(element, ref)
    state.refs[state.seq - 1] = element
    return ref
  }

  const lines = []
  let used = 0
  const push = line => {
    if (used + line.length + 1 > budget) return false
    lines.push(line)
    used += line.length + 1
    return true
  }

  push(`page: ${clip(document.title, 80)} — ${location.href}`)
  for (const heading of document.querySelectorAll('h1,h2,h3,h4')) {
    if (!visible(heading)) continue
    const text = clip(heading.textContent, 70)
    if (text !== '' && !push(`${heading.tagName.toLowerCase()} ${text}`)) break
  }

  const body = document.body
  if (body !== null) {
    const textLines = String(body.innerText ?? '')
      .split('\n')
      .map(line => clip(line, maxLineChars))
      .filter(line => line !== '')
    let emitted = 0
    for (const line of textLines) {
      if (emitted >= maxTextLines) break
      if (!push(`· ${line}`)) break
      emitted += 1
    }
  }

  const candidates = [...document.querySelectorAll(SELECTOR)].filter(visible)
  let listed = 0
  let total = 0
  for (const element of candidates) {
    const label = labelOf(element)
    if (label === '') continue
    total += 1
    if (listed >= maxElements) continue
    const ref = refOf(element)
    let line = `[${ref}] ${kindOf(element)} "${label}"`
    if (element.tagName === 'A') {
      const href = element.getAttribute('href') || ''
      if (href !== '') line += ` -> ${clip(href, 80)}`
    }
    const tag = element.tagName.toLowerCase()
    if (tag === 'input' && ['checkbox', 'radio'].includes((element.getAttribute('type') || '').toLowerCase())) {
      line += element.checked ? ' [x]' : ' [ ]'
    } else if (tag === 'input' || tag === 'textarea') {
      const value = collapse(element.value)
      if (value !== '') line += ` = ${clip(value, 60)}`
    } else if (tag === 'select') {
      const chosen = element.selectedOptions?.[0]?.textContent ?? ''
      if (collapse(chosen) !== '') line += ` = ${clip(chosen, 40)}`
    }
    if (element.disabled === true) line += ' (disabled)'
    if (!push(line)) break
    listed += 1
  }
  if (total > listed) push(`… (+${total - listed} more interactive elements)`)

  return { url: location.href, title: document.title, lines }
}

/** One resident browser plus the previous digest needed to diff against. */
export class BrowserSession {
  constructor(config = {}) {
    this.config = { ...DEFAULTS, ...config, viewport: { ...DEFAULTS.viewport, ...(config.viewport ?? {}) } }
    this.context = undefined
    this.page = undefined
    this.launching = undefined
    this.lastDigest = ''
    this.messages = []
  }

  /** Launch once, lazily, and reuse the browser for the process lifetime. */
  async ensure() {
    if (this.context !== undefined) return this.context
    this.launching ??= this.#launch()
    try {
      return await this.launching
    } catch (error) {
      this.launching = undefined
      throw error
    }
  }

  async #launch() {
    const playwright = await loadPlaywright()
    const userDataDir = this.config.userDataDir !== '' ? this.config.userDataDir : defaultUserDataDir()
    await mkdir(userDataDir, { recursive: true })
    const failures = []
    const plans = launchPlans(this.config)
    for (const plan of plans) {
      const name = plan.channel === '' ? 'bundled chromium' : `channel ${plan.channel}`
      const mode = plan.headless ? 'headless' : plan.visibility === 'offscreen' ? 'offscreen' : 'headed'
      try {
        const context = await playwright.chromium.launchPersistentContext(userDataDir, this.#launchOptions(plan))
        this.#adopt(context)
        this.config.log?.(`dsh-plugin-browser: launched ${name} (${mode})`)
        return context
      } catch (error) {
        failures.push(`${name} ${mode}: ${describeError(error)}`)
      }
    }
    throw new Error(
      `dsh-plugin-browser: no launch attempt succeeded, so the browser is unavailable.\n  ${failures.join('\n  ')}\n` +
        `Install Chrome or Edge, or run \`npx playwright install chromium\` to use the bundled one. ` +
        `Set config.channel to pin one ('chrome', 'msedge', 'chromium'), or to 'bundled' to skip the probe. ` +
        `If another DSH instance is already using ${userDataDir}, close it first.`,
    )
  }

  /** The Playwright options for one launch attempt. */
  #launchOptions(plan) {
    return {
      headless: plan.headless,
      viewport: this.config.viewport,
      acceptDownloads: this.config.acceptDownloads !== false,
      ignoreHTTPSErrors: this.config.ignoreHTTPSErrors === true,
      args: [...visibilityArgs(plan.visibility, plan.headless), ...(this.config.args ?? [])],
      ...(plan.channel !== '' ? { channel: plan.channel } : {}),
    }
  }

  /** Take ownership of a freshly launched context and the pages it already has. */
  #adopt(context) {
    context.on('page', page => {
      this.#attach(page)
      this.page = page
    })
    for (const page of context.pages()) this.#attach(page)
    this.page = undefined
    context.on('close', () => {
      this.context = undefined
      this.page = undefined
    })
    this.context = context
  }

  /** Record console output, page errors, and failed requests for `browser_console`. */
  #attach(page) {
    const record = (type, text) => {
      this.messages.push({ type, text })
      const limit = this.config.consoleLimit
      if (this.messages.length > limit) this.messages.splice(0, this.messages.length - limit)
    }
    page.on('console', message => record(message.type(), String(message.text()).slice(0, 400)))
    page.on('pageerror', error => record('pageerror', String(error?.message ?? error).slice(0, 400)))
    page.on('requestfailed', request => {
      const failure = request.failure()
      record('requestfailed', `${request.method()} ${request.url().slice(0, 200)} — ${failure?.errorText ?? 'failed'}`)
    })
    page.on('dialog', dialog => {
      record('dialog', `${dialog.type()}: ${String(dialog.message()).slice(0, 200)} (auto-dismissed)`)
      dialog.dismiss().catch(() => {})
    })
  }

  /** The active page, created on demand and re-picked if it was closed. */
  async active() {
    const context = await this.ensure()
    if (this.page === undefined || this.page.isClosed()) {
      const pages = context.pages()
      this.page = pages[pages.length - 1] ?? (await context.newPage())
    }
    return this.page
  }

  /** One digest render: page title, url, and budgeted body lines. */
  async digest(page) {
    const result = await page.evaluate(digestInPage, {
      budget: Math.max(400, this.config.maxDigestChars),
      maxElements: this.config.maxElements,
      maxTextLines: this.config.maxTextLines,
      maxLineChars: 90,
    })
    return { text: result.lines.join('\n'), url: result.url, title: result.title }
  }

  /** Take a digest and diff it against the previous one, remembering it. */
  async digestWithDiff(page) {
    const { text, url, title } = await this.digest(page)
    const header = `${title === '' ? '(untitled)' : title} — ${url}`
    if (this.lastDigest === '') {
      this.lastDigest = text
      return `full page digest (first observation)\n${text}`
    }
    const diff = diffLines(this.lastDigest, text)
    this.lastDigest = text
    return renderDiff(diff, header)
  }

  /** Settle briefly, then wait for the network to quiet down if it is willing. */
  async settle(page, network) {
    await page.waitForTimeout(Math.max(0, this.config.settleMs)).catch(() => {})
    if (network === true) await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => {})
  }

  async navigate(input) {
    const page = await this.active()
    const options = { waitUntil: input.waitUntil ?? 'domcontentloaded', timeout: this.config.navTimeoutMs }
    if (input.signal !== undefined) options.signal = input.signal
    const response = await page.goto(input.url, options)
    await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => {})
    const status = response === null ? 'no response' : String(response.status())
    const diff = await this.digestWithDiff(page)
    return `http ${status}\n${diff}`
  }

  /** Resolve a digest ref to its live element handle. */
  async #element(page, ref) {
    const index = Number.parseInt(String(ref).replace(/^e/, ''), 10)
    if (!Number.isFinite(index) || index < 1) throw new Error(`invalid ref "${ref}" (expected e.g. e12 from a digest)`)
    const handle = await page.evaluateHandle(position => window.__dshBrowserSession?.refs?.[position] ?? null, index - 1)
    const element = handle.asElement()
    if (element === null) {
      await handle.dispose()
      throw new Error(`ref "${ref}" is stale or unknown; run browser_snapshot and use a current ref`)
    }
    return element
  }

  async act(input) {
    const page = await this.active()
    const timeout = this.config.actionTimeoutMs
    const action = input.action
    const signal = input.signal
    const options = { timeout, ...(signal !== undefined ? { signal } : {}) }
    let note = ''
    if (action === 'back') {
      await page.goBack({ timeout })
    } else if (action === 'forward') {
      await page.goForward({ timeout })
    } else if (action === 'scroll') {
      const amount = input.amount ?? 600
      const to = input.ref === undefined ? null : input.ref
      if (to === null) await page.evaluate(delta => window.scrollBy(0, delta), amount)
      else {
        const element = await this.#element(page, to)
        await element.scrollIntoViewIfNeeded()
      }
    } else {
      if (action === 'press' && input.ref === undefined) {
        await page.keyboard.press(input.key ?? 'Enter')
        note = `pressed ${input.key ?? 'Enter'}`
      } else {
        const element = await this.#element(page, input.ref)
        if (action === 'click') await element.click(options)
        else if (action === 'dblclick') await element.dblclick(options)
        else if (action === 'hover') await element.hover(options)
        else if (action === 'fill') await element.fill(input.text ?? '', options)
        else if (action === 'type') {
          await element.focus()
          if (typeof element.pressSequentially === 'function') await element.pressSequentially(input.text ?? '', { delay: 20 })
          else await element.type(input.text ?? '', { delay: 20 })
        } else if (action === 'press') {
          await element.focus()
          await page.keyboard.press(input.key ?? 'Enter')
        } else if (action === 'select') await element.selectOption(input.value ?? '')
        else if (action === 'check') await element.check(options)
        else if (action === 'uncheck') await element.uncheck(options)
        else throw new Error(`unsupported action "${action}"`)
        note = `${action} ${input.ref}`
      }
    }
    const network = ['click', 'dblclick', 'press', 'select', 'back', 'forward'].includes(action)
    await this.settle(page, network)
    const diff = await this.digestWithDiff(page)
    return `${note === '' ? action : note}\n${diff}`
  }

  async evaluate(input) {
    const page = await this.active()
    const value = await page.evaluate(input.expression)
    let text
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
    if (text === undefined) text = 'undefined'
    const limit = 4_000
    return text.length > limit ? `${text.slice(0, limit)} … (${text.length} chars total)` : text
  }

  async wait(input) {
    const page = await this.active()
    const timeout = input.timeoutMs ?? 10_000
    if (typeof input.ms === 'number') {
      await page.waitForTimeout(input.ms)
    } else if (typeof input.text === 'string' && input.text !== '') {
      await page.waitForFunction(needle => document.body.innerText.includes(needle), input.text, { timeout })
    } else if (typeof input.goneText === 'string' && input.goneText !== '') {
      await page.waitForFunction(needle => !document.body.innerText.includes(needle), input.goneText, { timeout })
    } else {
      throw new Error('browser_wait needs one of: text, goneText, ms')
    }
    return this.digestWithDiff(page)
  }

  async screenshot(input) {
    const page = await this.active()
    const dir = this.config.screenshotDir !== '' ? this.config.screenshotDir : join(dshHome(), 'browser', 'shots')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const requested = input.name ?? `shot-${stamp}.png`
    const path = isAbsolute(requested) ? requested : join(dir, requested)
    await mkdir(dirname(path), { recursive: true })
    await page.screenshot({ path, fullPage: input.fullPage === true })
    return path
  }

  async tabs(input) {
    const context = await this.ensure()
    const pages = context.pages()
    const action = input.action
    if (action === 'list') {
      return pages
        .map((page, index) => `${page === this.page ? '*' : ' '} ${index}: ${page.isClosed() ? '(closed)' : page.url()}`)
        .join('\n')
    }
    if (action === 'new') {
      const page = await context.newPage()
      if (typeof input.url === 'string' && input.url !== '') await page.goto(input.url)
      this.page = page
      return `opened tab ${pages.length}: ${page.url()}`
    }
    const index = input.index ?? pages.length - 1
    const target = pages[index]
    if (target === undefined) throw new Error(`no tab at index ${index} (${pages.length} open)`)
    if (action === 'select') {
      this.page = target
      // Only activate on request: `bringToFront` raises the OS window, which is
      // exactly the focus theft a background browser exists to avoid.
      if (this.config.activateOnSelect === true) await target.bringToFront().catch(() => {})
      return `active tab ${index}: ${target.url()}\n${await this.digestWithDiff(target)}`
    }
    if (action === 'close') {
      await target.close()
      if (this.page === target) this.page = undefined
      return `closed tab ${index} (${context.pages().length} left)`
    }
    throw new Error(`unsupported tab action "${action}"`)
  }

  async console(input) {
    const level = input.level ?? 'error'
    const limit = input.limit ?? 30
    const wanted = (message) => {
      if (level === 'all') return true
      if (level === 'error') return ['error', 'pageerror', 'requestfailed', 'dialog'].includes(message.type)
      return ['warning', 'warn', 'error', 'pageerror', 'requestfailed', 'dialog'].includes(message.type)
    }
    const selected = this.messages.filter(wanted).slice(-limit)
    if (selected.length === 0) return `no ${level === 'all' ? '' : `${level} `}console output recorded`
    return selected.map(message => `[${message.type}] ${message.text}`).join('\n')
  }

  /** Close the browser; the next tool call launches a fresh one. */
  async dispose() {
    const context = this.context
    this.context = undefined
    this.page = undefined
    this.lastDigest = ''
    if (context !== undefined) await context.close().catch(() => {})
  }
}