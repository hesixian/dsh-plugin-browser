/**
 * @hesixian/dsh-plugin-browser: eight in-process browser tools for the DSH host
 * process.
 *
 * The tools own one resident Playwright browser (launched lazily, reused for
 * the process lifetime) and describe a page with a compact ref-indexed digest
 * instead of a full accessibility snapshot, so a navigation costs a diff of a
 * few dozen lines rather than tens of thousands of tokens.
 *
 * The definitions below are plain `ToolDefinition` objects carrying raw JSON
 * Schema — the package deliberately has **zero runtime dependencies**, so it
 * needs no registry access to install and nothing to resolve at boot. The raw
 * parameter schemas are byte-identical to what `defineTool` from
 * `@deepseek-ai/dsh-tools` would compile for the equivalent spec, which
 * `test/verify-tools.mjs` asserts against the shipped library.
 *
 * @module dsh-plugin-browser
 */

import { BrowserSession } from './session.mjs'

export const name = 'dsh-plugin-browser'

/** The registry this plugin contributes to. */
export const inject = ['tools']

/**
 * Raw parameter schemas, in `defineTool`-compiled form (property maps with an
 * implicit open root and an explicit `required` list).
 */
export const TOOL_PARAMETERS = {
  browser_navigate: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL to open.' },
      waitUntil: {
        type: 'string',
        description: 'When navigation counts as finished; default domcontentloaded.',
        enum: ['domcontentloaded', 'load', 'networkidle'],
      },
    },
    required: ['url'],
  },
  browser_snapshot: { type: 'object', properties: {} },
  browser_act: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'What to do.',
        enum: ['click', 'dblclick', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'back', 'forward'],
      },
      ref: { type: 'string', description: 'Digest ref such as e12.' },
      text: { type: 'string', description: 'Text for fill or type.' },
      value: { type: 'string', description: 'Option value for select.' },
      key: { type: 'string', description: 'Key for press, e.g. Enter.' },
      amount: { type: 'number', description: 'Pixels to scroll; default 600.' },
    },
    required: ['action'],
  },
  browser_eval: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'JavaScript expression evaluated in the page.' },
    },
    required: ['expression'],
  },
  browser_wait: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Wait until this text is visible.' },
      goneText: { type: 'string', description: 'Wait until this text is gone.' },
      ms: { type: 'number', description: 'Fixed delay in milliseconds.' },
      timeoutMs: { type: 'number', description: 'Deadline; default 10000.' },
    },
  },
  browser_screenshot: {
    type: 'object',
    properties: {
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page.' },
      name: { type: 'string', description: 'File name or absolute path for the PNG.' },
    },
  },
  browser_tab: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Tab operation.',
        enum: ['list', 'new', 'select', 'close'],
      },
      index: { type: 'number', description: 'Zero-based tab index for select or close.' },
      url: { type: 'string', description: 'URL to open with a new tab.' },
    },
    required: ['action'],
  },
  browser_console: {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        description: 'Severity filter; default error.',
        enum: ['error', 'warn', 'all'],
      },
      limit: { type: 'number', description: 'Maximum messages; default 30.' },
    },
  },
}

/**
 * Validate model arguments against the subset these schemas use — the same
 * job `defineTool` bakes into its own `execute`. A raw definition carries no
 * validator, so an invalid call must fail here with a readable message rather
 * than deep inside Playwright.
 * @param toolName - tool name for the message.
 * @param parameters - the tool's raw parameter schema.
 * @param args - the model-supplied arguments.
 * @returns the violations, empty when the arguments are acceptable.
 */
export function validateArgs(toolName, parameters, args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return [`${toolName}: arguments must be an object`]
  }
  const violations = []
  for (const key of parameters.required ?? []) {
    if (args[key] === undefined) violations.push(`${toolName}: missing required property "${key}"`)
  }
  for (const [key, schema] of Object.entries(parameters.properties ?? {})) {
    const value = args[key]
    if (value === undefined) continue
    if (schema.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== schema.type) {
      violations.push(`${toolName}.${key}: expected ${schema.type}, got ${typeof value}`)
      continue
    }
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
      violations.push(`${toolName}.${key}: must be one of ${schema.enum.join(' | ')}`)
    }
  }
  return violations
}

/** How a tool's canonical string value reaches the model. */
const output = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/**
 * Build one registry-ready definition from a raw parameter schema.
 * @param tool - name, description, schema, body, and optional deadline.
 * @returns a `ToolDefinition` for `ctx.tools.register`.
 */
