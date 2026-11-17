"""Standalone, test-only launcher. No production Hub integration."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
from datetime import date, datetime, timedelta

ROOT = Path(__file__).resolve().parent
COMMIT = '9d924f3054224e1994c7eb2def74b95327e51d72'
BASE_HASH = '80e93dbc11543ba1d6d502dac2e7037f6463e25bdd280997be61711cb203f6de'
TARGETS = ['练秋湖B11-3-09R', '练秋湖B11-3-10R', '练秋湖B11-3-08R']
LABELS = dict(free='找到且空闲', taken='找到但被占用', missing='没找到名称', nogrid='找到名称但没定位到时段格子')
JS_FORM_OBSTRUCTION = r"""() => {
  const nodes = [...document.querySelectorAll('input.ev_textField_input')];
  const input = nodes[0];
  const rect = e => { if (!e) return null; const r = e.getBoundingClientRect();
    return {x:r.x, y:r.y, width:r.width, height:r.height}; };
  const labels = ['上海', '练秋湖B11栋', '全部会议室', '可用会议室', '我的收藏'];
  const describe = e => !e ? null : ({tag:e.tagName, role:e.getAttribute('role'),
    classes:String(e.className || '').slice(0,160), rect:rect(e),
    knownLabel:labels.includes(e.getAttribute('title')) ? e.getAttribute('title') : null});
  const r = input && input.getBoundingClientRect();
  const top = r ? document.elementFromPoint(r.x+r.width/2, r.y+r.height/2) : null;
  const ancestors = []; let e = top;
  for (let i=0; e && i<5; i++,e=e.parentElement) ancestors.push(describe(e));
  const day = document.querySelector('input.ev_datepicker_input')?.value || '';
  return {readyState:document.readyState, viewport:{width:innerWidth,height:innerHeight},
    inputCount:nodes.length, input:describe(input), pointHitsInput:!!input && top===input,
    hitAncestors:ancestors, dialogCount:document.querySelectorAll('[role=dialog]').length,
    formDate:/^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(day) ? day : null};
}"""
DATA = ROOT / 'test-data'
os.environ['MSZ_HOME'] = str(DATA)
sys.dont_write_bytecode = True


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load():
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    if manifest['commit'] != COMMIT:
        raise RuntimeError('提交号不符，停止')
    for name, item in manifest['files'].items():
        path = ROOT / name
        if path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
            raise RuntimeError('文件校验失败：' + name)
    base = ROOT / 'msz-code-2.1.3.zip'
    if digest(base) != BASE_HASH:
        raise RuntimeError('基包校验失败')
    sys.path.insert(0, str(base))
    from msz import config as C
    loaded = {}
    for name in ('engine', 'jobs'):
        spec = importlib.util.spec_from_file_location('msz.' + name, ROOT / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        loaded[name] = module
    E, J = loaded['engine'], loaded['jobs']
    if J.Booker is not E.Booker:
        raise RuntimeError('jobs 未加载修复引擎')
    E.Booker.submit = deny_submit
    DATA.mkdir(exist_ok=True)
    proof = {'commit': COMMIT, 'python': sys.executable, 'base': str(base), 'baseSha256': digest(base),
             'modules': {n: {'path': m.__file__, 'sha256': digest(Path(m.__file__))} for n, m in loaded.items()},
             'configModule': C.__file__, 'data': str(DATA), 'test': True, 'submitBlocked': True}
    (DATA / 'loaded-modules.json').write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding='utf-8')
    return C, E, J


class SubmissionBlocked(BaseException):
    pass


def deny_submit(*args, **kwargs):
    raise SubmissionBlocked('安全拦截：测试程序误调用 Booker.submit，立即停止，未发送预约')


def capture_form_evidence(booker, directory, context, log, screenshot=False):
    """Observe only; do not click, dismiss, reload, or copy arbitrary page text."""
    stem = 'form-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    evidence = dict(context)
    try:
        evidence['page'] = booker.page.evaluate(JS_FORM_OBSTRUCTION)
    except Exception as exc:
        evidence['probeErrorType'] = type(exc).__name__
    if screenshot:
        try:
            path = directory / (stem + '.png')
            booker.page.screenshot(path=str(path), timeout=5000)
            evidence['screenshot'] = str(path)
        except Exception as exc:
            evidence['screenshotErrorType'] = type(exc).__name__
    try:
        path = directory / (stem + '.json')
        path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
        log('表单遮挡诊断已留在本机：' + str(path))
    except Exception as exc:
        log('表单证据保存失败：' + type(exc).__name__, 'warn')


def observed_fill(original, directory, log):
    def fill(booker, topic, day, start, hours, minutes):
        context = {'stage': 'before-fill', 'expectedDate': day, 'start': start,
                   'durationMinutes': int(hours) * 60 + int(minutes), 'test': True}
        capture_form_evidence(booker, directory, context, log)
        try:
            return original(booker, topic, day, start, hours, minutes)
        except Exception:
            context['stage'] = 'fill-failed'
            capture_form_evidence(booker, directory, context, log, screenshot=True)
            raise
    return fill


def main():
    C, E, J = load()
    if '--self-check' in sys.argv:
        try:
            E.Booker.submit(None)
        except SubmissionBlocked:
            print('PASS: 文件哈希、源码加载、jobs绑定、提交拦截；未访问真实网页')
            return
        raise RuntimeError('提交拦截未生效')
    cfg = copy.deepcopy(C.DEFAULTS)
    cfg['高级']['浏览器'] = 'Edge'
    cfg['高级']['无界面'] = False
    cfg['抢订设置']['校准服务器时间'] = False
    cfg['会后动作']['模式'] = '不动作'
    cfg['主题'] = '会议室识别测试（不提交）'
    C.save_config(cfg)
    stop = threading.Event()
    run = DATA / ('run-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    run.mkdir()

    def log(text, level='info'):
        line = f'{datetime.now().isoformat(timespec="seconds")} [{level}] {text}'
        print(line)
        with (run / 'diagnostics.log').open('a', encoding='utf-8') as f:
            f.write(line + '\n')

    def confirm(text):
        if input(text + '\n确认后输入 YES，其他输入停止：').strip() != 'YES':
            raise RuntimeError('用户未确认，停止本次测试')

    original_dialog = E.Booker.open_room_dialog
    original_check = E.Booker.check_room
    original_shot = E.Booker.shot

    def dialog(b, day):
        original_dialog(b, day)
        confirm(f'在刚打开的弹窗选择并核对：上海 / 练秋湖B11栋 / 全部会议室；日期 {day}。不要滚动名单、搜索房间或点击预约。')
        probe = b.page.evaluate(E.JS_ROOM_DIAGNOSTICS, TARGETS[0])
        log('筛选经用户确认：上海 / 练秋湖B11栋 / 全部会议室；日期 ' + day)
        if probe.get('activeRoomTab') not in (None, '全部会议室'):
            raise RuntimeError('页签不是全部会议室，停止')
        b.log_room_diagnostic(TARGETS[0], '测试起始现场', day)

    def check(b, room, start, minutes):
        result = original_check(b, room, start, minutes)
        log(room + '：' + LABELS[result[0]])
        return result

    def shot(b, name):
        # Keep every attempt locally; never overwrite a previous failure screenshot.
        return original_shot(b, run.name + '-' + datetime.now().strftime('%H%M%S%f') + '-' + name)

    E.Booker.open_room_dialog = dialog
    E.Booker.check_room = check
    E.Booker.shot = shot
    E.Booker.fill_form = observed_fill(E.Booker.fill_form, run, log)
    print('会议室识别独立测试 v2（失败现场取证）/ 源码 9d924f3 / 不提交预约')
    print('证据目录：', run)
    while True:
        choice = input('\n1 登录\n2 读取名单\n3 测试填表（09R、10R、10R→09R）\n0 退出\n请选择：').strip()
        if choice == '0':
            return
        try:
            if choice == '1':
                b = E.Booker(cfg, log, stop, J.Clock())
                try:
                    b.launch()
                    b.page.goto(b.url, wait_until='domcontentloaded', timeout=60000)
                    input('请本人在独立 Edge 窗口登录；看到会议室预约表单后回到这里按回车。不要填写真实预约。')
                    ok, _ = b.wait_for_form(timeout=10)
                    log('登录成功：已看到预约表单' if ok else '登录未确认：未看到预约表单')
                finally:
                    b.close()
                continue
            if choice not in ('2', '3'):
                continue
            day = date.fromisoformat(input('测试日期 YYYY-MM-DD（不留空）：').strip())
            if day < date.today():
                raise ValueError('不能使用历史日期')
            start = input('开始时间 HH:MM（半小时边界）：').strip()
            parsed = datetime.strptime(start, '%H:%M')
            minutes = int(input('持续分钟数（30的正整数倍）：').strip())
            if parsed.minute not in (0, 30) or minutes <= 0 or minutes % 30 or parsed.hour * 60 + parsed.minute + minutes > 1440:
                raise ValueError('时段格式不正确')
            cfg.update({'开始时间': start, '时长小时': minutes // 60, '时长分钟': minutes % 60})
            end = (parsed + timedelta(minutes=minutes)).strftime('%H:%M')
            confirm(f'本次日期 {day}，时段 {start}–{end}，仅识别和填表，不提交')
            log(f'路径 {choice}，日期 {day}，时段 {start}–{end}，test=True')
            if choice == '2':
                b = E.Booker(cfg, log, stop, J.Clock())
                try:
                    b.launch()
                    b.open_page()
                    b.fill_form(cfg['主题'], day.strftime('%Y/%m/%d'), start, minutes // 60, minutes % 60)
                    b.open_room_dialog(day.strftime('%Y/%m/%d'))
                    total = int(input('当前网页总记录数（按现场显示输入，不预设23）：'))
                    pages = int(input('当前网页总页数（无分页填1）：'))
                    if total < 0 or pages < 1:
                        raise ValueError('总记录数/页数无效')
                    names = set()
                    for page in range(1, pages + 1):
                        confirm(f'请让网页显示第 {page}/{pages} 页，保持上述筛选')
                        names.update(b.list_rooms())
                    log(f'名单去重 {len(names)} 间；网页总数 {total}；页数 {pages}；总数匹配={len(names) == total}')
                    for room in TARGETS:
                        log(room + ('：名单出现' if room in names else '：名单未出现'))
                    (run / ('rooms-' + datetime.now().strftime('%H%M%S%f') + '.json')).write_text(json.dumps({'rooms': sorted(names), 'webTotal': total, 'pages': pages}, ensure_ascii=False), encoding='utf-8')
                finally:
                    b.close()
            else:
                for rooms in ([TARGETS[0]], [TARGETS[1]], [TARGETS[1], TARGETS[0]]):
                    cfg['优先会议室'] = rooms
                    confirm('下一次会启动全新页面/弹窗，优先顺序：' + ' → '.join(rooms))
                    runner = J.Runner(cfg, log, lambda k, s, t: log(t), stop)
                    result = runner.grab(None, day, test=True)
                    log('本次结束：' + json.dumps(result, ensure_ascii=False))
                    log('优先列表遇空闲即停止；未检查到的后续房间不视为成功或被占')
        except SubmissionBlocked as exc:
            log(str(exc), 'fatal')
            raise SystemExit(2)
        except Exception as exc:
            log('本次停止：' + str(exc), 'error')
            print('证据保留在公司测试目录；先取证，不修改引擎。')


if __name__ == '__main__':
    main()
