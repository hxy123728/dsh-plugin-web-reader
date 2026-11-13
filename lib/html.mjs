/**
 * html.mjs —— 极简 HTML 解析 + 正文抽取（零依赖）
 *
 * 目标不是做浏览器：只把"人眼看到的主体文字"按顺序还原出来。
 * 步骤：词法切分 → 建树（容错）→ 删样板（script/nav/footer/侧栏）
 *      → 段落投票选正文容器 → 按块输出 Markdown。
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr', 'param', 'keygen',
])

// 这些标签的内容直接丢掉（脚本/样式/画布等）
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object'])

// 只保留文字时有意义的结构标签
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'li', 'ul', 'ol', 'br', 'tr', 'td', 'th', 'table', 'blockquote', 'pre'])

const BOILER_RE = /(^|[\s_-])(nav|navbar|menu|sidebar|side|footer|header|comment|banner|breadcrumb|related|share|advert|ads?|subscribe|popup|cookie|toolbar|social|recommend|rank|widget|promo|masthead|topbar|legal)([\s_-]|$)/i

function makeNode(tag, attrs = {}) {
  return { tag, attrs, children: [], parent: null }
}

function textNode(text) {
  return { tag: '#text', text, children: [], parent: null }
}

function append(parent, node) {
  node.parent = parent
  parent.children.push(node)
}

const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g

const ATTR_RE = /([:\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function parseAttrs(src) {
  const out = {}
  if (!src) return out
  ATTR_RE.lastIndex = 0
  let m
  while ((m = ATTR_RE.exec(src))) {
    const key = m[1].toLowerCase()
    if (!key) continue
    out[key] = m[3] ?? m[4] ?? m[5] ?? ''
  }
  return out
}

/**
 * 把 HTML 解析成树。容错策略：不匹配的闭合标签忽略；隐式闭合按常见规则处理。
 * @param {string} html
 */
export function parseHtml(html) {
  const root = makeNode('#root')
  const stack = [root]
  const top = () => stack[stack.length - 1]
  let last = 0
  TOKEN_RE.lastIndex = 0
  let m

  const pushText = (raw) => {
    if (!raw) return
    const text = decodeEntities(raw)
    if (!text.trim()) return
    append(top(), textNode(text.replace(/\s+/g, ' ')))
  }

  while ((m = TOKEN_RE.exec(html))) {
    pushText(html.slice(last, m.index))
    last = TOKEN_RE.lastIndex
    const [whole, closeTag, openTag, attrSrc, selfClose] = m

    if (whole.startsWith('<!--') || whole.startsWith('<![CDATA[') || whole.startsWith('<!')) {
      continue
    }

    if (closeTag) {
      const tag = closeTag.toLowerCase()
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }

    if (!openTag) continue
    const tag = openTag.toLowerCase()

    // 隐式闭合：只弹"同类兄弟"，不能把父容器一起弹掉。
    // 之前 tr/td/th 共用一个列表，导致第二个 <td> 把父 <tr> 也弹了，
    // 结果整张规格表解析成空（Amazon 的 Product information 就是这么丢的）。
    const SAME = { p: ['p'], li: ['li'], tr: ['tr'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'] }[tag]
    if (SAME) {
      while (stack.length > 1 && SAME.includes(top().tag)) stack.pop()
    }

    const node = makeNode(tag, parseAttrs(attrSrc))
    append(top(), node)

    if (SKIP.has(tag)) {
      // 跳过整段原始内容
      const endRe = new RegExp(`<\\/\\s*${tag}\\s*>`, 'i')
      const rest = html.slice(last)
      const end = endRe.exec(rest)
      if (end) {
        last = last + end.index + end[0].length
        TOKEN_RE.lastIndex = last
      }
      continue
    }

    if (!VOID.has(tag) && !selfClose) stack.push(node)
  }
  pushText(html.slice(last))
  return root
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©',
  reg: '®', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', middot: '·', times: '×', bull: '•', yen: '¥',
  euro: '€', pound: '£', deg: '°', plusmn: '±', zwnj: '', zwj: '', lrm: '', rlm: '', shy: ''
}

export function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return full
      try { return String.fromCodePoint(code) } catch { return full }
    }
    const v = ENTITIES[body.toLowerCase()]
    return v === undefined ? full : v
  })
}

// ---------------------------------------------------------------- 树查询

export function textOf(node) {
  if (!node) return ''
  if (node.tag === '#text') return node.text
  let out = ''
  for (const child of node.children) out += textOf(child)
  return out
}

export function cleanText(node) {
  return textOf(node).replace(/\s+/g, ' ').trim()
}

export function* walk(node) {
  for (const child of node.children || []) {
    yield child
    if (child.children) yield* walk(child)
  }
}

export function findAll(root, pred) {
  const out = []
  for (const n of walk(root)) if (pred(n)) out.push(n)
  return out
}

export function byTag(root, tag) {
  return findAll(root, (n) => n.tag === tag)
}

