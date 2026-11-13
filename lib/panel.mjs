/**
 * panel.mjs —— 面板所需的服务端状态：全局开关 + 每次访问的结果
 *
 * 与 cookies.json 分开存：
 *  - cookies.json  = 账号凭据（敏感，永不回显）
 *  - settings.json = 开关与访问健康度（可以随便看）
 */

import fs from 'node:fs'
import path from 'node:path'
import { storeDir } from './cookies.mjs'

const DEFAULTS = { autoMatch: true, visits: {} }

export function settingsPath() {
  return path.join(storeDir(), 'settings.json')
}

export function readSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const data = JSON.parse(raw)
    return { ...DEFAULTS, ...data, visits: data.visits || {} }
  } catch {
    return { ...DEFAULTS, visits: {} }
  }
}

export function writeSettings(patch) {
  const cur = readSettings()
  const next = { ...cur, ...patch, visits: patch.visits ?? cur.visits }
  const dir = storeDir()
  fs.mkdirSync(dir, { recursive: true })
  const p = settingsPath()
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(`${p}.tmp`, p)
  return next
}

/**
 * 记录一次访问结果，供面板显示"cookie 还活着吗"。
 * @param {string|null} profile
 * @param {{loginWall:boolean, chars:number, url:string, reason?:string}} info
 */
export function noteVisit(profile, info) {
  if (!profile) return
  const cur = readSettings()
  const visits = { ...cur.visits }
  visits[profile] = {
    at: new Date().toISOString(),
    loginWall: Boolean(info.loginWall),
    chars: Number(info.chars) || 0,
    url: String(info.url || '').slice(0, 300),
    reason: info.reason || '',
  }
  writeSettings({ visits })
}

export function getVisit(profile) {
  return readSettings().visits?.[profile] || null
}

/**
 * 判断"这次读到的是不是登录墙"。
 * 不能只看长度：有些登录墙很长（小红书），有些正常页很短（公告）。
 * 所以是"强特征优先 + 短文本兜底"。
 */
const STRONG = [
  /登录后(推荐|查看|继续|可|才能)/,
  /请先登录|请登录后/,
  /扫码登录|扫码即可登录/,
  /立即登录|登录查看/,
  /该内容.{0,6}登录/,
  /sign\s?in to (continue|view|see)/i,
  /log\s?in to (continue|view|see)/i,
  /you (must|need to) (be )?(logged|signed) in/i,
]

const WEAK = [/登录/, /sign\s?in/i, /log\s?in/i]

/**
 * @param {string} text 抽出来的正文
 * @param {number} [threshold] 短文本阈值
 * @returns {{loginWall:boolean, thin:boolean, reason:string}}
 */
export function detectLoginWall(text, threshold = 800) {
  const s = String(text || '')
  if (!s) return { loginWall: true, thin: true, reason: '没有抽到正文（大概率是登录墙或需要 JS）' }
  for (const re of STRONG) {
    if (re.test(s)) return { loginWall: true, thin: false, reason: `命中特征：${re.source.slice(0, 30)}` }
  }
  // 弱信号只在"整页很短、且登录字样出现在开头"时才算数：
  // 一篇 1000 字的技术文章里提一次「登录」不该被判成登录墙。
  if (s.length < threshold && WEAK.some((re) => re.test(s.slice(0, 300)))) {
    return { loginWall: true, thin: false, reason: `正文仅 ${s.length} 字且开头出现登录字样` }
  }
  // 没有登录痕迹、但内容薄得可疑：多半是前端渲染的空壳。
  // 这种情况不能报"可用"——那会让人以为 cookie 还活着。
  if (s.length < 200) {
    return { loginWall: false, thin: true, reason: `正文仅 ${s.length} 字，可能是前端渲染的空壳` }
  }
  return { loginWall: false, thin: false, reason: '' }
}
