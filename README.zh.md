# web-reader · 让 DSH 会自己读网址

把"给你一个链接，把里面的内容读出来"做成 DSH 插件：跑起来之后，任意会话里的 Agent 都能直接调用

```
web_read({ url: "https://..." })
```

拿到网页正文 / 商品信息 / 视频元数据，而不是靠猜。

- **零运行时依赖**：只用 Node 内置能力（fetch、TextDecoder、正则解析 HTML），不装 Python、不装浏览器内核、不联网装包。
- **装上就跨机器**：整个目录拷到另一台电脑，`dsh plugin add` 一行就可用。
- **可选增强**：想要"视频里说了什么"，再接本机的 yt-dlp + Whisper（不装也能用，只是拿不到语音）。

---

## 一、它能读到什么

| 链接类型 | 拿到的东西 | 实现 |
|---|---|---|
| 博客 / 新闻 / 文档 / 论坛帖 | 标题、正文（保留标题层级与列表）、meta 描述 | 自写正文抽取（段落投票 + 样板剔除） |
| 亚马逊等商品页 | 标题、价格、评分、评论数、库存/配送状态、卖点、规格表；**默认切成美国站：美元价 + 美区库存 + 送达日期** | 站点适配器 + 会话级"地址切换"握手 |
| B 站视频页 | 标题、UP主、分区、发布时间、时长、播放/点赞/投币/收藏/评论/弹幕、标签、分P、简介、**字幕正文** | 官方公开 API |
| YouTube / Vimeo | 标题、作者、封面 | oEmbed |
| 其它任意网页 | 正文兜底抽取 | 文本密度 + 换行还原 |

**读不到 / 读不全的**（插件会明确告诉你，而不是编内容）：

| 情况 | 表现 | 办法 |
|---|---|---|
| 纯前端渲染（首屏只有 JS） | 正文为空或只有标题 | 用带浏览器的方案截图后再喂给模型 |
| 验证码 / 机器人检测 | 返回验证码页 | 换时间重试、带 Cookie、或用浏览器 |
| 登录墙（小红书、付费专栏） | 跳到登录页 | 提供 Cookie |
| 海外站点（YouTube 等） | 连接超时 | 走代理 |
| 视频里的语音 | 只有元数据 | 见第五节（可选转写） |
| 亚马逊价格 | 已经默认切美国站；若仍显示人民币 | 说明地址切换握手失败（见第六节），可显式传 `zip` 换个邮编重试 |

---

## 一.5、亚马逊切到美国站（默认行为）

你在中国大陆打开亚马逊，页面会按 IP 把"配送至"设成 China，价格换成人民币，然后告诉你"无法配送"。这就是为什么之前读到 `CNY46.55 / 无法配送`——不是抓错了，是**那台"浏览器"确实在中国**。

插件现在会先做一次**会话级地址切换**，再读商品页：

1. 建一个 cookie 罐，预置 `lc-main=en_US`、`i18n-prefs=USD`（币种靠这个 cookie）；
2. `GET` 商品页，从页面里抠出会话内的 `anti-csrftoken-a2z`；
3. `POST /gp/delivery/ajax/address-change.html`，表单带 `zipCode=10001`，返回 `{"isValidAddress":1,...}`；
4. 用**同一组 cookie** 再 `GET` 商品页 —— 这时才是美国站视角。

实测同一件商品，两个视角差这么多：

| | 切美国前（region=local） | 切美国后（region=us，默认） |
|---|---|---|
| 价格 | CNY 46.55 | **$8.99** |
| 库存 | This item cannot be shipped to your selected delivery location | **In Stock** |
| 配送至 | China | **New York 10001** |
| 送达 | 无 | **FREE delivery, Tuesday November 3** |

用法：

```
web_read({ url: "https://www.amazon.com/dp/B0C23GQ4XT" })                  # 默认美国
web_read({ url: "...", region: "us", zip: "90210" })                       # 指定邮编（比佛利山）
web_read({ url: "...", region: "local" })                                  # 沿用 IP 地区，看"中国视角"
```

CLI 同理：`--region us|local`、`--zip 10001`。

**注意**：切换的是"收货地址"，不是"网络出口"。所以价格、库存、配送时间都变成美国口径了，但下列内容仍可能受 IP 影响：Deal 活动、Prime 会员价、部分地区限定商品。要完全伪装成美国用户，还得配美国代理——插件当前没有代理参数（CLI 层留了扩展位）。


