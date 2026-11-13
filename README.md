# dsh-plugin-web-reader

A DeepSeek Harness plugin that gives the agent a `web_read` tool:
turn any URL into Markdown — plus optional **account cookies**, **scheduled monitoring**, and **video transcription**.

> 中文文档见 [README.zh.md](README.zh.md)

## What it does

| Input | What you get |
|---|---|
| Any article / docs page | Title, body (headings, lists, tables preserved), meta description |
| Amazon product page | Price, rating, stock, delivery, bullets, spec table — **switched to the US site by default** |
| Bilibili video page | Title, uploader, stats, tags, multi-part list, **subtitles (any language)** |
| YouTube / Vimeo | Title, author, thumbnail |
| Any video (+ optional Python) | Key frames (jpg paths) + local Whisper transcript |
| JS-only pages | Detects the shell and hands off to [dsh-websift](https://github.com/KNLCXY/dsh-websift) if installed |

## Install

```bash
# straight from this repo
dsh plugin --profile web add github:hxy123728/dsh-plugin-web-reader

# or from a local checkout
dsh plugin --profile web add link:/absolute/path/to/dsh-plugin-web-reader

# or a release tarball
dsh plugin --profile web add file:./dsh-plugin-web-reader-1.8.1.tgz
```

Restart DSH. The agent can now call `web_read`.

## Tool parameters

| Param | Default | Meaning |
|---|---|---|
| `url` | — | Required, http/https |
| `mode` | `auto` | `page` / `product` / `video` |
| `maxChars` | 20000 | Output cap |
| `refresh` | false | Bypass the 5-minute cache (use for prices/stock) |
| `region` / `zip` | `us` / `10001` | Amazon delivery region |
| `cookie` | auto | Saved cookie profile name, or `off` |
| `render` | `auto` | Let dsh-websift render shells; `never` disables |
| `frames` | 0 | Video: extract 0–12 key frames |
| `asr` | false | Video: local Whisper transcription |
| `start` / `end` | — | Video: time range (seconds) |

## Features worth knowing

- **Zero runtime dependencies** for the core path — Node built-ins only (no Python, no browser).
- **Per-host throttling + `Retry-After`** — survives Amazon's soft rate limiting.
- **In-process cache** (LRU + TTL + byte cap) — a repeated read sends *zero* requests.
- **Cookie store** — values never enter tool args/results, never cross-domain. See [docs/SECURITY.md](docs/SECURITY.md).
- **Monitoring** — scheduled fetch + local rules (price drop / price below / keyword appears / disappears). **No model calls, no token cost.**
- **Web panel** — accounts and monitors in the DSH Web UI (bottom-right 🍪 button).

## Optional: video transcription

Needs a Python with `yt-dlp`, `imageio-ffmpeg`, `faster-whisper`:

```bash
python -m pip install yt-dlp imageio-ffmpeg faster-whisper
```

Then set `pythonPath` in `cordis.patch.yml` (or leave empty to use `python` on PATH).

## Tests

Ten suites, no network required for most of them:

```bash
node test/smoke.mjs          # tool registration + one real read
node test/needs-render.mjs   # SPA detection
node test/table-and-safety.mjs
node test/throttle-cache.mjs # local fake server
node test/cookies.mjs        # domain matching, redaction
node test/cookie-e2e.mjs     # local fake server, cookie actually sent?
node test/panel.mjs          # HTTP API
node test/monitors.mjs       # rule evaluation
node test/client-load.mjs    # browser bundle wiring
node test/websift-bridge.mjs # cross-plugin handoff
```

## Layout

```
index.js          Host: registers the web_read tool (inject: tools)
panel.js          Host: HTTP API + monitor scheduler (inject: webServer)
client.js         Web UI panel (shell.overlay)
lib/fetch.mjs     fetch + charset + throttle + cache
lib/html.mjs      zero-dep HTML parser + readability
lib/adapters.mjs  Bilibili / Amazon / oEmbed / generic
lib/cookies.mjs   cookie store (never echoed)
lib/monitors.mjs  scheduled checks + rules
lib/video.mjs     Python sidecar: frames + ASR
bin/              CLI (webread) + extract_video.py
```

## License

MIT. The optional integration with dsh-websift requires patching that project; see
[docs/websift-provide.patch](docs/websift-provide.patch) (30 lines, does not redistribute its code).
