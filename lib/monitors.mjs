/**
 * monitors.mjs —— 网页监控（定时抓取 + 规则判断）
 *
 * 设计前提：**判定全部是本地规则，绝不调用模型**。
 * 这样"自动化"本身不花一分钱余额；要不要让模型看，是面板上的手动动作。
 *
 * 存储：~/.dsh/storages/web-reader/monitors.json
 * 规则：
 *   price-drop  价格下跌
 *   price-below 价格低于阈值（只在"从高于变成低于"时触发，避免天天刷屏）
 *   contains    正文里出现关键词（之前没有）
 *   missing     正文里关键词消失（之前有）
 */

import fs from 'node:fs'
import path from 'node:path'
import { storeDir, headerForUrl, touch } from './cookies.mjs'

const VERSION = 1
const HISTORY_MAX = 20

export function monitorsPath() {
  return path.join(storeDir(), 'monitors.json')
}

export function loadMonitors() {
  try {
    const raw = fs.readFileSync(monitorsPath(), 'utf8')
    const data = JSON.parse(raw)
    return { version: VERSION, items: Array.isArray(data.items) ? data.items : [] }
  } catch {
    return { version: VERSION, items: [] }
  }
}

export function saveMonitors(data) {
  const dir = storeDir()
  fs.mkdirSync(dir, { recursive: true })
  const p = monitorsPath()
  fs.writeFileSync(`${p}.tmp`, JSON.stringify({ version: VERSION, items: data.items }, null, 2), 'utf8')
  fs.renameSync(`${p}.tmp`, p)
  return p
}

let seq = 0
function newId() {
  seq += 1
  return `m${Date.now().toString(36)}${seq}`
}

/**
 * 新增一条监控。
 * @param {{url:string, rule?:{type:string,value?:any}, intervalMs?:number, note?:string}} input
 */
