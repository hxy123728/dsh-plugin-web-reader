/**
 * limiter.mjs —— 按主机限流 + 尊重 Retry-After
 *
 * 为什么需要：亚马逊在连续几次请求后就不再正常返回页面，而是给一个 3.8 KB 的拦截页
 * （HTTP 200，内容不是商品）。之前只在 5xx 上退避，对这种"软限流"完全没有感知。
 *
 * 策略：
 *  - 同一主机两次请求之间至少间隔 minIntervalMs（默认 1.2s）
 *  - 同一主机同时最多 1 个在飞请求
 *  - 收到 429 / 503 时读 Retry-After（秒数或 HTTP 日期），否则指数退避，
 *    并把该主机冻结到指定时刻，后续请求自动排队等待
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析 Retry-After：既支持秒数，也支持 HTTP 日期。返回毫秒，无法解析则 null。 */
export function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after')
  if (!raw) return null
  const s = String(raw).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  const at = Date.parse(s)
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  return null
}

export class HostLimiter {
  constructor({ minIntervalMs = 1200, maxConcurrentPerHost = 1, maxCooldownMs = 60_000 } = {}) {
    this.minIntervalMs = minIntervalMs
    this.maxConcurrentPerHost = maxConcurrentPerHost
    this.maxCooldownMs = maxCooldownMs
    /** @type {Map<string, {nextAt:number, active:number, cooldownUntil:number, requests:number}>} */
    this.hosts = new Map()
  }

  _state(host) {
    let s = this.hosts.get(host)
    if (!s) {
      s = { nextAt: 0, active: 0, cooldownUntil: 0, requests: 0 }
      this.hosts.set(host, s)
    }
    return s
  }

  /**
   * 等到可以发请求为止，返回 release 回调（必须调用）。
   * @param {string} host
   */
  async acquire(host) {
    const s = this._state(host)
    for (;;) {
      const now = Date.now()
      const wait = Math.max(s.nextAt - now, s.cooldownUntil - now, 0)
      if (wait > 0) {
        await sleep(Math.min(wait, 5000))
        continue
      }
      if (s.active >= this.maxConcurrentPerHost) {
        await sleep(50)
        continue
      }
      s.active += 1
      s.requests += 1
      s.nextAt = now + this.minIntervalMs
      let released = false
      return () => {
        if (released) return
        released = true
        s.active = Math.max(0, s.active - 1)
      }
    }
  }

  /** 收到 429/503 时冻结该主机。 */
  cool(host, ms) {
    const s = this._state(host)
    const until = Date.now() + Math.min(ms, this.maxCooldownMs)
    if (until > s.cooldownUntil) s.cooldownUntil = until
    return s.cooldownUntil - Date.now()
  }

  cooldownLeft(host) {
    const s = this.hosts.get(host)
    return s ? Math.max(0, s.cooldownUntil - Date.now()) : 0
  }

  stats() {
    return [...this.hosts].map(([host, s]) => ({
      host,
      requests: s.requests,
      active: s.active,
      cooldownMs: Math.max(0, s.cooldownUntil - Date.now()),
    }))
  }
}
