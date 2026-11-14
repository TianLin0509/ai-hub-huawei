# ASAR 差量更新

完整更新包仍使用 schema 1，始终包含完整 app.asar。差量包沿用 latest.json 的 incrementalDelta 和原有文件名，镜像上传方式不变，不新增依赖。

schema 3 保存新版 ASAR 的原始 header、变化文件的字节，以及未变化文件在旧 ASAR 中的位置。客户端在暂存目录重建，既校验补丁内的目标 SHA256，也校验 latest.json 中 resultAsar 的大小和 SHA256；通过后才生成现有替换计划。原有替换、备份、回滚及用户数据路径不变。

## 兼容与回退

- 发布清单的 requires 包含旧 app.asar 的 SHA256，以及随首个支持版安装的 app.asar.unpacked/core/app-update/asar-delta-capability.json。旧客户端没有该文件，自动选择完整包。
- 首个支持版的用户升级仍下载完整包；从已安装支持模块的版本起，后续升级才使用新差量包。不会要求用户逐版升级。
- 客户端同时核对 baseVersion。跨版、旧程序被修改或能力文件缺失时直接下载完整更新包。
- 差量下载失败、补丁损坏、重建校验失败、下载期间基线被修改，都会在同一次操作里自动下载完整更新包。完整包失败时保留原有错误与重试入口，不循环回差量。

## 发布基线

prepare-release.js 从现有更新源读取上一版 latest.json，再获取其中 incremental 指向的完整更新包；先校验包大小、SHA256，再校验 ASAR 与 filesIndex 的 SHA256。基线不可用时保留原有 schema 2 方式，并输出原因。

离线发布可同时提供 AI_HUB_PREVIOUS_INDEX（上一版 latest.json）和 AI_HUB_PREVIOUS_PACKAGE（上一版完整 update.gz）。只提供索引时仍可生成旧式差量，不能凭源码重打的 ASAR 假定与发布包一致。

## 验证

定向回归：node --test tests/unit-asar-delta.test.js

隔离便携升级：tests/e2e-asar-delta-cdp.js，参数与跟发验收一致，另用 ACCEPT_MODE=delta|tamper|legacy。delta/tamper 用 ACCEPT_BASE_RESOURCES 指向装入待测更新模块的基线副本；legacy 使用原发布 ZIP。tamper 会改补丁内一字节并重新计算传输摘要，用于验证重建校验失败后的自动完整包回退。脚本记录实际请求、重启前后 SHA256、版本与数据保留情况。
