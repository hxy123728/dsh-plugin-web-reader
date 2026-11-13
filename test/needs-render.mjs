#!/usr/bin/env node
/**
 * needsRender 判定测试：不联网，用构造样本覆盖"空壳"与"正常文章"。
 *   node test/needs-render.mjs
 */
import { looksLikeSpa } from '../lib/adapters.mjs'

const spaOne = `<html><head><script src="a.js"></script></head><body><div id="app"></div>
<script>window.__INITIAL_STATE__={}</script></body></html>`

const spaTwo = `<html><head><script>1</script><script>2</script><script>3</script><script>4</script><script>5</script></head>
<body><div class="loading">Loading…</div></body></html>`

const noscript = `<html><body><noscript>请启用 JavaScript 后继续</noscript><div id="root"></div></body></html>`

const article = `<html><body><article><h1>标题</h1>${'<p>' + '这是一段足够长的正文内容，用来模拟真实文章。'.repeat(8) + '</p>'.repeat(1)}</article></body></html>`

const shortButReal = `<html><body><main><h1>短公告</h1><p>系统将于今晚 23:00 维护，预计 30 分钟。</p></main></body></html>`

const cases = [
  ['Next/React 空壳', spaOne, '', true],
  ['脚本多且无正文', spaTwo, '', true],
  ['noscript 提示', noscript, '', true],
  ['正常文章', article, '这是一段足够长的正文内容，用来模拟真实文章。'.repeat(12), false],
  ['短但有真实内容', shortButReal, '系统将于今晚 23:00 维护，预计 30 分钟。'.repeat(5), false],
]

let failed = 0
for (const [name, html, text, want] of cases) {
  const got = looksLikeSpa(html, text)
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  期望=${want} 实际=${got}`)
}
if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
