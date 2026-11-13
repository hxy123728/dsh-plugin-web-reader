/**
 * cache.mjs —— 进程内文本缓存（LRU + TTL + 总字节上限）
 *
 * 目的不是"加速"，而是**少发请求**：同一次会话里反复读同一个 URL（对比、追问、
 * 被 needsRender 触发重读）时不该再打一次对方服务器——之前那个限流就是被这么打出来的。
 *
 * 亚马逊商品页的 HTML 有 2.4 MB，所以不能只按"条数"限制，必须同时限制总字节：
 * 50 条 × 2.4 MB = 120 MB，进程会一直涨。
 */

export class TextCache {
  constructor({ ttlMs = 300_000, max = 50, maxBytes = 64 * 1024 * 1024, maxEntryBytes = 8 * 1024 * 1024 } = {}) {
    this.ttlMs = ttlMs
    this.max = max
    this.maxBytes = maxBytes
    this.maxEntryBytes = maxEntryBytes
    /** @type {Map<string, {at:number, size:number, value:any}>} */
    this.map = new Map()
    this.bytes = 0
    this.hits = 0
    this.misses = 0
  }

  get(key) {
    const e = this.map.get(key)
    if (!e) {
      this.misses += 1
      return undefined
    }
    if (Date.now() - e.at > this.ttlMs) {
      this._drop(key, e)
      this.misses += 1
      return undefined
    }
    // LRU：命中后挪到队尾
    this.map.delete(key)
    this.map.set(key, e)
    this.hits += 1
    return e.value
  }

  set(key, value) {
    const size = typeof value?.body === 'string' ? value.body.length : 0
    if (size === 0 || size > this.maxEntryBytes) return false // 太大的不缓存
    const old = this.map.get(key)
    if (old) this._drop(key, old)

    while (this.map.size >= this.max || this.bytes + size > this.maxBytes) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this._drop(oldest, this.map.get(oldest))
    }
    this.map.set(key, { at: Date.now(), size, value })
    this.bytes += size
    return true
  }

  _drop(key, entry) {
    if (!entry) return
    this.map.delete(key)
    this.bytes = Math.max(0, this.bytes - (entry.size || 0))
  }

  clear() {
    this.map.clear()
    this.bytes = 0
  }

  get size() {
    return this.map.size
  }

  stats() {
    return {
      size: this.map.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      ttlMs: this.ttlMs,
      max: this.max,
      maxBytes: this.maxBytes,
    }
  }
}

/** 只缓存"值得缓存"的响应。 */
export function isCacheable({ status, contentType, body }) {
  if (status !== 200) return false
  if (typeof body !== 'string' || body.length === 0) return false
  return /json|html|xml|text\/plain/i.test(contentType || '')
}
