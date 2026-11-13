#!/usr/bin/env node
/**
 * 限流 / 缓存 / Retry-After 的回归测试（本地起一个假服务器，不依赖外网）。
 *   node test/throttle-cache.mjs
 */
import http from 'node:http'
import { getText, configure, cacheStats, clearCache } from '../lib/fetch.mjs'

const checks = []
const assert = (name, cond, extra = '') => checks.push([name, Boolean(cond), extra])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let hits = 0
let limited = 0
const server = http.createServer((req, res) => {
  hits++
  const u = req.url
  if (u.startsWith('/429')) {
    limited++
    if (limited === 1) {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'text/plain' })
      res.end('slow down')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body><p>after retry</p></body></html>')
    return
  }
  if (u.startsWith('/page')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<html><body><p>${'缓存内容'.repeat(20)}</p></body></html>`)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<html><body><p>ok</p></body></html>')
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

configure({ minIntervalMs: 250, cacheTtlMs: 60_000, cacheMax: 10 })
clearCache()

try {
  // ---------- 1. 同主机最小间隔 ----------
  let t0 = Date.now()
  await getText(`${base}/a`)
  const firstMs = Date.now() - t0
  t0 = Date.now()
  await getText(`${base}/b`)
  const secondMs = Date.now() - t0
  assert('第一次请求不受限', firstMs < 250, `${firstMs}ms`)
  assert('同一主机第二次请求被节流（>=200ms）', secondMs >= 200, `${secondMs}ms`)

  // ---------- 2. 缓存 ----------
  clearCache()
  const before = hits
  const r1 = await getText(`${base}/page`)
  const t1 = Date.now()
  const r2 = await getText(`${base}/page`)
  const t2 = Date.now() - t1
  assert('两次请求只打了一次服务器', hits - before === 1, `hits+${hits - before}`)
  assert('第二次标记 cached=true', r2.cached === true)
  assert('第二次几乎不耗时', t2 < 50, `${t2}ms`)
  assert('内容一致', r1.body === r2.body && r2.body.includes('缓存内容'))

  // ---------- 3. refresh 绕过缓存 ----------
  const before2 = hits
  const r3 = await getText(`${base}/page`, { noCache: true })
  assert('noCache 会重新抓取', hits - before2 === 1, `hits+${hits - before2}`)
  assert('noCache 结果不带 cached 标记', r3.cached === undefined)

  // ---------- 4. 429 + Retry-After ----------
  const t3 = Date.now()
  const r4 = await getText(`${base}/429`, { retries: 2 })
  const waited = Date.now() - t3
  assert('429 后重试成功', r4.status === 200 && r4.body.includes('after retry'))
  assert('遵守 Retry-After（约 1s，>=900ms）', waited >= 900, `${waited}ms`)

  const st = cacheStats()
  assert('统计可用', st.cache.hits >= 1 && Array.isArray(st.hosts))
} finally {
  server.close()
}

for (const [name, ok, extra] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
const failed = checks.filter(([, ok]) => !ok)
if (failed.length) {
  console.error(`\n${failed.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
