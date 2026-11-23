"""Comprehensive regression tests for P0/P1 audit fixes and online password change."""
import asyncio
import json
import stat
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from qqagent import worker
from qqagent.adapters import Channels, MockChannels, ModelClient, Rejected, image_data
from qqagent.app import MAX_LOGIN_ATTEMPTS_KEYS, create_app
from qqagent.backup import export
from qqagent.engine import Engine
from qqagent.store import Store, js, now

ROOT = Path(__file__).resolve().parents[1]


def _seed_engine(tmp_path, *, vision=False, vision_name='', search=False, qzone=False):
    s = Store(tmp_path)
    with s.db() as c:
        pid = c.execute('INSERT INTO personas(body,created) VALUES(?,?)', ('[PERSONA]', now())).lastrowid
        c.execute(
            "INSERT INTO friends(id,name,permissions,updated) VALUES('10001','friend',?,?)",
            (js({'reply': True, 'proactive': True, 'read': True, 'like': True, 'comment': True}), now()),
        )
    s.set('persona_active', pid)
    cfg = s.get('config')
    cfg['channel'].update(enabled=True, qq_id='90000', owner_id='90001')
    cfg['policy'].update(enabled=True, quiet_start=0, quiet_end=0)
    cfg['tools'].update(vision=vision, search=search)
    cfg['vision_model']['name'] = vision_name
    if qzone:
        cfg['qzone'].update(enabled=True, read=True, comment=True, like=True, reply=True)
    s.save_config(cfg, s.get('revision'))
    s.control(stop=False, pause=False, running=True)
    e = Engine(s, lambda: {'ok': True})
    e.channels = MockChannels()
    return s, e


def test_nginx_configs_avoid_dev_null():
    for name in ('qq-agent-public.nginx.conf', 'qq-agent-public-ip.nginx.conf'):
        text = (ROOT / 'deploy' / name).read_text(encoding='utf-8')
        active_lines = [ln for ln in text.splitlines() if not ln.strip().startswith('#')]
        assert not any('/dev/null' in ln for ln in active_lines)
        assert 'error_log /var/lib/nginx-log-sinks/qq-agent-null crit;' in text


def test_static_app_js_test_send_success_and_syntax():
    js_path = ROOT / 'qqagent/static/app.js'
    subprocess.check_call(['node', '--check', str(js_path)])
    text = js_path.read_text(encoding='utf-8')
    assert "['success', 'blocked', 'cancelled', 'failed'].includes(result.status)" in text
    assert "['sent', 'blocked', 'cancelled', 'failed']" not in text
    assert "api('password', 'POST'" in text


@pytest.mark.asyncio
async def test_vision_routing_only_when_image_present_and_preserves_vision_on_search(tmp_path):
    s, e = _seed_engine(tmp_path, vision=True, vision_name='vision-v1', search=True)
    kinds = []

    class KindModel:
        def __init__(self, replies):
            self.replies = list(replies)

        async def complete(self, messages, kind='model', test=False):
            kinds.append((kind, json.dumps(messages, ensure_ascii=False)))
            return self.replies.pop(0)

    class FakeSearch:
        async def search(self, query):
            return [{'title': 'T', 'url': 'https://example.test', 'snippet': 'info'}]

    e.search = FakeSearch()

    # 1. Text-only message must route to 'model', NOT 'vision'
    e.model = KindModel(['纯文本回复'])
    e.ingest('qq', {'user_id': '10001', 'message_id': 1, 'time': now() - 3, 'message': '你好呀'})
    await e.process_pending()
    assert [k for k, _ in kinds] == ['model']

    # 2. Message with image + follow-up search routes BOTH turns to 'vision' so text-only model never gets image_url
    kinds.clear()
    e.model = KindModel(['{"search":"图片信息"}', '结合图片与搜索结果的回答'])
    with patch('qqagent.engine.image_data', AsyncMock(return_value='data:image/png;base64,AAAA')):
        e.ingest('qq', {
            'user_id': '10001', 'message_id': 2, 'time': now() - 3,
            'message': [
                {'type': 'text', 'data': {'text': '帮我查查这张图'}},
                {'type': 'image', 'data': {'url': 'https://gchat.qpic.cn/pic.png'}},
            ],
        })
        await e.process_pending()
    assert [k for k, _ in kinds] == ['vision', 'vision']
    assert 'data:image/png;base64,AAAA' in kinds[0][1]


