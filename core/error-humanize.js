'use strict';
// 常见原始报错翻译成人话（5.5.24「不再莫名报错」）：错误卡的「原因」「步骤」没写时用这里补。
// 只认报错里明确出现的错误码 / 状态码，认不出就返回 null，调用方保持原样，不硬猜。
// 顺序有讲究：磁盘满、端口占用这类具体的排在「没权限」「网络」这类笼统的前面。

const RULES = [
  { kind: 'disk-full', test: /\bENOSPC\b|no space left on device|磁盘空间不足|磁盘已满/i,
    title: '磁盘空间不够了',
    cause: '要写文件的那个盘已经满了，程序写不进去。',
    steps: ['清理一下 C 盘或数据所在的盘（回收站、下载目录、临时文件）', '腾出至少 1 GB 后再试一次'] },
  { kind: 'port-in-use', test: /\bEADDRINUSE\b|address already in use|端口.{0,6}(?:被占用|已占用)/i,
    title: '端口被别的程序占用了',
    cause: '要用的本机端口已经被另一个程序（常见是上一次没退干净的同一个程序）占着。',
    steps: ['关掉重复打开的同类程序，或稍等半分钟让它自己退出', '还不行就重启一次 AI HUB'] },
  { kind: 'not-found', test: /\bENOENT\b|\bis not recognized as an internal or external command\b|command not found|找不到(?:指定的)?(?:文件|路径|程序)|系统找不到/i,
    title: '找不到需要的程序或文件',
    cause: '要运行的程序没装、装在了别的位置，或者要读的文件已经被移走或删掉。',
    steps: ['确认相关工具已经安装（安装后最好重启一次 AI HUB）', '如果是你自己指定过的路径，检查那个位置的文件还在不在'] },
  { kind: 'permission', test: /\bE(?:ACCES|PERM|BUSY)\b|permission denied|access is denied|operation not permitted|拒绝访问|没有权限|resource busy|being used by another process|另一个程序正在使用/i,
    title: '没有权限，或文件正被占用',
    cause: '这个文件或目录被系统保护、只读，或者正被另一个程序打开着。',
    steps: ['关掉可能正在用这个文件的程序（编辑器、资源管理器预览、杀毒扫描）后再试', '如果在受保护的目录（如 Program Files）里，换到自己的用户目录下操作'] },
  { kind: 'network', test: /\bE(?:TIMEDOUT|CONNRESET|CONNREFUSED|CONNABORTED|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH)\b|socket hang up|fetch failed|network\s*error|timed?\s*out|getaddrinfo|网络(?:错误|异常|不通)|连接超时|无法连接/i,
    title: '网络连不上',
    cause: '请求没能到达对方服务：网络断了、代理或公司网络拦截，或者对方服务暂时没响应。',
    steps: ['确认网络正常（能打开网页）', '用了代理或在公司网络里，检查代理设置或稍后再试', '持续出现的话点「一键反馈」，附上下面的技术详情'] },
  { kind: 'auth', test: /\b401\b|unauthori[sz]ed|authentication|登录(?:已)?(?:过期|失效)|未登录/i,
    title: '登录失效了',
    cause: '这个账号的登录已经过期或被注销。',
    steps: ['到「账号」页重新登录一次', '登录后回来再试，刚才的内容不会丢'] },
  { kind: 'forbidden', test: /\b403\b|forbidden|无权限|没有访问权限/i,
    title: '没有访问权限',
    cause: '账号已登录，但对方服务不允许这个账号做这件事，或者被公司网络策略拦了。',
    steps: ['确认账号有对应权限（例如是否开通了这个模型或功能）', '在公司网络里时，先在浏览器打开一次对应网址看是否需要放行'] },
  { kind: 'rate-limit', test: /\b429\b|rate[\s_-]*limit|too many requests|限流|请求过于频繁/i,
    title: '请求太频繁，被限流了',
    cause: '短时间内发出的请求太多，对方服务暂时不再接收。',
    steps: ['等一两分钟再试', '着急的话换一个模型或账号'] },
  { kind: 'server', test: /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|overloaded|服务(?:器)?(?:错误|异常|不可用)/i,
    title: '对方服务出错了',
    cause: '对方服务器内部出了问题或正在过载，和你的操作无关。',
    steps: ['稍等片刻再试', '持续出现的话点「一键反馈」告诉维护人'] },
];

function humanizeError(raw) {
  const text = String(raw == null ? '' : (raw && raw.message) || raw).slice(0, 4000);
  if (!text.trim()) return null;
  const rule = RULES.find(item => item.test.test(text));
  return rule ? { kind: rule.kind, title: rule.title, cause: rule.cause, steps: rule.steps.slice() } : null;
}

module.exports = { humanizeError, RULES };
