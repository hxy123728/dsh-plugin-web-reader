/**
 * video.mjs —— 视频内容抽取（语音转写 + 关键帧）
 *
 * 分工：插件不内置模型，只负责"把视频变成文字和图片"；
 * 真正的理解由模型（我）看图 + 读转写来完成。
 *
 * 依赖外部 Python（yt-dlp / imageio-ffmpeg / faster-whisper）：
 *  - 找不到 Python 或依赖缺失时，返回结构化错误 + 安装提示，不影响其它功能
 *  - pythonPath 可在 cordis.patch.yml 里配，或用环境变量 WEB_READER_PYTHON
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { storeDir } from './cookies.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'bin', 'extract_video.py')

const CANDIDATES = [
  process.env.WEB_READER_PYTHON,
  path.join(process.cwd(), '.venv', 'Scripts', 'python.exe'),
  path.join(process.cwd(), '.venv', 'bin', 'python'),
  'python',
  'python3',
]

/** 选一个能跑的 python（只检查可执行性，不 import）。 */
export function pickPython(configured) {
  for (const c of [configured, ...CANDIDATES]) {
    if (!c) continue
    if (c.includes(path.sep) && !existsSync(c)) continue
    return c
  }
  return null
}

function run(cmd, args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { child.kill() } catch { /* 忽略 */ }
    }, timeoutMs)
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: String(e.message || e), killed })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), killed })
    })
  })
}

const MISSING = {
  ok: false,
  error: 'missing_python',
  hint:
    '视频转写需要 Python 依赖。安装：\n' +
    '  python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple yt-dlp imageio-ffmpeg faster-whisper\n' +
    '再在 cordis.patch.yml 里把 pythonPath 指向那个 Python（或用环境变量 WEB_READER_PYTHON）。',
}

/**
 * 抽取视频内容。
 * @param {string} url
 * @param {{pythonPath?: string, frames?: number, asr?: boolean, start?: number, end?: number,
 *          model?: string, lang?: string, outDir?: string, timeoutMs?: number}} [opts]
 */
export async function extractVideo(url, opts = {}) {
  const py = pickPython(opts.pythonPath)
  if (!py) return MISSING

  // 默认落到用户目录（%TEMP% 在受限环境里可能写不进去，且产物本来就该留档）
  const outDir = opts.outDir || process.env.WEB_READER_VIDEO_DIR || path.join(storeDir(), 'video')
  mkdirSync(outDir, { recursive: true })

  // 把 "k=v; k2=v2" 转成 Netscape cookies.txt 交给 yt-dlp：
  // 登录态能显著降低 B 站对视频流的 503 频控，也能拿到更高码率。
  let cookieFile = ''
  if (opts.cookieHeader) {
    try {
      const host = new URL(url).hostname
      const lines = ['# Netscape HTTP Cookie File']
      for (const part of String(opts.cookieHeader).split(';')) {
        const i = part.indexOf('=')
        if (i <= 0) continue
        const k = part.slice(0, i).trim()
        const v = part.slice(i + 1).trim()
        if (k) lines.push([host, 'TRUE', '/', 'FALSE', '0', k, v].join('\t'))
      }
      cookieFile = path.join(outDir, '.cookies.txt')
      writeFileSync(cookieFile, lines.join('\n') + '\n', 'utf8')
    } catch { cookieFile = '' }
  }

  const args = [
    SCRIPT,
    '--url', url,
    '--out', outDir,
    '--frames', String(Math.max(0, Math.min(12, Number(opts.frames) || 0))),
    '--asr', opts.asr === false ? '0' : '1',
    '--model', opts.model || 'small',
    '--lang', opts.lang || 'zh',
  ]
  if (opts.cookieHeader) args.push('--cookie', String(opts.cookieHeader))
  if (opts.start) args.push('--start', String(opts.start))
  if (opts.end) args.push('--end', String(opts.end))

  const res = await run(py, args, { timeoutMs: opts.timeoutMs || 600_000 })
  const line = (res.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()
  if (!line) {
    return {
      ok: false,
      error: 'no_output',
      detail: (res.stderr || '').slice(-500),
      hint: 'Python 没输出结果。先手工跑一次 bin/extract_video.py 看报错。',
    }
  }
  let data
  try { data = JSON.parse(line) } catch {
    return { ok: false, error: 'bad_json', detail: line.slice(0, 300) }
  }
  data.stderr_tail = (res.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3)
  return data
}

/** 把抽取结果拼成 Markdown（供 web_read 返回）。 */
export function renderVideo(v, { maxChars = 20000 } = {}) {
  const lines = []
  if (v.frames?.length) {
    lines.push('## 关键帧', '')
    for (const f of v.frames) lines.push(`- ${f}`)
    lines.push('', '> 这些是本地的图片路径，可以直接用看图工具逐张看。')
  }
  if (v.transcript) {
    lines.push('', '## 语音转写（Whisper ' + (v.model || '?') + '）', '')
    lines.push(v.transcript.length > maxChars ? v.transcript.slice(0, maxChars) + '\n…（已截断）' : v.transcript)
  } else if (v.asr_error) {
    lines.push('', `> 转写失败：${v.asr_error}`)
  }
  return lines.join('\n')
}
