/**
 * dsh-plugin-web-reader —— Host 半区（工具那一半）
 *
 * 挂载后向当前 profile 的 tools 注册表插入一个全局工具 web_read：
 *   web_read({ url, mode?, maxChars?, save?, refresh?, cookie?, render? })
 *
 * 面板的数据接口在 panel.js（另一行插件，只依赖 webServer），
 * 这样没有 webServer 的 profile 仍然能用工具。
 */

import { buildTool } from './lib/tool.mjs'
import { configure } from './lib/fetch.mjs'

export const name = 'web-reader'

/** 只用 tools 服务：没有它插件保持未激活，而不是把整个 profile 拖崩。 */
export const inject = ['tools']

/**
 * @param {any} ctx cordis 上下文
 * @param {{defaultMaxChars?: number}} [config] cordis.patch.yml 里的 config
 */
export function apply(ctx, config) {
  // 限流与缓存可以在 cordis.patch.yml 里调
  configure(config || {})
  // 惰性拿 websift 服务：没装就是 undefined，不写进 inject 也不会阻塞插件激活
  const getWebsift = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('websift') : undefined
    } catch {
      return undefined
    }
  }

  const disposer = ctx.tools.register(buildTool(config || {}, { getWebsift }))

  if (process.env.DSH_WEB_READER_DEBUG) {
    console.error('[web-reader] web_read tool registered', config || {})
  }
  return disposer
}