@pytest.mark.asyncio
async def test_context_limit_excludes_base64_image_data_and_webp_detected(tmp_path):
    # WebP magic byte detection
    webp_bytes = b'RIFF\x10\x00\x00\x00WEBPVP8 ' + b'\x00' * 16
    original = httpx.AsyncClient
    with patch('qqagent.adapters.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('8.8.8.8', 443))]), \
         patch('qqagent.adapters.httpx.AsyncClient', lambda **kw: original(transport=httpx.MockTransport(lambda req: httpx.Response(200, content=webp_bytes)), **kw)):
        uri = await image_data('https://gchat.qpic.cn/sticker.webp')
    assert uri.startswith('data:image/webp;base64,')

    # Context limit excludes data:image/ base64 strings
    s = Store(tmp_path)
    cfg = s.get('config')
    cfg['vision_model'].update(base_url='http://127.0.0.1:1/v1', name='v1', context_limit=1000)
    s.save_config(cfg, s.get('revision'))
    s.put_secret('vision_key', 'SECRET')
    huge_image = 'data:image/png;base64,' + ('A' * 10000)
    messages = [{'role': 'user', 'content': [{'type': 'text', 'text': '看图'}, {'type': 'image_url', 'image_url': {'url': huge_image}}]}]
    with patch('qqagent.adapters.httpx.AsyncClient', lambda **kw: original(transport=httpx.MockTransport(lambda req: httpx.Response(200, json={'choices': [{'message': {'content': '是一张图'}}]})), **kw)):
        assert await ModelClient(s).complete(messages, kind='vision') == '是一张图'
    # But genuinely oversized text is still rejected — including plain text starting with 'data:image/' (B2)
    too_long_text = [{'role': 'user', 'content': 'x' * 4000}]
    with pytest.raises(Rejected, match='上下文超过配置上限'):
        await ModelClient(s).complete(too_long_text, kind='vision')
    spoofed_plain_str = [{'role': 'user', 'content': 'data:image/png;base64,' + ('A' * 10000)}]
    with pytest.raises(Rejected, match='上下文超过配置上限'):
        await ModelClient(s).complete(spoofed_plain_str, kind='vision')
    spoofed_text_block = [{'role': 'user', 'content': [{'type': 'text', 'text': 'data:image/png;base64,' + ('A' * 10000)}]}]
    with pytest.raises(Rejected, match='上下文超过配置上限'):
        await ModelClient(s).complete(spoofed_text_block, kind='vision')


@pytest.mark.asyncio
async def test_qzone_freshness_window_scales_with_poll_minutes_and_fenced_json_and_null_persona(tmp_path):
    s, e = _seed_engine(tmp_path, qzone=True)
    s.set('qzone_baseline', now() - 1000)
    # Default poll_minutes=10 -> freshness window is 1200s; 8 min old post must be pending, not baseline/expired
    eight_min_ago = now() - 480
    ing = e.ingest('qzone', {'user_id': '10001', 'event_id': 'feed:8m', 'tid': 't8m', 'text': '八分钟前的动态', 'time': eight_min_ago})
    assert ing['state'] == 'pending'

    class FencedModel:
        async def complete(self, messages, *args, **kwargs):
            return '```json\n{"like": true, "comment": "真不错"}\n```'

    e.model = FencedModel()
    await e.process_pending()
    assert len(e.channels.sent) == 2

    # Active persona cleared mid-batch -> decide_qzone expires ALL remaining processing items in batch (B3)
    e.ingest('qzone', {'user_id': '10001', 'event_id': 'feed:nop1', 'tid': 'tnop1', 'text': 'x1', 'time': now() - 5})
    e.ingest('qzone', {'user_id': '10001', 'event_id': 'feed:nop2', 'tid': 'tnop2', 'text': 'x2', 'time': now() - 4})
    batch = s.rows("SELECT * FROM events WHERE id IN ('qzone:feed:nop1','qzone:feed:nop2') ORDER BY id")
    assert len(batch) == 2
    with s.db() as c:
        c.executemany("UPDATE events SET state='processing' WHERE id=?", [(r['id'],) for r in batch])
    orig_gate = e.gate
    def gate_then_disable(row):
        res = orig_gate(row)
        # Clear persona directly in DB without triggering set()'s bulk expire so decide_qzone's own finish(items) is exercised
        with s.db() as c:
            c.execute("UPDATE meta SET v='null' WHERE k='persona_active'")
        return res
    with patch.object(e, 'gate', side_effect=gate_then_disable):
        await e.decide_qzone('10001', batch)
    states = {r['id']: r['state'] for r in s.rows("SELECT id, state FROM events WHERE id IN ('qzone:feed:nop1','qzone:feed:nop2')")}
    assert states == {'qzone:feed:nop1': 'expired', 'qzone:feed:nop2': 'expired'}


@pytest.mark.asyncio
async def test_worker_ms_timestamps_null_lists_and_nonblocking_qzone_poll(tmp_path):
    s, e = _seed_engine(tmp_path, qzone=True)
    s.set('qzone_baseline', now() - 1000)

    poll_started = asyncio.Event()
    release_poll = asyncio.Event()

    class SlowQzoneBridge:
        async def call(self, channel, action, params=None, write=False):
            if action == 'get_friend_feeds':
                poll_started.set()
                await release_poll.wait()
                # Millisecond timestamp!
                return {'feeds': [{'uin': '10001', 'tid': 'ms1', 'content': '毫秒时间戳动态', 'created_time': int((now() - 10) * 1000)}], 'has_more': False}
            if action == 'get_emotion_list':
                return {'msglist': None}
            if action == 'get_comment_list':
                return {'comments': None}
            return {'message_id': 'ok'}

        async def send(self, row):
            return {'message_id': 'sent-1'}

    class QuickModel:
        async def complete(self, messages, *args, **kwargs):
            return '秒回私聊'

    e.channels = SlowQzoneBridge()
    e.model = QuickModel()

    # Start slow QZone poll; while it waits on HTTP, QQ private reply must NOT be blocked by decide_lock!
    poll_task = asyncio.create_task(worker.poll_qzone(e))
    await poll_started.wait()
    e.ingest('qq', {'user_id': '10001', 'message_id': 99, 'time': now() - 3, 'message': '在吗'})
    await asyncio.wait_for(e.process_pending(), timeout=2.0)
    assert s.rows("SELECT state FROM events WHERE id='qq:99'")[0]['state'] == 'processed'

    release_poll.set()
    await poll_task
    ms_row = s.rows("SELECT created, state FROM events WHERE id='qzone:feed:10001:ms1'")[0]
    assert ms_row['created'] < 100000000000
    assert ms_row['state'] == 'pending'

    # Also test null comments list directly
    class NullCommentsBridge:
        async def call(self, channel, action, params=None, write=False):
            if action == 'get_emotion_list':
                return {'msglist': [{'tid': 'p1'}]}
            return {'comments': None}

    e.channels = NullCommentsBridge()
    await worker.poll_own_comments(e, now() - 100, now())


def test_store_indexes_and_retention_cleans_expired_sessions(tmp_path):
    s = Store(tmp_path)
    idx_names = {r['name'] for r in s.rows("SELECT name FROM sqlite_master WHERE type='index'")}
    for expected in (
        'events_state_channel_created',
        'events_channel_friend_state_created',
        'ledger_status_updated',
        'ledger_friend_action_status_updated',
        'logs_created',
        'usage_created',
        'sessions_expires',
    ):
        assert expected in idx_names

    # Seed an expired session and a valid session; run one retention tick
    with s.db() as c:
        c.execute('INSERT INTO sessions VALUES(?,?,?)', ('expired-sid', 'c1', now() - 10))
        c.execute('INSERT INTO sessions VALUES(?,?,?)', ('active-sid', 'c2', now() + 3600))
        c.execute("INSERT OR REPLACE INTO tasks(name,next) VALUES('retention',?)", (now() - 1,))
        c.execute("INSERT OR REPLACE INTO tasks(name,next) VALUES('qzone_poll',?)", (now() + 9999,))
        c.execute("INSERT OR REPLACE INTO tasks(name,next) VALUES('decision',?)", (now() + 9999,))

    e = Engine(s)

    async def run_one_tick():
        async def stop_soon():
            await asyncio.sleep(0.05)
            e.stopping = True
        await asyncio.gather(worker.periodic(e), stop_soon())

    asyncio.run(run_one_tick())
    remaining = {r['id'] for r in s.rows('SELECT id FROM sessions')}
    assert remaining == {'active-sid'}


def test_app_security_component_isolation_443_attempts_cap_and_password_change(tmp_path, monkeypatch):
    monkeypatch.setenv('QQAGENT_PUBLIC_ORIGIN', 'https://qqbot.example.com')
    app = create_app(tmp_path, background=False)
    pw_file = tmp_path / 'admin-password.txt'
    assert stat.S_IMODE(pw_file.stat().st_mode) == 0o600
    initial_pw = pw_file.read_text().strip()

    # 1. Host :443 normalization & Origin normalization
    with TestClient(app, base_url='https://qqbot.example.com:443') as c:
        assert c.get('/').status_code == 200
        # 2. Auth checked BEFORE 8MB body size limit
        r_unauth = c.post('/api/control', content=b'x' * (9 * 1024 * 1024),
                          headers={'content-type': 'application/json', 'origin': 'https://qqbot.example.com'})
        assert r_unauth.status_code == 401

        # Login with normalized origin (no :443) against :443 base URL
        login1 = c.post('/api/login', json={'password': initial_pw}, headers={'origin': 'https://qqbot.example.com'})
        assert login1.status_code == 200
        csrf1 = login1.json()['csrf']
        hdr1 = {'x-csrf-token': csrf1, 'origin': 'https://qqbot.example.com'}

        # 3. Component validation before mutating state & qzone stop does NOT kill QQ private chat
        app.state.store.control(stop=False, running=True)
        assert c.post('/api/components', json={'component': 'invalid', 'action': 'stop'}, headers=hdr1).status_code == 400
        assert app.state.store.get('stop_all') is False
        assert app.state.store.get('social_running') is True

        app.state.runtime.deployed = True
        with patch.object(app.state.runtime, 'control', AsyncMock(return_value={'component': 'qzone', 'action': 'stop', 'active': False, 'success': True})):
            res_qz = c.post('/api/components', json={'component': 'qzone', 'action': 'stop'}, headers=hdr1)
            assert res_qz.status_code == 200
        # Stopping qzone must NOT have stopped QQ social running or set stop_all!
        assert app.state.store.get('stop_all') is False
        assert app.state.store.get('social_running') is True

        with patch.object(app.state.runtime, 'control', AsyncMock(return_value={'component': 'napcat', 'action': 'stop', 'active': False, 'success': True})):
            res_nc = c.post('/api/components', json={'component': 'napcat', 'action': 'stop'}, headers=hdr1)
            assert res_nc.status_code == 200
        assert app.state.store.get('stop_all') is True
        assert app.state.store.get('social_running') is False

        # 4. Online Admin Password Change (POST /api/password)
        with TestClient(app, base_url='https://qqbot.example.com') as other_client:
            login2 = other_client.post('/api/login', json={'password': initial_pw}, headers={'origin': 'https://qqbot.example.com'})
            assert login2.status_code == 200
            assert other_client.get('/api/status').status_code == 200

            # Wrong old password -> 400
            assert c.post('/api/password', json={'old': 'wrong-pw', 'password': 'new-strong-password'}, headers=hdr1).status_code == 400
            # Too short new password -> 400
            assert c.post('/api/password', json={'old': initial_pw, 'password': 'short'}, headers=hdr1).status_code == 400
            assert c.post('/api/password', json={'old': initial_pw, 'password': '汉字'}, headers=hdr1).status_code == 400

            # Valid Chinese 3-char password succeeds
            r_pw = c.post('/api/password', json={'old': initial_pw, 'password': '小鲸鱼'}, headers=hdr1)
            assert r_pw.status_code == 200
            assert r_pw.json()['ok'] is True
            # Initial plaintext bootstrap file removed
            assert not pw_file.exists()
            # Current session still valid; other session invalidated!
            assert c.get('/api/status').status_code == 200
            assert other_client.get('/api/status').status_code == 401
            # Old password rejected, new password accepted
            assert other_client.post('/api/login', json={'password': initial_pw}, headers={'origin': 'https://qqbot.example.com'}).status_code == 401
            assert other_client.post('/api/login', json={'password': '小鲸鱼'}, headers={'origin': 'https://qqbot.example.com'}).status_code == 200

        # 5. Backup restore runs cleanly via asyncio.to_thread
        snap = export(app.state.store)
        r_restore = c.post('/api/backup/restore', json=snap, headers=hdr1)
        assert r_restore.status_code == 200

    # 6. Bounded cap (4096) on attempts dict
    for i in range(MAX_LOGIN_ATTEMPTS_KEYS + 50):
        app.state.attempts[f'198.51.100.{i}'] = [now()]
    with TestClient(app, base_url='https://qqbot.example.com') as c:
        c.post('/api/login', json={'password': 'bad-password'}, headers={'origin': 'https://qqbot.example.com'})
    assert len(app.state.attempts) <= MAX_LOGIN_ATTEMPTS_KEYS


def test_malformed_host_and_origin_return_400_or_403_never_500(tmp_path, monkeypatch):
    """B1 regression: invalid ports, userinfo, paths, queries, fragments must return 400/403, never HTTP 500."""
    monkeypatch.setenv('QQAGENT_PUBLIC_ORIGIN', 'https://qqbot.example.com')
    app = create_app(tmp_path, background=False)
    initial_pw = (tmp_path / 'admin-password.txt').read_text().strip()

    # Malformed Host headers must return 400 (never 500)
    with TestClient(app, base_url='https://qqbot.example.com', raise_server_exceptions=False) as c:
        for bad_host in (
            'qqbot.example.com:99999',
            'qqbot.example.com:notaport',
            'evil.com:443',
            'user:pass@qqbot.example.com',
            'user@localhost',
            '[::1',
            '',
        ):
            r = c.get('/', headers={'host': bad_host})
            assert r.status_code == 400, f'Host={bad_host!r} returned {r.status_code}'

        # Malformed / spoofed / path-bearing / credential-bearing Origin headers must return 403 (never 500 or 200)
        for bad_origin in (
            'https://qqbot.example.com:99999',
            'https://qqbot.example.com:notaport',
            'https://[::1',
            'https://qqbot.example.com/extra',
            'https://qqbot.example.com/',
            'https://qqbot.example.com?x=1',
            'https://qqbot.example.com#frag',
            'https://user:pass@qqbot.example.com',
            'https://evil.com:443',
            'http://qqbot.example.com',
            'null',
            '',
        ):
            r = c.post('/api/login', json={'password': initial_pw}, headers={'origin': bad_origin})
            assert r.status_code == 403, f'Origin={bad_origin!r} returned {r.status_code}'

        # Legitimate :443 Origin still matches public origin cleanly
        r_ok = c.post('/api/login', json={'password': initial_pw}, headers={'origin': 'https://qqbot.example.com:443'})
        assert r_ok.status_code == 200

