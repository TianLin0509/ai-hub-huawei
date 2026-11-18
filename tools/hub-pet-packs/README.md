# 下载形象包（桌宠）发布源文件

这里放的是线上「下载形象」的包和目录，客户端从 core/hub-pet/role-packs.js 的 SOURCES 下载。本目录不进安装包。

- `catalog.json`：顶层 version 必须随任一包升级而升高（客户端在多源里取顶层版本最高的目录）。
- `<id>-<version>.json`：形象包。旧版本文件在服务器上保留不删，客户端只按 catalog 里列的版本下载。
- 1.1.0（2026-11-17）：兔子、柴犬、仓鼠、玄凤补了打字 5 帧、待机 5 段小动作（各 5 帧），开心/睡觉重画高清，每帧 400 像素。
- 1.2.0（2026-11-18）：新增拟人形象鲸鱼娘（19-whale-maid）、Claude 娘（21-claude-girl）、GPT 娘（23-gpt-girl），目录顶层升到 1.2.0，原 4 个形象不变。
  三个包的 meta.credit 带作者、协议、作者原话、改动说明与 CC BY-NC-SA 4.0 协议全文，设置页卡片上「形象来源与授权」可看；目录条目的 credit 是一句话署名，没下载时显示。
  这三个形象不可商用，公开渠道分发时须保留署名；鲸鱼娘另须附 https://github.com/PC2005-cloud/dsh-pet 。
- 发布前跑 `node --test tests/unit-hub-pet-role-packs-v110.test.js tests/unit-hub-pet-role-packs-r49b.test.js`（字节数、哈希、帧规格、署名）。
- 上传顺序：先传包、核对哈希，最后换 catalog.json。阿里云 me. 改完后 dl. 约 5 分钟内自动同步，公司内源由组件同步按包版本补建（pet-role-<版本>）；公开版另传公开版仓库的 hub-pet-v1 release。
