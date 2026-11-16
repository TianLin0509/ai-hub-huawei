# CLI 帮助兼容夹具

两份文本为 2026-11-16 实际 CLI `--help` 的完整 stdout（UTF-8），在独立 artifacts 目录安装，未改本机全局版本。

- 2.1.50：`npm install --prefix artifacts/claude-2150 --ignore-scripts --no-audit --no-fund @anthropic-ai/claude-code@2.1.50`，运行包内 `cli.js --version/--help`；版本输出 `2.1.50 (Claude Code)`，帮助 7436 字符，两次退出码均 0。
- 2.1.269：`npm install --prefix artifacts/claude-2.1.269 --ignore-scripts --no-audit --no-fund @anthropic-ai/claude-code@2.1.269`，运行其 optionalDependency `@anthropic-ai/claude-code-win32-x64/claude.exe --version/--help`；版本输出 `2.1.269 (Claude Code)`，帮助 21393 字符，两次退出码均 0。

采集程序和 stdout/stderr 留在工作目录 artifacts/probe-claude-help.cjs、artifacts/claude-<版本>-help.txt 等文件中。帮助能力与启动命令已验证；未对这两个版本运行真实登录、模型请求或 TUI 交互。
