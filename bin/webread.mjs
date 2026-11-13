#!/usr/bin/env node
/**
 * webread —— 不装 DSH 也能用的命令行版
 *
 * 读一个网址：
 *   node bin/webread.mjs <url> [--mode auto|page|product|video] [--region us|local] [--zip 10001]
 *                              [--max-chars N] [--out 文件] [--json] [--refresh] [--cookie 配置名]
 *
 * 账号 cookie（值只存在本机，不会打印）：
 *   node bin/webread.mjs cookies list
 *   node bin/webread.mjs cookies add <名字> --domain .xiaohongshu.com --cookie "k=v; k2=v2" [--note "我的号"]
 *   node bin/webread.mjs cookies import <名字> --domain .xiaohongshu.com --file cookies.txt
 *   node bin/webread.mjs cookies remove <名字>
 *   node bin/webread.mjs cookies path
 */

import { readUrl } from '../lib/adapters.mjs'
import { configure, cacheStats } from '../lib/fetch.mjs'
import * as store from '../lib/cookies.mjs'

function argOf(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function fail(msg, code = 2) {
  console.error(msg)
  process.exit(code)
}

const argv = process.argv.slice(2)

// ---------------------------------------------------------------- cookies 子命令
if (argv[0] === 'cookies') {
  const sub = argv[1] || 'list'
  const rest = argv.slice(2)
  const name = rest.find((a, i) => !a.startsWith('--') && !['--domain', '--cookie', '--file', '--note'].includes(rest[i - 1]))

  if (sub === 'list') {
    const rows = store.list()
    if (!rows.length) {
      console.log('还没有保存任何账号配置。')
      console.log(`库文件位置：${store.storePath()}`)
      process.exit(0)
    }
    console.log('名字\t域名\tcookie数\t最近使用\t备注')
    for (const r of rows) console.log(`${r.name}\t${r.domain}\t${r.count}\t${r.lastUsedAt || '-'}\t${r.note || '-'}`)
    console.log(`\n库文件：${store.storePath()}（只存本机，请勿同步或提交到仓库）`)
    process.exit(0)
  }

  if (sub === 'path') {
    console.log(store.storePath())
    process.exit(0)
  }

  if (sub === 'add') {
    if (!name) fail('用法: cookies add <名字> --domain .example.com --cookie "k=v; k2=v2"')
    const domain = argOf(rest, '--domain')
    const cookie = argOf(rest, '--cookie')
    if (!domain || !cookie) fail('add 需要 --domain 与 --cookie')
    const p = store.upsert(name, { domain, cookies: cookie, note: argOf(rest, '--note') || '' })
    console.log(`已保存账号配置 "${name}"：${p.domain}，${Object.keys(p.cookies).length} 个 cookie`)
    console.log('（值不会回显；要确认可用就再读一次目标页）')
    process.exit(0)
  }

  if (sub === 'import') {
    if (!name) fail('用法: cookies import <名字> --domain .example.com --file cookies.txt')
    const domain = argOf(rest, '--domain')
    const file = argOf(rest, '--file')
    if (!domain || !file) fail('import 需要 --domain 与 --file（Netscape cookies.txt）')
    const fs = await import('node:fs')
    const text = fs.readFileSync(file, 'utf8')
    const jar = store.parseNetscape(text, domain)
    if (!Object.keys(jar).length) fail('文件里没有匹配该域名的 cookie（检查 --domain 是否带前导点）')
    const p = store.upsert(name, { domain, cookies: jar, note: argOf(rest, '--note') || '' })
    console.log(`已从 ${file} 导入 "${name}"：${p.domain}，${Object.keys(p.cookies).length} 个 cookie`)
    process.exit(0)
  }

  if (sub === 'remove' || sub === 'rm') {
    if (!name) fail('用法: cookies remove <名字>')
    console.log(store.remove(name) ? `已删除 "${name}"` : `没有名为 "${name}" 的配置`)
    process.exit(0)
  }

  fail('未知子命令。可用：list / add / import / remove / path')
}

// ---------------------------------------------------------------- 读网址
const url = argv.find((a) => /^https?:\/\//i.test(a))
if (!url) {
  console.error('用法: node bin/webread.mjs <url> [--mode ...] [--region us|local] [--max-chars N] [--refresh] [--cookie 名字]')
  console.error('      node bin/webread.mjs cookies list|add|import|remove|path')
  process.exit(2)
}

const mode = argOf(argv, '--mode') || 'auto'
const maxChars = Number(argOf(argv, '--max-chars')) || 20000
const region = argOf(argv, '--region') || 'us'
const zip = argOf(argv, '--zip') || '10001'
const noCache = argv.includes('--refresh')
const frames = Number(argOf(argv, '--frames')) || 0
const asr = argv.includes('--asr')
const start = Number(argOf(argv, '--start')) || 0
const end = Number(argOf(argv, '--end')) || 0
const wantCookie = argOf(argv, '--cookie')

configure({})

let cookieHeader
let cookieProfile = null
let hint = ''
if (wantCookie === 'off') {
  // 强制匿名
} else if (wantCookie) {
  const named = store.headerForProfile(wantCookie)
  let host = ''
  try { host = new URL(url).hostname } catch { /* 忽略 */ }
  if (!named.profile) hint = `找不到配置 "${wantCookie}"`
  else if (!store.domainMatches(host, named.domain)) hint = `配置 "${wantCookie}" 属于 ${named.domain}，与 ${host} 不匹配，按匿名请求`
  else { cookieHeader = named.header; cookieProfile = wantCookie }
} else {
  const auto = store.headerForUrl(url)
  if (auto.profile) { cookieHeader = auto.header; cookieProfile = auto.profile }
}
if (cookieProfile) store.touch(cookieProfile)

try {
  const result = await readUrl(url, { mode, maxChars, region, zip, noCache, cookie: cookieHeader })
  // 视频：抽帧 / 转写
  if ((frames > 0 || asr) && result.kind === 'video') {
    const { extractVideo, renderVideo } = await import('../lib/video.mjs')
    const v = await extractVideo(url, { frames, asr, start, end, cookieHeader })
    if (v.ok) {
      result.markdown += '\n\n' + renderVideo(v, { maxChars })
      if (v.frames?.length) result.frames = v.frames
    } else {
      console.error('视频抽取失败：' + (v.hint || v.detail || v.error))
    }
  }
  if (cookieProfile) console.error(`（使用账号配置：${cookieProfile}）`)
  if (hint) console.error(`（提示：${hint}）`)
  if (argv.includes('--stats')) console.error('缓存/限流：' + JSON.stringify(cacheStats()))

  const out = argOf(argv, '--out')
  if (argv.includes('--json')) {
    const text = JSON.stringify(result, null, 2)
    console.log(text)
    if (out) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(out, text, 'utf8')
    }
  } else {
    console.log(result.markdown)
    if (out) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(out, result.markdown, 'utf8')
      console.error(`saved -> ${out} (${result.markdown.length} chars)`)
    }
  }
} catch (err) {
  console.error(`读取失败: ${err.message}`)
  process.exit(1)
}
