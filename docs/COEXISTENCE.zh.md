# 与 dsh-websift 共存与分工

`dsh-websift`（作者 KNLCXY，npm: `dsh-websift`）和本插件都能"读网页"，但底层路线相反：
它用**真 Chrome（CDP）**换能力，我们用**结构化接口 + 零依赖解析**换速度和确定性。两者不冲突，装一起是互补，不是重复。

## 一、定位差异

| 维度 | web-reader（本插件） | dsh-websift |
|---|---|---|
| 工具名 | `web_read` | `web_digest` / `web_find` / `browser` / `browser_proxy` |
| 底层 | Node `fetch` + 自写 HTML 解析 | 本机 Chrome headless + CDP |
| 依赖 | 无 | 需要 Chrome/Edge（约 700MB），首次调用 3–6s |
| JS 渲染 | ✗（会返回 `needsRender: true`） | ✓ |
| 登录态 | ✗ | ✓（`action=login` 弹窗登录，cookie 持久化） |
| 代理 | ✗ | ✓（auto/always/never，可单次覆盖） |
| 截图 | ✗ | ✓（整页 PNG，配合 `read_image`） |
| 搜索 | ✗ | ✓（`web_find` 真链接、`web_digest` 多页摘要） |
| token 控制 | `maxChars` 截断 | 预算 + 相关性闸门 + 抽取式摘要（省 80–98%） |
| B 站结构化 | ✓ 官方 API：数据、标签、分P、字幕 | ✗（只能抓 HTML 文本） |
| 亚马逊切美国站 | ✓ 会话级地址握手 + 结构化字段 | ✗（拿到的是你 IP 地区的页面） |
| 速度 | 1 次 HTTP，通常 < 1s | 首次 3–6s，之后 1–3s |
| 适用 | 已知站点、批量、离线/无 Chrome 环境 | 任意站点、被墙、要登录、要截图 |

**一句话**：`web_read` 是"查字典"，`browser` 是"开浏览器"。查字典查不到的，才去开浏览器。

## 二、路由表（装了两个插件时怎么选）

| 场景 | 用谁 | 理由 |
|---|---|---|
| B 站视频的播放量/UP主/字幕 | `web_read` | 官方 API，不用渲染，字段全 |
| 亚马逊商品的价格/评分/规格 | `web_read` | 自动切美国站 + 结构化字段 |
| 普通博客/新闻/文档 | `web_read` | 快，正文干净 |
| 返回 `needsRender: true` | `browser`（websift） | 服务端只给了空壳，必须执行 JS |
| 小红书/微博/X/Instagram 这类 | `browser` | 前端渲染 + 常有登录墙 |
| 要截图看排版/图表 | `browser` action=screenshot | 本插件不做图像 |
| 需要先登录才能看的内容 | `browser` action=login | 登录态持久化在它自己的 profile |
| 被墙的站（YouTube 等） | `browser`（proxy=always） | 它自带三档代理 |
| "帮我查一下 XX 是什么/对比几个来源" | `web_digest` | 搜索 + 多页 + 相关性摘要，省 token |
| 只要一组真实链接 | `web_find` | 返回可点开的真实 URL |

## 三、三种组合姿势

**1）只要轻量（推荐日常）**：只装 `web-reader`。
覆盖文章、商品、B 站；碰到空壳会明确告诉你，不会瞎编。零依赖，换机器最省事。

**2）只要能力（推荐调研/被墙场景）**：只装 `dsh-websift`。
一切都能读，代价是 Chrome 常驻内存、首次慢、token 预算制。

**3）两个都装（本次讨论的方案）**：
各取所长，但**必须定规则**，否则模型会在 `web_read` / `web_digest` / `browser` 之间反复试，反而更慢更贵。

规则已经写进本插件的工具描述：空壳时返回
`needsRender: true` + `hint: 改用浏览器类工具（如 dsh-websift 的 browser）`。
模型看到这个字段就知道该换工具，不需要你在对话里教。

## 四、已知的"不能"

- **插件之间不能直接互调工具**。DSH 的工具注册表是给 Agent 用的，不是给插件用的；本插件没有、也不该有"调用 `browser`"的 API。
  所以 handoff 只能靠**返回结构化提示**（`needsRender` / `hint`），由模型决定下一步。这也是 DSH 的常规组合方式。
- **代理设置不共享**。websift 有自己的三档代理；本插件是直连（`fetch` 走系统环境变量，不支持 per-call 代理）。
  如果同一批任务既要直连又要代理，代理那部分交给 websift。
- **登录态不共享**。websift 的 cookie 在它自己的 profile 里；本插件目前不接受 Cookie 注入（CLI 层留了位置）。

## 五、深度结合（已实现：给 websift 加 `ctx.provide`）

上游 `apply()` 不导出任何接口，所以"插件 A 调插件 B"原本做不到。
但只要给 websift 补 **30 行**，把内部渲染函数暴露成 cordis 服务，就能打通：

```js
// websift 侧（lib/index.js 的 apply 末尾）
const dispose = ctx.provide('websift', {
  renderPage: (url, opts) => run(resolveSettings(config), {...}),   // 真 Chrome 取正文
  search:     (q, opts)    => runFind(...),
})
return [dispose]
```

```js
// web-reader 侧（本插件）
const svc = ctx.get('websift')        // 惰性探测，没装就是 undefined，不影响激活
if (result.needsRender && svc) {
  const r = await svc.renderPage(url, { maxChars })
  // 命中 → 返回 { renderedBy: 'websift', needsRender: false, markdown: 真实正文 }
}
```

带来的变化：**用户完全无感**。`web_read` 遇到空壳页不再"交还给模型换工具"，
而是自己补一次渲染再返回。实测接线（假服务）9 项断言全过：`renderedBy` 标记、
`render: 'never'` 可关闭、无服务时退回 `needsRender` + hint。

代价与边界：

- 必须装**改造版**（`link:` 本地目录），npm 上的官方包没有这个服务，两者同名不能共存。
- 上游升级要重打补丁（位置固定在 `apply()` 末尾，见 `dsh-websift-svc/PATCH.zh.md`）。
- 服务只暴露 `renderPage` / `search` / `settings` 三个口子，不做双向耦合；
  我们仍然不依赖它的工具名和内部结构。

## 五之二、仍然不建议做的

1. **把 CDP 搬进本插件**：等于重写 dsh-websift 的一半，违背"零依赖、装上就用"的定位。
2. **让 websift 反过来调我们的解析器**：收益是"渲染后的 HTML 也能走亚马逊/B站适配器"，
   但要给 websift 加回调逻辑，耦合度翻倍，收益有限。

结论：**共存 + 单向 handoff + 可选的 `websift` 服务渲染**，已经覆盖了实际会遇到的场景。

## 六、装 websift 的命令（如果决定加装）

```bash
dsh plugin --profile web add dsh-websift
```

它自带 Web GUI 设置页（浏览器代理、开关），配置写在 `~/.dsh/storages/websift/settings.json`，
`cordis.patch.yml` 里只有出厂默认值。装完重启 DSH 即可，两个插件会各自注册工具，互不影响。
