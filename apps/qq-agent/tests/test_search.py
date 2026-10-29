"""联网搜索：配置、客户端边界与引擎的一次性检索决策。"""
import json
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from qqagent.adapters import MockChannels, Rejected, SearchClient
from qqagent.app import create_app
from qqagent.config import Configuration, Search
from qqagent.engine import Engine
from qqagent.store import Store, js, now


def test_search_defaults_and_tools_switch():
    cfg = Configuration()
    assert cfg.search.base_url.startswith('https://') and cfg.search.max_results == 5
    assert cfg.tools.search is False
    allowed = cfg.model_copy(deep=True)
    allowed.tools.search = True
    Configuration.model_validate(allowed.model_dump())
    unsafe = cfg.model_copy(deep=True)
    unsafe.tools.stickers = True
    with pytest.raises(ValueError):
        Configuration.model_validate(unsafe.model_dump())


@pytest.mark.parametrize('url', ['http://example.test/v1', 'file:///x', 'https://user:p@example.test/v1'])
def test_search_url_rejected(url):
    base = Search().model_dump()
    base['base_url'] = url
    with pytest.raises(ValueError):
        Search.model_validate(base)


def configured_store(tmp_path, **search):
    s = Store(tmp_path)
    cfg = s.get('config')
    cfg['search'].update(**search)
    cfg['tools']['search'] = True
    s.save_config(cfg, s.get('revision'))
    s.put_secret('search_key', 'SEARCH_SECRET')
    return s


def patched(handler):
    original = httpx.AsyncClient
    return patch('qqagent.adapters.httpx.AsyncClient',
                 lambda **kw: original(transport=httpx.MockTransport(handler), **kw))


@pytest.mark.asyncio
async def test_search_sanitizes_results(tmp_path):
    s = configured_store(tmp_path)
    seen = {}

    def handler(request):
        seen['body'] = json.loads(request.content)
        seen['auth'] = request.headers.get('authorization')
        return httpx.Response(200, json={'results': [
            {'title': ' T ', 'url': 'https://example.test/a', 'snippet': 'S'},
            {'title': '', 'url': 'javascript:alert(1)', 'snippet': 'bad'},
            {'title': 'ok2', 'url': '', 'snippet': 'S2'},
            'not-a-dict',
        ]})

    with patched(handler):
        results = await SearchClient(s).search('  查询  词 ')
    assert seen['body'] == {'query': '查询 词', 'max_results': 5}
    assert seen['auth'] == 'Bearer SEARCH_SECRET'
    assert results == [{'title': 'T', 'url': 'https://example.test/a', 'snippet': 'S'},
                       {'title': 'ok2', 'url': '', 'snippet': 'S2'}]


@pytest.mark.asyncio
@pytest.mark.parametrize('status,text', [(401, 'x'), (500, 'x'), (400, 'invalid')])
async def test_search_http_errors(tmp_path, status, text):
    s = configured_store(tmp_path)
    with patched(lambda request: httpx.Response(status, text=text)):
        with pytest.raises(Rejected):
            await SearchClient(s).search('q')


@pytest.mark.asyncio
async def test_search_malformed_and_daily_budget(tmp_path):
    s = configured_store(tmp_path, daily=1)
    with patched(lambda request: httpx.Response(200, json={'results': 'no'})):
        with pytest.raises(Rejected):
            await SearchClient(s).search('q')
    s.log('', 'search', 'ok', '检索完成')
    with patched(lambda request: httpx.Response(200, json={'results': []})):
        with pytest.raises(Rejected, match='预算'):
            await SearchClient(s).search('q')


class FakeModel:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    async def complete(self, messages, *args, **kwargs):
        self.calls.append(messages)
        return self.replies.pop(0)


class FakeSearch:
    def __init__(self, results=None, error=None):
        self.results = results or []
        self.error = error
        self.calls = []

    async def search(self, query):
        self.calls.append(query)
        if self.error:
            raise self.error
        return self.results


