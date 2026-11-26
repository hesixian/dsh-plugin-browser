/**
 * End-to-end smoke test for the browser engine, offline.
 *
 * Drives the real BrowserSession against two local fixture pages: navigation
 * diffs, digest refs, real clicks, typing, evaluation, screenshots, tabs, and
 * console capture. No network and no MCP server are involved.
 *
 *   node test/smoke.mjs
 *
 * @module dsh-plugin-browser/test/smoke
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserSession, diffLines, renderDiff } from '../lib/session.mjs'
import { TOOL_PARAMETERS, validateArgs } from '../lib/index.mjs'

const CHECK = '\u2713'

/** First fixture: a form, a button that appends a row, and a console error. */
const PAGE_ONE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>仪表盘</title></head>
<body>
  <h1>测试仪表盘</h1>
  <p>第一段可见文本。</p>
  <a href="/docs">文档</a>
  <button id="add">添加一行</button>
  <label>关键词 <input id="kw" type="text" placeholder="输入关键词"></label>
  <select id="city"><option>北京</option><option>上海</option></select>
  <ul id="rows"><li>初始行</li></ul>
  <script>
    document.getElementById('add').addEventListener('click', () => {
      const li = document.createElement('li')
      li.textContent = '新增行 ' + document.querySelectorAll('#rows li').length
      document.getElementById('rows').appendChild(li)
    })
    console.error('fixture error line')
  </script>
