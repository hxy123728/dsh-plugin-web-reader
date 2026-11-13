/**
 * cookies.mjs —— 账号 Cookie 库
 *
 * 设计约束（三条都是硬性的）：
 *  1. **cookie 值永远不进模型上下文**。工具参数只接受"配置名"（如 "xiaohongshu"），
 *     不接受原始 cookie 字符串；返回结果里也不会出现任何 cookie 值。
 *  2. **只发给匹配的域名**。按 domain 后缀匹配，且取最长匹配；不匹配就一条都不发。
 *  3. **落到用户目录、权限收紧**。默认 ~/.dsh/storages/web-reader/cookies.json，
 *     POSIX 下 0600，Windows 下尽力用 icacls 去掉继承。
 *
 * 文件格式：
 * {
 *   "version": 1,
 *   "profiles": {
 *     "xiaohongshu": {
 *       "domain": ".xiaohongshu.com",
 *       "cookies": { "web_session": "…", "a1": "…" },
 *       "note": "我的小红书账号",
 *       "createdAt": "...", "updatedAt": "...", "lastUsedAt": "..."
 *     }
 *   }
 * }
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function storeDir() {
  // 显式覆盖优先（测试 / 多实例隔离用）
  if (process.env.WEB_READER_STORE) return process.env.WEB_READER_STORE
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'web-reader')
}

export function storePath() {
  return path.join(storeDir(), 'cookies.json')
}

export function load() {
  const p = storePath()
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, profiles: {} }
    // 静默返回空会让用户以为"cookie 丢了"，这里必须叫出来
    throw new Error(`读不了 cookie 库（${err.code}）：${p}`)
  }
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || !data.profiles) return { version: 1, profiles: {} }
    return { version: 1, ...data }
  } catch {
    throw new Error(`cookie 库不是合法 JSON：${p}（可删掉后重新添加）`)
  }
}

export function save(data) {
  const dir = storeDir()
  fs.mkdirSync(dir, { recursive: true })
  const p = storePath()
  const tmp = `${p}.tmp`
  // 先写临时文件再 rename：避免写到一半崩溃留下损坏的库
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, p)
  harden(p)
  return p
}

/**
 * 收紧权限。
 *
 * ⚠️ 这里踩过一个坑：原先在 Windows 上用 icacls 去掉继承、只授权当前用户，
 * 但 `${process.env.USERNAME}` 拼出来是 `<user>\`（域为空、用户名丢失），icacls 却返回成功——
 * 结果文件 ACL 变成"谁都不许访问"，下一次 load() 直接 EACCES，整个 cookie 库报废。
 *
 * 结论：**不要在没有验证的情况下改 ACL**。Windows 上文件本来就位于用户配置目录，
 * 继承权限通常已是"仅当前用户 + 管理员"；真要更强隔离，用 BitLocker/EFS，
 * 而不是让插件去动 ACL。POSIX 上 chmod 0600 是安全的，保留。
 */
function harden(file) {
  if (process.platform === 'win32') return
  try { fs.chmodSync(file, 0o600) } catch { /* 尽力而为 */ }
}

/** 解析 "a=1; b=2" 形式的 cookie 字符串。 */
export function parseCookieString(str) {
  const out = {}
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

/** 解析 Netscape cookies.txt（浏览器扩展导出的格式）。可按域名过滤。 */
export function parseNetscape(text, domainFilter) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const f = s.split('\t')
    if (f.length < 7) continue
    const domain = f[0]
    if (domainFilter && !domainMatches(domain, domainFilter) && !domainMatches(domainFilter, domain)) continue
    out[f[5]] = f[6]
  }
  return out
}