export function byId(root, id) {
  return findAll(root, (n) => n.attrs && n.attrs.id === id)[0]
}

export function byClass(root, cls) {
  return findAll(root, (n) => n.attrs && (` ${n.attrs.class || ''} `).includes(` ${cls} `))
}

export function firstText(root, tags) {
  for (const tag of tags) {
    const [n] = byTag(root, tag)
    if (n) {
      const t = cleanText(n)
      if (t) return t
    }
  }
  return ''
}

export function metaContent(root, key) {
  const n = findAll(root, (x) => x.tag === 'meta' && (x.attrs?.name === key || x.attrs?.property === key))[0]
  return n?.attrs?.content?.trim() || ''
}

// ---------------------------------------------------------------- 正文抽取

function dropNode(node) {
  const p = node.parent
  if (!p) return
  const i = p.children.indexOf(node)
  if (i >= 0) p.children.splice(i, 1)
}

function pruneBoilerplate(root) {
  for (const tag of SKIP) for (const n of byTag(root, tag)) dropNode(n)
  for (const n of findAll(root, (x) => x.tag === 'nav' || x.tag === 'footer' || x.tag === 'header' || x.tag === 'aside')) {
    if (cleanText(n).length < 3000) dropNode(n)
  }
  for (const n of findAll(root, (x) => Boolean(x.attrs?.class || x.attrs?.id))) {
    const sig = `${n.attrs.class || ''} ${n.attrs.id || ''}`
    if (BOILER_RE.test(sig) && cleanText(n).length < 1500 && n.parent) dropNode(n)
  }
}

const HEAD_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

function blocksOf(container) {
  const out = []
  let buf = []
  const flush = () => {
    if (buf.length) {
      out.push(buf.join(' '))
      buf = []
    }
  }
  for (const n of walk(container)) {
    if (n.tag === 'br') { flush(); continue }
    if (HEAD_TAGS.has(n.tag)) {
      flush()
      const t = cleanText(n)
      if (t) out.push(`${'#'.repeat(Number(n.tag[1]))} ${t}`)
      continue
    }
    if (n.tag === 'li') {
      flush()
      const t = cleanText(n)
      if (t) out.push(`- ${t}`)
      continue
    }
    if (n.tag === 'p' || n.tag === 'blockquote' || n.tag === 'pre') {
      flush()
      const t = cleanText(n)
      if (t) out.push(t)
      continue
    }
  }
  flush()
  // 去重（保留顺序）
  const seen = new Set()
  return out.filter((x) => {
    const k = x.slice(0, 120)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * 抽取正文。
 * @param {string} html
 * @returns {{title: string, blocks: string[], text: string}}
 */
export function extractMain(html) {
  const root = parseHtml(html)
  const title =
    metaContent(root, 'og:title') ||
    cleanText(byTag(root, 'title')[0]) ||
    cleanText(byTag(root, 'h1')[0]) ||
    ''

  pruneBoilerplate(root)

  // 段落投票：每个 <p> 按长度给父容器加分；随后向上合并"只包住同一批段落"的容器
  const votes = new Map()
  for (const p of byTag(root, 'p')) {
    const len = cleanText(p).length
    if (len < 25) continue
    const parent = p.parent
    if (parent) votes.set(parent, (votes.get(parent) || 0) + len)
  }

  let best = null
  let bestScore = -1
  for (const [node, score] of votes) {
    if (score > bestScore) { best = node; bestScore = score }
  }
  if (best) {
    for (;;) {
      const parent = best.parent
      if (!parent) break
      if ((votes.get(parent) || 0) !== bestScore) break
      if (cleanText(parent).length > cleanText(best).length * 1.8) break
      best = parent
    }
  }
  if (!best) {
    // 兜底：文本密度（很多老站点整篇塞在一个 div 里，没有 <p>）
    let score = -1
    for (const n of findAll(root, (x) => ['article', 'main', 'div', 'section'].includes(x.tag))) {
      const text = cleanText(n)
      if (text.length < 200) continue
      let linkLen = 0
      for (const a of findAll(n, (x) => x.tag === 'a')) linkLen += cleanText(a).length
      const s = text.length - 3 * linkLen
      if (s > score) { score = s; best = n }
    }
  }

  let blocks = best ? blocksOf(best) : []
  if (blocks.join('').length < 200) {
    // 再兜底：整页按换行还原
    const plain = plainText(root)
    if (plain.length > blocks.join('').length) blocks = plain
  }
  const text = blocks.join('\n\n')
  return { title, blocks, text: text || cleanText(root) }
}

function plainText(root) {
  const parts = []
  const rec = (node) => {
    for (const c of node.children || []) {
      if (c.tag === '#text') { parts.push(c.text); continue }
      if (c.tag === 'br') parts.push('\n')
      if (BLOCK.has(c.tag)) parts.push('\n')
      rec(c)
      if (BLOCK.has(c.tag)) parts.push('\n')
    }
  }
  rec(root)
  return parts.join('').split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 12)
}

