import asyncio,json,time
import pytest,httpx
from unittest.mock import patch
from qqagent.store import Store,now,js
from qqagent.engine import Engine
from qqagent.adapters import Channels,MockChannels,ModelClient,Rejected,Uncertain
from qqagent.worker import poll_qzone,autonomous
from test_core import seed

@pytest.mark.asyncio
async def test_actual_adapter_separates_routes(tmp_path):
    s=Store(tmp_path);calls=[]
    def handle(req):
        calls.append((str(req.url),json.loads(req.content)));return httpx.Response(200,json={'retcode':0,'data':{'message_id':1}})
    original=httpx.AsyncClient
    def client(**kwargs):return original(transport=httpx.MockTransport(handle),**kwargs)
    with patch('qqagent.adapters.httpx.AsyncClient',client):
        ch=Channels(s)
        await ch.send({'channel':'qq','friend':'10001','action':'reply','payload':js({'segments':[{'type':'text','data':{'text':'TEST'}}]})})
        await ch.send({'channel':'qzone','friend':'10001','action':'reply_comment','payload':js({'tid':'tid','user_id':12345,'reply_comment_id':'c','reply_uin':'10001','content':'TEST'})})
    assert calls[0][0]=='http://127.0.0.1:13700/send_private_msg'
    assert calls[1][0]=='http://127.0.0.1:13702/send_comment'
    assert calls[1][1]['reply_comment_id']=='c'

@pytest.mark.asyncio
@pytest.mark.parametrize('error',[httpx.ReadTimeout('timeout'),httpx.RemoteProtocolError('bad')])
async def test_transport_uncertainty(tmp_path,error):
    s=Store(tmp_path)
    def handle(req):raise error
    original=httpx.AsyncClient
    with patch('qqagent.adapters.httpx.AsyncClient',lambda **kw:original(transport=httpx.MockTransport(handle),**kw)):
        with pytest.raises(Uncertain):await Channels(s).call('qq','send_private_msg',{},write=True)
        with pytest.raises(Rejected):await Channels(s).call('qq','get_status')

class FakeModel:
    def __init__(self,text='[REPLY_SENTINEL]'):self.calls=[];self.text=text
    async def complete(self,messages,*args,**kwargs):self.calls.append(messages);return self.text

@pytest.mark.asyncio
async def test_inbound_reply_and_memory_scope(tmp_path):
    s=Store(tmp_path);seed(s);e=Engine(s,lambda:{'ok':True});e.channels=MockChannels();e.model=FakeModel()
    with s.db() as c:c.execute('INSERT INTO memories(friend,kind,body,source,label,created) VALUES(?,?,?,?,?,?)',('20002','memory','OTHER_FRIEND_PRIVATE','source','fact',now()))
    for mid,txt in [(1,'我喜欢[INPUT_SENTINEL]'),(2,'[NEXT_SENTINEL]')]:e.ingest('qq',{'user_id':10001,'message_id':mid,'time':now()-3,'message':txt})
    await e.process_pending();assert len(e.channels.sent)==1 and len(e.model.calls)==1
    assert 'OTHER_FRIEND_PRIVATE' not in json.dumps(e.model.calls)
    assert s.rows('SELECT body FROM memories WHERE friend=?',('10001',))[0]['body']=='我喜欢[INPUT_SENTINEL]'
    assert s.active_persona()['body']=='[OPAQUE_TEST_SENTINEL]'

@pytest.mark.asyncio
async def test_qzone_public_never_reads_private_memory(tmp_path):
    s=Store(tmp_path);seed(s);cfg=s.get('config');cfg['qzone'].update(enabled=True,comment=True,like=True);s.save_config(cfg,s.get('revision'))
    with s.db() as c:c.execute('INSERT INTO memories(friend,kind,body,source,label,created) VALUES(?,?,?,?,?,?)',('10001','memory','PRIVATE_SENTINEL','source','fact',now()))
    e=Engine(s,lambda:{'ok':True});e.channels=MockChannels();e.model=FakeModel('{"like":true,"comment":"[COMMENT_SENTINEL]"}')
    s.set('qzone_baseline',now()-100)
    e.ingest('qzone',{'user_id':10001,'event_id':'feed:tid','tid':'tid','text':'[PUBLIC_SENTINEL]','time':now()-3});await e.process_pending()
    assert len(e.channels.sent)==2
    assert 'PRIVATE_SENTINEL' not in json.dumps(e.model.calls)

@pytest.mark.asyncio
async def test_initial_poll_all_historical_baseline(tmp_path):
    s=Store(tmp_path);seed(s);cfg=s.get('config');cfg['qzone'].update(enabled=True,read=True);s.save_config(cfg,s.get('revision'))
    e=Engine(s)
    class Bridge:
        async def call(self,*args):return {'msglist':[{'uin':'10001','tid':str(i),'content':'x','created_time':now()} for i in range(3)],'has_more':False}
    e.channels=Bridge();await poll_qzone(e)
    assert all(r['state']=='baseline' for r in s.rows('SELECT state FROM events'))

@pytest.mark.asyncio
async def test_restore_no_replay_model_not_called(tmp_path):
    s=Store(tmp_path);seed(s);e=Engine(s,lambda:{'ok':True});e.model=FakeModel()
    from qqagent.backup import export,restore
    e.ingest('qq',{'user_id':10001,'message_id':1,'time':now()-3,'message':'x'})
    restore(s,export(s));await e.process_pending();assert not e.model.calls

@pytest.mark.asyncio
async def test_unknown_usage_reserved(tmp_path):
    s=Store(tmp_path);cfg=s.get('config');cfg['model'].update(base_url='http://127.0.0.1:12345/v1',name='mock');cfg['policy']['token_daily']=100;s.save_config(cfg,s.get('revision'));s.put_secret('model_key','KEY_SENTINEL')
    original=httpx.AsyncClient
    def handle(req):return httpx.Response(200,json={'choices':[{'message':{'content':'OK'}}]})
    with patch('qqagent.adapters.httpx.AsyncClient',lambda **kw:original(transport=httpx.MockTransport(handle),**kw)):
        m=ModelClient(s);assert await m.complete([{'role':'user','content':'x'}])=='OK'
        with pytest.raises(Rejected):await m.complete([{'role':'user','content':'x'}])
    assert s.day_usage(0)['unknown']==1
