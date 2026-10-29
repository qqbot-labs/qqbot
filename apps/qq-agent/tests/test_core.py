import asyncio,json,sqlite3,time
import pytest
from fastapi.testclient import TestClient
from qqagent.app import create_app
from qqagent.store import Store,js,now
from qqagent.engine import Engine
from qqagent.adapters import MockChannels,segments,Rejected,image_data,Channels
from qqagent.backup import export,restore,validate
from qqagent.config import Configuration

@pytest.fixture
def app(tmp_path):return create_app(tmp_path,background=False)
@pytest.fixture
def client(app):
    with TestClient(app) as c:
        password=(app.state.store.root/'admin-password.txt').read_text().strip()
        r=c.post('/api/login',json={'password':password});assert r.status_code==200
        c.headers['x-csrf-token']=r.json()['csrf'];yield c

def seed(s):
    with s.db() as c:
        cur=c.execute('INSERT INTO personas(body,created) VALUES(?,?)',('[OPAQUE_TEST_SENTINEL]',now()));id=cur.lastrowid
        c.execute("INSERT INTO friends(id,name,permissions,updated) VALUES('10001','test',?,?)",(js({'reply':True,'proactive':True,'read':True,'like':True,'comment':True}),now()))
    s.set('persona_active',id);cfg=s.get('config');cfg['channel']['enabled']=True;cfg['policy']['enabled']=True;cfg['policy']['quiet_start']=cfg['policy']['quiet_end']=0;s.save_config(cfg,s.get('revision'));s.control(stop=False,pause=False,running=True)

def test_auth_no_leak(app):
    with TestClient(app) as c:
        for path in ['status','config','personas','friends','memories','activity','backup','diagnostics']:
            assert c.get('/api/'+path).status_code==401
        assert c.get('/healthz').status_code==200

def test_csrf_origin(client):
    assert client.post('/api/control',headers={'origin':'https://evil.example'},json={'stop':False}).status_code==403
    assert client.post('/api/control',headers={'x-csrf-token':''},json={'stop':False}).status_code==403

def test_empty_persona(client,app):
    assert client.get('/api/personas').json()=={'active':None,'versions':[]}
    assert client.post('/api/personas',json={'body':'','enable':True}).status_code==400
    assert app.state.store.active_persona() is None

def test_persona_roundtrip(client,app):
    body='  [USER_INPUT_SENTINEL]\n\n\t'
    r=client.post('/api/personas',json={'body':body,'enable':False}).json()
    assert app.state.store.active_persona() is None
    assert client.post('/api/personas/activate',json={'id':r['id']}).status_code==200
    assert app.state.store.active_persona()['body']==body

def test_config_conflict_validation(client):
    d=client.get('/api/config').json();d['config']['policy']['total_daily']=-1
    assert client.put('/api/config',json={'revision':d['revision'],'config':d['config']}).status_code==400
    d=client.get('/api/config').json();payload={'revision':d['revision'],'config':d['config']}
    assert client.put('/api/config',json=payload).status_code==200
    assert client.put('/api/config',json=payload).status_code==400

@pytest.mark.parametrize('name',['model_key','qq_token','qzone_cookie'])
def test_secrets_encrypted_and_mask(client,app,name):
    assert client.put('/api/secrets',json={'name':name,'value':'SECRET_SENTINEL'}).status_code==200
    assert app.state.store.secret(name)=='SECRET_SENTINEL'
    assert 'SECRET_SENTINEL' not in client.get('/api/config').text
    assert 'SECRET_SENTINEL' not in client.get('/api/backup').text
    assert 'SECRET_SENTINEL' not in client.get('/api/diagnostics').text
    assert b'SECRET_SENTINEL' not in app.state.store.path.read_bytes()
    client.put('/api/secrets',json={'name':name,'value':''});assert app.state.store.secret(name)=='SECRET_SENTINEL'
    assert client.put('/api/secrets',json={'name':name,'value':'******'}).status_code==400
    client.put('/api/secrets',json={'name':name,'clear':True});assert not app.state.store.secret(name)

@pytest.mark.asyncio
async def test_simulation():
    from qqagent.simulation import run_simulation
    r=await run_simulation();assert r['passed']

@pytest.mark.asyncio
@pytest.mark.parametrize('outcome,expected',[('success','success'),('unknown','unknown'),('failed','failed')])
async def test_no_retry(tmp_path,outcome,expected):
    s=Store(tmp_path);seed(s);e=Engine(s,lambda:{'ok':True});m=MockChannels(outcome);e.channels=m
    id=e.enqueue('qq:1','qq','10001','reply',{'segments':[]})
    result=await e.dispatch(id);assert result['status']==expected
    await e.dispatch(id);assert len(m.sent)==1

