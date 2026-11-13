#!/usr/bin/env node
/**
 * 面板接口的单元测试：直接调 handle()，不启动 DSH。
 *   node test/panel.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-panel-'))
process.env.WEB_READER_STORE = tmp

const routes = await import('../lib/routes.mjs')
const panel = await import('../lib/panel.mjs')
const store = await import('../lib/cookies.mjs')

const checks = []
const assert = (name, cond, extra = '') => checks.push([name, Boolean(cond), extra])

function mockRes() {
  const res = { statusCode: 0, headers: {}, body: '' }
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {} }
  res.end = (b) => { res.body = b || '' }
  return res
}

async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
  const req = {
    method,
    headers: { 'x-web-reader': '1', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = mockRes()
  await routes.handle(req, res, routes.PREFIX + pathname)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* 非 JSON */ }
  return { status: res.statusCode, json, raw: res.body }
}

try {
  // 1) 空状态
  let r = await call('/state')
  assert('state 返回 200', r.status === 200)
  assert('默认开启自动匹配', r.json.autoMatch === true)
  assert('初始没有配置', Array.isArray(r.json.profiles) && r.json.profiles.length === 0)

  // 2) 新增
  r = await call('/add', { method: 'POST', body: { name: 'demo', domain: '.example.com', cookie: 'a=1; b=2', note: '测试号' } })
  assert('add 成功', r.status === 200 && r.json.count === 2)
  assert('响应不含 cookie 值', !r.raw.includes('a=1'))

  // 3) 新增参数缺失
  r = await call('/add', { method: 'POST', body: { name: 'x', domain: '.x.com' } })
  assert('缺 cookie 时 400', r.status === 400)

  // 4) 列表与元信息
  r = await call('/state')
  const p = r.json.profiles.find((x) => x.name === 'demo')
  assert('列表含域名与备注', p && p.domain === '.example.com' && p.note === '测试号')
  assert('列表含启用状态与最近使用字段', p.enabled === true && 'lastUsedAt' in p)
  assert('state 不含任何 cookie 值', !r.raw.includes('a=1'))

  // 5) 禁用
  r = await call('/toggle', { method: 'POST', body: { name: 'demo', enabled: false } })
  assert('toggle 成功', r.status === 200 && r.json.enabled === false)
  const auto = store.headerForUrl('https://www.example.com/x')
  assert('禁用后自动匹配跳过它', auto.profile === null, String(auto.profile))

  // 6) 全局开关
  r = await call('/settings', { method: 'POST', body: { autoMatch: false } })
  assert('全局开关关闭', r.status === 200 && r.json.autoMatch === false)
  assert('设置落盘', panel.readSettings().autoMatch === false)

  // 7) CSRF 闸门
  r = await call('/add', { method: 'POST', headers: { 'x-web-reader': '' }, body: {} })
  assert('缺自定义头返回 403', r.status === 403)

  // 8) 未知接口
  r = await call('/nope', { method: 'POST', body: {} })
  assert('未知接口 404', r.status === 404)

  // 9) 删除
  r = await call('/remove', { method: 'POST', body: { name: 'demo' } })
  assert('remove 成功', r.status === 200)
  r = await call('/state')
  assert('删除后列表为空', r.json.profiles.length === 0)

  // 11) 监控接口
  r = await call('/monitors/add', { method: 'POST', body: { url: 'https://example.com/p', ruleType: 'price-drop', intervalMs: 3600000 } })
  assert('新增监控成功', r.status === 200 && Boolean(r.json.id))
  r = await call('/state')
  assert('state 带出 monitors', Array.isArray(r.json.monitors) && r.json.monitors.length === 1)
  assert('state 提供未读总数', r.json.monitorUnread === 0)
  assert('state 不含监控正文', !JSON.stringify(r.json).includes('text'))

  r = await call('/monitors/add', { method: 'POST', body: { url: 'ftp://x', ruleType: 'any' } })
  assert('非法 URL 返回 400', r.status === 400)

  r = await call('/monitors/add', { method: 'POST', body: { url: 'https://example.com/p', ruleType: 'price-drop' } })
  assert('重复规则返回 400', r.status === 400)

  const mid = (await call('/state')).json.monitors[0].id
  r = await call('/monitors/remove', { method: 'POST', body: { id: mid } })
  assert('删除监控成功', r.status === 200)
  r = await call('/state')
  assert('删除后列表为空', r.json.monitors.length === 0)
  // 10) 登录墙判定
  assert('正常正文不误判', panel.detectLoginWall('这是一篇正常的文章。'.repeat(80)).loginWall === false)
  assert('强特征命中', panel.detectLoginWall('登录后查看全文').loginWall === true)
  assert('短文本+登录字样命中', panel.detectLoginWall('请登录').loginWall === true)
  assert('空正文视为墙', panel.detectLoginWall('').loginWall === true)
  assert('无登录痕迹但内容极薄 -> thin', panel.detectLoginWall('前端渲染的空壳页面'.repeat(3)).thin === true)
  assert('thin 不算登录墙', panel.detectLoginWall('前端渲染的空壳页面'.repeat(3)).loginWall === false)
  assert('正常文章不是 thin', panel.detectLoginWall('这是一篇正常的文章。'.repeat(80)).thin === false)
  assert('长文里提一次"登录"不误判', panel.detectLoginWall('今天我们聊聊登录系统的设计。'.repeat(60)).loginWall === false)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

for (const [name, ok, extra] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
const failed = checks.filter(([, ok]) => !ok)
if (failed.length) {
  console.error(`\n${failed.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
