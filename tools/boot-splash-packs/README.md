# 开场动画资源包发布源文件

这里放线上「开场动画」可下载套装的包和目录，客户端从 core/boot-splash.js 的 SOURCES 下载（内源优先，内源版本名 `boot-splash-<包版本>`）。本目录不进安装包。

- 2026-11-22 首版 1.0.0：Claude / Codex / DeepSeek 各 20 套（1–10 号明亮笑容配「柔光登场」，11–20 号沉静坚毅配「冲击登场」）+ Hub 群星 5 款。
  随包内置 4 套（群星·星座、三家的 18 号「掌心魔法阵」）放在 renderer/assets/boot-splash/，其余 61 套在这里。
  全部 65 套的缩略图与名称随包带在 renderer/assets/boot-splash/thumbs/ 与 index.json，不联网也能浏览，点「下载并使用」才取大图。
- 图片均由 Codex 订阅生图原创，不含第三方素材。
- `catalog.json`：顶层 version 必须随任一包升级而升高；`<id>-<version>.json`：schema 1，image 为 1280×720 webp data URL。
- 上传顺序：先传包、核对哈希，最后换 catalog.json。阿里云 me. 的 /hub-update/boot-splash/ 改完后 dl. 约 5 分钟内自动同步；公司内源由组件同步（openx_sync.py --only boot-splash）按包版本建 boot-splash-<版本>。
- 发布前跑 `node --test tests/unit-boot-splash.test.js`（字节数、哈希、格式）。
