<p align="center"><img src="../../.github/assets/banner.png" alt="repotify：成千上万的代理技能，只挑适合你仓库的" width="100%"></p>

<h3 align="center">成千上万的代理技能，只挑适合你仓库的。</h3>

<p align="center">Repotify 读取开发者和 AI 公司在 GitHub 上发布的代理技能，按用途分类、检查风险，<br>并把最适合你项目的技能安装到 Claude Code、Cursor、Codex 或 Gemini CLI 中。</p>

<p align="center"><a href="../../README.md">English</a> · <a href="README.tr.md">Türkçe</a> · <b>简体中文</b></p>

## 开始使用

在项目文件夹中运行：

```bash
npx -y @repotify/repotify@latest
```

或者直接告诉你的代理：**"为这个项目配置 Repotify：https://github.com/repotify/repotify"**

<p align="center"><img src="../../.github/assets/demo.svg" alt="终端中的 Repotify：读取项目，为每项工作推荐一个条目，排除 react-native-skills，然后安装所选条目" width="100%"></p>

## 工作原理

1. **读取。** 只查看清单文件和文件名。你的代码不会被读取，也不会被发送到任何地方。
2. **询问。** 最多三个简短问题，而且只问项目本身无法回答的内容。
3. **挑选。** 每项工作挑一个最好的技能、MCP 服务器或工具。目录中的每个条目都通过了安全扫描，每个技能都经过三个 AI 模型的评审。
4. **安装。** 每个技能来自固定的提交，校验哈希，并在你的电脑上再次扫描。钩子和 MCP 服务器在你开启之前保持关闭。

## 为什么选择 Repotify

- **适合你的项目。** 依赖中有 Excel，就只带来表格技能，而不是 Word 和 PowerPoint。移动应用不会收到仅限 Web 的技能。
- **可疑内容进不来。** 每个技能都按 shell 和 curl 的方式解读，隐藏下载、窃取凭据和提示注入等已知手法都会被发现。
- **不臃肿。** 每项工作一个条目，控制在上下文预算内，代理保持快速。

## 清理已安装的技能

`repotify audit` 检查项目中已有的技能，告诉你哪些该保留、哪些该删除，并给出理由。它不会删除任何东西。

<p align="center"><img src="../../.github/assets/audit.svg" alt="repotify audit：保留对项目有用的技能，建议删除其他技术栈或重复的技能，并标记未通过安全扫描的技能" width="100%"></p>

## 命令

| 命令 | 作用 |
|---|---|
| `repotify` | 读取项目并为你的代理安装 repotify 技能 |
| `repotify recommend` | 显示这个项目的推荐 |
| `repotify install <id…> --yes` | 安装你选择的技能 |
| `repotify enable <id>` | 在展示改动后开启钩子或 MCP 服务器 |
| `repotify audit` | 评估已安装的技能 |
| `repotify suggest` | 把你自己的技能推荐到目录 |

支持 **Claude Code**、**Cursor**、**Codex**、**Gemini CLI** 以及任何读取 `.agents/skills` 的代理。全部命令、安全模型和隐私说明：[docs/GUIDE.md](../GUIDE.md)（英文）。

## 路线图

- [x] 审计已安装的技能、基于证据的推荐、支持 Linux、macOS 和 Windows
- [ ] 由全天候运行的 AI 研究实验室发现的 1,000+ 个经过审查的技能、MCP 服务器和工具
- [ ] 根据开发者保留和移除的内容不断优化排名
- [ ] MCP 模式：你的代理把 Repotify 当作工具调用

## 参与贡献

写了很棒的技能？在它的仓库里运行 `repotify suggest`。发现 bug 或误报？[提交 issue](https://github.com/repotify/repotify/issues)。想写代码？从 [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) 开始。

---

<p align="center">⭐ 如果 Repotify 帮到了你的代理，点个星能让更多开发者找到它。<br><sub>MIT 许可证 · <a href="https://repotify.github.io/repotify/zh-CN/">网站</a> · <a href="https://www.npmjs.com/package/@repotify/repotify">npm</a> · <a href="../../CHANGELOG.md">更新日志</a> · <a href="../../.github/SECURITY.md">安全</a></sub></p>
