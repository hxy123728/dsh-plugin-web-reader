#!/usr/bin/env node
/**
 * 客户端 bundle 的加载测试（无浏览器）：
 * 用假 window/require/ctx 验证它会注册到 shell.overlay，且挂载点是我们的 id。
 *   node test/client-load.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const checks = []
const assert = (name, cond, extra = '') => checks.push([name, Boolean(cond), extra])

// 极简 React 替身：模块加载阶段只会用到 createElement / Fragment
const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (v) => [v, () => {}],
  useCallback: (f) => f,
  useEffect: () => {},
}

let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: { load: (m) => { loaded = m } },
    confirm: () => true,
  },
  console,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  setTimeout,
}
sandbox.globalThis = sandbox

vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })

assert('调用 __ModuleLoader__.load', loaded !== null)
assert('模块 id 与包名一致', loaded?.id === 'dsh-plugin-web-reader', loaded?.id)
assert('有 factory', typeof loaded?.factory === 'function')

const mod = loaded.factory((name) => (name === 'react' ? fakeReact : {}))
assert('导出 apply', typeof mod.apply === 'function')
assert('声明 inject slots', Array.isArray(mod.inject) && mod.inject.includes('slots'))

// 场景 A：ctx.get('slots')（对齐已跑通的插件）
{
  const calls = []
  const slots = {
    inject: (slot, cb) => { calls.push(['inject', slot]); cb(); return () => {} },
    register: (opts, comp) => { calls.push(['register', opts, comp]); return () => {} },
  }
  const ctx = { get: (n) => (n === 'slots' ? slots : undefined) }
  mod.apply(ctx)
  assert('A: 注入到 shell.overlay', calls[0]?.[0] === 'inject' && calls[0]?.[1] === 'shell.overlay', JSON.stringify(calls[0]?.[1]))
  const reg = calls.find((c) => c[0] === 'register')
  assert('A: 注册名 shell.overlay', reg?.[1]?.name === 'shell.overlay')
  assert('A: 带 key', reg?.[1]?.key === 'web-reader-accounts', reg?.[1]?.key)
  assert('A: 带 id', reg?.[1]?.id === 'web-reader-accounts')
  assert('A: 有 order', typeof reg?.[1]?.order === 'number')
  assert('A: 组件是函数', typeof reg?.[2] === 'function')
}

// 场景 B：老式 ctx.slots
{
  const calls = []
  const slots = {
    inject: (slot, cb) => { calls.push(slot); cb(); return () => {} },
    register: () => () => {},
  }
  mod.apply({ slots })
  assert('B: 兼容 ctx.slots', calls[0] === 'shell.overlay')
}

// 场景 C：没有 slots 服务时不抛错（只是不渲染）
{
  let threw = false
  try { mod.apply({ get: () => undefined }) } catch { threw = true }
  assert('C: 缺 service 不抛错', threw === false)
}

for (const [name, ok, extra] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
const failed = checks.filter(([, ok]) => !ok)
if (failed.length) {
  console.error(`\n${failed.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