def seed(tmp_path):
    s = Store(tmp_path)
    with s.db() as c:
        persona = c.execute('INSERT INTO personas(body,created) VALUES(?,?)', ('[PERSONA]', now())).lastrowid
        c.execute("INSERT INTO friends(id,name,permissions,updated) VALUES('10001','f',?,?)",
                  (js({'reply': True}), now()))
    s.set('persona_active', persona)
    cfg = s.get('config')
    cfg['channel'].update(enabled=True, qq_id='90000', owner_id='90001')
    cfg['policy'].update(enabled=True, quiet_start=0, quiet_end=0)
    cfg['tools']['search'] = True
    s.save_config(cfg, s.get('revision'))
    s.control(stop=False, pause=False, running=True)
    e = Engine(s, lambda: {'ok': True})
    e.channels = MockChannels()
    return s, e


def inbound(e):
    e.ingest('qq', {'user_id': '10001', 'message_id': 1, 'time': now() - 3, 'message': '今天有什么新闻'})


@pytest.mark.asyncio
async def test_engine_search_then_answer(tmp_path):
    s, e = seed(tmp_path)
    e.model = FakeModel(['{"search":"今日新闻"}', '[ANSWER_SENTINEL]'])
    e.search = FakeSearch([{'title': 'T', 'url': 'https://e.test', 'snippet': 'SNIPPET_SENTINEL'}])
    inbound(e)
    await e.process_pending()
    assert e.search.calls == ['今日新闻']
    assert len(e.model.calls) == 2
    assert 'SNIPPET_SENTINEL' in json.dumps(e.model.calls[-1], ensure_ascii=False)
    assert e.channels.sent[0]['payload'].find('ANSWER_SENTINEL') > 0


@pytest.mark.asyncio
async def test_engine_search_failure_falls_back(tmp_path):
    s, e = seed(tmp_path)
    e.model = FakeModel(['{"search":"x"}', '[FALLBACK_SENTINEL]'])
    e.search = FakeSearch(error=Rejected('搜索不可用'))
    inbound(e)
    await e.process_pending()
    assert '检索不可用' in json.dumps(e.model.calls[-1], ensure_ascii=False)
    assert 'FALLBACK_SENTINEL' in e.channels.sent[0]['payload']


@pytest.mark.asyncio
async def test_engine_repeated_search_never_sends_json(tmp_path):
    s, e = seed(tmp_path)
    e.model = FakeModel(['{"search":"x"}', '{"search":"y"}'])
    e.search = FakeSearch([])
    inbound(e)
    await e.process_pending()
    assert not e.channels.sent


@pytest.mark.asyncio
async def test_engine_skips_search_when_disabled(tmp_path):
    s, e = seed(tmp_path)
    cfg = s.get('config')
    cfg['tools']['search'] = False
    s.save_config(cfg, s.get('revision'))
    e.model = FakeModel(['{"search":"x"}'])
    e.search = FakeSearch([])
    inbound(e)
    await e.process_pending()
    assert not e.search.calls


def login_client(tmp_path):
    app = create_app(tmp_path, background=False)
    client = TestClient(app)
    client.__enter__()
    password = (tmp_path / 'admin-password.txt').read_text().strip()
    response = client.post('/api/login', json={'password': password})
    assert response.status_code == 200
    client.headers['x-csrf-token'] = response.json()['csrf']
    return app, client


def test_search_secret_and_check_endpoint(tmp_path):
    app, client = login_client(tmp_path)
    try:
        assert client.put('/api/secrets', json={'name': 'search_key', 'value': 'K'}).status_code == 200
        assert client.get('/api/status').json()['secrets']['search_key'] is True
        app.state.engine.search = FakeSearch([])
        result = client.post('/api/check/search').json()
        assert result['online'] is True and '0 条' in result['sample']
        assert client.get('/api/status').json()['channels']['search']['online'] is True
    finally:
        client.__exit__(None, None, None)
