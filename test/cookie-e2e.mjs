#!/usr/bin/env node
/**
 * Cookie 端到端：工具真的把 cookie 发出去了吗？会不会发给错域名？
 *   node test/cookie-e2e.mjs
 *
 * 本地起一个"会回显 Cookie 头"的服务器，验证：
 *  1. 指定配置名 → 请求里带上 cookie
 *  2. 域名不匹配 → 一个字节都不发
 *  3. cookie: "off" → 不发
 *  4. 结果里不出现 cookie 值（只出现配置名）
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-cookie-e2e-'))
process.env.DSH_HOME = tmpHome

const store = await import('../lib/cookies.mjs')
const { buildTool } = await import('../lib/tool.mjs')

let lastCookie = null
const server = http.createServer((req, res) => {
  lastCookie = req.headers.cookie || ''
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<html><head><title>回显</title></head><body><article><h1>回显</h1><p>${'正文'.repeat(120)}</p></article></body></html>`)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const url = `http://127.0.0.1:${port}/page`

const checks = []
const assert = (name, cond, extra = '') => checks.push([name, Boolean(cond), extra])

store.upsert('local', { domain: '127.0.0.1', cookies: 'session=TOP_SECRET_123; uid=42', note: '测试用' })
store.upsert('other', { domain: '.example.com', cookies: 'a=NEVER_SEND' })

const tool = buildTool({}, {})

try {
  // 1) 自动匹配
  let out = await tool.execute({ url, refresh: true }, { signal: new AbortController().signal })
  assert('自动匹配发出 cookie', /session=TOP_SECRET_123/.test(lastCookie), lastCookie)
  assert('结果标出用了哪个配置', out.cookieProfile === 'local', out.cookieProfile)
  assert('结果不含 cookie 值', !JSON.stringify(out).includes('TOP_SECRET_123'))

  // 2) 指定配置名
  lastCookie = null
  out = await tool.execute({ url, cookie: 'local', refresh: true }, { signal: new AbortController().signal })
  assert('命名配置发出 cookie', /uid=42/.test(lastCookie))

  // 3) 跨站配置 → 不发
  lastCookie = null
  out = await tool.execute({ url, cookie: 'other', refresh: true }, { signal: new AbortController().signal })
  assert('域名不匹配时不发 cookie', !lastCookie || !/NEVER_SEND/.test(lastCookie), String(lastCookie))
  assert('不匹配时给出提示', /不匹配/.test(out.hint || ''), out.hint)

  // 4) off → 不发
  lastCookie = null
  await tool.execute({ url, cookie: 'off', refresh: true }, { signal: new AbortController().signal })
  assert('cookie=off 不发', !lastCookie || lastCookie === '', String(lastCookie))

  // 5) 缓存区分登录/匿名
  const anon = await tool.execute({ url, cookie: 'off', refresh: true }, { signal: new AbortController().signal })
  const auth = await tool.execute({ url, cookie: 'local', refresh: true }, { signal: new AbortController().signal })
  assert('登录与匿名结果都能拿到', Boolean(anon.markdown) && Boolean(auth.markdown))

  // 6) 不存在的配置
  out = await tool.execute({ url, cookie: 'nope', refresh: true }, { signal: new AbortController().signal })
  assert('不存在的配置给出提示', /找不到/.test(out.hint || ''), out.hint)
} finally {
  server.close()
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

for (const [name, ok, extra] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
const failed = checks.filter(([, ok]) => !ok)
if (failed.length) {
  console.error(`\n${failed.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