@pytest.mark.asyncio
async def test_concurrent_budget(tmp_path):
    s=Store(tmp_path);seed(s);cfg=s.get('config');cfg['policy']['total_daily']=1;s.save_config(cfg,s.get('revision'))
    e=Engine(s,lambda:{'ok':True});e.channels=MockChannels()
    ids=[e.enqueue('qq:'+str(i),'qq','10001','reply',{'segments':[]}) for i in range(5)]
    r=await asyncio.gather(*(e.dispatch(id) for id in ids));assert sum(x['status']=='success' for x in r)==1

@pytest.mark.asyncio
async def test_stop_before_dispatch(tmp_path):
    s=Store(tmp_path);seed(s);e=Engine(s,lambda:{'ok':True});e.channels=MockChannels()
    id=e.enqueue('qq:1','qq','10001','reply',{'segments':[]});s.control(stop=True)
    assert (await e.dispatch(id))['status']=='cancelled';assert not e.channels.sent

@pytest.mark.parametrize('key',['reply','proactive','like','comment','read'])
def test_permission_independent(tmp_path,key):
    s=Store(tmp_path);seed(s)
    with s.db() as c:c.execute('UPDATE friends SET permissions=?',(js({key:True}),))
    e=Engine(s)
    for other in ('reply','proactive','like','comment','read'):assert e.permitted('10001',other)==(key==other)
    assert not e.permitted('20002',key)

def test_optout_restart(tmp_path):
    s=Store(tmp_path);seed(s);e=Engine(s);event={'user_id':10001,'message_id':88,'time':now(),'message':'停止互动'}
    e.ingest('qq',event);assert not e.permitted('10001','reply');s2=Store(tmp_path);assert not Engine(s2).permitted('10001','reply')
    assert e.ingest('qq',event)['duplicate'];assert not e.ingest('qzone',{**event,'event_id':88}).get('duplicate')

def test_restart_cancels_and_unknown(tmp_path):
    s=Store(tmp_path);seed(s);e=Engine(s)
    a=e.enqueue('1','qq','10001','reply',{});b=e.enqueue('2','qq','10001','reply',{})
    with s.db() as c:c.execute("UPDATE ledger SET status='sending' WHERE id=?",(b,))
    s2=Store(tmp_path);r={r['id']:r['status'] for r in s2.rows('SELECT * FROM ledger')};assert r[a]=='cancelled' and r[b]=='unknown'

def test_backup_integrity_restore(tmp_path):
    s=Store(tmp_path);seed(s);s.put_secret('model_key','SECRET_SENTINEL');b=export(s);validate(b)
    b['data']['meta']['config']['policy']['total_daily']=5
    with pytest.raises(ValueError):validate(b)
    b=export(s);restore(s,b);assert s.get('stop_all') and s.get('pause_active') and not s.get('social_running')
    assert s.secret('model_key')=='SECRET_SENTINEL';assert s.active_persona()['body']=='[OPAQUE_TEST_SENTINEL]'

def test_memory_scope(client):
    for friend in ('10001','20002'):
        assert client.post('/api/memories',json={'friend':friend,'body':friend+' PRIVATE','source':'owner','label':'fact'}).status_code==200
    r=client.get('/api/memories?friend=10001').json();assert len(r)==1 and r[0]['friend']=='10001'
    assert not client.get('/api/memories').json()

@pytest.mark.parametrize('url',['file:///etc/passwd','http://127.0.0.1/a','https://evil.test/a','https://gchat.qpic.cn:8443/a'])
@pytest.mark.asyncio
async def test_image_ssrf(url):
    with pytest.raises(Rejected):await image_data(url)

def test_segments():
    seg=segments('a[CQ:image,url=https://gchat.qpic.cn/x?a=1&#44;b=2]b[CQ:reply,id=5]')
    assert seg[1]['type']=='image' and seg[1]['data']['url'].endswith('a=1,b=2')
    assert seg[-1]['type']=='reply'

def test_shell_rejected(client):
    assert client.post('/api/components',json={'component':'$(id)','action':'start'}).status_code==400

def test_no_implicit_identity_generation(client,app):
    assert not client.get('/api/personas').json()['versions']
    assert client.post('/api/memories',json={'friend':'10001','body':'X','source':'owner','kind':'growth'}).status_code==400

def test_persona_diff_preserves_original_and_shows_lines(client,app):
    a=client.post('/api/personas',json={'body':'[SENTINEL_A]\n','enable':False}).json()['id']
    b=client.post('/api/personas',json={'body':'[SENTINEL_B]\n','enable':False}).json()['id']
    r=client.get(f'/api/personas/diff?base={a}&target={b}').json()
    assert '-[SENTINEL_A]' in r['diff'] and '+[SENTINEL_B]' in r['diff']
    assert app.state.store.rows('SELECT body FROM personas WHERE id=?',(a,))[0]['body']=='[SENTINEL_A]\n'
    assert client.get('/api/personas/diff?target=999').status_code==404
