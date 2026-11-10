# 公司版独立会议室页面

2026-11-02：会议室从助理设置中独立到左侧栏，按秘书终结者组织为总览、抢订计划、会后动作、历史记录、运行日志、设置。助理里的旧快捷入口继续跳转到同一页面。

## 实现边界

- `renderer/company-rooms-page.js` 管理六页、未保存草稿与状态轮询；`company-rooms.css` 沿用 Hub 界面并对齐原 exe 的信息布局。
- 页面只在现有公司版 gate 内建立，不依赖用户先开启助理简报。
- 主进程复用 `RoomBooking`：旧 IPC 保留，增加完整状态、受限目录打开与旧组件重连。新的一次抢订、测试消息和删除待办限用户页面调用。
- `room-component/hub_control.py` 是完整控制接口的可审阅源码。签名 2.1.2 包保留原 2.1.1 adapter 为 base，所有配置写入仍由秘书 GUI 线程负责。原抢订、登录、校时和会后动作引擎不变。
- 原 2.1.0 exe / 签名基线不变。`scripts/build-room-control.py --base <官方2.1.1代码包> --key <发布签名私钥>` 离线重建控制包，不执行公网发布；输入由维护者提供，私钥不进仓库。普通应用构建直接使用已签名的2.1.2包。
- 更新旧 helper 前，检查没有任务/登录/读取正在进行，并核对 PID 对应的可执行文件路径等于经签名验证的 Hub 缓存路径。拒绝降级，不终止外部秘书进程。
- 空计划允许保存高级设置；启动前须有会议室。设置用显式保存，切页不丢草稿。组件自身开机启动、软件更新、分享不再另设一套。

## 验证入口

```powershell
node --test tests/unit-company-rooms-page.test.js
# 使用具备 PyQt5 的秘书开发环境，测试直接导入签名 zip。
python tests/room-control-adapter-test.py
$env:MSZ_SOURCE = '<秘书终结者源码目录>'
node tests/e2e-company-rooms-page-cdp.js
$env:ROOM_UPGRADE_BASE_BUNDLE = '<官方2.1.1签名组件目录，含baseline/control/代码包>'
node tests/e2e-company-rooms-upgrade.js
```

E2E 使用独立临时数据、后台 Hub、原 exe 和本地模拟会议室网页。可设置 `ROOM_UI_ENTRY` 指向公司导出物、`ROOM_UI_OUT` 指定证据目录；公司导出物不使用强制开启 gate 的测试开关。测试结束核对己方 PID 与 exe 路径后清理己方进程。

覆盖首次无房间配置、编辑排序与读取加入、草稿保持、原引擎测试不提交、一次抢订、守护启停、历史日志、窄高度滚动、导航/阅读模式，以及真实旧 helper 升级的数据保留。内网真实登录、实际会议室竞争、实际 WeLink 通知和自动释放不在本地模拟验证范围。
