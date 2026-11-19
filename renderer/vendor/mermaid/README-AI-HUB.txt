mermaid 11.17.2（MIT，见 LICENSE），取自 npm 包 mermaid@11.17.2 的 dist/mermaid.min.js，未改动。
用途：会话卡片里 ```mermaid 代码块离线画图（renderer/card-media.js 按需加载，不走 CDN；在 renderer/card-mermaid-frame.html 沙箱框架里执行）。
升级：npm pack mermaid@<版本>，替换 mermaid.min.js 与 LICENSE，跑 tests/e2e-card-media-cdp.js。
第三方许可证：mermaid.min.js 打包了 d3、DOMPurify、dagre-d3-es、cytoscape、katex 等依赖，清单与许可证全文见 THIRD-PARTY-NOTICES.txt；升级时按新版 dependencies 一并更新。