export function addMonitor(input) {
  let url = String(input.url || '').trim()
  // 直接填 ASIN（10 位字母数字）也认：很多人脑子里想的就是 ASIN，不是整条 URL
  if (/^[A-Z0-9]{10}$/i.test(url)) {
    url = `https://www.amazon.com/dp/${url.toUpperCase()}`
  }
  if (!/^https?:\/\//i.test(url)) throw new Error('需要 http(s) URL，或 10 位 Amazon ASIN（如 B0C23GQ4XT）')
  const rule = input.rule || { type: 'any' }
  if (!['price-drop', 'price-below', 'contains', 'missing', 'any'].includes(rule.type)) {
    throw new Error(`不支持的规则：${rule.type}`)
  }
  if ((rule.type === 'contains' || rule.type === 'missing') && !String(rule.value || '').trim()) {
    throw new Error('关键词规则需要 value')
  }
  if (rule.type === 'price-below' && !Number.isFinite(Number(rule.value))) {
    throw new Error('price-below 需要数字阈值')
  }

  const data = loadMonitors()
  if (data.items.some((i) => i.url === url && i.rule?.type === rule.type)) {
    throw new Error('这个 URL 已有同类规则')
  }
  const item = {
    id: newId(),
    url,
    rule: { type: rule.type, value: rule.value ?? null },
    intervalMs: Number(input.intervalMs) >= 300_000 ? Number(input.intervalMs) : 3_600_000,
    note: String(input.note || '').slice(0, 120),
    createdAt: new Date().toISOString(),
    lastCheckAt: null,
    last: null,        // { price, currency, text, title }
    changes: 0,
    unread: 0,
    log: [],
    lastChangeAt: null,
    history: [],
    error: '',
  }
  data.items.push(item)
  saveMonitors(data)
  return item
}

export function removeMonitor(id) {
  const data = loadMonitors()
  const i = data.items.findIndex((x) => x.id === id)
  if (i < 0) return false
  data.items.splice(i, 1)
  saveMonitors(data)
  return true
}

export function markRead(ids) {
  const data = loadMonitors()
  let n = 0
  for (const it of data.items) {
    if (!ids || ids.includes(it.id)) {
      if (it.unread) { it.unread = 0; n += 1 }
    }
  }
  if (n) saveMonitors(data)
  return n
}

/** 从结构化的 meta 里解析价格与币种。 */
export function parsePrice(meta) {
  const raw = meta && meta.price
  if (!raw) return { price: null, currency: '' }
  const s = String(raw).replace(/,/g, '')
  const m = s.match(/([A-Z]{3}|[$¥€£])?\s*([\d]+(?:\.\d+)?)/)
  if (!m) return { price: null, currency: '' }
  return { price: Number(m[2]), currency: m[1] || '' }
}

/**
 * 纯函数：根据规则比较上一次与这一次的结果。
 * @param {{type:string,value:any}} rule
 * @param {{price:number|null,currency:string,text:string}|null} prev
 * @param {{price:number|null,currency:string,text:string}} cur
 * @returns {{changed:boolean, reason:string}}
 */
export function evaluateRule(rule, prev, cur) {
  const type = rule?.type || 'any'
  if (type === 'any') {
    return { changed: Boolean(prev) && prev.text !== cur.text, reason: '正文有变化' }
  }
  if (type === 'price-drop') {
    if (!prev || prev.price == null || cur.price == null) return { changed: false, reason: '无价格可比' }
    if (prev.currency && cur.currency && prev.currency !== cur.currency) {
      return { changed: false, reason: '币种变了，跳过比较' }
    }
    return cur.price < prev.price
      ? { changed: true, reason: `价格 ${prev.price} → ${cur.price}` }
      : { changed: false, reason: '未下跌' }
  }
  if (type === 'price-below') {
    const threshold = Number(rule.value)
    if (cur.price == null) return { changed: false, reason: '当前没取到价格' }
    const wasAbove = !prev || prev.price == null || prev.price > threshold
    if (cur.price <= threshold && wasAbove) {
      return { changed: true, reason: `价格 ${cur.price} ≤ ${threshold}` }
    }
    return { changed: false, reason: `未跌破 ${threshold}` }
  }
  if (type === 'contains') {
    const kw = String(rule.value || '')
    const had = prev ? prev.text.includes(kw) : false
    const has = cur.text.includes(kw)
    return has && !had ? { changed: true, reason: `出现「${kw}」` } : { changed: false, reason: '未出现' }
  }
  if (type === 'missing') {
    const kw = String(rule.value || '')
    const had = prev ? prev.text.includes(kw) : false
    const has = cur.text.includes(kw)
    return had && !has ? { changed: true, reason: `「${kw}」消失` } : { changed: false, reason: '仍在' }
  }
  return { changed: false, reason: '未知规则' }
}

/**
 * 抓一次并落盘。fetchPage 可注入，便于测试。
 * @param {object} item
 * @param {(item:object) => Promise<{title:string, markdown:string, meta:object}>} fetchPage
 */
export async function checkItem(item, fetchPage) {
  const data = loadMonitors()
  const target = data.items.find((x) => x.id === item.id)
  if (!target) return { item: null, event: null }

  try {
    const res = await fetchPage(target)
    const { price, currency } = parsePrice(res.meta)
    const cur = { price, currency, text: String(res.markdown || ''), title: String(res.title || '') }
    const { changed, reason } = evaluateRule(target.rule, target.last, cur)
    const at = new Date().toISOString()

    target.lastCheckAt = at
    target.last = { price: cur.price, currency: cur.currency, title: cur.title, textLength: cur.text.length }
    target.error = ''
    // 每次检查都留一条痕，哪怕没变化 —— 否则用户以为监控没在跑
    const entry = { at, price: cur.price, currency: cur.currency, changed, reason }
    target.log = [entry, ...(target.log || [])].slice(0, 20)
    let event = null
    if (changed) {
      event = { at, reason, from: target.last?.price ?? null, to: cur.price }
      target.changes = (target.changes || 0) + 1
      target.unread = (target.unread || 0) + 1
      target.lastChangeAt = at
      target.history = [{ at, reason }, ...(target.history || [])].slice(0, HISTORY_MAX)
    }
    // 只在内存里更新（避免每条都整表写一次）
    const idx = data.items.findIndex((x) => x.id === target.id)
    data.items[idx] = target
    saveMonitors(data)
    return { item: target, event }
  } catch (err) {
    const at = new Date().toISOString()
    target.lastCheckAt = at
    target.error = String(err && err.message ? err.message : err).slice(0, 200)
    target.log = [{ at, price: null, currency: '', changed: false, reason: '检查失败：' + target.error }, ...(target.log || [])].slice(0, 20)
    const idx = data.items.findIndex((x) => x.id === target.id)
    data.items[idx] = target
    saveMonitors(data)
    return { item: target, event: null, error: target.error }
  }
}

/** 用真实抓取器跑一次（供定时器与"立即检查"共用）。 */
export async function defaultFetchPage(item) {
  const { readUrl } = await import('./adapters.mjs')
  const auto = headerForUrl(item.url)
  if (auto.profile) touch(auto.profile)
  return readUrl(item.url, {
    maxChars: 6000,
    region: 'us',
    cookie: auto.header || undefined,
  })
}

/** 到期需要检查的条目。 */
export function dueItems(now = Date.now()) {
  const data = loadMonitors()
  return data.items.filter((it) => {
    if (it.paused) return false
    if (!it.lastCheckAt) return true
    const last = Date.parse(it.lastCheckAt)
    if (!Number.isFinite(last)) return true
    return now - last >= (it.intervalMs || 3_600_000)
  })
}
