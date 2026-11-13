/**
 * client.js —— 账号面板（DSH Web UI）
 *
 * 形态对齐「已经在你机器上跑通的」dsh-plugin-local-ai-tts：
 *   - 用 ctx.get('slots') 拿插槽服务（不是 ctx.slots）
 *   - 注册到 shell.overlay，并带 key + id + order
 * 官方模板写的是 ctx.slots + conversation.composer.dock，以实际能渲染的为准。
 *
 * 数据全部来自 Host 半区的 /web-reader-api/*，页面里不持有任何 cookie 值。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-web-reader',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/web-reader-api'

    // 只使用 DSH 真实存在的 --dsw-alias-* token（从 dsh-web-frontend 的 index-*.css 里核对过）。
    // 兜底一律用 CSS 系统色（Canvas / CanvasText / GrayText），它们跟随浏览器/系统的明暗，
    // 不会再出现"深色字配深色底"这种两套主题混搭的事故。
    const T = {
      bg: 'var(--dsw-alias-bg-layer-3, Canvas)',
      bgInput: 'var(--dsw-alias-bg-layer-1, Canvas)',
      text: 'var(--dsw-alias-label-primary, CanvasText)',
      muted: 'var(--dsw-alias-label-tertiary, GrayText)',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.45))',
      accent: 'var(--dsw-alias-button-primary-fill, #4176E6)',
      onAccent: 'var(--dsw-alias-label-primary-foreground, #fff)',
      danger: 'var(--dsw-alias-state-error-primary, #d33)',
      ok: 'var(--dsw-alias-state-success-primary, #2f9e44)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))',
      shadow: 'var(--dsw-elevation-panel, 0 12px 40px rgba(0,0,0,.22))',
    }

    async function api(path, body) {
      const init = body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-web-reader': '1' },
            body: JSON.stringify(body),
          }
        : {}
      const res = await fetch(API + path, init)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    const s = {
      row: {
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 8,
        padding: '10px 0',
        borderTop: `1px solid ${T.border}`,
        alignItems: 'center',
      },
      name: { fontWeight: 600, fontSize: 13, color: T.text },
      sub: { fontSize: 12, color: T.muted, marginTop: 2 },
      btn: {
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        border: `1px solid ${T.border}`,
        background: 'transparent',
        color: T.text,
        cursor: 'pointer',
      },
      primary: {
        fontSize: 12,
        padding: '6px 12px',
        borderRadius: 6,
        border: 'none',
        background: T.accent,
        color: T.onAccent,
        cursor: 'pointer',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        fontSize: 12,
        padding: '6px 8px',
        borderRadius: 6,
        border: `1px solid ${T.border}`,
        background: T.bgInput,
        color: T.text,
        marginTop: 6,
      },
      dot: (color) => ({ display: 'inline-block', width: 7, height: 7, borderRadius: 4, background: color, marginRight: 5 }),
    }

    function Badge({ profile }) {
      const v = profile.lastVisit
      if (!v) return h('span', { style: { color: T.muted } }, '未测过')
      if (!profile.enabled) return h('span', { style: { color: T.muted } }, '已禁用')
      if (v.loginWall) {
        return h(
          'span',
          { style: { color: T.danger }, title: v.reason || '' },
          h('i', { style: s.dot(T.danger) }),
          '疑似登录墙',
        )
      }
      // 没登录痕迹但内容极薄：多半是 JS 空壳，不能显示"可用"
      if (v.thin) {
        return h(
          'span',
          { style: { color: T.warn }, title: v.reason || '' },
          h('i', { style: s.dot(T.warn) }),
          '内容过少（疑似空壳）',
        )
      }
      return h('span', { style: { color: T.ok } }, h('i', { style: s.dot(T.ok) }), '可用')
    }

    function ruleLabel(rule) {
      const r = rule || { type: 'any' }
      if (r.type === 'price-drop') return '价格下跌'
      if (r.type === 'price-below') return `价格 < ${r.value}`
      if (r.type === 'contains') return `出现「${r.value}」`
      if (r.type === 'missing') return `「${r.value}」消失`
      return '任意变化'
    }

    function fmt(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return '—'
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    function Panel() {
      const [open, setOpen] = React.useState(false)
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [draft, setDraft] = React.useState({ name: '', domain: '', text: '', note: '', isFile: false })
      const [tab, setTab] = React.useState('accounts')
      const [mdraft, setMdraft] = React.useState({ urls: '', ruleType: 'price-drop', ruleValue: '', intervalMs: 3600000 })

      const load = React.useCallback(async () => {
        try {
          setErr('')
          setData(await api('/state'))
        } catch (e) {
          setErr(String(e.message || e))
        }
      }, [])

      React.useEffect(() => {
        if (open) load()
      }, [open, load])

      const run = async (tag, fn) => {
        setBusy(tag)
        setErr('')
        try {
          await fn()
          await load()
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const submitImport = () => {
        const { name, domain, text, note, isFile } = draft
        if (!name || !domain || !text.trim()) return setErr('名字、域名、内容和不能为空')
        return run('import', async () => {
          if (isFile || text.includes('\t')) {
            await api('/import', { name, domain, text, note })
          } else {
            await api('/add', { name, domain, cookie: text, note })
          }
          setDraft({ name: '', domain: '', text: '', note: '', isFile: false })
        })
      }

      const onFile = (e) => {
        const f = e.target.files && e.target.files[0]
        if (!f) return
        const reader = new FileReader()
        reader.onload = () => setDraft((d) => ({ ...d, text: String(reader.result || ''), isFile: true }))
        reader.readAsText(f)
      }

      const button = h(
        'button',
        {
          type: 'button',
          onClick: () => setOpen((v) => !v),
          title: '账号与 Cookie 管理',
          style: {
            // shell.overlay 是一个铺满的层，按钮必须自己定位，否则会飘到左上角
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 95,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            padding: '6px 12px',
            borderRadius: 999,
            border: `1px solid ${T.border}`,
            background: T.bg,
            color: T.text,
            boxShadow: T.shadow,
            cursor: 'pointer',
          },
        },
        data && data.monitorUnread ? `🍪 账号 · ${data.monitorUnread}` : '🍪 账号',
      )

      if (!open) return button

      const rows = (data && data.profiles) || []
      const autoMatch = data ? data.autoMatch : true

      return h(
        React.Fragment,
        null,
        button,
        h(
          'div',
          {
            style: {
              position: 'fixed',
              right: 16,
              bottom: 72,
              width: 420,
              maxHeight: '70vh',
              overflowY: 'auto',
              zIndex: 90,
              background: T.bg,
              color: T.text,
              border: `1px solid ${T.border}`,
              borderRadius: 12,
              padding: 14,
              boxShadow: T.shadow,
              fontSize: 13,
            },
          },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('strong', { style: { fontSize: 14 } }, '账号与 Cookie'),
            h('button', { type: 'button', onClick: () => setOpen(false), style: s.btn }, '关闭'),
          ),

          err ? h('div', { style: { color: T.danger, marginTop: 8, fontSize: 12 } }, err) : null,

          // 全局开关
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: autoMatch,
              disabled: busy === 'auto',
              onChange: (e) => run('auto', () => api('/settings', { autoMatch: e.target.checked })),
            }),
            h('span', null, '按域名自动匹配账号'),
            h('span', { style: { color: T.muted, fontSize: 11 } }, '（关闭后只有显式指定才带 cookie）'),
          ),

          // 标签页
          h(
            'div',
            { style: { display: 'flex', gap: 6, marginTop: 10, borderBottom: `1px solid ${T.border}`, paddingBottom: 6 } },
            ...[['accounts', '账号'], ['monitors', '监控']].map(([k, label]) =>
              h(
                'button',
                {
                  key: k,
                  type: 'button',
                  onClick: () => {
                    setTab(k)
                    if (k === 'monitors') run('read', () => api('/monitors/read', {}))
                  },
                  style: {
                    fontSize: 12,
                    padding: '4px 12px',
                    borderRadius: 999,
                    border: `1px solid ${k === tab ? T.accent : T.border}`,
                    background: k === tab ? T.accent : 'transparent',
                    color: k === tab ? T.onAccent : T.muted,
                    cursor: 'pointer',
                  },
                },
                label,
                k === 'monitors' && data && data.monitorUnread ? ` (${data.monitorUnread})` : '',
              ),
            ),
          ),

          // 列表
          h('div', { style: { marginTop: 6, display: tab === 'accounts' ? 'block' : 'none' } },
            rows.length === 0
              ? h('div', { style: { color: T.muted, padding: '12px 0' } }, '还没有账号配置，下面导入一条。')
              : rows.map((p) =>
                  h(
                    'div',
                    { key: p.name, style: s.row },
                    h(
                      'div',
                      null,
                      h('div', { style: s.name }, p.name, h('span', { style: { color: T.muted, fontWeight: 400 } }, ` · ${p.domain}`)),
                      h('div', { style: s.sub }, p.note ? `${p.note} · ` : '', `${p.count} 个 cookie · 最近使用 ${p.lastUsedAt || '—'}`),
                      h('div', { style: { ...s.sub, marginTop: 4 } }, h(Badge, { profile: p })),
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                      h(
                        'button',
                        {
                          type: 'button',
                          style: s.btn,
                          disabled: busy === 'test-' + p.name,
                          onClick: () =>
                            run('test-' + p.name, () =>
                              api('/status', { name: p.name, url: `https://${String(p.domain).replace(/^\./, '')}` }),
                            ),
                        },
                        busy === 'test-' + p.name ? '…' : '测试',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: s.btn,
                          onClick: () => run('toggle-' + p.name, () => api('/toggle', { name: p.name, enabled: !p.enabled })),
                        },
                        p.enabled ? '禁用' : '启用',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: { ...s.btn, color: T.danger },
                          onClick: () => {
                            if (window.confirm(`删除账号配置「${p.name}」？删除后需要重新导入 cookie。`)) {
                              run('rm-' + p.name, () => api('/remove', { name: p.name }))
                            }
                          },
                        },
                        '删除',
                      ),
                    ),
                  ),
                ),
          ),

          // 监控
          h(
            'div',
            { style: { marginTop: 6, display: tab === 'monitors' ? 'block' : 'none' } },
            (data && data.monitors && data.monitors.length
              ? data.monitors
              : []
            ).map((m) =>
              h(
                'div',
                { key: m.id, style: s.row },
                h(
                  'div',
                  { style: { minWidth: 0 } },
                  h(
                    'div',
                    { style: { ...s.name, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    m.note || m.url,
                  ),
                  h(
                    'div',
                    { style: s.sub },
                    `${ruleLabel(m.rule)} · 每 ${Math.round(m.intervalMs / 60000)} 分钟 · 上次检查 ${fmt(m.lastCheckAt)}`,
                  ),
                  h(
                    'div',
                    { style: { ...s.sub, marginTop: 4 } },
                    m.error
                      ? h('span', { style: { color: T.danger } }, `出错：${m.error}`)
                      : m.changes
                        ? h('span', { style: { color: m.unread ? T.warn : T.muted } }, `变化 ${m.changes} 次${m.unread ? `（${m.unread} 条未读）` : ''}`)
                        : h('span', { style: { color: T.muted } }, '暂无变化'),
                    m.last && m.last.price != null ? ` · 当前 ${m.last.currency || ''}${m.last.price}` : '',
                  ),
                  // 检查留痕：哪怕没变化也显示最近一次，否则用户以为监控没跑
                  m.log && m.log.length
                    ? h(
                        'div',
                        { style: { ...s.sub, opacity: 0.85 } },
                        `最近 ${fmt(m.log[0].at)}：`,
                        m.log[0].changed ? '✅ ' : '',
                        m.log[0].price != null ? `${m.log[0].currency || ''}${m.log[0].price}` : '无价格',
                        `（${m.log[0].reason || (m.log[0].changed ? '已触发' : '未触发')}）`,
                      )
                    : null,
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      style: s.btn,
                      disabled: busy === 'chk-' + m.id,
                      onClick: () => run('chk-' + m.id, () => api('/monitors/check', { id: m.id })),
                    },
                    busy === 'chk-' + m.id ? '…' : '检查',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: { ...s.btn, color: T.danger },
                      onClick: () => run('rmm-' + m.id, () => api('/monitors/remove', { id: m.id })),
                    },
                    '删除',
                  ),
                ),
              ),
            ),
            (data && data.monitors && data.monitors.length
              ? null
              : h('div', { style: { color: T.muted, padding: '12px 0' } }, '还没有监控。下面按行添加地址。')
            ),
            h(
              'div',
              { style: { marginTop: 10, paddingTop: 12, borderTop: `1px solid ${T.border}` } },
              h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '添加监控'),
              h('textarea', {
                style: { ...s.input, height: 66, resize: 'vertical', fontFamily: 'ui-monospace, monospace' },
                placeholder: '每行一个 URL 或 ASIN，例如\nhttps://www.amazon.com/dp/B0BZD1TCWM\nB09QM2DRBV',
                value: mdraft.urls,
                onChange: (e) => setMdraft({ ...mdraft, urls: e.target.value }),
              }),
              h(
                'div',
                { style: { display: 'flex', gap: 6, marginTop: 6 } },
                h(
                  'select',
                  {
                    style: { ...s.input, marginTop: 0, flex: 1 },
                    value: mdraft.ruleType,
                    onChange: (e) => setMdraft({ ...mdraft, ruleType: e.target.value }),
                  },
                  h('option', { value: 'price-drop' }, '价格下跌'),
                  h('option', { value: 'price-below' }, '价格低于'),
                  h('option', { value: 'contains' }, '出现关键词'),
                  h('option', { value: 'missing' }, '关键词消失'),
                ),
                h(
                  'input',
                  {
                    style: { ...s.input, marginTop: 0, width: 110 },
                    placeholder: mdraft.ruleType === 'price-below' ? '阈值' : '关键词',
                    value: mdraft.ruleValue,
                    onChange: (e) => setMdraft({ ...mdraft, ruleValue: e.target.value }),
                  },
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' } },
                h(
                  'select',
                  {
                    style: { ...s.input, marginTop: 0, flex: 1 },
                    value: mdraft.intervalMs,
                    onChange: (e) => setMdraft({ ...mdraft, intervalMs: Number(e.target.value) }),
                  },
                  h('option', { value: 3600000 }, '每 1 小时'),
                  h('option', { value: 900000 }, '每 15 分钟'),
                  h('option', { value: 21600000 }, '每 6 小时'),
                  h('option', { value: 86400000 }, '每天'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    style: s.primary,
                    disabled: busy === 'madd',
                    onClick: () =>
                      run('madd', async () => {
                        const urls = mdraft.urls.split('\n').map((x) => x.trim()).filter(Boolean)
                        if (!urls.length) throw new Error('至少填一个 URL')
                        for (const u of urls) {
                          await api('/monitors/add', {
                            url: u,
                            ruleType: mdraft.ruleType,
                            ruleValue: mdraft.ruleValue,
                            intervalMs: mdraft.intervalMs,
                          })
                        }
                        setMdraft({ ...mdraft, urls: '' })
                      }),
                  },
                  busy === 'madd' ? '添加中…' : '添加',
                ),
              ),
              h(
                'div',
                { style: { color: T.muted, fontSize: 11, marginTop: 8, lineHeight: 1.5 } },
                '检查在本地完成（只发 HTTP，不调用模型，不产生余额消耗）；命中后只在本面板记录，不会自动叫 AI 分析。',
              ),
            ),
          ),

          // 导入
          h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}`, display: tab === 'accounts' ? 'block' : 'none' } },
            h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '导入 / 更新'),
            h('input', {
              style: s.input,
              placeholder: '别名，例如 xiaohongshu',
              value: draft.name,
              onChange: (e) => setDraft({ ...draft, name: e.target.value }),
            }),
            h('input', {
              style: s.input,
              placeholder: '域名，例如 .xiaohongshu.com',
              value: draft.domain,
              onChange: (e) => setDraft({ ...draft, domain: e.target.value }),
            }),
            h('input', {
              style: s.input,
              placeholder: '备注（可选），例如 我的小号',
              value: draft.note,
              onChange: (e) => setDraft({ ...draft, note: e.target.value }),
            }),
            h('textarea', {
              style: { ...s.input, height: 84, resize: 'vertical', fontFamily: 'ui-monospace, monospace' },
              placeholder: '粘贴 cookie（k=v; k2=v2），或选择 cookies.txt 文件',
              value: draft.text,
              onChange: (e) => setDraft({ ...draft, text: e.target.value, isFile: false }),
            }),
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
              h('input', { type: 'file', accept: '.txt,text/plain', onChange: onFile, style: { fontSize: 11, color: T.muted } }),
              h('div', { style: { flex: 1 } }),
              h(
                'button',
                { type: 'button', style: s.primary, disabled: busy === 'import', onClick: submitImport },
                busy === 'import' ? '保存中…' : '保存',
              ),
            ),
            h('div', { style: { color: T.muted, fontSize: 11, marginTop: 8, lineHeight: 1.5 } },
              'cookie 只保存在本机 ', h('code', null, '~/.dsh/storages/web-reader/cookies.json'),
              '，面板与工具都不会回显它的值。',
            ),
          ),
        ),
      )
    }

    const apply = (ctx) => {
      const slots = typeof ctx.get === 'function' ? ctx.get('slots') : ctx.slots
      if (!slots || typeof slots.inject !== 'function') return
      return slots.inject('shell.overlay', () =>
        slots.register(
          { name: 'shell.overlay', key: 'web-reader-accounts', id: 'web-reader-accounts', order: 1003 },
          Panel,
        ),
      )
    }

    return { apply, inject: ['slots'] }
  },
})
