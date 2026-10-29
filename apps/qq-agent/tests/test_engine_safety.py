"""核心调度的离线安全回归；所有状态位于 pytest 临时目录。"""
import asyncio
import json
import socket
from unittest.mock import AsyncMock

import pytest

from qqagent.adapters import MockChannels, Rejected, Uncertain
from qqagent.engine import Engine
from qqagent.store import Store, js, now
from qqagent import worker


class RecordingModel:
    def __init__(self, text='[OUTPUT_SENTINEL]', effect=None):
        self.text = text
        self.effect = effect
        self.calls = []

    async def complete(self, messages, *args, **kwargs):
        self.calls.append(messages)
        if self.effect:
            result = self.effect()
            if asyncio.iscoroutine(result):
                await result
        return self.text


@pytest.fixture(autouse=True)
def deny_real_network(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError('核心测试禁止真实网络')
    monkeypatch.setattr(socket, 'create_connection', denied)
    monkeypatch.setattr(socket.socket, 'connect', denied)
    monkeypatch.setattr(socket.socket, 'connect_ex', denied)
    monkeypatch.setattr(socket, 'getaddrinfo', denied)


def add_friend(s, friend='10001', **permissions):
    with s.db() as c:
        c.execute('INSERT OR REPLACE INTO friends(id,name,permissions,updated) VALUES(?,?,?,?)',
                  (friend, '[FRIEND_SENTINEL]', js(permissions), now()))


def configure(s, **groups):
    cfg = s.get('config')
    for name, fields in groups.items():
        cfg[name].update(fields)
    s.save_config(cfg, s.get('revision'))


@pytest.fixture
def engine(tmp_path):
    s = Store(tmp_path)
    with s.db() as c:
        persona = c.execute('INSERT INTO personas(body,created) VALUES(?,?)',
                            ('[OPAQUE_TEST_SENTINEL]', now())).lastrowid
    s.set('persona_active', persona)
    configure(s, channel={'enabled': True, 'qq_id': '90000', 'owner_id': '90001'},
              policy={'enabled': True, 'quiet_start': 0, 'quiet_end': 0})
    s.control(stop=False, pause=False, running=True)
    add_friend(s, reply=True, proactive=True, read=True, like=True, comment=True)
    e = Engine(s, lambda: {'ok': True})
    e.channels = MockChannels()
    e.model = RecordingModel()
    return e


def inbound(e, mid=1, friend='10001', message='[INPUT_SENTINEL]', **extra):
    event = {'user_id': friend, 'message_id': mid, 'time': now()-3, 'message': message}
    event.update(extra)
    return e.ingest('qq', event)


def memory(s, friend='10001', kind='memory', body='[MEMORY_SENTINEL]', label='fact', source='owner'):
    with s.db() as c:
        c.execute('INSERT INTO memories(friend,kind,body,source,label,created) VALUES(?,?,?,?,?,?)',
                  (friend, kind, body, source, label, now()))


@pytest.mark.asyncio
async def test_stop_between_gate_and_claim_never_sends(engine, monkeypatch):
    original = engine.gate
    def stop_after_gate(row):
        reason = original(row)
        engine.s.control(stop=True)
        return reason
    monkeypatch.setattr(engine, 'gate', stop_after_gate)
    ident = engine.enqueue('race', 'qq', '10001', 'reply', {'segments': []})
    result = await engine.dispatch(ident)
    assert not engine.channels.sent
    assert result['status'] == 'cancelled'


@pytest.mark.asyncio
@pytest.mark.parametrize('proactive', [False, True])
async def test_stop_then_resume_during_generation_drops_old_output(engine, proactive):
    def stop_resume():
        engine.s.control(stop=True)
        engine.s.control(stop=False)
    engine.model = RecordingModel(effect=stop_resume)
    if proactive:
        memory(engine.s)
        await worker.autonomous(engine)
    else:
        inbound(engine)
        await engine.process_pending()
    assert len(engine.model.calls) == 1
    assert not engine.channels.sent
    assert not engine.s.rows("SELECT id FROM ledger WHERE status='pending'")


@pytest.mark.asyncio
async def test_pause_is_independent_from_passive_replies(engine):
    engine.s.control(pause=True)
    inbound(engine)
    await engine.process_pending()
    proactive = engine.enqueue('proactive', 'qq', '10001', 'proactive', {'segments': []})
    assert (await engine.dispatch(proactive))['status'] == 'blocked'
    assert [r['action'] for r in engine.channels.sent] == ['reply']
    assert not engine.s.get('stop_all')


@pytest.mark.asyncio
async def test_pause_then_resume_during_proactive_generation_drops_old_output(engine):
    def pause_resume():
        engine.s.control(pause=True)
        engine.s.control(pause=False)
    memory(engine.s)
    engine.model = RecordingModel(effect=pause_resume)
    await worker.autonomous(engine)
    assert not engine.channels.sent
    assert not engine.s.rows("SELECT id FROM ledger WHERE status='pending'")


@pytest.mark.asyncio
async def test_midnight_budget_uses_send_time_not_enqueue_time(engine):
    configure(engine.s, policy={'total_daily': 1})
    first = engine.enqueue('yesterday', 'qq', '10001', 'reply', {'segments': []})
    with engine.s.db() as c:
        c.execute('UPDATE ledger SET created=? WHERE id=?', (engine.day()-10, first))
    assert (await engine.dispatch(first))['status'] == 'success'
    second = engine.enqueue('today', 'qq', '10001', 'reply', {'segments': []})
    assert (await engine.dispatch(second))['status'] == 'blocked'
    assert len(engine.channels.sent) == 1


@pytest.mark.asyncio
async def test_cooldown_uses_send_time_not_old_enqueue_time(engine):
    first = engine.enqueue('old-proactive', 'qq', '10001', 'proactive', {'segments': []})
    with engine.s.db() as c:
        c.execute('UPDATE ledger SET created=? WHERE id=?', (now()-3*86400, first))
    assert (await engine.dispatch(first))['status'] == 'success'
    second = engine.enqueue('new-proactive', 'qq', '10001', 'proactive', {'segments': []})
    assert (await engine.dispatch(second))['status'] == 'blocked'
    assert len(engine.channels.sent) == 1


@pytest.mark.parametrize('value', [None, 0, '', float('nan'), float('inf')])
def test_missing_or_invalid_timestamp_never_becomes_fresh(engine, value):
    event = {'user_id': '10001', 'message_id': 1, 'message': '[OLD_SENTINEL]'}
    if value is not None:
        event['time'] = value
    try:
        result = engine.ingest('qq', event)
    except ValueError:
        return
    assert result['state'] != 'pending'


def test_self_echo_and_group_sender_cannot_trigger_private_reply(engine):
    assert inbound(engine, friend='90000')['ignored']
    assert inbound(engine, friend='10001', group_id=12345)['ignored']
    assert not engine.s.rows('SELECT * FROM events')


@pytest.mark.asyncio
async def test_stopped_arrivals_are_not_replayed_after_resume(engine):
    engine.s.control(stop=True)
    inbound(engine)
    engine.s.control(stop=False)
    await engine.process_pending()
    assert not engine.model.calls
    assert not engine.channels.sent


@pytest.mark.asyncio
async def test_each_event_expires_before_batching_with_fresh_message(engine):
    old = inbound(engine, 1, message='[STALE_SENTINEL]')['id']
    with engine.s.db() as c:
        c.execute('UPDATE events SET created=? WHERE id=?', (now()-600, old))
    inbound(engine, 2, message='[FRESH_SENTINEL]')
    await engine.process_pending()
    assert '[STALE_SENTINEL]' not in json.dumps(engine.model.calls)
    assert '[FRESH_SENTINEL]' in json.dumps(engine.model.calls)


@pytest.mark.asyncio
async def test_model_exception_does_not_repeat_or_starve_other_friend(engine):
    add_friend(engine.s, '20002', reply=True)
    inbound(engine, 1)
    inbound(engine, 2, friend='20002')
    class FailingOnce(RecordingModel):
        async def complete(self, messages, *args, **kwargs):
            self.calls.append(messages)
            if len(self.calls) == 1:
                raise RuntimeError('[PRIVATE_EXCEPTION_SENTINEL]')
            return '[OUTPUT_SENTINEL]'
    engine.model = FailingOnce()
    for _ in range(2):
        try:
            await engine.process_pending()
        except RuntimeError:
            pass
    assert len(engine.model.calls) == 2
    assert [r['friend'] for r in engine.channels.sent] == ['20002']
    assert '[PRIVATE_EXCEPTION_SENTINEL]' not in js(engine.s.rows('SELECT * FROM logs'))


@pytest.mark.asyncio
async def test_denied_pending_events_cannot_starve_allowed_friend(engine):
    add_friend(engine.s, '20002', reply=False)
    for mid in range(100):
        inbound(engine, mid+1, friend='20002')
    inbound(engine, 101)
    await engine.process_pending()
    await engine.process_pending()
    assert [r['friend'] for r in engine.channels.sent] == ['10001']


@pytest.mark.asyncio
async def test_cancelled_send_is_immediately_unknown_and_never_retried(engine):
    started = asyncio.Event()
    class Hanging(MockChannels):
        async def send(self, row):
            self.sent.append(dict(row))
            started.set()
            await asyncio.Event().wait()
    engine.channels = Hanging()
    ident = engine.enqueue('cancelled-network', 'qq', '10001', 'reply', {'segments': []})
    task = asyncio.create_task(engine.dispatch(ident))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert engine.s.rows('SELECT status FROM ledger WHERE id=?', (ident,))[0]['status'] == 'unknown'
    await engine.dispatch(ident)
    assert len(engine.channels.sent) == 1


@pytest.mark.asyncio
async def test_autonomous_and_restore_share_decision_lock(engine):
    memory(engine.s)
    engine.s.set('qzone_baseline', now())
    async with engine.decide_lock:
        task = asyncio.create_task(worker.autonomous(engine))
        await asyncio.sleep(0)
        assert not engine.model.calls
    await task


@pytest.mark.asyncio
async def test_failed_initial_qzone_poll_does_not_release_history(engine):
    configure(engine.s, qzone={'enabled': True, 'read': True, 'comment': True, 'pages': 2})
    class PartialPoll:
        def __init__(self):
            self.calls = 0
        async def call(self, *args):
            self.calls += 1
            if self.calls == 2:
                raise Rejected('模拟第二页失败')
            return {'feeds': [{'uin': '10001', 'tid': str(self.calls), 'text': '[PUBLIC_SENTINEL]', 'time': now()-3}],
                    'has_more': self.calls == 1, 'next_cursor': 'next'}
    engine.channels = PartialPoll()
    with pytest.raises(Rejected):
        await worker.poll_qzone(engine)
    assert not engine.s.get('qzone_baseline')
    await worker.poll_qzone(engine)
    assert all(r['state'] == 'baseline' for r in engine.s.rows('SELECT state FROM events'))


@pytest.mark.asyncio
async def test_qzone_forged_owner_cannot_redirect_public_comment(engine):
    configure(engine.s, qzone={'enabled': True, 'read': True, 'comment': True, 'reply': True})
    engine.s.set('qzone_baseline', now()-100)
    engine.model = RecordingModel('{"comment":"[PUBLIC_OUTPUT]"}')
    engine.ingest('qzone', {'user_id': '10001', 'event_id': 'forged-owner', 'tid': 't',
                            'owner_uin': '20002', 'text': '[PUBLIC_SENTINEL]', 'time': now()-3})
    await engine.process_pending()
    assert all(json.loads(r['payload'])['user_id'] == 10001 for r in engine.channels.sent)


@pytest.mark.asyncio
async def test_qzone_public_context_excludes_all_private_history(engine):
    configure(engine.s, qzone={'enabled': True, 'read': True, 'comment': True})
    memory(engine.s, body='[PRIVATE_MEMORY]')
    memory(engine.s, friend='20002', body='[OTHER_PRIVATE_MEMORY]')
    inbound(engine, 1, message='[PRIVATE_HISTORY]')
    with engine.s.db() as c:
        c.execute("UPDATE events SET state='processed'")
    engine.s.set('qzone_baseline', now()-100)
    engine.model = RecordingModel('{"comment":"[PUBLIC_OUTPUT]"}')
    engine.ingest('qzone', {'user_id': '10001', 'event_id': 'public', 'tid': 't',
                            'text': '[PUBLIC_INPUT]', 'time': now()-3})
    await engine.process_pending()
    serialized = js(engine.model.calls)
    assert '[PUBLIC_INPUT]' in serialized
    for sentinel in ('[PRIVATE_MEMORY]', '[OTHER_PRIVATE_MEMORY]', '[PRIVATE_HISTORY]'):
        assert sentinel not in serialized