function tool({ name: toolName, description, parameters, timeoutMs, execute }) {
  return {
    name: toolName,
    description,
    parameters,
    output,
    timeoutMs,
    async execute(args, exec) {
      const violations = validateArgs(toolName, parameters, args)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return String(await execute(args, exec))
    },
  }
}

/** The eight tool definitions, all sharing one resident browser. */
function definitions(session) {
  return [
    tool({
      name: 'browser_navigate',
      description:
        'Open a URL in the resident browser and return the HTTP status plus a compact diff against the previous page digest. ' +
        'The first navigation of a browser returns the full digest; later ones return only changed lines.',
      parameters: TOOL_PARAMETERS.browser_navigate,
      timeoutMs: 60_000,
      execute: args => session.navigate({ url: args.url, waitUntil: args.waitUntil }),
    }),
    tool({
      name: 'browser_snapshot',
      description:
        'Return the full compact digest of the current page — title, URL, headings, visible text lines, and interactive ' +
        'elements with refs like e12 that browser_act accepts — instead of a diff.',
      parameters: TOOL_PARAMETERS.browser_snapshot,
      timeoutMs: 30_000,
      execute: async () => (await session.digest(await session.active())).text,
    }),
    tool({
      name: 'browser_act',
      description:
        'Drive the page: click/dblclick/hover/fill/type/select/check/uncheck by digest ref, press a key, scroll, or ' +
        'go back/forward. Returns the diff of what changed afterwards.',
      parameters: TOOL_PARAMETERS.browser_act,
      timeoutMs: 45_000,
      execute: (args, exec) =>
        session.act({
          action: args.action,
          ref: args.ref,
          text: args.text,
          value: args.value,
          key: args.key,
          amount: args.amount,
          signal: exec.signal,
        }),
    }),
    tool({
      name: 'browser_eval',
      description:
        'Evaluate a JavaScript expression in the page and return its JSON result (truncated). Use it to read or extract ' +
        'page content, or when no digest ref fits the job.',
      parameters: TOOL_PARAMETERS.browser_eval,
      timeoutMs: 30_000,
      execute: args => session.evaluate({ expression: args.expression }),
    }),
    tool({
      name: 'browser_wait',
      description:
        'Wait until text appears (text) or disappears (goneText), or for a fixed delay (ms), then return the diff.',
      parameters: TOOL_PARAMETERS.browser_wait,
      timeoutMs: 45_000,
      execute: args => session.wait({ text: args.text, goneText: args.goneText, ms: args.ms, timeoutMs: args.timeoutMs }),
    }),
    tool({
      name: 'browser_screenshot',
      description:
        'Save a PNG of the page (or the whole scrollable page) to disk and return its path. Use read_image to look at it.',
      parameters: TOOL_PARAMETERS.browser_screenshot,
      timeoutMs: 30_000,
      execute: args => session.screenshot({ fullPage: args.fullPage, name: args.name }),
    }),
    tool({
      name: 'browser_tab',
      description: 'List, open, activate, or close browser tabs. Activating a tab returns its digest diff.',
      parameters: TOOL_PARAMETERS.browser_tab,
      timeoutMs: 30_000,
      execute: args => session.tabs({ action: args.action, index: args.index, url: args.url }),
    }),
    tool({
      name: 'browser_console',
      description: 'Return recent console messages, page errors, and failed requests, oldest first.',
      parameters: TOOL_PARAMETERS.browser_console,
      timeoutMs: 10_000,
      execute: args => session.console({ level: args.level, limit: args.limit }),
    }),
  ]
}

/**
 * Register the browser tools and own the resident browser's lifetime.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - optional overrides of {@link DEFAULTS} (channel, headless, userDataDir, budgets).
 */
export function apply(ctx, config = {}) {
  const session = new BrowserSession({
    ...config,
    // A logger must never take the registration down with it, so the session
    // gets a callback that swallows its own failures.
    log:
      config.log ??
      (message => {
        try {
          ctx.logger?.info?.(message)
        } catch {
          // logging is not worth failing a launch for
        }
      }),
  })
  const registered = definitions(session)
  for (const definition of registered) ctx.tools.register(definition)
  ctx.effect(() => () => session.dispose(), 'dsh-plugin-browser: close the resident browser')
  // One startup line for operators (and one piece of evidence that a boot
  // rehearsal really did mount this layer).
  try {
    ctx.logger?.info?.(
      `dsh-plugin-browser: registered ${registered.length} tools; the browser launches on first use`,
    )
  } catch {
    // logging is not worth failing a plugin mount for
  }
}