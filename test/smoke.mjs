#!/usr/bin/env node
/**
 * 冒烟测试：不依赖 DSH，直接验证工具定义与执行链路。
 *   node test/smoke.mjs [url]
 */
import { buildTool } from '../lib/tool.mjs'

const url = process.argv[2] || 'https://www.bilibili.com/video/BV1GJ411x7h7/'
let registered
const ctx = { tools: { register: (def) => { registered = def; return () => {} } } }

const tool = buildTool({ defaultMaxChars: 3000 })
ctx.tools.register(tool)

const checks = []
const assert = (name, cond) => { checks.push([name, Boolean(cond)]) }

assert('注册后拿到定义', registered && registered.name === 'web_read')
assert('parameters 是 JSON Schema', registered.parameters?.type === 'object')
assert('parameters 含 url 必填', registered.parameters.required?.includes('url'))
assert('output.schema 存在', registered.output?.schema?.type === 'object')
assert('output.render 是函数', typeof registered.output?.render === 'function')

const out = await registered.execute({ url, maxChars: 400 }, { signal: new AbortController().signal })
assert('execute 返回 kind', typeof out.kind === 'string')
assert('execute 返回 markdown', typeof out.markdown === 'string' && out.markdown.length > 50)
assert('render 产出 text 块', registered.output.render({}, out)[0]?.type === 'text')

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log('\n--- 结果预览 ---')
console.log(out.markdown.slice(0, 400))

const failed = checks.filter(([, ok]) => !ok)
if (failed.length) {
  console.error(`\n${failed.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
