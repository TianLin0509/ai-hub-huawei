# 公司版独立会议室页面

2026-11-02：会议室从助理设置中独立到左侧栏，按秘书终结者组织为总览、抢订计划、会后动作、历史记录、运行日志、设置。助理里的旧快捷入口继续跳转到同一页面。

## 实现边界

- `renderer/company-rooms-page.js` 管理六页、未保存草稿与状态轮询；`company-rooms.css` 沿用 Hub 界面并对齐原 exe 的信息布局。
- 页面只在现有公司版 gate 内建立，不依赖用户先开启助理简报。
- 主进程复用 `RoomBooking`：旧 IPC 保留，增加完整状态、受限目录打开与旧组件重连。新的一次抢订、测试消息和删除待办限用户页面调用。
- `room-component/hub_control.py` 是完整控制接口的可审阅源码。签名 2.1.2 包保留原 2.1.1 adapter 为 base，所有配置写入仍由秘书 GUI 线程负责。原抢订、登录、校时和会后动作引擎不变。
- 原 2.1.0 exe / 签名基线不变。普通应用构建使用 `control.json` 指向的签名包；旁边的可读 Python 源码不会直接执行。
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

## 2026-11-16：读取漏行及满员误报修复（源码，待组件签名）

`room-component/engine.py`、`jobs.py` 从当前签名 2.1.3 包提取后维护：读取名单改为按真实容器可视高度重叠滚动，等内容稳定并到达底部才成功；超时或滚不动明确报读取未完成。原先一次无新增就结束的条件已移除。抢订保留逐房间 `taken/missing/nogrid` 原因，只有全部明确被占才报满员；保留 main 的 retry=True 刷新重试、占用文案兼容、状态文件占用重试和园区提前天数；优先顺序及正常成功提交不变。默认用户行为只在名单读取及识别失败提示上变化，正常抢订流程不变。

首次抢订找不到房间的现场原因尚未确认，失败日志仅增加 `[会议室诊断]`：请求日期/开始时间、表单日期、可识别的活动页签、名称匹配节点数及可见数；不收集整页 HTML、URL 或账号内容。列表原有的叶节点、格子宽度和至少 8 格规则保留，仍需公司网页验证，不声称覆盖所有页面改版。

2026-11-17 审查补修：名单也支持由整个网页滚动的布局，通过 `document.scrollingElement` 遍历；找不到滚动区域不再直接返回部分名单。列表容器被窗口或外层区域裁剪、或自身隐藏溢出时，明确提示“读取未完成”，请展开完整列表后重试，不修改网页样式来强行读取。正常完整容器与预约提交路径不变。这次补修已做本地 Edge 模拟回归，尚未部署到独立测试目录或正式签名组件。

```powershell
python tests/room-booking-engine-test.py
python tests/room-component-build-test.py
python tests/room-booking-browser-test.py --node <node.exe> --browser <msedge.exe>
# 在现有组件发布者的签名机器上执行，私钥只留在该机器：
python scripts/build-room-control.py --key <本机已有发布密钥路径> --version 2.1.4
python scripts/build-room-control.py --check
```

构建脚本核验仓库现有 2.1.3 基包的固定 SHA-256，再覆盖三个可读源码，保留其余模块；只生成新签名 ZIP 和清单，不发布。`--check` 验证签名、包大小/哈希和源码一致性。当前旧包会返回退出码 2、`pendingSources: [engine.py, jobs.py]`；新包签名后必须返回退出码 0、`ok: true`，再做原适配器/GUI 回归和公司「测试填表（不提交）」验收。Python 定向测试从旧包加载其他依赖，在测试进程中覆盖两个修复模块，不改变 Hub 的签名校验。
