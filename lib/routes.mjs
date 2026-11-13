/**
 * routes.mjs —— 面板用的 HTTP 接口（挂在 DSH 的 webServer 上）
 *
 * 全部走同一个前缀 /web-reader-api，约定：
 *  - 响应 JSON；错误也返回 JSON（{error}），不用 HTML
 *  - **绝不返回 cookie 值**：列表只给元信息，导入只回条数
 *  - 要求自定义请求头 x-web-reader: 1 —— 跨站表单/图片无法伪造该头，
 *    相当于一个便宜的 CSRF 闸门（同源请求由我们的 UI 自己带上）
 */

import { list, upsert, remove, setEnabled, parseNetscape, parseCookieString } from './cookies.mjs'
import { readSettings, writeSettings, noteVisit, getVisit, detectLoginWall } from './panel.mjs'
import { loadMonitors, addMonitor, removeMonitor, checkItem, defaultFetchPage, markRead } from './monitors.mjs'

export const PREFIX = '/web-reader-api'

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req, limit = 256 * 1024) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(c)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) } catch { throw new Error('请求体不是合法 JSON') }
}

/** 状态快照：列表 + 全局开关 + 每个配置的最近访问健康度。 */
export function statePayload() {
  const settings = readSettings()
  const rows = list().map((p) => ({
    ...p,
    lastVisit: getVisit(p.name),
  }))
  const monitors = loadMonitors().items.map((m) => ({
    id: m.id,
    url: m.url,
    rule: m.rule,
    note: m.note,
    intervalMs: m.intervalMs,
    lastCheckAt: m.lastCheckAt,
    lastChangeAt: m.lastChangeAt,
    changes: m.changes || 0,
    unread: m.unread || 0,
    error: m.error || '',
    last: m.last || null,
    history: (m.history || []).slice(0, 5),
    log: (m.log || []).slice(0, 6),
  }))
  return {
    autoMatch: settings.autoMatch !== false,
    profiles: rows,
    monitors,
    monitorUnread: monitors.reduce((n, m) => n + (m.unread || 0), 0),
  }
}

/**
 * 处理一次请求。返回 true 表示已处理。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 */
export async function handle(req, res, pathname) {
  const sub = pathname.slice(PREFIX.length) || '/'
  const method = req.method || 'GET'

  if (method === 'GET' && (sub === '/' || sub === '/state')) {
    return json(res, 200, statePayload()), true
  }

  if (method !== 'POST') return json(res, 405, { error: '只支持 GET/POST' }), true

  // 写操作要求自定义头
  if (req.headers['x-web-reader'] !== '1') {
    return json(res, 403, { error: '缺少 x-web-reader 请求头' }), true
  }

  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return json(res, 400, { error: err.message }), true
  }

  try {
    if (sub === '/add') {
      const name = String(body.name || '').trim()
      const domain = String(body.domain || '').trim()
      const raw = String(body.cookie || '')
      const jar = parseCookieString(raw)
      if (!name || !domain || !Object.keys(jar).length) {
        return json(res, 400, { error: '需要 name、domain 和可解析的 cookie（k=v; k2=v2）' }), true
      }
      const p = upsert(name, { domain, cookies: jar, note: body.note || '' })
      return json(res, 200, { ok: true, name, domain: p.domain, count: Object.keys(p.cookies).length }), true
    }

    if (sub === '/import') {
      const name = String(body.name || '').trim()
      const domain = String(body.domain || '').trim()
      const text = String(body.text || '')
      const jar = parseNetscape(text, domain)
      if (!name || !domain) return json(res, 400, { error: '需要 name 与 domain' }), true
      if (!Object.keys(jar).length) {
        return json(res, 400, { error: '文件里没有匹配该域名的 cookie（注意 domain 要带前导点，如 .example.com）' }), true
      }
      const p = upsert(name, { domain, cookies: jar, note: body.note || '' })
      return json(res, 200, { ok: true, name, domain: p.domain, count: Object.keys(p.cookies).length }), true
    }

    if (sub === '/remove') {
      const ok = remove(String(body.name || ''))
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '没有这个配置' }), true
    }

    if (sub === '/toggle') {
      const name = String(body.name || '')
      const enabled = body.enabled !== false
      const val = setEnabled(name, enabled)
      return json(res, val === null ? 404 : 200, val === null ? { error: '没有这个配置' } : { ok: true, enabled: val }), true
    }

    if (sub === '/settings') {
      const patch = {}
      if (typeof body.autoMatch === 'boolean') patch.autoMatch = body.autoMatch
      const next = writeSettings(patch)
      return json(res, 200, { ok: true, autoMatch: next.autoMatch }), true
    }

    if (sub === '/status') {
      // 由前端在"测试"按钮里调用：读一次页面，判断是否命中登录墙
      const name = String(body.name || '')
      const url = String(body.url || '')
      if (!url) return json(res, 400, { error: '需要 url' }), true
      const { readUrl } = await import('./adapters.mjs')
      const { headerForProfile } = await import('./cookies.mjs')
      const hit = headerForProfile(name)
      const result = await readUrl(url, { maxChars: 4000, cookie: hit.header || undefined })
      const wall = detectLoginWall(result.markdown)
      noteVisit(name, { ...wall, chars: result.markdown.length, url })
      return json(res, 200, {
        ok: true,
        loginWall: wall.loginWall,
        reason: wall.reason,
        chars: result.markdown.length,
        renderedBy: result.renderedBy || '',
      }), true
    }

    if (sub === '/monitors/add') {
      try {
        const item = addMonitor({
          url: body.url,
          rule: { type: String(body.ruleType || 'any'), value: body.ruleValue },
          intervalMs: Number(body.intervalMs) || 3_600_000,
          note: body.note,
        })
        return json(res, 200, { ok: true, id: item.id }), true
      } catch (err) {
        // 校验类错误（URL 不合法、规则缺参数、重复）应该 400，而不是 500
        return json(res, 400, { error: String(err.message || err) }), true
      }
    }

    if (sub === '/monitors/remove') {
      const ok = removeMonitor(String(body.id || ''))
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '没有这条监控' }), true
    }

    if (sub === '/monitors/check') {
      // 立即检查：一条或全部（只跑已到期的，避免手点把限流打满）
      const { dueItems, checkItem, defaultFetchPage } = await import('./monitors.mjs')
      const one = String(body.id || '')
      const targets = one
        ? loadMonitors().items.filter((m) => m.id === one)
        : dueItems()
      let changed = 0
      for (const item of targets) {
        const r = await checkItem(item, defaultFetchPage)
        if (r.event) changed += 1
      }
      return json(res, 200, { ok: true, checked: targets.length, changed }), true
    }

    if (sub === '/monitors/read') {
      markRead(Array.isArray(body.ids) ? body.ids : undefined)
      return json(res, 200, { ok: true }), true
    }
    return json(res, 404, { error: `未知接口 ${sub}` }), true
  } catch (err) {
    return json(res, 500, { error: String(err && err.message ? err.message : err) }), true
  }
}
