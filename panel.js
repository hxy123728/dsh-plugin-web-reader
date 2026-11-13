/**
 * panel.js —— 面板的数据接口 + 监控定时器（独立的一行插件）
 *
 * 为什么单独一行：这一半只需要 webServer，而工具那一半只需要 tools。
 * 合成一个 apply 时，要么把 webServer 写进 inject（没有 webServer 的 profile
 * 会让整个插件不激活，工具也没了），要么用 ctx.get 硬拿（cordis 会返回 undefined，
 * 实测拿不到）。拆成两行后各自声明依赖，缺谁都不影响另一半。
 *
 * 定时器说明：每分钟醒一次，只跑"已到期"的条目；抓取本身走 fetch 层的按主机限流，
 * 所以即使一次到期 10 条也不会把同一个站点打爆。判定全在本地，不调用模型。
 */

import { handle as panelHandle, PREFIX } from './lib/routes.mjs'
import { dueItems, checkItem, defaultFetchPage } from './lib/monitors.mjs'

export const name = 'web-reader-panel'

export const inject = ['webServer']

const TICK_MS = 60_000

export function apply(ctx) {
  const webServer = ctx.webServer
  const routeDisposer = webServer.register({
    kind: 'prefix',
    path: PREFIX,
    async handler(req, res) {
      let pathname = PREFIX
      try {
        pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
      } catch { /* 保持默认 */ }
      await panelHandle(req, res, pathname)
    },
  })

  // 监控调度：串行执行 + 重入保护，避免上一轮没跑完又叠一轮
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const targets = dueItems()
      for (const item of targets) {
        try {
          await checkItem(item, defaultFetchPage)
        } catch { /* checkItem 内部已记录错误 */ }
      }
      if (process.env.DSH_WEB_READER_DEBUG && targets.length) {
        console.error('[web-reader] monitors checked', targets.length)
      }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => { void tick() }, TICK_MS)
  if (typeof timer.unref === 'function') timer.unref()
  void tick()

  if (process.env.DSH_WEB_READER_DEBUG) {
    console.error('[web-reader] panel routes at', PREFIX, '| port', webServer.port, '| monitor tick', TICK_MS, 'ms')
  }

  return [routeDisposer, () => clearInterval(timer)]
}
