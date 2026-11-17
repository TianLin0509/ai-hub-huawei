# 下载形象包（桌宠）发布源文件

这里放的是线上「下载形象」的包和目录，客户端从 core/hub-pet/role-packs.js 的 SOURCES 下载。本目录不进安装包。

- `catalog.json`：顶层 version 必须随任一包升级而升高（客户端在多源里取顶层版本最高的目录）。
- `<id>-<version>.json`：形象包。旧版本文件在服务器上保留不删，客户端只按 catalog 里列的版本下载。
- 1.1.0（2026-11-17）：兔子、柴犬、仓鼠、玄凤补了打字 5 帧、待机 5 段小动作（各 5 帧），开心/睡觉重画高清，每帧 400 像素。
- 发布前跑 `node --test tests/unit-hub-pet-role-packs-v110.test.js`（字节数、哈希、帧规格）。
- 上传顺序：先传包、核对哈希，最后换 catalog.json。阿里云 me. 改完后 dl. 约 5 分钟内自动同步，公司内源由组件同步按包版本补建（pet-role-<版本>）；公开版另传公开版仓库的 hub-pet-v1 release。
