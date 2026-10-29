# AI 圆桌 lite 网页脚本（原样拷贝，勿手改）

- 来源：`C:\Work\20260909-ai-yuanzhuo-lite\src\adapters.js`、`src\content.js`
- 版本：lite main `09addf1`（v0.8.0），2026-10-28 拷入
- 用途：Hub「AI 网页」自动提问、读回答（`main/web-page-agent.js`）。在 Electron 隔离世界里运行，
  `chrome.runtime` 由 Hub 的垫片提供，行为与 lite 在 Chrome 插件里一致。
- 更新：lite 修了网站适配后，重新拷贝这两个文件并改上面的版本行，跑 `node scripts/run_unit_tests.js`。
  Hub 自己需要的改动不写进这两个文件，放到 `main/web-page-agent.js`。
- 2026-10-28 用户拍板：lite 继续独立维护（面向不用 Hub 的用户），Hub 相关新功能只做在 Hub。
