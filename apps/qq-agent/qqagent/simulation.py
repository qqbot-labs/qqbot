import asyncio,tempfile,json
from pathlib import Path
from .store import Store,js,now
from .engine import Engine
from .adapters import MockChannels,segments

async def run_simulation():
    results=[]
    def check(name,ok):results.append({'name':name,'passed':bool(ok)})
    with tempfile.TemporaryDirectory(prefix='qqagent-simulation-') as tmp:
        s=Store(tmp);e=Engine(s,lambda:{'ok':True});mock=MockChannels();e.channels=mock
        with s.db() as c:c.execute("INSERT INTO friends(id,name,permissions,updated) VALUES('10001','工程测试对象',?,?)",(js({'reply':True,'proactive':True}),now()))
        config=s.get('config');config['channel']['enabled']=True;config['policy']['enabled']=True;s.save_config(config,s.get('revision'));s.control(stop=False,running=True)
        id=e.enqueue('test:blank','qq','10001','reply',{'segments':[]});r=await e.dispatch(id);check('未启用人格阻止正式发信',r['status']=='blocked' and not mock.sent)
        # Opaque sentinel, no name, identity, background, style or sample character.
        with s.db() as c:cur=c.execute('INSERT INTO personas(body,created) VALUES(?,?)',('[TEST_SENTINEL]',now()));active_id=cur.lastrowid
        s.set('persona_active',active_id)
        id=e.enqueue('test:stop','qq','10001','reply',{'segments':[]});s.control(stop=True);r=await e.dispatch(id);check('已生成待发送消息被停止冻结',r['status']=='cancelled' and not mock.sent)
        s.control(stop=False);id=e.enqueue('test:unknown','qq','10001','reply',{'segments':[]});mock.outcome='unknown';r=await e.dispatch(id);await e.dispatch(id);check('超时结果未知且不盲重发',r['status']=='unknown' and len(mock.sent)==1)
        event={'user_id':10001,'message_id':8,'time':now(),'message':[{'type':'text','data':{'text':'不要主动找我'}}]}
        first=e.ingest('qq',event);second=e.ingest('qq',event);check('渠道事件持久去重',bool(second.get('duplicate')))
        check('退订跨请求生效',not e.permitted('10001','proactive') and e.permitted('10001','reply'))
        event2={**event,'message_id':9,'message':'[CQ:image,url=https://gchat.qpic.cn/example.png]'};e.ingest('qq',event2);check('图片消息段/CQ码解析',segments(event2['message'])[0]['type']=='image')
        with s.db() as c:c.execute('INSERT INTO memories(friend,kind,body,source,label,created) VALUES(?,?,?,?,?,?)',('20002','memory','PRIVATE_SENTINEL','sim','fact',now()))
        check('记忆读取前按好友隔离',not s.rows('SELECT body FROM memories WHERE friend=?',('10001',)))
        q=e.ingest('qzone',{'user_id':10001,'event_id':'old','time':now()-86400,'text':'基线'});check('空间首次历史基线不补评',q['state']=='baseline')
        from .backup import export,restore
        b=export(s);check('备份不包含凭据', 'secrets' not in b['data']['tables'] and 'password_hash' not in b['data']['meta'])
        restore(s,b);check('恢复后保持停止与暂停',s.get('stop_all') and s.get('pause_active') and not s.get('social_running'))
    return {'mode':'隔离工程模拟；未调用 QQ/空间/模型','passed':all(r['passed'] for r in results),'results':results}
