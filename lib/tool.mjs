/**
 * tool.mjs —— 把"读网址"包装成 Agent 可调用的工具
 *
 * 这里手写 DSH 工具定义的规范化结构（name/description/parameters/output/execute），
 * 不 import @deepseek-ai/dsh-tools：外部插件包里那个模块不一定能解析到，
 * 而 ctx.tools.register 只校验 output.schema 与 render，所以零依赖就能注册。
 */

import { readUrl } from './adapters.mjs'
import { extractMain } from './html.mjs'
import { extractVideo, renderVideo } from './video.mjs'
import { headerForUrl, headerForProfile, domainMatches, touch } from './cookies.mjs'
import { readSettings, noteVisit, detectLoginWall } from './panel.mjs'

const PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      description: '要读取的网址（http/https）。支持普通网页、亚马逊商品页、B站视频页、YouTube/Vimeo 等。',
    },
    mode: {
      type: 'string',
      enum: ['auto', 'page', 'product', 'video'],
      description:
        'auto（默认）按域名自动选择；page 只做正文抽取；product 按商品页解析（价格/评分/卖点/规格）；video 取视频元数据与字幕。',
    },
    maxChars: {
      type: 'integer',
      description: '返回正文的最大字符数，默认 20000。长文建议先小后大，避免一次灌满上下文。',
    },
    save: {
      type: 'string',
      description: '把 Markdown 结果额外写入这个路径（相对当前工作目录），便于后续引用或交接。',
    },
    region: {
      type: 'string',
      enum: ['us', 'local'],
      description:
        '商品页的配送地区。us（默认）= 握手切到美国纽约 10001，拿到美元价格、美区库存与送达时间；local = 沿用当前网络出口（IP）的地区。',
    },
    zip: {
      type: 'string',
      description: '配合 region=us 使用的美国邮编，默认 10001。',
    },
    render: {
      type: 'string',
      enum: ['auto', 'never'],
      description:
        '空壳页是否自动借 dsh-websift 的 Chrome 渲染，默认 auto；never 表示只用本插件（不调用外部插件）。',
    },
    refresh: {
      type: 'boolean',
      description:
        '默认走缓存（同一 URL 5 分钟内直接复用，避免重复请求触发对方限流）；传 true 强制重新抓取。价格、库存这类会变的数字建议传 true。',
    },
    frames: {
      type: 'integer',
      description:
        '视频：抽几张关键帧（0-12，默认 0）。抽出来的 jpg 路径会出现在结果里，可以直接用看图工具逐张看。需要本机装好 yt-dlp/ffmpeg。',
    },
    asr: {
      type: 'boolean',
      description:
        '视频：是否做本地语音转写（Whisper）。默认 false —— 只有在视频没有可用字幕时才值得开，会慢（约 1 分钟/分钟音频）。',
    },
    start: { type: 'number', description: '视频：从第几秒开始（配合 asr/frames，默认 0）' },
    end: { type: 'number', description: '视频：到第几秒结束（默认到结尾）' },
    cookie: {
      type: 'string',
      description:
        '已保存的账号配置名（如 "xiaohongshu"）。不传则按域名自动匹配；传 "off" 强制匿名。' +
        'cookie 值由本机 ~/.dsh/storages/web-reader/cookies.json 保管，不会出现在参数或结果里。',
    },
  },
  required: ['url'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', description: 'page | product | video | binary' },
    title: { type: 'string' },
    url: { type: 'string', description: '最终 URL（跟随重定向后）' },
    markdown: { type: 'string', description: '读到的正文/信息，Markdown 格式' },
    needsRender: {
      type: 'boolean',
      description: '为 true 表示页面是前端渲染的空壳，需要浏览器类工具（如 dsh-websift 的 browser）再读一次',
    },
    hint: { type: 'string', description: '需要注意的提示（渲染失败、账号配置不匹配等）' },
    renderedBy: { type: 'string', description: '为空壳页提供渲染的外部件，目前只可能是 websift' },
    frames: { type: 'array', items: { type: 'string' }, description: '视频抽出的关键帧本地路径，可直接用看图工具读' },
    video: { type: 'object', additionalProperties: true, description: '视频抽取的统计信息' },
    cookieProfile: { type: 'string', description: '本次实际使用的账号配置名（不含任何 cookie 值）' },
    saved: { type: 'string', description: '若指定了 save，这里是写入的绝对路径' },
  },
  required: ['kind', 'markdown'],
}

