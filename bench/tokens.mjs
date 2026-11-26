/**
 * Reproducible token-cost benchmark for the digest + diff reply model.
 *
 * The README's central claim is a *token* claim: that describing a page with a
 * budgeted, ref-indexed digest and replying with a line diff costs an order of
 * magnitude less than handing the model a full accessibility snapshot. A claim
 * that matters needs a script, not an anecdote — this is that script.
 *
 * It measures three fixtures (a form, a 60-row table, an article) on this
 * machine, offline:
 *
 *   | baseline                                  | what it is                          |
 *   |-------------------------------------------|-------------------------------------|
 *   | Playwright `ariaSnapshot()`               | the tree Playwright-based MCP tools ship |
 *   | `document.body.innerText`                 | a naive "dump the text" baseline    |
 *   | this plugin's digest                      | budgeted, ref-indexed, ~1k tokens   |
 *   | this plugin's reply after a small change  | a line diff, not the page again     |
 *
 * Token counts are an estimate: CJK characters are counted as one token each,
 * everything else at four characters per token. That heuristic is deliberately
 * conservative (it over-counts English, under-counts JSON-heavy text), so the
 * comparison stays honest without pretending to know a tokenizer.
 *
 *   node bench/tokens.mjs
 *   node bench/tokens.mjs --json      # machine-readable
 *
 * @module dsh-plugin-browser/bench/tokens
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserSession } from '../lib/session.mjs'

/** Count CJK code points as one token each, other characters at four per token. */
export function estimateTokens(text) {
  let tokens = 0
  let other = 0
  for (const character of String(text)) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(character)) {
      tokens += 1
    } else {
      other += 1
    }
  }
  return tokens + Math.ceil(other / 4)
}

/** A form with labels, a select, checkboxes and a button that appends a row. */
const FORM = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>订单录入</title></head>
<body>
  <h1>订单录入</h1>
  <p>请填写客户信息并提交，带星号的字段为必填项。</p>
  <label>客户名称 <input id="name" placeholder="请输入客户名称"></label>
  <label>联系电话 <input id="phone" placeholder="请输入手机号"></label>
  <label>城市 <select id="city"><option>北京</option><option>上海</option><option>广州</option></select></label>
  <label><input type="checkbox" id="urgent"> 加急处理</label>
  <button id="add">添加明细行</button>
  <table><tbody id="rows"><tr><td>初始明细</td></tr></tbody></table>
  <script>
    document.getElementById('add').addEventListener('click', () => {
      const tr = document.createElement('tr')
      tr.innerHTML = '<td>新增明细 ' + document.querySelectorAll('#rows tr').length + '</td>'
      document.getElementById('rows').appendChild(tr)
    })
  </script>
</body></html>`

/** A 60-row table: the case where a full snapshot explodes. */
const TABLE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>管网台账</title></head>
<body>
  <h1>管网台账</h1>
  <table><thead><tr><th>编号</th><th>类型</th><th>位置</th><th>长度</th><th>操作</th></tr></thead>
  <tbody>${Array.from({ length: 60 }, (_, index) => `<tr><td>PS-${String(index + 1).padStart(3, '0')}</td><td>污水管</td><td>人民路 ${index + 1} 号</td><td>${(index + 1) * 12} m</td><td><button>查看</button><a href="/t/${index + 1}">编辑</a></td></tr>`).join('')}</tbody></table>
</body></html>`

/** An article: mostly prose, the shape a "read this page" request usually has. */
const ARTICLE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>技术说明</title></head>
<body>
  <h1>技术说明</h1>
  ${Array.from({ length: 24 }, (_, index) => `<h2>第 ${index + 1} 节</h2><p>这是第 ${index + 1} 节的正文，用来模拟一篇需要通读的长文章。段落中包含若干技术细节，以及一些需要在回答里引用的结论。</p>`).join('')}