## 一.6、和浏览器类插件（dsh-websift）怎么配合

本插件不执行 JS。碰到前端渲染的页面，它会返回 `needsRender: true` + `hint`，提示模型改用浏览器类工具（例如 [dsh-websift](https://github.com/KNLCXY/dsh-websift) 的 `browser`）。

分工：**结构化/已知站点用 web_read（快、零依赖），空壳/被墙/要登录/要截图交给 browser，多源调研交给 web_digest。**

完整的路由表、三种组合姿势、以及"为什么插件之间不能直接互调工具"，见 [docs/COEXISTENCE.zh.md](docs/COEXISTENCE.zh.md)。

---

## 一.7、缓存与限流（默认开启）

这两件事是"被打脸"之后加的：连续查几次亚马逊，对方就不再返回商品页，而是一个 3.8 KB 的拦截页（HTTP 200，内容不对），而旧代码完全看不出来。

- **按主机限流**：同一域名两次请求至少间隔 `minIntervalMs`（默认 1200ms），同时只允许一个在飞请求。
- **尊重 Retry-After**：429 / 503 会读响应头里的等待时间（秒数或 HTTP 日期），冻结该域名后再试，最多等 60s。
- **进程内缓存**：同一 URL 默认复用 5 分钟，命中时**连请求都不发**。亚马逊的"切换美国地址"是一套两次请求的握手，命中缓存后整套省掉。

实测同一商品页（2.4 MB）：

| | 耗时 | 请求数 |
|---|---|---|
| 首次 | 4.6s | 2（抓取 + 地址切换后的重取） |
| 5 分钟内再读 | **55ms** | **0** |
| `refresh: true` | 4.9s | 2 |

缓存的边界：

- 只缓存 200 且 content-type 是 html/json/text 的响应；
- 单条上限 8 MB、总量上限 64 MB，超了按 LRU 淘汰（亚马逊一页就 2.4 MB，只按条数限制会吃光内存）；
- 亚马逊缓存键带 `region|zip`——"美国站视图"和"默认视图"共用一个 key 会串味；
- 带 Cookie 的响应与匿名响应分开存（`auth` / `anon` 前缀）。

可调参数（`cordis.patch.yml` 的 config）：

`yaml
config:
  minIntervalMs: 1200   # 同主机最小间隔
  cacheTtlMs: 300000    # 缓存有效期
  cacheMax: 50          # 最多缓存条数
`
## 一.8、账号 Cookie（可选，读登录后才能看的内容）

小红书正文、B站字幕、需要登录的专栏，光靠匿名请求拿不到。插件支持把账号 Cookie 存在本机，按域名自动带上。

### 存进来

`ash
# 1) 从浏览器导出 cookies.txt（扩展 "Get cookies.txt LOCALLY" 或 EditThisCookie），然后：
node bin/webread.mjs cookies import xiaohongshu --domain .xiaohongshu.com --file cookies.txt --note "我的号"

# 2) 或者直接贴一行
node bin/webread.mjs cookies add bilibili --domain .bilibili.com --cookie "SESSDATA=…; bili_jct=…"

# 3) 看有哪些（只显示元信息，不显示值）
node bin/webread.mjs cookies list
node bin/webread.mjs cookies path     # 库文件位置
node bin/webread.mjs cookies remove xiaohongshu
`

装进 DSH 后，工具参数用配置名即可：

`
web_read({ url: "https://www.xiaohongshu.com/explore/…" })            # 按域名自动匹配
web_read({ url: "…", cookie: "xiaohongshu" })                        # 指定配置
web_read({ url: "…", cookie: "off" })                                # 强制匿名
`

结果里只会出现 cookieProfile: "xiaohongshu"，**不会出现任何 cookie 值**。

### 三条硬约束

1. **值不进模型上下文**：工具参数只收"配置名"，不收原始 cookie；返回值、日志、错误信息都不含值。
2. **不跨站发送**：按域名后缀匹配（取最长匹配），example.com.evil.com 这种伪造域名不会匹配成功；配置属于 A 站时发给 B 站会直接按匿名请求，并在 hint 里说明。
3. **只存本机**：默认 ~/.dsh/storages/web-reader/cookies.json，POSIX 下 chmod 600。

> ⚠️ 踩过的坑：原本在 Windows 上用 icacls 收紧权限，结果拼出的用户名变成 `<user>\`（域为空），
> icacls 却返回成功——文件 ACL 变成谁都不能访问，整个库直接报废。
> 现在的做法是 **Windows 上不动 ACL**（文件本来就在用户目录，继承权限通常已是"仅本人+管理员"）；
> 真要更强隔离请用 BitLocker/EFS。并且 load() 遇到 EACCES 会报错，而不是静默返回空库。

### 什么时候会失效

- Cookie 有过期时间，账号被登出后请求会悄悄退回"未登录"，读到的是登录墙页面。
- 判断方法：看结果里的 cookieProfile 字段是否出现；如果出现了但内容仍是登录墙，说明 cookie 过期了，重新导一次。
- 缓存键区分 uth / non：加了 cookie 之后不会读到之前匿名缓存的旧结果（反之亦然）。
## 一.9、可视面板（Web UI）

装好后，输入框那一排会多一个 **🍪 账号** 按钮，点开是账号面板：

| 功能 | 说明 |
|---|---|
| 列表 | 别名、域名、备注、最近使用时间、cookie 条数 |
| 健康状态 | 绿色"可用" / 红色"疑似登录墙"（最近一次访问的判定，含原因） |
| 启用/禁用 | 单条开关，禁用后自动匹配与显式指定都不再发送 |
| 删除 | 二次确认后删除该配置 |
| 导入 | 粘贴 k=v; k2=v2，或直接选 cookies.txt（自动识别 Netscape 格式） |
| 全局开关 | "按域名自动匹配账号"，关掉后只有显式传 cookie: 才带 |

状态是**间接判断**出来的：每次带 cookie 抓完页面，用一个启发式扫一遍正文——
强特征（"登录后查看""扫码登录""sign in to continue"）直接判墙；
弱特征（正文很短且开头出现"登录"字样）才判墙；一篇 1000 字文章里提一次"登录"不算。
面板里的"测试"按钮会对该配置的域名根地址抓一次，立刻刷新这个状态。

架构上拆成两行插件，互不拖累：

`yaml
- id: web-reader        name: dsh-plugin-web-reader         # 工具，inject ['tools']
- id: web-reader-panel  name: dsh-plugin-web-reader/panel   # 面板接口，inject ['webServer']
`

> 为什么拆：webServer 不在 inject 里时 ctx.get('webServer') 返回 undefined（实测），
> 而把它写进 inject 又会让没有 webServer 的 profile（CLI/tui）整个插件不激活、工具也没了。

接口（前缀 /web-reader-api，全部 JSON，**不返回任何 cookie 值**）：

`
GET  /state                 -> { autoMatch, profiles:[{name,domain,enabled,count,note,lastUsedAt,lastVisit}] }
POST /add     {name,domain,cookie,note}
POST /import  {name,domain,text,note}
POST /remove  {name}
POST /toggle  {name,enabled}
POST /settings{autoMatch}
POST /status  {name,url}    -> { loginWall, reason, chars }
`

写操作要求自定义头 `x-web-reader: 1`（跨站表单无法伪造该头，便宜的 CSRF 闸门）。
## 一.10、视频「看」和「听」（可选，需要本机 Python）

B 站/YouTube 的元数据和字幕是白送的，但有些视频**没有可用字幕**（比如那个树莓派课程，B 站挂的 AI 字幕甚至是错的）。这时可以用两个新参数：

`
web_read({ url: "https://www.bilibili.com/video/BV...", frames: 6 })        # 抽 6 张关键帧
web_read({ url: "...", asr: true, start: 0, end: 120 })                     # 转写前 2 分钟
web_read({ url: "...", frames: 4, asr: true })                              # 两个都要
`

返回里会多两段：

- `## 关键帧`：本地 jpg 路径列表 —— 我可以用看图工具逐张看
- `## 语音转写（Whisper small）`：带时间轴的全文（同时落盘 .txt / .srt）

**分工**：插件只负责把视频变成"文字 + 图片"，真正的理解由模型看图读字完成。这样不会偷偷消耗你的余额（转写是本地算力）。

### 依赖（一次性）

`powershell
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple yt-dlp imageio-ffmpeg faster-whisper
# 模型走国内镜像
\="https://hf-mirror.com"; \="1"
`

然后在 `cordis.patch.yml` 里把 `pythonPath` 指向那个 Python（留空则用 PATH 里的 python）。

### 实测

| 环节 | 结果 |
|---|---|
| 抽帧 | ✅ 3 张 jpg（`--frames` 参数） |
| 转写 | ✅ 15 秒音频 → 104 字，12.6s（small 模型，已缓存） |
| Cookie 透传 | ✅ 登录态能降低 B 站对视频流的 503 频控 |

### 坑

- **B 站视频流有频控**：短时间内反复下同一个视频会 503，等一两分钟再试。
- **转写速度**：CPU 上 small 模型约 1 分钟音频 / 1 分钟；先用 `start`/`end` 截一段更实际。
- **输出目录**：默认 `~/.dsh/storages/web-reader/video`；受限环境下可用环境变量 `WEB_READER_VIDEO_DIR` 改到工作区。
## 二、安装（三种方式，选一个）

### 方式 A：本机已有源码目录（开发用，改完即生效）

```powershell
# Windows PowerShell
cd <插件目录>
powershell -ExecutionPolicy Bypass -File .\install.ps1          # 默认装进 web profile
powershell -ExecutionPolicy Bypass -File .\install.ps1 desktop  # 或 desktop
```

```bash
# macOS / Linux
bash install.sh          # web
bash install.sh desktop  # desktop
```

等价于手工执行：

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-plugin-web-reader
```

`link:` 装的是软链接，改代码不用重装，重启（或 HMR）后生效。

### 方式 B：拷到别的电脑（最常用）

1. 把整个 `dsh-plugin-web-reader` 目录打成一个 zip（也可以干脆拷文件夹）。
2. 在目标机器解压到任意位置，例如 `D:\plugins\dsh-plugin-web-reader`。
3. 安装：

```powershell
dsh plugin --profile web add link:"D:\plugins\dsh-plugin-web-reader"
```

4. 重启 DSH。新会话的 Agent 工具列表里就会出现 `web_read`。

> 目标机器需要什么？**只有 DSH 本身**。Node 是 DSH 自带的（≥ 20 即可），不需要 Python、不需要 ffmpeg。
> 不想用 `link:` 也可以把它推到 Git 仓库，然后 `dsh plugin --profile web add github:<user>/<repo>`。

### 方式 C：打包后安装（不依赖源码路径）

```bash
cd dsh-plugin-web-reader
npm pack            # 产出 dsh-plugin-web-reader-1.1.0.tgz
dsh plugin --profile web add ./dsh-plugin-web-reader-1.1.0.tgz
```

---

## 三、在 DSH 里怎么用

**什么都不用做**：Agent 看到你发的链接，会自己判断要不要调 `web_read`。它拿到的结果是 Markdown，会直接在回答里用。

你也可以明确要求：

> 读一下 https://... ，把价格和评分整理成表
> 这个 B 站视频讲了什么？先 web_read 拿元数据和字幕

### 工具参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `url` | 是 | 要读的网址，必须 http/https |
| `mode` | 否 | `auto`（默认，按域名自动选） / `page` / `product` / `video` |
| `maxChars` | 否 | 返回正文上限，默认 20000；长文先小后大，别一次灌满上下文 |
| `save` | 否 | 把 Markdown 额外写到某个路径，便于交接或再引用 |
| `region` | 否 | 商品页配送地区：`us`（默认，切到美国 10001）/ `local`（跟随 IP） |
| `zip` | 否 | 配合 `region=us` 的美国邮编，默认 `10001` |
| `refresh` | 否 | 默认走缓存；传 true 强制重新抓取（价格/库存建议传） |

返回：`{ kind, title, url, markdown, saved? }`。

### 插件配置（可选）

在 profile 的 `cordis.patch.yml` 里覆盖行配置即可：

```yaml
- id: web-reader
  config:
    defaultMaxChars: 12000
```

---

## 四、不开 DSH 也能用（命令行）

```bash
node bin/webread.mjs "https://www.bilibili.com/video/BV1GJ411x7h7/"
node bin/webread.mjs "https://www.amazon.com/dp/B09B8V1LZ3" --mode product
node bin/webread.mjs "https://example.com/post" --max-chars 8000 --out post.md
node bin/webread.mjs "https://example.com/post" --json
```

适合在 CI、脚本、或者没装 DSH 的机器上直接用。

---

## 五、可选：视频"听写"（不在插件内，按需接）

插件本身**不**做语音识别，它只负责把视频的元数据和字幕取回来。想要"视频里说了什么"，在目标机器上再装一小套工具链：

```powershell
# 1) 装 yt-dlp + ffmpeg + faster-whisper（清华镜像，国内可用）
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple yt-dlp imageio-ffmpeg faster-whisper

# 2) 模型走国内镜像
$env:HF_ENDPOINT="https://hf-mirror.com"; $env:HF_HUB_DISABLE_XET="1"
```

然后把流程串起来（任选脚本形态）：`yt-dlp -f bestaudio` 下音频 → ffmpeg 转 16k 单声道 wav → faster-whisper 转写 → 把 txt 交给 Agent 分析。B 站视频大多没有字幕，这一步是唯一能拿到口播内容的办法。

> 这一节故意不放进插件：模型权重几百 MB、还要 Python 与 GPU/CPU 选择，放进插件会让"装完就能用"变成"装完还要配一堆"。拆开之后，读网页是零成本的，听写是可选加装。

---

## 六、实现原理（为什么会比"curl 一下"准）

三层，各自解决一类问题：

1. **抓取层** `lib/fetch.mjs`
   - 浏览器 UA + Accept-Language，很多 403 就是这个；
   - 编码按 Content-Type → `<meta charset>` → utf-8 逐级回退（中文站常见 gbk）；
   - 超时 + 5xx/429 退避重试。
   - **踩过的坑**：给 `api.bilibili.com` 带 `Referer` 会被 WAF 判 412，得换成 `Origin` + `Sec-Fetch-*` 这套；插件里已经按站点分开处理。

2. **适配层** `lib/adapters.mjs`
   - B 站走 `x/web-interface/view` 等公开接口，拿的是结构化字段，不靠 HTML 猜；
   - 亚马逊按 `#productTitle`、`#feature-bullets`、`#corePrice_desktop`、`#acrPopover`、`#availability` 取值；
   - 读商品页之前先做一次地址切换握手（cookie 罐 + 页面内 csrf + `address-change` 表单 POST），否则拿到的是按你 IP 的地区页面；
   - 价格只认 `span.a-price` 内的 `a-offscreen` —— 直接取页面第一个 `a-offscreen` 会拿到分期/优惠券/配件价，实测差十倍。

3. **正文层** `lib/html.mjs`
   - 自写容错解析器建 DOM 树（不依赖 jsdom，也就不需要装依赖）；
   - 删 `script/style/nav/footer/aside`，再按 class/id 删侧栏、推荐、评论区等样板；
   - 段落投票选正文容器（每个 `<p>` 按长度给父容器计分，再向上合并只包住同一批段落的外层）；
   - 没 `<p>` 的老站点退化为文本密度 + 换行还原。

---

## 七、已知限制

- **不执行 JS**：SPA 站点只能拿到服务端渲染的部分；这是刻意的取舍——加浏览器内核会让插件变成几百 MB 且跨平台易碎。
- **通用抽取可能残留少量导航文字**：站点结构千奇百怪，适配器只覆盖了 B 站、亚马逊；其余靠启发式。
- **亚马逊价格/库存与访问地区相关**：中国大陆地址常显示"无法配送"，此时页面没有真实售价。
- **不做登录**：需要 Cookie 的站点，当前版本没有传 Cookie 的工具参数（CLI 层也留了扩展位）。
- **只读文本**：不下载图片/视频文件，只给 URL。

---

## 八、文件结构

```
dsh-plugin-web-reader/
├── package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 插入 web-reader 行
├── index.js              # Host 插件：inject ['tools']，注册 web_read
├── lib/
│   ├── fetch.mjs         # 抓取层
│   ├── html.mjs          # 解析 + 正文抽取
│   ├── adapters.mjs      # B站 / 亚马逊 / oEmbed / 通用
│   └── tool.mjs          # 工具定义（手写规范化结构，不依赖 @deepseek-ai/*）
├── bin/webread.mjs       # 命令行入口
├── locale/{zh,en}.json   # 插件管理页显示的名称与描述
├── icon.svg
└── install.ps1 / install.sh
```

## 九、卸载

```bash
dsh plugin --profile web remove dsh-plugin-web-reader
```

然后重启 DSH。



