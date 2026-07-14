# agy-hud: Antigravity CLI 状态栏 HUD 插件

[English](README.md) | **简体中文**

`agy-hud` 是一个用 TypeScript 编写、运行在 Node.js 上的紧凑型 Antigravity CLI 状态栏 HUD 插件。

它从标准输入读取 Antigravity 状态栏 JSON,并渲染出一到两行简短的终端 HUD:

<img src="docs/hud-preview.png" alt="agy-hud 状态栏 HUD 预览" width="700">

## 运行要求

- Antigravity CLI 1.1.0 或更高版本。状态栏通过 CLI 原生的 `/statusline` 命令接入,0.1.8 依赖它:旧版 `plugin.json` 声明的 `components` hook 在 1.1.x 下已不被识别,因此已被移除。如果你的 CLI 是尚无 `/statusline` 的 1.0.x,则无法激活这个版本——请留在 0.1.7,或升级 CLI。
- `PATH` 中可用的 Node.js 18+
- macOS 或 Linux。目前暂不支持 Windows,因为插件 hook/install 流程尚未在 Windows 上验证。

`agy-hud` 以 Antigravity 插件归档包分发,不是 npm 包。归档包内已包含打包后的运行脚本 `dist/agy-hud.js`,所以插件用户不需要运行 `npm install`。

## 从 GitHub Release 安装