/**
 * @param {{defaultMaxChars?: number, userAgent?: string}} [config]
 */
export function buildTool(config = {}, deps = {}) {
  const defaultMaxChars = Number.isFinite(config.defaultMaxChars) ? config.defaultMaxChars : 20000

  return {
    name: 'web_read',
    description:
      '读取一个网址的真实内容并返回 Markdown。普通文章返回正文；亚马逊等商品页返回价格/评分/卖点/规格；' +
      'B站/YouTube 视频页返回标题、UP主、播放数据、简介与字幕。当用户直接给你链接、或你需要确认链接里的实际内容时使用它。' +
      '它不执行页面 JS：遇到纯前端渲染的站点只能拿到空壳，此时结果里会带 needsRender=true 与 hint —— 请改用本 profile 的浏览器类工具（例如 dsh-websift 的 browser，action=text）再读一次。',
    parameters: PARAMS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.markdown }],
    },
    async execute(args, exec) {
      const signal = exec?.signal
      if (signal?.aborted) throw new Error('已取消')
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http:// 或 https:// 开头')
      const maxChars = Number.isInteger(args.maxChars) && args.maxChars > 0 ? args.maxChars : defaultMaxChars

      // 账号 cookie：只在这里解析成 Cookie 头，值不会进入参数、结果或日志。
      let cookieHeader = ''
      let cookieProfile = null
      let cookieHint = ''
      if (args.cookie !== 'off') {
        if (args.cookie) {
          const named = headerForProfile(String(args.cookie))
          let host = ''
          try { host = new URL(url).hostname } catch { /* 忽略 */ }
          if (!named.profile) {
            cookieHint = `找不到名为 "${args.cookie}" 的账号配置（用 webread cookies list 查看）。`
          } else if (!domainMatches(host, named.domain)) {
            // 跨站不发：防止把 A 站的凭据送到 B 站
            cookieHint = `账号配置 "${args.cookie}" 属于 ${named.domain}，与 ${host} 不匹配，已按匿名请求。`
          } else {
            cookieHeader = named.header
            cookieProfile = named.profile
          }
        } else if (readSettings().autoMatch !== false) {
          // 全局开关关闭时不做自动匹配（显式指定仍然有效）
          const auto = headerForUrl(url)
          if (auto.profile) {
            cookieHeader = auto.header
            cookieProfile = auto.profile
          }
        }
      }

      let result = await readUrl(url, {
        mode: args.mode,
        maxChars,
        cookie: cookieHeader || undefined,
        region: args.region || config.amazonRegion || 'us',
        noCache: args.refresh === true,
        zip: args.zip || config.amazonZip || '10001',
        userAgent: config.userAgent,
      })
      if (cookieProfile) {
        touch(cookieProfile)
        // 记录这次访问是否撞到登录墙，面板用它间接判断 cookie 是否还有效
        const wall = detectLoginWall(result.markdown)
        noteVisit(cookieProfile, { ...wall, chars: (result.markdown || '').length, url })
      }
      if (cookieHint) result.hint = [result.hint, cookieHint].filter(Boolean).join('\n')

      // 视频：抽帧 / 语音转写（需要本机 Python + yt-dlp + ffmpeg + faster-whisper）
      const wantFrames = Number.isInteger(args.frames) ? Math.max(0, Math.min(12, args.frames)) : 0
      const wantAsr = args.asr === true
      if ((wantFrames > 0 || wantAsr) && result.kind === 'video') {
        const v = await extractVideo(url, {
          pythonPath: config.pythonPath,
          cookieHeader: cookieHeader || undefined,
          frames: wantFrames,
          asr: wantAsr,
          start: Number(args.start) || 0,
          end: Number(args.end) || 0,
          model: config.videoModel || 'small',
          lang: config.videoLang || 'zh',
        })
        if (v.ok) {
          result.markdown = `${result.markdown}\n\n${renderVideo(v, { maxChars })}`
          if (v.frames?.length) result.frames = v.frames
          result.video = {
            transcriptChars: (v.transcript || '').length,
            frames: v.frames?.length || 0,
            model: v.model,
            elapsed: v.elapsed,
          }
        } else {
          result.hint = [result.hint, `视频抽取失败（${v.error}）：${v.hint || v.detail || ''}`].filter(Boolean).join('\n')
        }
      }
      // 空壳页 → 借用 dsh-websift 的 Chrome（如果装了带 websift 服务的版本）
      if (result.needsRender && args.render !== 'never') {
        const svc = deps.getWebsift?.()
        if (svc && typeof svc.renderPage === 'function') {
          // HTTP 抓取可能已被重定向（站点常把未登录请求跳到 /login），此时 result.url
          // 是登录页，拿它去渲染等于渲染错页面。优先用调用方给的原始 URL。
          const candidates = [...new Set([url, result.url].filter(Boolean))]
          // 先要渲染后的 HTML，用我们自己的正文抽取器再洗一遍
          // （websift 的 innerText 会带大量导航碎片）；抽不出来再退回它的纯文本。
          const attempt = async (target) => {
            try {
              const h = await svc.renderPage(target, { maxChars, action: 'html' })
              if (h?.ok && typeof h.text === 'string' && /<\w+[\s>]/.test(h.text)) {
                const ex = extractMain(h.text)
                if (ex.text && ex.text.trim().length >= 150) return { ...h, text: ex.text, viaHtml: true }
              }
            } catch { /* 退回纯文本 */ }
            return svc.renderPage(target, { maxChars, action: 'text' })
          }
          let best = null
          let lastErr = null
          for (const target of candidates) {
            try {
              const r = await attempt(target)
              if (r?.ok && (r.text || '').trim().length > 120) { best = r; break }
              best ??= r
            } catch (err) { lastErr = err }
          }
          if (best?.ok && (best.text || '').trim().length > 120) {
            const title = result.title || best.title || ''
            result = {
              ...result,
              kind: 'page',
              title,
              markdown: [
                `# ${title || url}`,
                '',
                best.text.length > maxChars ? `${best.text.slice(0, maxChars)}\n…（已截断）` : best.text,
                '',
                `> 服务器只返回空壳：由 dsh-websift 的 Chrome 渲染${best.viaHtml ? '，再用 web-reader 的正文抽取清洗' : ''}（route=${best.route || '?'}，${best.seconds || 0}s）。`,
              ].join('\n'),
              needsRender: false,
              renderedBy: 'websift',
              hint: '',
            }
          } else {
            result.hint = `${result.hint || ''}\n已尝试用 websift 渲染，但没拿到正文${lastErr ? `（${lastErr.message}）` : `（route=${best?.route || '?'}）`}，可能需要登录或代理。`
          }
        } else {
          result.hint = `${result.hint || ''}\n（当前 profile 没有 websift 服务；可手动调用 websift 的 browser 工具，或安装带服务的版本。）`
        }
      }

      let saved
      if (args.save) {
        const { writeFileSync, mkdirSync } = await import('node:fs')
        const { dirname, resolve } = await import('node:path')
        saved = resolve(args.save)
        mkdirSync(dirname(saved), { recursive: true })
        writeFileSync(saved, result.markdown, 'utf8')
      }

      return {
        kind: result.kind,
        title: result.title || '',
        url: result.url || url,
        markdown: result.markdown,
        ...(result.needsRender ? { needsRender: true } : {}),
        ...(result.hint ? { hint: result.hint } : {}),
        ...(result.renderedBy ? { renderedBy: result.renderedBy } : {}),
        ...(cookieProfile ? { cookieProfile } : {}),
        ...(result.frames?.length ? { frames: result.frames } : {}),
        ...(result.video ? { video: result.video } : {}),
        ...(saved ? { saved } : {}),
      }
    },
  }
}








