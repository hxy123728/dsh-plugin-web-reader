#!/usr/bin/env node
/**
 * 联调测试：web_read 在"空壳页"上自动借 websift 的渲染服务。
 * 用假服务验证接线（真 Chrome 起不来的环境也能跑）。
 *   node test/websift-bridge.mjs
 *
 * 覆盖两条路径：
 *   A. 服务返回 HTML（首选用我们的抽取器清洗）
 *   B. 服务只返回纯文本（退回原样）
 */
import { buildTool } from '../lib/tool.mjs'

const SPA_URL = 'https://www.xiaohongshu.com/explore'
const PARAGRAPH = '这是 Chrome 渲染之后的正文段落，足够长以便通过抽取阈值。'.repeat(6)
const RENDERED_HTML = `<!doctype html><html><head><title>渲染标题</title></head><body>
<nav><a href="/a">首页</a><a href="/b">登录</a></nav>
<article><h1>渲染标题</h1>${'<p>' + PARAGRAPH + '</p>'.repeat(3)}</article>
<footer>底部广告</footer></body></html>`
const PLAIN = '纯文本渲染结果。'.repeat(30)

const checks = []
const assert = (name, cond, extra = '') => checks.push([name, Boolean(cond), extra])

// ---------- A. 服务返回 HTML ----------
let htmlCalls = 0
const htmlService = {
  version: '1.0.8-svc.1',
  async renderPage(url, opts = {}) {
    htmlCalls++
    if (opts.action === 'html') return { ok: true, url, title: '渲染标题', text: RENDERED_HTML, route: 'direct', seconds: 1.2 }
    return { ok: true, url, title: '渲染标题', text: PLAIN, route: 'direct', seconds: 1.2 }
  },
}

{
  const tool = buildTool({}, { getWebsift: () => htmlService })
  const out = await tool.execute({ url: SPA_URL }, { signal: new AbortController().signal })
  assert('HTML 路径：只调用一次（不需要再要纯文本）', htmlCalls === 1, `calls=${htmlCalls}`)
  assert('HTML 路径：标记 renderedBy=websift', out.renderedBy === 'websift')
  assert('HTML 路径：正文经我们的抽取器清洗', out.markdown.includes('Chrome 渲染之后的正文段落'))
  assert('HTML 路径：导航噪音被剔除', !out.markdown.includes('底部广告') && !out.markdown.includes('- 首页'))
  assert('HTML 路径：不再标记 needsRender', !out.needsRender)
}

// ---------- B. 服务只给纯文本 ----------
let textCalls = 0
const textService = {
  async renderPage(url, opts = {}) {
    textCalls++
    if (opts.action === 'html') return { ok: false, url, text: '', route: 'direct', seconds: 1 }
    return { ok: true, url, title: '渲染标题', text: PLAIN, route: 'direct', seconds: 1 }
  },
}
{
  const tool = buildTool({}, { getWebsift: () => textService })
  const out = await tool.execute({ url: SPA_URL }, { signal: new AbortController().signal })
  assert('纯文本路径：HTML 失败后回退（共 2 次调用）', textCalls === 2, `calls=${textCalls}`)
  assert('纯文本路径：仍然接受结果', out.renderedBy === 'websift' && out.markdown.includes('纯文本渲染结果'))
}

// ---------- C. render=never ----------
{
  const before = textCalls
  const tool = buildTool({}, { getWebsift: () => textService })
  const out = await tool.execute({ url: SPA_URL, render: 'never' }, { signal: new AbortController().signal })
  assert('render=never 不调用 websift', textCalls === before, `calls=${textCalls}`)
  assert('render=never 仍标记 needsRender', out.needsRender === true)
  assert('needsRender 时给出 hint', (out.hint || '').length > 10)
}

// ---------- D. 没有服务 ----------
{
  const tool = buildTool({}, { getWebsift: () => undefined })
  const out = await tool.execute({ url: SPA_URL }, { signal: new AbortController().signal })
  assert('无服务时 needsRender=true', out.needsRender === true)
  assert('无服务时 hint 提到 websift', /websift/.test(out.hint || ''))
}

for (const [name, ok, extra] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
const failed = checks.filter(([, ok]) => !ok)
if (failed.length) {
  console.error(`\n${failed.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
