#!/usr/bin/env node
/**
 * Cookie 库的单元测试（不联网、不碰真实库文件）。
 *   node test/cookies.mjs
 *
 * 重点验证三条硬约束：
 *  1. 值不出现在任何"可展示"输出里（只有 list 的元信息与 mask）
 *  2. 只发给匹配域名，跨站一律不发
 *  3. 库文件权限收紧（POSIX 0600；Windows 跳过）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 必须在 import 之前设置，store 目录依赖它
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-cookies-'))
process.env.DSH_HOME = tmpHome

const store = await import('../lib/cookies.mjs')

const checks = []
const assert = (name, cond, extra = '') => checks.push([name, Boolean(cond), extra])

try {
  // ---------- 1. 域名匹配 ----------
  assert('精确域名匹配', store.domainMatches('example.com', 'example.com'))
  assert('.example.com 匹配子域', store.domainMatches('www.example.com', '.example.com'))
  assert('.example.com 匹配裸域', store.domainMatches('example.com', '.example.com'))
  assert('不匹配无关域名', !store.domainMatches('evil.com', '.example.com'))
  assert('拒绝后缀伪造（notexample.com）', !store.domainMatches('notexample.com', '.example.com'))
  assert('拒绝子串伪造（example.com.evil.com）', !store.domainMatches('example.com.evil.com', '.example.com'))
  assert('无前导点也匹配子域（xiaohongshu.com -> www.）', store.domainMatches('www.xiaohongshu.com', 'xiaohongshu.com'))
  assert('无前导点仍拒绝伪造', !store.domainMatches('xiaohongshu.com.evil.com', 'xiaohongshu.com'))

  // ---------- 2. 写入与读取 ----------
  store.upsert('xhs', { domain: '.xiaohongshu.com', cookies: 'web_session=SECRET_A; a1=SECRET_B', note: '我的小红书' })
  store.upsert('bili', { domain: '.bilibili.com', cookies: 'SESSDATA=SECRET_C' })
  const data = store.load()
  assert('两个配置都写入了', Object.keys(data.profiles).length === 2)
  assert('cookie 数量正确', Object.keys(data.profiles.xhs.cookies).length === 2)

  const file = store.storePath()
  assert('库文件已生成', fs.existsSync(file))
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777
    assert('POSIX 权限为 0600', mode === 0o600, '0o' + mode.toString(8))
  }

  // ---------- 3. 值不外泄 ----------
  const listed = JSON.stringify(store.list())
  assert('list() 不含任何 cookie 值', !/SECRET_/.test(listed), listed.slice(0, 120))
  assert('list() 保留元信息', /xiaohongshu/.test(listed) && /我的小红书/.test(listed))

  const masked = store.mask('abcdefghijklmnop')
  assert('mask 只留头尾', masked === 'abcd…mnop', masked)
  assert('短值直接星号', store.mask('short') === '***')

  // ---------- 4. 按 URL 自动匹配 ----------
  const hit = store.headerForUrl('https://www.xiaohongshu.com/explore/abc')
  assert('自动匹配到 xhs', hit.profile === 'xhs', hit.profile)
  assert('头里带上了值（仅供请求使用）', hit.header.includes('web_session=SECRET_A'))

  const miss = store.headerForUrl('https://www.amazon.com/dp/B0C23GQ4XT')
  assert('无匹配时返回空头', miss.profile === null && miss.header === '')

  const cross = store.headerForUrl('https://xiaohongshu.com.evil.com/')
  assert('伪造域名不匹配', cross.profile === null)

  // 最长匹配优先
  store.upsert('xhs-sub', { domain: '.www.xiaohongshu.com', cookies: 'k=v' })
  const best = store.headerForUrl('https://www.xiaohongshu.com/x')
  assert('最长域名匹配胜出', best.profile === 'xhs-sub', best.profile)

  // ---------- 5. Netscape 导入 ----------
  const netscape = [
    '# Netscape HTTP Cookie File',
    '.xiaohongshu.com\tTRUE\t/\tFALSE\t0\tweb_session\tNET_A',
    '.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tNET_B',
  ].join('\n')
  const jar = store.parseNetscape(netscape, '.xiaohongshu.com')
  assert('Netscape 只挑出目标域名', Object.keys(jar).length === 1 && jar.web_session === 'NET_A', JSON.stringify(Object.keys(jar)))

  // ---------- 6. 删除 ----------
  assert('删除已存在的配置', store.remove('bili') === true)
  assert('删除后数量减少', Object.keys(store.load().profiles).length === 2)
  assert('删除不存在的返回 false', store.remove('nope') === false)

  // ---------- 7. 名字校验 ----------
  let threw = false
  try { store.upsert('../evil', { domain: '.x.com', cookies: 'a=b' }) } catch { threw = true }
  assert('拒绝路径穿越式配置名', threw)
} finally {
  // 权限被收紧后个别环境删不掉临时目录，测试结果不受影响
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

for (const [name, ok, extra] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
const failed = checks.filter(([, ok]) => !ok)
if (failed.length) {
  console.error(`\n${failed.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
