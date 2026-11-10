"""Hub full-page controls; mutations stay on the secretary's GUI thread.

The signed 2.1.1 adapter is retained as hub_control_base by the offline packer.
Booking, browser login, clock calibration and post actions use the original engine.
"""
import copy
import queue
import re
import threading
from datetime import datetime, timedelta
from . import config as C, post, welink
from . import hub_control_base as base

GROUPS = {
    '抢订设置': {'开放时间': 'clock', '提前填表秒数': (5, 600), '最大重试次数': (1, 30),
                 '重试间隔毫秒': (50, 3000), '抢不到换下一间': bool,
                 '登录预检提前分钟': (0, 180), '校准服务器时间': bool},
    '会后动作': {'模式': ['不动作', '通知模式', '自动释放'], '小鲁班ID': str, '提醒提前分钟': (1, 60)},
    '系统': {'守护时阻止睡眠': bool},
    '高级': {'网址': 'url', '浏览器': ['自动', 'Edge', 'Chrome', '内置Chromium'],
             '自动标定网格': bool, '网格起点X': (0, 3000), '格子宽度': (10, 100),
             '网格起始时间': 'time', 'welink-cli路径': str},
}


def validate_patch(patch):
    if not isinstance(patch, dict) or set(patch) - set(base.FIELDS) - set(GROUPS):
        raise ValueError('不支持的会议室设置；目标日期仍为开放日七天后')
    basic = {k: v for k, v in patch.items() if k in base.FIELDS}
    empty_rooms = basic.get('优先会议室') == []
    if empty_rooms:
        del basic['优先会议室']
    result = base.validate_patch(basic)
    if empty_rooms:
        result['优先会议室'] = []
    for group, spec in GROUPS.items():
        if group not in patch:
            continue
        values = patch[group]
        if not isinstance(values, dict) or set(values) - set(spec):
            raise ValueError(group + '含有不支持的设置')
        for key, value in values.items():
            rule = spec[key]
            valid = True
            if rule is bool:
                valid = type(value) is bool
            elif rule is str:
                valid = isinstance(value, str) and len(value) <= 2048
            elif isinstance(rule, tuple):
                valid = type(value) is int and rule[0] <= value <= rule[1]
            elif isinstance(rule, list):
                valid = value in rule
            elif rule in ('clock', 'time'):
                valid = bool(re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d' + (r':[0-5]\d' if rule == 'clock' else ''), str(value)))
            elif rule == 'url':
                valid = isinstance(value, str) and len(value) <= 2048 and bool(re.match(r'^https?://[^\s]+$', value))
            if not valid:
                raise ValueError(key + '的值或范围不正确')
        result[group] = copy.deepcopy(values)
    return result


class HubControl(base.HubControl):
    def __init__(self, window):
        self.work = None
        self.results = queue.Queue()
        self.read_result = {'state': 'idle', 'names': [], 'error': ''}
        self.test_result = {'state': 'idle', 'error': ''}
        super().__init__(window)

    def status(self):
        while not self.results.empty():
            op, value, error = self.results.get_nowait()
            self.work = None
            if op == 'read-rooms':
                self.read_result = {'state': 'error' if error else 'done', 'names': value or [], 'error': error}
            else:
                self.test_result = {'state': 'error' if error else 'done', 'error': error}
            self.w.log(error or ('会议室列表已读取' if op == 'read-rooms' else '测试消息已发送'), 'bad' if error else 'ok')
        s = super().status()
        w = self.w
        opened, target = w._calc_next()
        if w.job in ('once', 'test'):
            now = w.clock.now()
            h, m, sec = map(int, w.cfg['抢订设置']['开放时间'].split(':'))
            opened = now.replace(hour=h, minute=m, second=sec, microsecond=0)
            target = now.date() + timedelta(days=7)
        s.update(capabilities=['full-ui'], loginState=w.login_state,
                 loginCheckedAt=w.login_checked_at.isoformat() if w.login_checked_at else None,
                 nextOpen=opened.isoformat(), targetDate=target.isoformat(),
                 serverNow=w.clock.now().isoformat(), controlBusy=self.work,
                 preferences={k: {f: copy.deepcopy(w.cfg[k][f]) for f in fields} for k, fields in GROUPS.items()},
                 history=C.load_history()[-50:], logs=w.log_view.toPlainText()[-60000:],
                 pending=[dict(a, description=post.describe(a)) for a in post.pending()],
                 roomRead=self.read_result, messageTest=self.test_result,
                 cliAvailable=bool(welink.find_cli(w.cfg['高级'].get('welink-cli路径', ''))))
        return s

    def background(self, op, fn):
        self.work = op
        if op == 'read-rooms':
            self.read_result = {'state': 'running', 'names': [], 'error': ''}
        else:
            self.test_result = {'state': 'running', 'error': ''}
        def run():
            try:
                self.results.put((op, fn(), ''))
            except Exception as exc:
                self.results.put((op, None, str(exc)))
        threading.Thread(target=run, daemon=True).start()

    def invoke(self, op, args):
        w = self.w
        if self.work and op not in ('status', 'pause'):
            raise ValueError('正在读取会议室或发送测试消息，请稍等')
        if op in ('configure', 'once', 'read-rooms', 'test-message'):
            if w._busy() or not w.btn_login.isEnabled():
                raise ValueError('请先停止任务，待浏览器退出后再操作')
        if op == 'configure':
            patch = validate_patch(args)
            candidate = copy.deepcopy(w.cfg)
            for k, v in patch.items():
                if k in GROUPS:
                    candidate[k].update(v)
                else:
                    candidate[k] = v
            duration = candidate['时长小时'] * 60 + candidate['时长分钟']
            h, m = map(int, candidate['开始时间'].split(':'))
            if not 30 <= duration <= 720 or h * 60 + m + duration > 1440:
                raise ValueError('会议时长须为 30 分钟至 12 小时，结束时间不能跨天')
            if candidate['会后动作']['模式'] != '不动作':
                if not welink.find_cli(candidate['高级'].get('welink-cli路径', '')):
                    raise ValueError('未找到 welink-cli，请先配置路径；当前设置未改动')
                if candidate['会后动作']['模式'] == '通知模式' and not candidate['会后动作']['小鲁班ID'].strip():
                    raise ValueError('请填写提醒接收人')
            C.save_config(candidate)
            w.cfg = candidate
            w._loading = True
            try:
                w._load_into_ui()
            finally:
                w._loading = False
            w.refresh_all()
        elif op == 'once':
            if not w.cfg['优先会议室']:
                raise ValueError('请先填写优先会议室')
            w.start_job('once')
        elif op == 'read-rooms':
            from .engine import read_rooms
            cfg = copy.deepcopy(w.cfg)
            day = (datetime.now() + timedelta(weeks=1)).strftime('%Y/%m/%d')
            self.background(op, lambda: read_rooms(cfg, lambda m, l='info': w.bus.log.emit(m, l), threading.Event(), day))
        elif op == 'test-message':
            cfg = copy.deepcopy(w.cfg)
            recipient = cfg['会后动作']['小鲁班ID'].strip()
            if not recipient:
                raise ValueError('请先保存提醒接收人')
            self.background(op, lambda: welink.send(recipient, '秘书终结者测试消息 ' + datetime.now().strftime('%H:%M:%S'), cfg['高级'].get('welink-cli路径', '')))
        elif op == 'remove-pending':
            aid = args.get('id')
            if not isinstance(aid, str) or not any(a['id'] == aid for a in post.pending()):
                raise ValueError('待执行事项已不存在，请刷新列表')
            post.remove(aid)
        else:
            return super().invoke(op, args)
        return self.status()


def attach(window):
    if not getattr(window, '_hub_control', None):
        window._hub_control = HubControl(window)
    return window._hub_control