从[最新 release](https://github.com/franksde/agy-hud/releases/latest)下载平台无关归档包:

```sh
curl -fsSL -o agy-hud.tar.gz \
  https://github.com/franksde/agy-hud/releases/latest/download/agy-hud.tar.gz
tar -xzf agy-hud.tar.gz
agy plugin install ./agy-hud
```

解压出的目录就是一个完整的插件(包含 `plugin.json`、`hooks/`、`dist/`),可以直接传给 `agy plugin install`。它需要 Node.js 18+,解压后不需要再运行 `npm install`。

**重要：安装完成后，请在你的 Antigravity CLI 交互式命令行内运行以下命令来启用状态栏：**
```
/statusline ~/.gemini/config/plugins/agy-hud/hooks/status-line.sh
```

## 从本地路径安装

不要把 git clone 出来的仓库目录直接传给 `agy plugin install`。该命令会拷贝**整个**目录,于是 `.git/`、`src/`、`test/` 之类全都会被塞进插件目录;而且如果这个 clone 启用了 git fsmonitor,拷贝会直接失败在 `.git/fsmonitor--daemon.ipc` 上——那是一个 socket,不是普通文件。

正确做法是先按 release 归档的文件清单构造一个干净目录,再安装它:

```sh
npm ci && npm run build && npm test

stage=$(mktemp -d)/agy-hud
mkdir -p "$stage/hooks" "$stage/dist" "$stage/docs"
cp plugin.json config.example.json README.md README.zh-CN.md LICENSE SECURITY.md CONTRIBUTING.md CHANGELOG.md "$stage/"
cp hooks/status-line.sh "$stage/hooks/"
cp dist/agy-hud.js "$stage/dist/"
cp docs/hud-preview.png "$stage/docs/"

agy plugin validate "$stage"
agy plugin install "$stage"
```

本地安装和 release 安装会落到同一个插件目录,所以上面那条 `/statusline` 命令在这里同样需要执行。

## 升级

**装上新版本 ≠ 升级完成。** CLI 的 `statusLine.command` 指向的是某一个具体文件,而 `agy plugin install` 并不会去更新它。如果你的 command 仍然指向旧的那份 `dist/agy-hud.js`,那么跑的就还是旧版本:HUD 一切正常、没有任何报错,你只是没升级而已。

先确认你实际在跑哪一份:

```sh
grep -A2 '"statusLine"' ~/.gemini/antigravity-cli/settings.json
```

command 只会是下面两种形态之一。无论哪种,**插件根目录都是路径里的那个 `agy-hud` 目录**——不是 command 里写的 `hooks` 目录,也不是 `dist`:

```text
/Users/you/.gemini/config/plugins/agy-hud/hooks/status-line.sh
                                   ^^^^^^^ 插件根目录

node /Users/you/.gemini/config/plugins/agy-hud/dist/agy-hud.js statusline
                                       ^^^^^^^ 插件根目录
```

确认这个根目录当前是什么版本:

```sh
node <插件根目录>/dist/agy-hud.js version
```

**如果你的 HUD 现在是正常的**,最省事的升级就是覆盖这个根目录里的 bundle。接线一个字都不用改,也不需要执行任何 slash command:

```sh
curl -fsSL -o agy-hud.tar.gz \
  https://github.com/franksde/agy-hud/releases/latest/download/agy-hud.tar.gz
tar -xzf agy-hud.tar.gz
cp agy-hud/dist/agy-hud.js <插件根目录>/dist/agy-hud.js
node <插件根目录>/dist/agy-hud.js version   # 确认已经报告新版本号
```

**如果你的 HUD 在把 Antigravity CLI 升到 1.1.x 之后就消失了**,说明你之前依赖的是旧的 `components` hook,而新版 CLI 不再注册它。按上面的安装步骤装好新版,并用 `/statusline` 接一次线即可。这一步无法省略:插件没有任何 install hook 能替你写入状态栏配置——`components` 原本就是那个机制,而它已经没了。

配额缓存在两种情况下都无需任何操作,见[配额缓存](#配额缓存)。

## 面向 AI Agent

如果你是正在替用户安装 `agy-hud` 的 AI agent,请不要静默安装。先确认显示效果。

**先判断用户是不是已经装过**:读 `~/.gemini/antigravity-cli/settings.json` 里的 `statusLine.command`。如果它已经指向某个 `agy-hud.js`,那这就是一次**升级**而不是安装:请按[升级](#升级)一节,直接覆盖那个文件。不要只是 `agy plugin install` 到新的插件目录就收工——那样 CLI 跑的仍是旧文件,HUD 看起来完全正常,用户永远不会发现自己还停在旧版本。

如果确认是全新安装:

1. 把下面这段信息完整的 HUD 预览发给用户,让他们在安装之前就看到每一个元素:

   ```
    3.5 Flash High |  Pro │  agy-hud │  main
   Context ░░░░░░░░░░ 0% │ Usage ████████░░ 82% (↻ 1h 52m) |  █░░░░░░░░░ 13% (↻ 4d 21h)
   ```

   向用户说明各部分的含义:模型与套餐档位、工作目录、git 分支、带 token 明细的上下文进度条(`context_value: both`)、连续的配额剩余进度条、本地重置时间,以及 agent 状态。默认配置使用更紧凑的 `percent` 上下文显示。图标需要 Nerd Font —— 没有时会显示成方框 —— HUD 在窄终端下也会平滑降级。

2. 请用户确认效果,或询问是否需要调整 `multiline`、`show_icons`、`context_value` 或 `usage_value`(见[配置](#配置))。

3. 用户确认后,下载 `https://github.com/franksde/agy-hud/releases/latest/download/agy-hud.tar.gz` 并解压。

4. 执行 `agy plugin install <解压目录>`。传入的必须是解压出来的归档目录,绝不能是 git clone 的仓库目录(原因见[从本地路径安装](#从本地路径安装))。安装成功后,请提示用户在 CLI 中运行 `/statusline ~/.gemini/config/plugins/agy-hud/hooks/status-line.sh` 来启用状态栏——在此之前 HUD 不会出现。如果失败,把错误展示给用户,不要静默重试。

## Release 归档内容

GitHub release 会发布一个平台无关归档包:

- `agy-hud.tar.gz`

归档包应包含 `plugin.json`、`hooks/status-line.sh`、`dist/agy-hud.js`、`config.example.json`、`README.md`、`README.zh-CN.md`、`LICENSE` 以及相关文档。

## CLI

安装插件**不会**在你的 `PATH` 上放一个 `agy-hud` 命令——归档包分发的是 bundle,不是 npm 包。请用 `node` 直接运行 bundle,路径取你的 `statusLine.command` 所指向的插件根目录(新版安装通常是 `~/.gemini/config/plugins/agy-hud`):

```sh
node <插件根目录>/dist/agy-hud.js statusline < statusline_payload.json
node <插件根目录>/dist/agy-hud.js version
node <插件根目录>/dist/agy-hud.js quota refresh
```

下文为了简洁,用 `agy-hud` 指代上面这条命令。如果你经常用,可以自己配一个 alias。

`statusline` 从标准输入以及本地配置/缓存文件渲染。当 `agent_state` 从 active work 回到 `idle` 时,它会先做一次本地 loopback `quota refresh` 再渲染,让同一次 redraw 就能反映本轮回答后的配额。缺失或过期缓存仍会用后台刷新作为兜底。`quota refresh` 会向正在运行的 Antigravity 本地服务请求 `GetUserStatus`,写入脱敏后的配额缓存;如果找不到可用的本地服务,会以非零状态退出。

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
当 workspace 路径可用时,git 分支显示会优先从当前 workspace/worktree 解析,再回退到 Antigravity 的 VCS branch payload。

显示选项:

- `show_agent_state`:显示来自标准输入的 `agent_state`,例如 `Idle`、`Thinking` 或 `Auth`。
- `show_icons`:显示 Nerd Font 图标。如果你的终端字体把图标渲染成方框,设为 `false` 可回退到纯文本。
- `context_value`:`percent`、`tokens` 或 `both`。默认为 `percent`,即上下文显示当前输入侧窗口占用率。存在 token 总量时,百分比和进度条会由 `total_input_tokens / context_window_size` 计算,避免最近一次长输出让 HUD 跳动。
- `usage_value`:`remaining` 或 `percent`。默认为 `remaining`,即配额文字和进度条都显示剩余量。当 Antigravity 提供 5 小时和周两个窗口时,HUD 会按顺序分开显示各自的刷新倒计时,例如 `Usage ████████░░ 82% (↻ 1h 52m) |  █░░░░░░░░░ 13% (↻ 4d 21h)`。

## 配额缓存

在 Antigravity CLI 1.0.8 及更新版本中,`agy-hud` 会优先读取 status-line payload 里的官方 `quota` 对象。如果 payload 同时包含 5 小时和周两个窗口,HUD 会按顺序分别显示,不再折叠成一个容易误解的数字。如果这个官方 bucket 仍然看起来完全未消耗,但新鲜的 active-model 缓存已经显示有消耗,`agy-hud` 会使用新鲜缓存,避免显示过期的 `100% left`。旧版 CLI 或没有官方配额数据的 payload,会回退到本地配额缓存。默认缓存路径为:

```text
$XDG_CACHE_HOME/agy-hud/quota_cache.json
$HOME/.cache/agy-hud/quota_cache.json   # 未设置 XDG_CACHE_HOME 时
```

你可以用 `AGY_HUD_QUOTA_CACHE` 覆盖该路径,覆盖后读写都只使用这一个路径。

0.1.8 之前,缓存位于 `$HOME/.gemini/antigravity-cli/scratch/agy-hud/quota_cache.json`,而那个目录在
Antigravity CLI 1.1.0 之后已被官方弃用。升级无需任何操作:新缓存还不存在时,HUD 仍会读取旧文件,
第一次刷新就会写出新缓存。旧文件会原样保留,所以降级回旧版本同样可以正常工作。

如果新缓存存在但解析不出来(比如一次写入被崩溃打断),HUD 会改用旧缓存渲染,并强制触发一次刷新去
重写这个损坏的文件,而不是让它一直被掩盖着。

Antigravity 运行时,可以手动刷新这份回退缓存:

```sh
node <插件根目录>/dist/agy-hud.js quota refresh
```

刷新命令兼容两种已知的 Antigravity 本地服务形态:当前的 `agy` loopback 服务,以及旧版 `language_server --csrf_token ...` 进程,按这个顺序尝试。如果存在 CSRF token,它只会被用于 loopback `GetUserStatus` 请求。命令最终只保存下面这种脱敏缓存。正常的 `statusline` 渲染会读取该缓存,并在 active work 结束时刷新;同时保留过期缓存刷新作为兜底。如果缓存仍然看起来完全未消耗(所有模型都是 `100% left`),新的会话或 agent 状态变化也会触发一次带去抖的即时后台刷新。

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

如果配额数据缺失,HUD 会直接省略 usage 区块,不会显示伪造的 limit。官方 quota payload 可以提供实时的 `reset_in_seconds`,所以双窗口配额会显示每个窗口自己的相对刷新倒计时。本地 fallback cache 仍然来自本地 API 的 `resetTime` 字段,并以本地时钟时间显示。

## 隐私与安全

`agy-hud statusline` 从标准输入以及本地可选的配置/缓存文件渲染。它不会向外部传输状态栏 payload 数据。配额刷新只会访问本地 Antigravity loopback 服务。

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
