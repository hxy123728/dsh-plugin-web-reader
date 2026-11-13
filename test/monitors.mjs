#!/usr/bin/env node
/**
 * 监控规则的单元测试（不联网：抓取器用注入的假函数）。
 *   node test/monitors.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-mon-'))
process.env.WEB_READER_STORE = tmp

const M = await import('../lib/monitors.mjs')

const checks = []
const assert = (name, cond, extra = '') => checks.push([name, Boolean(cond), extra])

const P = (price, currency = 'USD') => ({ price, currency, text: '' })
const T = (text, price = null) => ({ price, currency: price == null ? '' : 'USD', text })

try {
  // ---------- parsePrice ----------
  assert('解析 $9.99', JSON.stringify(M.parsePrice({ price: '$9.99' })) === JSON.stringify({ price: 9.99, currency: '$' }))
  assert('解析 CNY 298.79', M.parsePrice({ price: 'CNY 298.79' }).price === 298.79)
  assert('解析带千分位', M.parsePrice({ price: '$1,299.00' }).price === 1299)
  assert('无价格返回 null', M.parsePrice({}).price === null)

  // ---------- 规则：价格 ----------
  assert('价格下跌触发', M.evaluateRule({ type: 'price-drop' }, P(100), P(90)).changed === true)
  assert('价格上涨不触发', M.evaluateRule({ type: 'price-drop' }, P(90), P(95)).changed === false)
  assert('首次检查没有基线不触发', M.evaluateRule({ type: 'price-drop' }, null, P(90)).changed === false)
  assert('币种变了跳过', M.evaluateRule({ type: 'price-drop' }, P(100, 'USD'), P(90, 'CNY')).changed === false)

  assert('跌破阈值触发', M.evaluateRule({ type: 'price-below', value: 100 }, P(120), P(90)).changed === true)
  assert('已在阈值下不重复触发', M.evaluateRule({ type: 'price-below', value: 100 }, P(90), P(95)).changed === false)
  assert('首次即低于阈值也触发', M.evaluateRule({ type: 'price-below', value: 100 }, null, P(80)).changed === true)
  assert('没有价格不触发', M.evaluateRule({ type: 'price-below', value: 100 }, P(200), T('no price')).changed === false)

  // ---------- 规则：关键词 ----------
  assert('关键词新出现触发', M.evaluateRule({ type: 'contains', value: '补货' }, T('暂无库存'), T('已补货')).changed === true)
  assert('关键词一直都在不触发', M.evaluateRule({ type: 'contains', value: '补货' }, T('有补货'), T('有补货')).changed === false)
  assert('关键词消失触发', M.evaluateRule({ type: 'missing', value: '现货' }, T('现货充足'), T('缺货')).changed === true)
  assert('关键词仍在不触发', M.evaluateRule({ type: 'missing', value: '现货' }, T('现货'), T('现货')).changed === false)

  // ---------- 任意变化 ----------
  assert('正文变化触发', M.evaluateRule({ type: 'any' }, T('a'), T('b')).changed === true)
  assert('正文相同不触发', M.evaluateRule({ type: 'any' }, T('a'), T('a')).changed === false)

  // ---------- 存储 ----------
  const a = M.addMonitor({ url: 'https://example.com/a', rule: { type: 'price-drop' }, intervalMs: 3600000 })
  assert('新增返回 id', Boolean(a.id))
  assert('默认间隔 1 小时', a.intervalMs === 3600000)
  assert('过小间隔被抬到 1 小时', M.addMonitor({ url: 'https://example.com/b', rule: { type: 'any' }, intervalMs: 1000 }).intervalMs === 3600000)

  let threw = false
  try { M.addMonitor({ url: 'ftp://x', rule: { type: 'any' } }) } catch { threw = true }
  assert('拒绝非 http URL', threw)

  threw = false
  try { M.addMonitor({ url: 'https://example.com/a', rule: { type: 'price-drop' } }) } catch { threw = true }
  assert('拒绝同 URL 同类规则', threw)

  threw = false
  try { M.addMonitor({ url: 'https://example.com/c', rule: { type: 'contains', value: '  ' } }) } catch { threw = true }
  assert('关键词规则必须给 value', threw)

  const asinItem = M.addMonitor({ url: 'B0C23GQ4XT', rule: { type: 'any' } })
  assert('裸 ASIN 自动展开成 URL', asinItem.url === 'https://www.amazon.com/dp/B0C23GQ4XT', asinItem.url)
  M.removeMonitor(asinItem.id)
  assert('列表长度正确', M.loadMonitors().items.length === 2)
  assert('删除生效', M.removeMonitor(a.id) === true && M.loadMonitors().items.length === 1)
  assert('删除不存在返回 false', M.removeMonitor('nope') === false)

  // ---------- 到期判断 ----------
  const fresh = M.loadMonitors().items[0]
  assert('从未检查过即到期', M.dueItems().some((x) => x.id === fresh.id))
  const data = M.loadMonitors()
  data.items[0].lastCheckAt = new Date().toISOString()
  M.saveMonitors(data)
  assert('刚检查过不到期', !M.dueItems().some((x) => x.id === fresh.id))
  data.items[0].lastCheckAt = new Date(Date.now() - 7200_000).toISOString()
  M.saveMonitors(data)
  assert('超过间隔后到期', M.dueItems().some((x) => x.id === fresh.id))

  // ---------- checkItem：两次抓取产生一次事件 ----------
  const item = M.addMonitor({ url: 'https://example.com/price', rule: { type: 'price-drop' } })
  let price = 100
  const fetcher = async () => ({ title: '测试商品', markdown: '正文', meta: { price: `$${price}` } })

  const r1 = await M.checkItem(item, fetcher)
  assert('首次检查建立基线', r1.event === null && r1.item.last.price === 100)

  price = 88
  const r2 = await M.checkItem(item, fetcher)
  assert('降价后产生事件', Boolean(r2.event))
  assert('事件带原因与价差', /100/.test(r2.event.reason) && r2.item.last.price === 88)
  assert('计数与未读递增', r2.item.changes === 1 && r2.item.unread === 1)

  const r3 = await M.checkItem(item, fetcher)
  assert('价格不变不再触发', r3.event === null && r3.item.changes === 1)
  assert('每次检查都写日志（3 次）', (r3.item.log || []).length === 3, 'log=' + (r3.item.log || []).length)
  assert('日志带时间与价格', Boolean(r3.item.log[0].at) && r3.item.log[0].price === 88)
  assert('未触发也留痕', r3.item.log[0].changed === false)

  assert('标记已读清零', M.markRead() >= 1 && M.loadMonitors().items.every((x) => !x.unread))

  // 抓取异常被记录而不是抛出
  const badItem = M.addMonitor({ url: 'https://example.com/bad', rule: { type: 'any' } })
  const r4 = await M.checkItem(badItem, async () => { throw new Error('boom') })
  assert('抓取失败写入 error 字段', r4.error === 'boom' && r4.item.error === 'boom')
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
