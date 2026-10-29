"""模型建议目录、推理强度与 OpenCode 网关边界。"""
import json
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from qqagent.adapters import ModelClient, Rejected
from qqagent.app import create_app
from qqagent.config import Configuration, Model
from qqagent.store import Store


def configured(tmp_path, **model):
    s = Store(tmp_path)
    cfg = s.get('config')
    cfg['model'].update(**model)
    s.save_config(cfg, s.get('revision'))
    s.put_secret('model_key', 'SECRET_SENTINEL')
    return s


def patched(handler):
    original = httpx.AsyncClient
    return patch('qqagent.adapters.httpx.AsyncClient',
                 lambda **kw: original(transport=httpx.MockTransport(handler), **kw))


def test_default_effort_is_low():
    assert Configuration().model.reasoning_effort == 'low'


@pytest.mark.parametrize('value', ['', 'low', 'medium', 'high', 'max'])
def test_allowed_efforts(value):
    base = Model().model_dump()
    base['reasoning_effort'] = value
    assert Model.model_validate(base).reasoning_effort == value


def test_invalid_effort_rejected():
    base = Model().model_dump()
    base['reasoning_effort'] = 'turbo'
    with pytest.raises(ValidationError):
        Model.model_validate(base)


@pytest.mark.asyncio
async def test_opencode_go_request_carries_session_and_effort(tmp_path):
    s = configured(tmp_path, base_url='https://opencode.ai/inference/go/openai/v1',
                   name='deepseek-v4.1-flash', reasoning_effort='low')
    seen = {}

    def handler(request):
        seen['headers'] = {key.lower(): value for key, value in request.headers.items()}
        seen['body'] = json.loads(request.content)
        return httpx.Response(200, json={'choices': [{'message': {'content': 'OK'}}],
                                         'usage': {'prompt_tokens': 10, 'completion_tokens': 2}})

    with patched(handler):
        assert await ModelClient(s).complete([{'role': 'user', 'content': 'x'}]) == 'OK'
    assert seen['body']['reasoning_effort'] == 'low'
    assert seen['headers']['x-opencode-session'].startswith('qqagent-')


@pytest.mark.asyncio
async def test_other_provider_gets_no_session_header_or_effort(tmp_path):
    s = configured(tmp_path, base_url='https://example.test/v1', name='other', reasoning_effort='')
    seen = {}

    def handler(request):
        seen['headers'] = {key.lower(): value for key, value in request.headers.items()}
        seen['body'] = json.loads(request.content)
        return httpx.Response(200, json={'choices': [{'message': {'content': 'OK'}}]})

    with patched(handler):
        assert await ModelClient(s).complete([{'role': 'user', 'content': 'x'}]) == 'OK'
    assert 'x-opencode-session' not in seen['headers']
    assert 'reasoning_effort' not in seen['body']


@pytest.mark.asyncio
@pytest.mark.parametrize('content', ['', '   \n'])
async def test_empty_content_is_rejected(tmp_path, content):
    s = configured(tmp_path, base_url='https://example.test/v1', name='m')
    handled = {'value': False}

    def handler(request):
        handled['value'] = True
        return httpx.Response(200, json={'choices': [{'message': {'content': content}}],
                                         'usage': {'prompt_tokens': 5, 'completion_tokens': 5}})

    with patched(handler):
        with pytest.raises(Rejected, match='未返回正文'):
            await ModelClient(s).complete([{'role': 'user', 'content': 'x'}])
    assert handled['value'] is True


def login_client(tmp_path):
    app = create_app(tmp_path, background=False)
    client = TestClient(app)
    client.__enter__()
    password = (tmp_path / 'admin-password.txt').read_text().strip()
    response = client.post('/api/login', json={'password': password})
    assert response.status_code == 200
    client.headers['x-csrf-token'] = response.json()['csrf']
    return app, client


def test_catalog_requires_login(tmp_path):
    app = create_app(tmp_path, background=False)
    with TestClient(app) as client:
        assert client.get('/api/model-catalog').status_code == 401


def test_catalog_lists_models_and_efforts(tmp_path):
    app, client = login_client(tmp_path)
    try:
        data = client.get('/api/model-catalog').json()
        ids = {item['id'] for item in data['models']}
        assert {'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash',
                'deepseek-v4-flash-vision-exp'} <= ids
        assert [item['id'] for item in data['efforts']] == ['low', 'medium', 'high', 'max']
        flash = next(item for item in data['models'] if item['id'] == 'deepseek-v4.1-flash')
        assert flash['vision'] is True and flash['default_effort'] == 'low' and flash['input_price'] > 0
    finally:
        client.__exit__(None, None, None)


def test_config_api_validates_effort(tmp_path):
    app, client = login_client(tmp_path)
    try:
        data = client.get('/api/config').json()
        data['config']['model']['reasoning_effort'] = 'turbo'
        assert client.put('/api/config', json={'revision': data['revision'], 'config': data['config']}).status_code == 400
        data = client.get('/api/config').json()
        data['config']['model']['reasoning_effort'] = 'high'
        response = client.put('/api/config', json={'revision': data['revision'], 'config': data['config']})
        assert response.status_code == 200
        assert client.get('/api/config').json()['config']['model']['reasoning_effort'] == 'high'
    finally:
        client.__exit__(None, None, None)


def test_old_config_without_effort_defaults_low():
    data = Configuration().model_dump()
    data['model'].pop('reasoning_effort')
    assert Configuration.model_validate(data).model.reasoning_effort == 'low'


@pytest.mark.asyncio
@pytest.mark.parametrize('base_url', ['https://opencode.ai.evil.test/v1', 'https://example.test/v1'])
async def test_lookalike_and_other_hosts_get_no_session_or_effort(tmp_path, base_url):
    s = configured(tmp_path, base_url=base_url, name='m', reasoning_effort='high')
    seen = {}

    def handler(request):
        seen['headers'] = {key.lower(): value for key, value in request.headers.items()}
        seen['body'] = json.loads(request.content)
        return httpx.Response(200, json={'choices': [{'message': {'content': 'OK'}}]})

    with patched(handler):
        assert await ModelClient(s).complete([{'role': 'user', 'content': 'x'}]) == 'OK'
    assert 'x-opencode-session' not in seen['headers']
    assert 'reasoning_effort' not in seen['body']


def test_instance_salt_is_stable_and_unique(tmp_path):
    s = Store(tmp_path)
    first = ModelClient(s)._instance_salt()
    assert first == ModelClient(s)._instance_salt() and len(first) == 32
    other = ModelClient(Store(tmp_path / 'other'))._instance_salt()
    assert other != first


def test_empty_content_settles_known_usage(tmp_path):
    import asyncio

    s = configured(tmp_path, base_url='https://example.test/v1', name='m')

    def handler(request):
        return httpx.Response(200, json={'choices': [{'message': {'content': ''}}],
                                         'usage': {'prompt_tokens': 7, 'completion_tokens': 3}})

    async def run():
        with patched(handler):
            with pytest.raises(Rejected):
                await ModelClient(s).complete([{'role': 'user', 'content': 'x'}])

    asyncio.run(run())
    row = s.rows('SELECT input,output FROM usage')[0]
    assert row['input'] == 7 and row['output'] == 3


def test_catalog_efforts_are_consistent():
    from qqagent.app import MODEL_CATALOG
    from qqagent.config import REASONING_EFFORTS

    for item in MODEL_CATALOG:
        assert set(item['efforts']) <= set(REASONING_EFFORTS)
        assert item['default_effort'] in item['efforts']
        assert item['max_output'] > 0 and item['context'] >= 1000
