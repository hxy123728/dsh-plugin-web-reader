/**
 * fetch.mjs —— 抓取层（零依赖，用 Node 内置 fetch）
 *
 * 处理三件常被忽略的事：
 *  1. 伪装成浏览器（UA / Accept-Language / Referer），很多站的 403 是这个原因
 *  2. 编码：优先 Content-Type，其次 <meta charset>，再退 utf-8
 *  3. 重试：超时与 5xx 退避重试
 */

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

import { HostLimiter, retryAfterMs } from './limiter.mjs'
import { TextCache, isCacheable } from './cache.mjs'

/** 进程级共享：一个 profile 只有一个插件实例，限流和缓存都是全局的。 */
const limiter = new HostLimiter()
const textCache = new TextCache()

const DEFAULT_TIMEOUT = 30_000

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * @param {string} url
 * @param {{referer?: string, cookie?: string, timeoutMs?: number, retries?: number,
 *          accept?: string, json?: boolean, headers?: Record<string,string>,
 *          jar?: import('./jar.mjs').CookieJar, acceptLanguage?: string,
 *          maxBytes?: number, noCache?: boolean}} [opts]
 * @returns {Promise<{body: string, finalUrl: string, status: number, contentType: string, cached?: boolean}>}
 */
export async function getText(url, opts = {}) {
  const {
    referer, cookie, timeoutMs = DEFAULT_TIMEOUT, retries = 2,
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    json = false, headers: extra = {}, jar, acceptLanguage, maxBytes = 12_000_000,
    noCache = false,
  } = opts

  const headers = {
    'User-Agent': UA,
    Accept: json ? 'application/json, text/plain, */*' : accept,
    'Accept-Language': acceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    ...extra,
  }
  if (referer) headers.Referer = referer
  if (cookie) headers.Cookie = cookie
  else if (jar && jar.size !== 0) headers.Cookie = jar.header()

  let lastErr
  const host = hostOf(url)

  // 1) 缓存命中：同一次会话里重复读同一页，不再打对方服务器
  if (!noCache) {
    const hit = textCache.get(cacheKey(url, headers))
    if (hit) return { ...hit, cached: true }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    let release = () => {}
    try {
      // 2) 按主机排队：同站至少间隔 minIntervalMs，且同时只允许一个在飞
      release = await limiter.acquire(host)
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      jar?.absorb(res)

      // 3) 429/503：读 Retry-After，冻结该主机后再试
      if (res.status === 429 || res.status === 503) {
        const wait = retryAfterMs(res.headers) ?? Math.min(30_000, 1000 * 2 ** attempt)
        limiter.cool(host, wait)
        // 把这份响应体读掉，避免 keep-alive 连接挂住
        try { await res.arrayBuffer() } catch { /* 忽略 */ }
        const err = new Error(
          `HTTP ${res.status} 限流（${(wait / 1000).toFixed(1)}s 后再试）` +
            (attempt === retries ? '，已用尽重试' : ''),
        )
        err.status = res.status
        lastErr = err
        if (attempt < retries) {
          await sleep(Math.min(wait, 30_000))
          continue
        }
        throw err
      }

      const contentType = res.headers.get('content-type') || ''
      // 体积上限：见过 2.4 MB 的商品页，也见过把整站 JS 塞进 HTML 的页面。
      // 不设上限时 arrayBuffer() 会全量吃进内存，再整体解析，很容易把会话拖死。
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > maxBytes) {
        const err = new Error(`响应过大（${(declared / 1048576).toFixed(1)} MB > 上限 ${(maxBytes / 1048576).toFixed(1)} MB）`)
        err.code = 'TOO_LARGE'
        throw err
      }
      const buf = await readCapped(res, maxBytes)
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText}`)
        err.status = res.status
        err.body = buf.toString('utf8').slice(0, 300)
        // 4xx 除了 429 不值得重试
        if (res.status < 500 && res.status !== 429) throw err
        lastErr = err
        await sleep(800 * (attempt + 1))
        continue
      }

      const result = { body: decodeBuffer(buf, contentType), finalUrl: res.url || url, status: res.status, contentType }
      if (!noCache && isCacheable(result)) textCache.set(cacheKey(url, headers), result)
      return result
    } catch (err) {
      lastErr = err
      if (err.code === 'TOO_LARGE') break
      if (err.status && err.status < 500 && err.status !== 429) break
      if (attempt < retries) await sleep(800 * (attempt + 1))
    } finally {
      release()
    }
  }
  throw lastErr || new Error('抓取失败')
}

function hostOf(url) {
  try { return new URL(url).hostname } catch { return 'invalid' }
}

/** 缓存键带上 UA / Cookie 身份，避免"登录态"与"匿名态"串味。 */
function cacheKey(url, headers) {
  const id = headers.Cookie ? 'auth' : 'anon'
  return `${id}|${url}`
}

/**
 * 调整全局限流与缓存（插件启动时按 config 调一次）。
 * @param {{minIntervalMs?: number, cacheTtlMs?: number, cacheMax?: number}} opts
 */
export function configure(opts = {}) {
  if (Number.isFinite(opts.minIntervalMs) && opts.minIntervalMs >= 0) limiter.minIntervalMs = opts.minIntervalMs
  if (Number.isFinite(opts.cacheTtlMs)) textCache.ttlMs = opts.cacheTtlMs
  if (Number.isFinite(opts.cacheMax) && opts.cacheMax > 0) textCache.max = opts.cacheMax
}

export function cacheStats() {
  return { cache: textCache.stats(), hosts: limiter.stats() }
}

export function clearCache() {
  textCache.clear()
}

/** 边读边数，超过上限就中断（Content-Length 可能缺失或被伪造）。 */
async function readCapped(res, maxBytes) {
  if (!res.body) return Buffer.from(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      try { await reader.cancel() } catch { /* 忽略 */ }
      throw Object.assign(new Error(`响应超过上限 ${(maxBytes / 1048576).toFixed(1)} MB，已中断`), { code: 'TOO_LARGE' })
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export async function getJson(url, opts = {}) {
  const r = await getText(url, { ...opts, json: true })
  try {
    return { data: JSON.parse(r.body), finalUrl: r.finalUrl, status: r.status }
  } catch {
    throw new Error(`返回的不是 JSON（可能是拦截页）：${r.body.slice(0, 200)}`)
  }
}

/**
 * 表单 POST（亚马逊的地址切换接口要这个格式，且必须带 cookie 罐与会话内 csrf）。
 * @param {string} url
 * @param {Record<string,string>} form
 * @param {{referer?: string, jar?: any, csrf?: string, headers?: Record<string,string>, timeoutMs?: number}} [opts]
 */
export async function postForm(url, form, opts = {}) {
  const { referer, jar, csrf, headers: extra = {}, timeoutMs = DEFAULT_TIMEOUT } = opts
  const headers = {
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/json,*/*',
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  }
  if (referer) headers.Referer = referer
  if (csrf) headers['anti-csrftoken-a2z'] = csrf
  if (jar && jar.size) headers.Cookie = jar.header()

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  })
  jar?.absorb(res)
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { /* 不是 JSON 就算了 */ }
  return { status: res.status, text, json }
}

function decodeBuffer(buf, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1')
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
  }
  const label = (charset || 'utf-8').toLowerCase()
  try {
    return new TextDecoder(label).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}


/** 供适配器使用：用自己的 key 读/写缓存（例如区分"美国站视图"和"默认视图"）。 */
export function peekCache(key) {
  return textCache.get(key)
}

export function storeCache(key, value) {
  if (isCacheable(value)) textCache.set(key, value)
}
