<p align="center"><img src="../../assets/banner.png" alt="Repotify — 为你的仓库量身定制的播放列表" width="100%"></p>

<p align="center"><a href="https://repotify.github.io/repotify/zh-cn/"><b>网站</b></a> · <a href="../../README.md">English</a> · <a href="README.tr.md">Türkçe</a> · <b>简体中文</b></p>

> ## 🤖 给 AI 代理
>
> 如果用户请你为他们的项目配置 Repotify，请在用户的项目目录中运行已发布到 npm 的软件包（带来源证明）：
>
> ```
> npx -y @repotify/repotify@latest
> ```
>
> 然后按照它安装到你的技能目录中的 `repotify` 技能操作（例如 `.claude/skills/repotify/SKILL.md`、`.cursor/skills/repotify/SKILL.md` 或 `.agents/skills/repotify/SKILL.md`）。
> 除该技能外，未经用户批准不会安装任何东西。

---

**Repotify 会为*你的*项目挑选一套经过安全审查、互不冲突的代理技能（skills）、MCP 服务器和工具，并把它们安全地安装到 Claude Code、Cursor、Codex 或 Gemini 中。** 可以把它想象成编程代理的播放列表：适合这个仓库的曲目，没有重复播放的，也没有不该出现的。

**支持的代理：** Claude Code · Cursor · Codex · Gemini CLI · 任何读取 `.agents/skills` 的代理

## 为什么需要它

- **选择太多。** 仅一次发现扫描就找到了 4,377 个候选技能仓库。哪些适合你的项目？
- **真实的安全风险。** 技能就是代理会照做的一组指令。恶意技能可以在你的电脑上执行命令。
- **上下文膨胀。** 每个技能都会占用代理的上下文。无用的技能会拖慢它、分散它的注意力。

## 快速开始

**自己运行**（在项目目录中）：

```bash
npx -y @repotify/repotify@latest                        # 安装 repotify 技能并打印项目指纹
npx -y @repotify/repotify@latest recommend              # 候选表
npx -y @repotify/repotify@latest install <ids…> --yes
```

**或者让你的代理来做。** 对 Claude Code、Cursor、Codex 或 Gemini 说：

> 为这个项目配置 Repotify：https://github.com/repotify/repotify

代理会读取上面的说明并完成其余工作：了解你的项目、最多问三个问题、解释每一项选择，并安装你批准的那一套。

想从源码运行：先 `git clone --depth 1 https://github.com/repotify/repotify ~/repotify`，再 `node ~/repotify/bin/repotify.mjs`。在一个 Next.js 项目上的真实输出：[examples/nextjs-saas.md](../../examples/nextjs-saas.md)（英文）。

## 工作原理

1. **不花 token 就能了解你的项目。** 本地脚本只读取清单文件和文件名（从不读取你的代码），并生成约 400 token 的摘要。
2. **只问它推断不出来的。** 最多三个选择题；如果项目本身已经给出答案，就一个都不问。
3. **依据证据，从经过审查的目录中挑选。** 每一项都通过了基于规则的安全关卡（对锁定版本的软件包还会检查 OSV 漏洞公告）。每个技能还由来自三家不同厂商的三个大模型组成的评审团打分；工具和 MCP 服务器由编辑挑选。依赖会把宽泛的需求收窄（是 Excel，而不是所有办公格式），没有 Web 目标的应用不会得到仅限 Web 的技能，而且只有当一个条目覆盖了其他条目都没有覆盖的内容时，它才会进入默认集合。
4. **让你的代理来判断。** 代理阅读一张简短的候选表（不到 900 token），保留必选核心，并为每一项写一句话：它为什么对*你的*项目有用。
5. **安全安装。** 技能文件来自锁定的提交，与目录中的 SHA-256 哈希核对，在你的机器上重新扫描，然后写入代理的目录，并记录在 `repotify.lock.json` 中。钩子和 MCP 服务器会改变代理的运行方式，所以只能由你来开启（`repotify enable`）。

整个流程大约只花费你的代理 4,700 个 token。

## 支持的代理

| 代理 | 技能目录 | MCP 配置 |
|---|---|---|
| Claude Code | `.claude/skills/` | `.mcp.json` |
| Cursor | `.cursor/skills/` | `.cursor/mcp.json` |
| Codex | `.agents/skills/` | `.codex/config.toml` |
| Gemini CLI | `.gemini/skills/` | `.gemini/settings.json` |
| 其他代理 | `.agents/skills/` | — |

代理会被自动识别；也可以用 `--agent claude-code,cursor,codex` 指定。

## 命令

