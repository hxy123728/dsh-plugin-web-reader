/**
 * jar.mjs —— 极简 Cookie 罐（fetch 没有内置 cookie 管理）
 *
 * 亚马逊的"配送地区"是会话级的：必须先带着同一组 cookie 完成一次
 * 地址切换握手，后面的请求才会按美国站返回价格与库存。
 */

export class CookieJar {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial))
  }

  set(name, value) {
    if (value === '' || value === 'deleted') this.map.delete(name)
    else this.map.set(name, value)
  }

  get(name) {
    return this.map.get(name)
  }

  get size() {
    return this.map.size
  }

  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** 从响应的 Set-Cookie 里吸收；优先用 getSetCookie() 以免被逗号切错 */
  absorb(res) {
    const h = res?.headers
    if (!h) return
    let list = []
    if (typeof h.getSetCookie === 'function') list = h.getSetCookie()
    else {
      const raw = h.get('set-cookie')
      if (raw) list = [raw]
    }
    for (const line of list) {
      const m = /^\s*([^=;\s]+)=([^;]*)/.exec(line)
      if (!m) continue
      const [, name, value] = m
      const expired = /expires=Thu, 01 Jan 1970/i.test(line) || /max-age=0\b/i.test(line)
      this.set(name, expired ? '' : value)
    }
  }
}