</body></html>`

/** Second fixture: one heading changed and one button added, for the diff. */
const PAGE_TWO = PAGE_ONE.replace('<h1>测试仪表盘</h1>', '<h1>测试仪表盘（改版）</h1>').replace(
  '<button id="add">添加一行</button>',
  '<button id="add">添加一行</button><button id="export">导出</button>',
)

/** Find a digest ref by matching one of its element lines. */
function refFor(digest, needle) {
  const line = digest.split('\n').find(candidate => /^\[e\d+\]/.test(candidate) && candidate.includes(needle))
  assert.ok(line !== undefined, `digest has no element line containing ${JSON.stringify(needle)}\n${digest}`)
  const ref = /^\[(e\d+)\]/.exec(line)?.[1]
  assert.ok(ref !== undefined, `digest line has no ref: ${line}`)
  return ref
}

/** Argument validation is the plugin's own job: a raw definition has no validator. */
function checkValidation() {
  assert.deepEqual(validateArgs('t', TOOL_PARAMETERS.browser_navigate, { url: 'https://x' }), [])
  assert.equal(validateArgs('t', TOOL_PARAMETERS.browser_navigate, {}).length, 1)
  assert.equal(validateArgs('t', TOOL_PARAMETERS.browser_navigate, { url: 7 }).length, 1)
  assert.equal(validateArgs('t', TOOL_PARAMETERS.browser_act, { action: 'nope' }).length, 1)
  assert.equal(validateArgs('t', TOOL_PARAMETERS.browser_act, { action: 'click', amount: 'x' }).length, 1)
  assert.deepEqual(validateArgs('t', TOOL_PARAMETERS.browser_snapshot, {}), [])
}

/** The line diff must localize a change instead of shifting every later line. */
function checkDiff() {
  const before = 'page: A\nh1 标题\n[e1] link "文档" -> /docs\n[e2] button "添加一行'
  const after = 'page: A\nh1 标题\n[e1] link "文档" -> /docs\n[e2] button "添加一行\n[e3] button "导出"'
  const diff = diffLines(before, after)
  assert.deepEqual(diff.added, ['[e3] button "导出"'])
  assert.deepEqual(diff.removed, [])
  assert.match(renderDiff(diff, 'header'), /Δ \+1 −0/)
  assert.match(renderDiff(diffLines(before, before), 'header'), /no visible change/)
}

async function main() {
  checkValidation()
  checkDiff()
  process.stdout.write(`${CHECK} argument validation and line diff\n`)

  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-browser-smoke-'))
  const one = join(root, 'one.html')
  const two = join(root, 'two.html')
  await writeFile(one, PAGE_ONE, 'utf8')
  await writeFile(two, PAGE_TWO, 'utf8')

  const session = new BrowserSession({
    headless: true,
    userDataDir: join(root, 'profile'),
    screenshotDir: join(root, 'shots'),
    settleMs: 120,
  })
  try {
    const first = await session.navigate({ url: pathToFileURL(one).href })
    assert.match(first, /http 200/)
    assert.match(first, /full page digest \(first observation\)/)
    assert.match(first, /测试仪表盘/)
    assert.match(first, /\[e\d+\] button "添加一行"/)
    process.stdout.write(`${CHECK} navigate returned a full digest on first observation\n`)

    const repeat = await session.navigate({ url: pathToFileURL(one).href })
    assert.match(repeat, /no visible change/)
    process.stdout.write(`${CHECK} re-navigating the same page reported no visible change\n`)

    const second = await session.navigate({ url: pathToFileURL(two).href })
    assert.match(second, /Δ \+/)
    assert.match(second, /导出/)
    assert.ok(
      !second.includes('[e1] link "文档"'),
      `a diff must not repeat unchanged lines:\n${second}`,
    )
    assert.ok(second.split('\n').length < 20, `a diff must stay small:\n${second}`)
    process.stdout.write(`${CHECK} changed page returned only a diff (${second.split('\n').length} lines)\n`)

    const snapshot = (await session.digest(await session.active())).text
    const button = refFor(snapshot, '添加一行')
    const field = refFor(snapshot, '关键词')
    const select = refFor(snapshot, '北京')
    assert.ok(Number(button.slice(1)) > 0)

    const clicked = await session.act({ action: 'click', ref: button })
    assert.match(clicked, /新增行/, `expected the new row in the diff:\n${clicked}`)
    process.stdout.write(`${CHECK} click on ${button} produced the appended row in the diff\n`)

    const typed = await session.act({ action: 'fill', ref: field, text: '管网' })
    assert.match(typed, /管网/, `expected the typed value in the diff:\n${typed}`)
    const read = await session.evaluate({ expression: 'document.getElementById("kw").value' })
    assert.equal(read, '"管网"')
    process.stdout.write(`${CHECK} fill + eval round-trip (eval returned ${read})\n`)

    const selected = await session.act({ action: 'select', ref: select, value: '上海' })
    assert.match(selected, /上海/, `expected the selected option in the diff:\n${selected}`)
    process.stdout.write(`${CHECK} select by ref\n`)

    const pressed = await session.act({ action: 'press', key: 'Tab' })
    assert.ok(typeof pressed === 'string' && pressed.length > 0)
    process.stdout.write(`${CHECK} global key press\n`)

    const shot = await session.screenshot({ name: 'smoke.png' })
    assert.ok(existsSync(shot), `screenshot missing at ${shot}`)
    assert.ok((await readFile(shot)).length > 1000)
    process.stdout.write(`${CHECK} screenshot written to ${shot}\n`)

    const messages = await session.console({ level: 'error' })
    assert.match(messages, /fixture error line/)
    process.stdout.write(`${CHECK} console capture saw the page error\n`)

    const tabs = await session.tabs({ action: 'list' })
    assert.match(tabs, /\* 0:/)
    await session.tabs({ action: 'new', url: pathToFileURL(one).href })
    assert.match(await session.tabs({ action: 'list' }), /1:/)
    await session.tabs({ action: 'select', index: 0 })
    await session.tabs({ action: 'close', index: 1 })
    process.stdout.write(`${CHECK} tab list/new/select/close\n`)

    const waited = await session.wait({ ms: 150 })
    assert.ok(typeof waited === 'string')
    process.stdout.write(`${CHECK} wait\n`)

    const stale = await session
      .act({ action: 'click', ref: 'e9999' })
      .then(() => 'no error')
      .catch(error => error.message)
    assert.match(stale, /stale or unknown/)
    process.stdout.write(`${CHECK} a stale ref fails with a readable message\n`)
  } finally {
    await session.dispose()
    await rm(root, { recursive: true, force: true })
  }
  process.stdout.write('\nsmoke: all browser engine checks passed\n')
}

await main()