/**
 * Registry acceptance test: mount the **real** `@deepseek-ai/dsh-tools`
 * runtime on a real cordis context, register this plugin's eight raw tool
 * definitions, and run calls through the real pipeline.
 *
 * This is the check a boot rehearsal would otherwise provide — that the
 * registry accepts definition objects which never went through `defineTool`,
 * that the shipped output schema passes `assertSupportedJsonSchema`, and that a
 * call really executes and returns rendered content. It needs no web server,
 * no profile restart, and no network.
 *
 *   node test/registry.mjs
 *
 * @module dsh-plugin-browser/test/registry
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveFrom } from '../lib/dsh-paths.mjs'

const CHECK = '\u2713'

const toolsPlugin = (await import(pathToFileURL(resolveFrom('@deepseek-ai/dsh-tools')).href)).default
/**
 * Since DSH's tool runtime hands dispatch to a *provider*, mounting `dsh-tools`
 * alone is no longer a complete composition: `ctx.tools.execute` throws
 * `ToolExecutorUnavailableError` until an executor registers itself. The real
 * deployment mounts the native executor, so this test does the same rather than
 * stubbing dispatch — a stub would stop it from testing the pipeline it claims
 * to test.
 */
const executorPlugin = await import(pathToFileURL(resolveFrom('@deepseek-ai/dsh-tool-executor-native')).href)
const { Context } = await import(pathToFileURL(resolveFrom('@deepseek-ai/cordis')).href)
/** The plugin module exactly as the DSH loader mounts it: `{ name, inject, apply }`. */
const browserPlugin = await import('../lib/index.mjs')

/** A stand-in for the prompt assembler `dsh-tools` injects; it never needs to do anything. */
const systemPromptStub = new Proxy(
  {},
  {
    get: () => () => undefined,
  },
)

const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-browser-registry-'))
const fixture = join(root, 'page.html')
await writeFile(
  fixture,
  '<title>注册表测试</title><h1>注册表测试</h1><button>确定</button><input placeholder="关键词">',
  'utf8',
)

const ctx = new Context()
ctx.provide('systemPrompt', systemPromptStub)
// Awaiting a plugin fiber settles once its apply finished, including inject waits.
const registryFiber = ctx.plugin(toolsPlugin)
await registryFiber
assert.ok(ctx.tools !== undefined, 'mounting dsh-tools must provide ctx.tools')
const executorFiber = ctx.plugin(executorPlugin)
await executorFiber
process.stdout.write(`${CHECK} mounted the real ToolRuntime and its native executor\n`)

const browserFiber = ctx.plugin(browserPlugin, {
  headless: true,
  userDataDir: join(root, 'profile'),
  screenshotDir: join(root, 'shots'),
  settleMs: 50,
})
await browserFiber
process.stdout.write(`${CHECK} the loader-shaped plugin object mounted (awaited its fiber)\n`)

try {
  const names = ctx.tools
    .schemas()
    .map(schema => schema.name)
    .sort()
  assert.deepEqual(
    names,
    ['browser_act', 'browser_console', 'browser_eval', 'browser_navigate', 'browser_screenshot', 'browser_snapshot', 'browser_tab', 'browser_wait'],
    'the registry must expose exactly the eight browser tools',
  )
  process.stdout.write(`${CHECK} the registry accepted all ${names.length} raw definitions\n`)

  const signal = new AbortController().signal
  /**
   * Dispatch one call the way the runtime does now: a batch of raw calls whose
   * arguments travel as a JSON string, settled into `results[].result`.
   * @param name - tool name.
   * @param args - the model-shaped argument object.
   * @returns the settled result for that one call.
   */
  const call = async (name, args) => {
    const batch = await ctx.tools.execute({
      calls: [{ id: `${name}-call`, name, arguments: JSON.stringify(args) }],
      signal,
    })
    return batch.results[0].result
  }

  const navigated = await call('browser_navigate', { url: pathToFileURL(fixture).href })
  assert.equal(navigated.isError, false, `navigate failed: ${JSON.stringify(navigated.content)}`)
  const digest = navigated.content.map(block => block.text).join('\n')
  assert.match(digest, /http 200/)
  assert.match(digest, /注册表测试/)
  assert.match(digest, /\[e\d+\] button "确定"/)
  assert.equal(navigated.value, digest, 'the canonical value must be the string the renderer projected')
  process.stdout.write(`${CHECK} browser_navigate executed through the real pipeline\n`)

  const evaluated = await call('browser_eval', { expression: 'document.querySelector("button").textContent' })
  assert.equal(evaluated.isError, false)
  assert.equal(evaluated.content[0].text, '"确定"')
  process.stdout.write(`${CHECK} browser_eval executed through the real pipeline\n`)

  const badArgs = await call('browser_act', { action: 'definitely-not-an-action' })
  assert.equal(badArgs.isError, true, 'checked arguments must fail before dispatch')
  assert.match(badArgs.content[0].text, /must be one of/)
  process.stdout.write(`${CHECK} invalid arguments are rejected with a readable violation\n`)

  const unknown = await call('browser_nope', {})
  assert.equal(unknown.isError, true)
  process.stdout.write(`${CHECK} an unknown tool fails as a structured error, not a crash\n`)
} finally {
  // Disposing the browser fiber runs the plugin's own ctx.effect disposer.
  await browserFiber.dispose().catch(() => {})
  await executorFiber.dispose().catch(() => {})
  await registryFiber.dispose().catch(() => {})
  await rm(root, { recursive: true, force: true })
}

process.stdout.write('\nregistry: the shipped definitions are accepted and executable\n')