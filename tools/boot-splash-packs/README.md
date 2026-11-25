# 开场动画资源包发布源文件

这里放线上「开场动画」可下载套装的包和目录，客户端只从公司内源下载（目录读随包快照 core/boot-splash-catalog-snapshot.json，内源版本名 `boot-splash-<包版本>`）；服务器只作内源同步的中转，不对用户发布。本目录不进安装包。

- 2026-11-22 首版 1.0.0：Claude / Codex / DeepSeek 各 20 套（1–10 号明亮笑容配「柔光登场」，11–20 号沉静坚毅配「冲击登场」）+ Hub 群星 5 款。
  随包内置 4 套（群星·星座、三家的 18 号「掌心魔法阵」）放在 renderer/assets/boot-splash/，其余 61 套在这里。
  全部 65 套的缩略图与名称随包带在 renderer/assets/boot-splash/thumbs/ 与 index.json，不联网也能浏览，点「下载并使用」才取大图。
- 图片均由 Codex 订阅生图原创，不含第三方素材。
- `catalog.json`：顶层 version 必须随任一包升级而升高；`<id>-<version>.json`：schema 1，image 为 1280×720 webp data URL。
- 上传顺序：先传包、核对哈希，最后换 catalog.json。阿里云 me. 的 /hub-update/boot-splash/ 改完后 dl. 约 5 分钟内自动同步；公司内源由组件同步（openx_sync.py --only boot-splash）按包版本建 boot-splash-<版本>。
- 发布前跑 `node --test tests/unit-boot-splash.test.js`（字节数、哈希、格式）。
- 2026-11-24 3.0.0：目录改名 `catalog-v3.json`（新角色 gemini，旧版本会整份拒收 v3，`catalog-v2.json` 原样保留）。视频包全部改 lite（<5 MB，1080p H.264，两遍编码把码率给实际播放的几秒）：codex-orig、deepseek-dive 升 3.0.0，新增 gemini-orig（wynneceles 原作，只重新编码不剪不改）与 claude/codex/deepseek-draw（Hub 自制「召唤师抽卡」）。claude-orig lite 随包内置在 renderer/assets/boot-splash/claude-orig.mp4 并作默认开场，不再在目录里。
