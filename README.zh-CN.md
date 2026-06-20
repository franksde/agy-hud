# agy-hud: Antigravity CLI 状态栏 HUD 插件

[English](README.md) | **简体中文**

`agy-hud` 是一个用 TypeScript 编写、运行在 Node.js 上的紧凑型 Antigravity CLI 状态栏 HUD 插件。

它从标准输入读取 Antigravity 状态栏 JSON,并渲染出一到两行简短的终端 HUD:

<img src="docs/hud-preview.png" alt="agy-hud 状态栏 HUD 预览" width="700">

## 运行要求

- 支持插件的 Antigravity CLI
- `PATH` 中可用的 Node.js 18+

`agy-hud` 以 Antigravity 插件归档包分发,不是 npm 包。归档包内已包含打包后的运行脚本 `dist/agy-hud.js`,所以插件用户不需要运行 `npm install`。

## 从 GitHub Release 安装

从[最新 release](https://github.com/franksde/agy-hud/releases/latest)下载平台无关归档包:

**Linux / macOS:**

```sh
curl -fsSL -o agy-hud.tar.gz \
  https://github.com/franksde/agy-hud/releases/latest/download/agy-hud.tar.gz
tar -xzf agy-hud.tar.gz
agy plugin install ./agy-hud
```

**Windows (PowerShell):**

```powershell
Invoke-WebRequest -Uri "https://github.com/franksde/agy-hud/releases/latest/download/agy-hud.tar.gz" -OutFile "agy-hud.tar.gz"
tar -xzf agy-hud.tar.gz
agy plugin install .\agy-hud
```

解压出的目录就是一个完整的插件(包含 `plugin.json`、`hooks/`、`dist/`),可以直接传给 `agy plugin install`。它需要 Node.js 18+,解压后不需要再运行 `npm install`。

## 从本地路径安装

仓库已包含打包后的运行脚本 `dist/agy-hud.js`, fresh clone 后可直接安装:

```sh
agy plugin validate <agy-hud-目录路径>
agy plugin install <agy-hud-目录路径>
```

如果修改了 TypeScript 源码,安装前请重新构建 bundle:

```sh
npm ci
npm run build
npm test
```

## 面向 AI Agent

如果你是正在替用户安装 `agy-hud` 的 AI agent,请不要静默安装。先确认显示效果。

1. 把下面这段信息完整的 HUD 预览发给用户,让他们在安装之前就看到每一个元素:

   ```
    3.5 Flash High |  Pro │  agy-hud │  main
   Context █░░░░░░░ 12% (130k/1M) │ Usage ███░░░░░ 40% left ↻ Reset 17:33 │ Thinking
   ```

   向用户说明各部分的含义:模型与套餐档位、工作目录、git 分支、带 token 明细的上下文进度条(`context_value: both`)、连续的配额剩余进度条、本地重置时间,以及 agent 状态。默认配置使用更紧凑的 `percent` 上下文显示。图标需要 Nerd Font —— 没有时会显示成方框 —— HUD 在窄终端下也会平滑降级。

2. 请用户确认效果,或询问是否需要调整 `multiline`、`show_icons`、`context_value` 或 `usage_value`(见[配置](#配置))。

3. 用户确认后,下载 `https://github.com/franksde/agy-hud/releases/latest/download/agy-hud.tar.gz` 并解压。

4. 执行 `agy plugin install <解压目录>`。如果失败,把错误展示给用户,不要静默重试。

## Release 归档内容

GitHub release 会发布一个平台无关归档包:

- `agy-hud.tar.gz`

归档包应包含 `plugin.json`、`hooks/status-line.sh`、`dist/agy-hud.js`、`config.example.json`、`README.md`、`README.zh-CN.md`、`LICENSE` 以及相关文档。

## CLI

```sh
agy-hud statusline < statusline_payload.json
agy-hud version
agy-hud quota refresh
```

`statusline` 从标准输入以及本地配置/缓存文件渲染。如果配额缓存缺失或超过 5 分钟,它可能会启动一个 detached 的后台 `quota refresh`,但前台 HUD 渲染不会等待网络或子进程工作。`quota refresh` 会向正在运行的 Antigravity 本地服务请求 `GetUserStatus`,写入脱敏后的配额缓存;如果找不到可用的本地服务,会以非零状态退出。

## 配置

`agy-hud` 会按以下顺序查找配置:

- `AGY_HUD_CONFIG`
- `AGY_HUD_GIT_BRANCH`,用于显式覆盖 git 分支显示
- 打包脚本旁边或插件根目录下的 `config.json`
- `$XDG_CONFIG_HOME/agy-hud/config.json`
- `$HOME/.config/agy-hud/config.json`

默认配置:

```json
{
  "show_model": true,
  "show_progress_bar": true,
  "multiline": true,
  "color": true,
  "debug": false,
  "show_git_branch": true,
  "show_cwd": true,
  "show_agent_state": true,
  "show_icons": true,
  "context_value": "percent",
  "usage_value": "remaining"
}
```

`show_progress_bar` 和 `multiline` 默认为 `true`,对应推荐的紧凑两行 HUD。`debug` 默认为 `false`;正常使用时请保持关闭,以免污染状态栏输出。`AGY_HUD_GIT_BRANCH` 适用于 Antigravity 不提供分支、且 hook 进程无法从工作区解析出分支的环境。

显示选项:

- `show_agent_state`:显示来自标准输入的 `agent_state`,例如 `Idle`、`Thinking` 或 `Auth`。
- `show_icons`:显示 Nerd Font 图标。如果你的终端字体把图标渲染成方框,设为 `false` 可回退到纯文本。
- `context_value`:`percent`、`tokens` 或 `both`。默认为 `percent`,即上下文显示当前输入侧窗口占用率。存在 token 总量时,百分比和进度条会由 `total_input_tokens / context_window_size` 计算,避免最近一次长输出让 HUD 跳动。
- `usage_value`:`remaining` 或 `percent`。默认为 `remaining`,即配额文字和进度条都显示剩余量,例如 `Usage ███░░░░░ 40% left ↻ Reset 17:33`。

## 配额缓存

在 Antigravity CLI 1.0.8 及更新版本中,`agy-hud` 会优先读取 status-line payload 里的官方 `quota` 对象。旧版 CLI 或没有官方配额数据的 payload,会回退到本地配额缓存。默认缓存路径为:

```text
$HOME/.gemini/antigravity-cli/scratch/agy-hud/quota_cache.json
```

你可以用 `AGY_HUD_QUOTA_CACHE` 覆盖该路径。

Antigravity 运行时,可以手动刷新这份回退缓存:

```sh
agy-hud quota refresh
```

刷新命令兼容两种已知的 Antigravity 本地服务形态:旧版 `language_server --csrf_token ...` 进程,以及当前的 `agy` loopback 服务。如果存在 CSRF token,它只会被用于 loopback `GetUserStatus` 请求。命令最终只保存下面这种脱敏缓存。正常的 `statusline` 渲染会读取该缓存,并在缓存过期时后台刷新。如果缓存仍然看起来完全未消耗(所有模型都是 `100% left`),新的会话或 agent 状态变化也会触发一次带去抖的即时后台刷新。

期望的(已脱敏)缓存结构:

```json
{
  "timestamp": "2026-05-19T12:00:00Z",
  "plan_name": "Pro",
  "models": {
    "Gemini 3.5 Flash (Medium)": {
      "remainingFraction": 0.2,
      "resetTime": "2026-05-19T12:44:00Z"
    }
  }
}
```

如果配额数据缺失,HUD 会直接省略 usage 区块,不会显示伪造的 limit。重置时间来自本地 API 的 `resetTime` 字段,并以本地时钟时间显示,因为 status-line hook 无法在没有重绘的情况下更新已经渲染出的倒计时。

## 隐私与安全

`agy-hud statusline` 从标准输入以及本地可选的配置/缓存文件渲染。它不会向外部传输状态栏 payload 数据。后台配额刷新只会访问本地 Antigravity loopback 服务。

`agy-hud quota refresh` 只访问 loopback 上的本地 Antigravity 服务,不会打印 CSRF token、cookie 或原始 probe 响应。

渲染器刻意不打印敏感的状态栏字段,包括邮箱、session ID、会话 ID、transcript 路径、token、CSRF 值、cookie、密钥以及完整的工作区路径。git 分支检测直接读取 `.git/HEAD`,不会调用 `git`。

请勿在 issue 或 pull request 中放入原始 Antigravity probe 负载、日志、cookie、token、邮箱或本机路径。

## 开发

```sh
npm ci
npm run build
npm test
```

`npm run build` 会把 `src/main.ts` bundle 到 `dist/agy-hud.js`。源码变更时请一并提交更新后的 `dist/agy-hud.js`,确保 clone 后无需构建即可运行。

## 限制说明

配额字段依赖本地 Antigravity 的可用性以及一份兼容的本地缓存。如果 Antigravity 未运行,或本地 `GetUserStatus` 端点发生变化,HUD 会省略配额细节。
