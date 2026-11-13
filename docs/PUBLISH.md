# 发布步骤

这份代码已经清理过：没有本机绝对路径、没有用户名、没有 Cookie。

## 1. 先确认这些（需要你填）

| 项 | 现在填的是 | 请确认 |
|---|---|---|
| LICENSE 署名 | `Copyright (c) 2026 hxy` | 要不要改成真名 / 昵称 |
| 仓库名 | `dsh-plugin-web-reader` | 是否就用这个 |
| 仓库可见性 | Public | 也可以先 Private |
| 是否发布 websift fork | **不发布**（只保留 patch 文件） | 见下 |

关于 websift fork：它是对第三方 MIT 项目的修改。建议**不把整份代码放进这个仓库**，只提交 `docs/websift-provide.patch`（30 行 diff）+ 说明，让别人自己 apply。这样既尊重上游，也不用跟着上游版本升级维护一个分叉。

## 2. 建仓库（三选一）

### 方式 A：装 gh CLI（最省事）

```powershell
winget install --id GitHub.cli
gh auth login
cd D:\projects\publish\dsh-plugin-web-reader
gh repo create dsh-plugin-web-reader --public --source=. --push
```

### 方式 B：用 PAT（个人访问令牌）

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. 权限：`Contents: Read and write`
3. 然后：

```powershell
cd D:\projects\publish\dsh-plugin-web-reader
git remote add origin https://<你的用户名>:<PAT>@github.com/<你的用户名>/dsh-plugin-web-reader.git
git push -u origin main
```

⚠️ 用 URL 里带 token 的方式推完，记得把 remote 改回不带 token 的形式，否则 token 会留在 `.git/config`：

```powershell
git remote set-url origin https://github.com/<用户名>/dsh-plugin-web-reader.git
```

### 方式 C：SSH

```powershell
ssh-keygen -t ed25519 -C "your@email"
# 把 ~/.ssh/id_ed25519.pub 贴到 GitHub → Settings → SSH and GPG keys
ssh -T git@github.com
cd D:\projects\publish\dsh-plugin-web-reader
git remote add origin git@github.com:<用户名>/dsh-plugin-web-reader.git
git push -u origin main
```

## 3. 发布前的本地检查

```powershell
cd D:\projects\publish\dsh-plugin-web-reader

# 1) 确认没有敏感文件被跟踪
git ls-files | Select-String "cookie|settings|monitors|\.env"

# 2) 确认没有本机路径
git grep -n "D:\\我的世界" ; git grep -n "hxy"

# 3) 跑一遍测试
node test/smoke.mjs
node test/cookies.mjs
node test/monitors.mjs
```

## 4. 建议加的东西

- **Topics**：`dsh`、`dsh-plugin`、`deepseek-harness`、`web-scraper`、`cookie-manager`
- **Release**：把 `dsh-plugin-web-reader-1.8.1.zip` 作为附件挂上去，README 里给下载链接
- **README 顶部**：加一句"需要 DSH 0.2.x"，以及一张面板截图（你截图给我也行，我可以写进 README）