/** host 是否属于 cookie 的 domain（.example.com 匹配 example.com 与所有子域）。 */
export function domainMatches(host, domain) {
  if (!host || !domain) return false
  const h = String(host).toLowerCase()
  const d = String(domain).toLowerCase()
  if (d === '') return false
  // 有没有前导点都按"该站点及其子域"处理：
  // 用户填 xiaohongshu.com 时，访问 www.xiaohongshu.com 也该命中；
  // 但 example.com.evil.com 这种伪造域名仍然不匹配（后缀不是 .example.com）。
  const bare = d.startsWith('.') ? d.slice(1) : d
  return h === bare || h.endsWith('.' + bare)
}

/** 找出某个 URL 该用哪个配置（最长域名匹配胜出）。 */
export function findForUrl(url, data = load()) {
  let host
  try { host = new URL(url).hostname } catch { return null }
  let best = null
  for (const [name, p] of Object.entries(data.profiles || {})) {
    if (!p || !p.domain) continue
    if (p.enabled === false) continue
    if (!domainMatches(host, p.domain)) continue
    if (!best || String(p.domain).length > String(best.profile.domain).length) {
      best = { name, profile: p }
    }
  }
  return best
}

/** 生成发往该 URL 的 Cookie 头；没有匹配返回空字符串。 */
export function headerForUrl(url, data = load()) {
  const hit = findForUrl(url, data)
  if (!hit) return { header: '', profile: null, domain: '' }
  const header = Object.entries(hit.profile.cookies || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  return { header, profile: hit.name, domain: hit.profile.domain }
}

/** 按配置名取 Cookie 头（调用方负责校验域名是否匹配）。 */
export function headerForProfile(name, data = load()) {
  const p = data.profiles?.[name]
  if (!p) return { header: '', profile: null, domain: '' }
  const header = Object.entries(p.cookies || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  return { header, profile: name, domain: p.domain }
}

/** 新增或覆盖一个配置。 */
export function upsert(name, { domain, cookies, note = '' }) {
  if (!name || !/^[\w.-]{1,64}$/.test(name)) throw new Error('配置名只能用字母/数字/下划线/点/横线，最长 64')
  if (!domain) throw new Error('必须指定 domain，例如 .xiaohongshu.com')
  const jar = typeof cookies === 'string' ? parseCookieString(cookies) : cookies
  if (!jar || !Object.keys(jar).length) throw new Error('没有解析出任何 cookie（格式应为 k=v; k2=v2）')

  const data = load()
  const now = new Date().toISOString()
  const old = data.profiles[name]
  data.profiles[name] = {
    domain,
    cookies: jar,
    enabled: old?.enabled !== false,
    note: note || old?.note || '',
    createdAt: old?.createdAt || now,
    updatedAt: now,
  }
  save(data)
  return data.profiles[name]
}

export function remove(name) {
  const data = load()
  if (!data.profiles[name]) return false
  delete data.profiles[name]
  save(data)
  return true
}

export function touch(name) {
  const data = load()
  if (!data.profiles[name]) return
  data.profiles[name].lastUsedAt = new Date().toISOString()
  save(data)
}

/** 列表视图：只含元信息，**不含 cookie 值**。 */
export function list() {
  const data = load()
  return Object.entries(data.profiles || {}).map(([name, p]) => ({
    name,
    domain: p.domain,
    enabled: p.enabled !== false,
    count: Object.keys(p.cookies || {}).length,
    note: p.note || '',
    createdAt: p.createdAt || '',
    updatedAt: p.updatedAt || '',
    lastUsedAt: p.lastUsedAt || '',
  }))
}

/** 展示用脱敏：只留头尾各 4 个字符。 */
export function mask(value) {
  const s = String(value ?? '')
  if (s.length <= 10) return '***'
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}



/** 启用 / 禁用某个配置（禁用后自动匹配与显式指定都不再发送）。 */
export function setEnabled(name, enabled) {
  const data = load()
  const p = data.profiles[name]
  if (!p) return null
  p.enabled = Boolean(enabled)
  p.updatedAt = new Date().toISOString()
  save(data)
  return p.enabled
}