</body></html>`

/**
 * Measure the cost of a *session*, not a page.
 *
 * A snapshot-style tool re-sends the whole tree on every turn, so its cost grows
 * with turns × page size. A diff-only reply costs a line per turn regardless of
 * page size — or one line saying nothing changed.
 * @param session - the session to drive.
 * @param root - temporary directory holding the fixture.
 * @param fixture - the page to drive and the element to click.
 * @returns the per-turn cost of both models.
 */
async function measureSequence(session, root, fixture) {
  const file = join(root, `sequence-${fixture.label}.html`)
  await writeFile(file, fixture.html, 'utf8')
  await session.navigate({ url: pathToFileURL(file).href })
  const page = await session.active()
  const digest = (await session.digest(page)).text
  let ariaTokens = null
  try {
    ariaTokens = estimateTokens(await page.locator('body').ariaSnapshot())
  } catch {
    ariaTokens = null
  }
  const line = digest.split('\n').find(candidate => /^\[e\d+\]/.test(candidate) && candidate.includes(fixture.needle))
  const ref = line === undefined ? undefined : /^\[(e\d+)\]/.exec(line)?.[1]
  if (ref === undefined) return null
  const rounds = 10
  let pluginTotal = 0
  for (let round = 0; round < rounds; round += 1) {
    pluginTotal += estimateTokens(await session.act({ action: 'click', ref }))
  }
  return {
    label: fixture.label,
    rounds,
    ariaTokens,
    baselineTotal: ariaTokens === null ? null : ariaTokens * rounds,
    pluginTotal,
  }
}

/** Fixtures to measure, in report order. */
const FIXTURES = [
  { name: '表单（含 5 个可交互元素）', html: FORM, action: 'click', needle: '添加明细行' },
  { name: '台账（60 行表格）', html: TABLE, action: 'none' },
  { name: '文章（24 节正文）', html: ARTICLE, action: 'none' },
]

/** Measure one fixture and return its row of numbers. */
async function measure(session, fixture, root) {
  const file = join(root, `${fixture.name}.html`)
  await writeFile(file, fixture.html, 'utf8')
  await session.navigate({ url: pathToFileURL(file).href })

  const page = await session.active()
  const digest = (await session.digest(page)).text
  const bodyText = await page.evaluate(() => document.body.innerText)
  let aria = ''
  try {
    aria = await page.locator('body').ariaSnapshot()
  } catch {
    aria = ''
  }

  let diffReply = ''
  if (fixture.action === 'click') {
    const line = digest.split('\n').find(candidate => /^\[e\d+\]/.test(candidate) && candidate.includes(fixture.needle))
    if (line !== undefined) {
      const ref = /^\[(e\d+)\]/.exec(line)?.[1]
      diffReply = await session.act({ action: 'click', ref })
    }
  }

  return {
    fixture: fixture.name,
    bodyChars: bodyText.length,
    bodyTokens: estimateTokens(bodyText),
    ariaChars: aria.length,
    ariaTokens: aria === '' ? null : estimateTokens(aria),
    digestChars: digest.length,
    digestTokens: estimateTokens(digest),
    diffChars: diffReply.length,
    diffTokens: diffReply === '' ? null : estimateTokens(diffReply),
  }
}

/** Render the rows as a markdown table. */
function table(rows) {
  const lines = [
    '| 场景 | innerText | 无障碍树 ariaSnapshot | 本插件摘要 | 改动后的 diff 回包 |',
    '|---|---|---|---|---|',
  ]
  const tokens = row => (row.ariaTokens === null ? 'n/a' : `${row.ariaTokens}`)
  const diff = row => (row.diffTokens === null ? 'n/a' : `${row.diffTokens} tok / ${row.diffChars} 字符`)
  for (const row of rows) {
    lines.push(
      `| ${row.fixture} | ${row.bodyTokens} tok / ${row.bodyChars} 字符 | ${tokens(row)} tok / ${row.ariaChars} 字符 | ` +
        `${row.digestTokens} tok / ${row.digestChars} 字符 | ${diff(row)} |`,
    )
  }
  return lines.join('\n')
}

async function main() {
  const json = process.argv.includes('--json')
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-browser-bench-'))
  const session = new BrowserSession({
    headless: true,
    userDataDir: join(root, 'profile'),
    screenshotDir: join(root, 'shots'),
    settleMs: 200,
  })
  const rows = []
  const sequences = []
  try {
    for (const fixture of FIXTURES) rows.push(await measure(session, fixture, root))
    for (const fixture of [
      { label: '表单：每轮点击都会新增一行', html: FORM, needle: '添加明细行' },
      { label: '台账：每轮点击都不改变页面', html: TABLE, needle: '查看' },
    ]) {
      const measured = await measureSequence(session, root, fixture)
      if (measured !== null) sequences.push(measured)
    }
  } finally {
    await session.dispose()
    await rm(root, { recursive: true, force: true })
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ platform: process.platform, node: process.version, rows, sequences }, null, 2)}\n`,
    )
    return
  }

  process.stdout.write(`# token 成本实测（${process.platform} / Node ${process.version}）\n\n`)
  process.stdout.write(`${table(rows)}\n\n`)
  const comparable = rows.filter(row => row.ariaTokens !== null)
  if (comparable.length > 0) {
    for (const row of comparable) {
      const ratio = (row.ariaTokens / row.digestTokens).toFixed(1)
      process.stdout.write(`· ${row.fixture}：摘要是无障碍树的 1/${ratio}\n`)
    }
  }
  process.stdout.write(
    '\n注：token 为估算值（CJK 字符按 1 计，其余按 4 字符 1 计），仅用于同机同场景的相对比较。\n',
  )
  if (sequences.length > 0) {
    process.stdout.write(`\n## 连续 10 轮交互的累计成本\n\n`)
    for (const sequence of sequences) {
      if (sequence.baselineTotal === null) continue
      const ratio = (sequence.baselineTotal / sequence.pluginTotal).toFixed(1)
      process.stdout.write(
        `· ${sequence.label}：每轮回发完整摘要 ${sequence.baselineTotal} tok（10 × ${sequence.ariaTokens}）` +
          ` vs 只回 diff ${sequence.pluginTotal} tok —— 1/${ratio}\n`,
      )
    }
    process.stdout.write(
      '\n单页首次观察时两者接近；差距随交互轮数线性放大，页面越大越明显。这才是 diff-only 的真正价值。\n',
    )
  }
}

await main()