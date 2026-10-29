import json
from unittest.mock import patch
import httpx
import pytest
from qqagent.store import Store,now
from qqagent.adapters import Channels,ModelClient,Rejected,Uncertain,segments,image_data

@pytest.mark.parametrize('data',[None,[],{}, {'status':'ok','data':{}}, {'retcode':False,'data':{}}, {'retcode':0,'data':[]}, {'retcode':0,'data':{},'status':'garbage'}])
@pytest.mark.asyncio
async def test_malformed_write_response_is_unknown(tmp_path,data):
    s=Store(tmp_path);original=httpx.AsyncClient
    with patch('qqagent.adapters.httpx.AsyncClient',lambda **kw:original(transport=httpx.MockTransport(lambda req:httpx.Response(200,json=data)),**kw)):
        with pytest.raises(Uncertain):await Channels(s).call('qq','send_private_msg',{},write=True)

@pytest.mark.asyncio
async def test_explicit_failure_is_not_success(tmp_path):
    original=httpx.AsyncClient
    with patch('qqagent.adapters.httpx.AsyncClient',lambda **kw:original(transport=httpx.MockTransport(lambda req:httpx.Response(200,json={'retcode':0,'status':'failed','data':None})),**kw)):
        with pytest.raises(Rejected):await Channels(Store(tmp_path)).call('qq','send_private_msg',{},write=True)

@pytest.mark.parametrize('usage',[[], {'prompt_tokens':True,'completion_tokens':1}, {'prompt_tokens':-1,'completion_tokens':'2'}, {'prompt_tokens':4,'completion_tokens':None}, {'prompt_tokens':{'private':'x'},'completion_tokens':1}])
@pytest.mark.asyncio
async def test_usage_is_unknown_instead_of_corrupting_budget(tmp_path,usage):
    s=Store(tmp_path);cfg=s.get('config');cfg['model'].update(base_url='http://127.0.0.1:1/v1',name='mock');s.save_config(cfg,s.get('revision'));s.put_secret('model_key','SECRET_SENTINEL')
    original=httpx.AsyncClient
    def respond(req):return httpx.Response(200,json={'choices':[{'message':{'content':'OK'}}],'usage':usage})
    with patch('qqagent.adapters.httpx.AsyncClient',lambda **kw:original(transport=httpx.MockTransport(respond),**kw)):
        assert await ModelClient(s).complete([{'role':'user','content':'x'}])=='OK'
    assert s.day_usage(0)['unknown']==1
    row=s.rows('SELECT * FROM usage')[0]
    assert row['input'] is None or type(row['input']) is int and row['input']>=0
    assert row['output'] is None or type(row['output']) is int and row['output']>=0
    assert row['cost'] is None

@pytest.mark.parametrize('raw',[None,[],[None,{'type':'image','data':None}],[{'type':'text','data':[]}]])
def test_malformed_segments(raw):assert segments(raw)==[]

@pytest.mark.asyncio
async def test_dns_failure_redacted():
    with patch('qqagent.adapters.socket.getaddrinfo',side_effect=OSError('PRIVATE_SENTINEL')):
        with pytest.raises(Rejected) as e:await image_data('https://gchat.qpic.cn/a')
    assert 'PRIVATE_SENTINEL' not in str(e.value)

@pytest.mark.parametrize('length',['bad','-1','999999999999'])
@pytest.mark.asyncio
async def test_invalid_image_lengths(length):
    original=httpx.AsyncClient
    def reply(req):return httpx.Response(200,headers={'content-length':length},content=b'GIF89aDATA')
    with patch('qqagent.adapters.socket.getaddrinfo',return_value=[(2,1,6,'',('8.8.8.8',443))]),patch('qqagent.adapters.httpx.AsyncClient',lambda **kw:original(transport=httpx.MockTransport(reply),**kw)):
        with pytest.raises(Rejected):await image_data('https://gchat.qpic.cn/a')