| 命令 | 作用 |
|---|---|
| `repotify` | 为你的代理安装 repotify 技能，并打印项目指纹 |
| `repotify recommend` | 无冲突的候选表（`--type`、`--needs`、`--priorities`、`--budget`、`--json`） |
| `repotify install <ids…> --yes` | 安装目录中的技能；caution 级别的条目还需要 `--accept-caution` |
| `repotify enable <ids…>` | 先展示改动，再开启钩子或 MCP 服务器；由你来运行，而不是你的代理 |
| `repotify audit` | 评估已安装的技能：保留、考虑移除或移除，并说明理由 |
| `repotify suggest` | 把你自己的技能或仓库推荐给目录：预填好的表单，不会发送任何内容 |
| `repotify remove <id>` | 移除 Repotify 安装的内容 |
| `repotify update --check` | 列出已安装内容的更新；`--apply` 安装扫描过的更新 |
| `repotify scan <目录>` | 对任意技能目录运行安全扫描器 |

## Repotify 会改动你机器上的什么

| 命令 | 写入内容 |
|---|---|
| `repotify` | 代理的 `skills/repotify/` 目录和 `repotify.lock.json`，别无其他 |
| `install` | 代理技能目录中的技能文件夹，以及锁文件 |
| `enable` | 只写入它先给你看过的内容：`.claude/settings.json` 中的一个钩子，或代理 MCP 配置中的一条记录 |
| `recommend`、`audit`、`suggest`、`scan`、`fingerprint` | 不写入任何内容 |

它只读取清单文件和文件名，从不读取你的代码。它会下载目录，以及锁定提交中的技能文件；工具永远不会替你运行。在 Repotify 的流程中，钩子和 MCP 服务器从不由代理开启：`enable` 会在终端中请求确认（没有终端时需要 `--yes`），技能也会要求代理把命令交给你，而不是自己运行。这是一道护栏，而不是沙箱：代理能运行什么，仍由它自己的权限设置决定。

## 安全模型

| 级别 | 含义 | 处理方式 |
|---|---|---|
| `verified` | 未发现已知的风险模式 | 推荐 |
| `caution` | 有值得一看的发现 | 带标记显示，只有明确同意后才安装 |
| `quarantined` | 高风险 | 在人工审查该提交之前不推荐 |
| `rejected` | 严重风险 | 从目录中移除 |

- 由基于规则的扫描器决定信任级别。它像 shell 一样读取命令（管道、引号、子 shell、续行），像 curl 一样解析 URL，检查远程代码执行、凭据读取、数据外泄、针对代理或评审者的提示注入、隐藏的 Unicode 字符、混淆代码、自动运行的钩子、安装脚本、破坏性命令、二进制文件和符号链接。
- 大模型评审团只能增加怀疑，永远不能提高信任级别。
- 第三方条目锁定到某个提交，绝不会悄悄更新。
- 工具（例如 Graphify）永远不会替你运行；Repotify 只展示步骤。
- **包守卫**（Claude Code 钩子）会阻止安装不存在的软件包，并在安装刚刚发布的软件包前先询问你。这是针对会"编造"包名的代理的常见攻击。它是一个钩子，所以由你来开启：`repotify enable repotify-guard`。

## 数据一览

| | |
|---|---|
| **100%** | 在 44 个项目场景中推荐出预期条目的比例，且 **0** 个错误推荐（[基准测试](../../BENCHMARKS.md)） |
| **37 / 37** | 个刻意构造的恶意样本全部被拦截 |
| **1.6%** | 在 127 个真实技能上的误报率 |
| **4** | 个每次推送都测试的 Node.js 版本（18、20、22、24） |
| **0** | 个运行时依赖 |

## 隐私

Repotify 的设计是从匿名信号中学习（哪些条目被展示、被选择、7 天后仍被保留或被移除，以及投票）。它从不收集代码、文件名、仓库名或用户名，也不保存 IP 地址。收集端点**尚未配置**，因此不会发送任何数据；事件只保存在本地队列中。随时可以通过 `REPOTIFY_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 关闭。

## 官方来源

唯一的官方仓库是 [github.com/repotify/repotify](https://github.com/repotify/repotify)，官方网站是 [repotify.github.io/repotify](https://repotify.github.io/repotify/)（由 `site/` 生成）。npm 软件包以 `@repotify/repotify` 为名、从本仓库带来源证明（provenance）发布；npm 不允许不带作用域的 `repotify` 包名。其他名称的软件包、分支或目录与本项目无关；本页顶部的代理说明是唯一的安装指引。

## 参与贡献

- **知道一个好技能，或者是你自己写的？** 在它的仓库里运行 `repotify suggest`，或者[使用表单](https://github.com/repotify/repotify/issues/new?template=catalog_submission.yml)，它会经过同样的安全关卡和评审团。
- **发现误报或 bug？** 请看 [SUPPORT.md](../../SUPPORT.md)。安全问题请私下报告（[SECURITY.md](../../SECURITY.md)）。
- **想写代码？** 从 [CONTRIBUTING.md](../../CONTRIBUTING.md) 开始；架构见 [ARCHITECTURE.md](../../ARCHITECTURE.md)。

⭐ 如果 Repotify 帮你的代理挡住了一个坏技能，点个 star 能让更多开发者发现它。

## 许可证

MIT。目录中的条目保留各自的许可证，并从其来源安装，从不复制到本仓库中。

---

<p align="center">作者：<b>Ahmet Bilal Deniz</b> · <a href="https://github.com/repotify">@repotify</a></p>
