/**
 * Verify the plugin's hand-written raw parameter schemas against the real
 * `@deepseek-ai/dsh-tools` compiler.
 *
 * The plugin ships zero runtime dependencies: its tool definitions are plain
 * objects carrying raw JSON Schema. This test pins that claim down by
 * compiling the *equivalent* `defineTool` spec with the shipped library and
 * asserting the two are byte-identical, so the registry validates model
 * arguments against exactly the schema `defineTool` would have produced.
 *
 *   node test/verify-tools.mjs          # assert equality
 *   node test/verify-tools.mjs --print  # dump the compiled schemas
 *
 * @module dsh-plugin-browser/test/verify-tools
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolveFrom } from '../lib/dsh-paths.mjs'

const printed = process.argv.includes('--print')
/** `--print` only needs the specs, so it does not depend on the plugin loading. */
const { TOOL_PARAMETERS } = printed ? { TOOL_PARAMETERS: {} } : await import('../lib/index.mjs')

/** Load the shipped tool library from whichever root provides it. */
export async function loadDshTools(env = process.env) {
  return import(pathToFileURL(resolveFrom('@deepseek-ai/dsh-tools', env)).href)
}

/** The `defineTool` parameter specs the shipped raw schemas must equal. */
export const EQUIVALENT_SPECS = {
  browser_navigate: {
    url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
    waitUntil: {
      type: 'string',
      enum: ['domcontentloaded', 'load', 'networkidle'],
      description: 'When navigation counts as finished; default domcontentloaded.',
    },
  },
  browser_snapshot: {},
  browser_act: {
    action: {
      type: 'string',
      required: true,
      enum: ['click', 'dblclick', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'back', 'forward'],
      description: 'What to do.',
    },
    ref: { type: 'string', description: 'Digest ref such as e12.' },
    text: { type: 'string', description: 'Text for fill or type.' },
    value: { type: 'string', description: 'Option value for select.' },
    key: { type: 'string', description: 'Key for press, e.g. Enter.' },
    amount: { type: 'number', description: 'Pixels to scroll; default 600.' },
  },
  browser_eval: {
    expression: { type: 'string', required: true, description: 'JavaScript expression evaluated in the page.' },
  },
  browser_wait: {
    text: { type: 'string', description: 'Wait until this text is visible.' },
    goneText: { type: 'string', description: 'Wait until this text is gone.' },
    ms: { type: 'number', description: 'Fixed delay in milliseconds.' },
    timeoutMs: { type: 'number', description: 'Deadline; default 10000.' },
  },
  browser_screenshot: {
    fullPage: { type: 'boolean', description: 'Capture the whole scrollable page.' },
    name: { type: 'string', description: 'File name or absolute path for the PNG.' },
  },
  browser_tab: {
    action: {
      type: 'string',
      required: true,
      enum: ['list', 'new', 'select', 'close'],
      description: 'Tab operation.',
    },
    index: { type: 'number', description: 'Zero-based tab index for select or close.' },
    url: { type: 'string', description: 'URL to open with a new tab.' },
  },
  browser_console: {
    level: { type: 'string', enum: ['error', 'warn', 'all'], description: 'Severity filter; default error.' },
    limit: { type: 'number', description: 'Maximum messages; default 30.' },
  },
}

const { defineTool, parameterSchemaSpecToJsonSchema } = await loadDshTools()
const { apply } = await import('../lib/index.mjs')
const names = Object.keys(EQUIVALENT_SPECS)

if (printed) {
  for (const name of names) {
    process.stdout.write(`${name}\n${JSON.stringify(parameterSchemaSpecToJsonSchema(EQUIVALENT_SPECS[name]), null, 2)}\n\n`)
  }
} else {
  assert.deepEqual(
    Object.keys(TOOL_PARAMETERS).sort(),
    [...names].sort(),
    'the plugin must ship exactly the eight verified tools',
  )
  for (const name of names) {
    const compiled = JSON.parse(JSON.stringify(parameterSchemaSpecToJsonSchema(EQUIVALENT_SPECS[name])))
    assert.deepEqual(
      JSON.parse(JSON.stringify(TOOL_PARAMETERS[name])),
      compiled,
      `${name}: shipped raw schema must equal the compiled defineTool schema`,
    )
    // A definition carrying this spec must be accepted by defineTool itself.
    defineTool({
      name,
      description: 'verification stub',
      parameters: EQUIVALENT_SPECS[name],
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('ok'),
    })
    process.stdout.write(`ok ${name}\n`)
  }
  // `apply` must register exactly those tools and own a disposer for the browser.
  const registered = []
  let disposer
  apply(
    {
      tools: { register: definition => registered.push(definition.name) },
      effect: callback => {
        disposer = callback()
      },
    },
    {},
  )
  assert.deepEqual([...registered].sort(), [...names].sort(), 'apply must register exactly the eight verified tools')
  assert.equal(typeof disposer, 'function', 'apply must return a browser disposer through ctx.effect')
  process.stdout.write(`ok apply() registered ${registered.length} tools with a disposer\n`)
  process.stdout.write(`\nverified ${names.length} tool schemas against @deepseek-ai/dsh-tools\n`)
}