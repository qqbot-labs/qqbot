import asyncio, base64, difflib, hashlib, hmac, json, os, secrets, time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from .store import Store, js, now
from .engine import Engine
from .config import Permissions
from .runtime import Runtime
from .adapters import Rejected
from . import backup

class Input(BaseModel):model_config=ConfigDict(extra='forbid',strict=True)
class Login(Input):password:str=Field(max_length=200)
class ConfigInput(Input):revision:int;config:dict
class SecretInput(Input):name:str;value:str=Field('',max_length=20000);clear:bool=False
class PersonaInput(Input):body:str=Field(max_length=100000);enable:bool=False
class Activate(Input):id:int|None
class Control(Input):pause:bool|None=None;stop:bool|None=None;running:bool|None=None
class FriendInput(Input):id:str;permissions:Permissions;reset_optout:bool=False
class MemoryInput(Input):friend:str;body:str=Field(min_length=1,max_length=5000);source:str=Field(min_length=1,max_length=500);label:str='fact';kind:str='memory'
class TestInput(Input):text:str=Field(min_length=1,max_length=1000);request_id:str=Field(min_length=8,max_length=100)
class Component(Input):component:str;action:str

# 建议目录，不是白名单：手动填写其他 OpenAI-compatible 模型仍然可用。
MODEL_CATALOG=(
    {'id':'deepseek-v4.1-flash','label':'DeepSeek V4.1 Flash','vision':True,'context':1000000,'max_output':384000,
     'input_price':0.15,'output_price':0.60,'efforts':['low','medium','high','max'],'default_effort':'low',
     'note':'日常主力，支持图片输入；默认推理强度 low'},
    {'id':'deepseek-v4-pro','label':'DeepSeek V4 Pro','vision':False,'context':1000000,'max_output':384000,
     'input_price':0.66,'output_price':1.98,'efforts':['high','max'],'default_effort':'high',
     'note':'更强推理与代码能力，纯文本，成本更高'},
    {'id':'deepseek-v4-flash','label':'DeepSeek V4 Flash','vision':False,'context':1000000,'max_output':384000,
     'input_price':0.15,'output_price':0.60,'efforts':['low','medium','high','max'],'default_effort':'low',
     'note':'上一代 Flash，纯文本；同价位优先 V4.1 Flash'},
    {'id':'deepseek-v4-flash-vision-exp','label':'DeepSeek V4 Flash Vision Exp','vision':True,'context':1000000,
     'max_output':384000,'input_price':0.15,'output_price':0.60,'efforts':['low','medium','high','max'],
     'default_effort':'low','note':'实验性视觉模型；通常可直接用 V4.1 Flash 代替'},
)


def create_app(data_dir=None,project_root=None,background=True):
    root=Path(project_root or Path(__file__).resolve().parents[1]);s=Store(data_dir or os.environ.get('QQAGENT_DATA',root/'.runtime'))
    runtime=Runtime(root);engine=Engine(s,runtime.versions)
    public_origin=os.environ.get('QQAGENT_PUBLIC_ORIGIN','')
    public_url=urlsplit(public_origin)
    if public_origin and (public_url.scheme!='https' or not public_url.hostname or public_url.username or public_url.password or public_url.path or public_url.query or public_url.fragment):
        raise ValueError('公网入口必须为不带路径和凭据的 HTTPS origin')
    # First password is only written to an owner-readable local file, never printed/logged.
    if not s.get('password_hash'):
        pw=secrets.token_urlsafe(24);salt=secrets.token_bytes(16)
        s.set('password_hash',{'salt':salt.hex(),'hash':hashlib.scrypt(pw.encode(),salt=salt,n=16384,r=8,p=1).hex()})
        p=s.root/'admin-password.txt';p.write_text(pw+'\n');p.chmod(0o600)
    @asynccontextmanager
    async def lifespan(app):
        tasks=[]
        if background:
            tasks=[asyncio.create_task(engine.loop())]
            from .worker import event_loop,periodic
            tasks.extend([asyncio.create_task(event_loop(engine,'qq')),asyncio.create_task(periodic(engine))])
        yield
        engine.stopping=True
        for t in tasks:t.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
    app=FastAPI(title='QQ Agent 统一管理台',docs_url=None,redoc_url=None,openapi_url=None,lifespan=lifespan)
    app.state.store=s;app.state.engine=engine;app.state.runtime=runtime
    attempts={}
    @app.middleware('http')
    async def security(req,call_next):
        host=req.url.hostname
        local_host=host in ('127.0.0.1','localhost','::1','testserver')
        public_host=bool(public_origin) and req.url.scheme=='https' and req.url.netloc==public_url.netloc
        if not (local_host or public_host):return JSONResponse({'detail':'Host 不允许'},400)
        if req.method not in ('GET','HEAD','OPTIONS'):
            origin=req.headers.get('origin')
            if origin and origin!=str(req.base_url).rstrip('/'):return JSONResponse({'detail':'Origin 不允许'},403)
            length=req.headers.get('content-length')
            if length and (not length.isdecimal() or int(length)>8*1024*1024):return JSONResponse({'detail':'提交超过限制'},413)
            chunks=[];received=0
            async for chunk in req.stream():
                received+=len(chunk)
                if received>8*1024*1024:return JSONResponse({'detail':'提交超过限制'},413)
                chunks.append(chunk)
            req._body=b''.join(chunks)

        if req.url.path.startswith('/api/') and req.url.path!='/api/login':
            sid=req.cookies.get('qqagent_session','');rows=s.rows('SELECT * FROM sessions WHERE id=? AND expires>?',(hashlib.sha256(sid.encode()).hexdigest(),now()))
            if not rows:return JSONResponse({'detail':'请登录管理台'},401)
            req.state.session=rows[0]
            if req.method not in ('GET','HEAD') and not hmac.compare_digest(req.headers.get('x-csrf-token',''),rows[0]['csrf']):return JSONResponse({'detail':'CSRF 校验失败'},403)
        res=await call_next(req)
        for k,v in {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}.items():res.headers[k]=v
        return res
    def validation_message(e):
        # 校验结果不得回显密码、密钥、Cookie 或用户原文。
        return '；'.join('.'.join(str(x) for x in error['loc'])+': '+error['msg'] for error in e.errors(include_input=False,include_url=False))[:600]
    @app.exception_handler(ValidationError)
    async def invalid_config(req,e):return JSONResponse({'detail':validation_message(e)},400)
    @app.exception_handler(RequestValidationError)
    async def invalid_request(req,e):
        return JSONResponse({'detail':'提交格式无效，请检查字段类型与长度'},422)
    @app.exception_handler(ValueError)
    async def invalid(req,e):return JSONResponse({'detail':str(e)[:600]},400)
    @app.exception_handler(Rejected)
    async def adapter_error(req,e):return JSONResponse({'detail':str(e)[:300]},502)
    @app.get('/')
    def index():return FileResponse(root/'qqagent/static/index.html')
    @app.get('/healthz')
    def health():return {'service':'qq-agent-console','ok':True,'version':'0.1.0'}
    @app.post('/api/login')
    def login(data:Login,req:Request):
        ip=req.client.host if req.client else 'local';record=attempts.get(ip,[]);record=[x for x in record if now()-x<300]
        if len(record)>=10:raise HTTPException(429,'登录过于频繁，请五分钟后重试')
        record.append(now());attempts[ip]=record
        ph=s.get('password_hash');digest=hashlib.scrypt(data.password.encode(),salt=bytes.fromhex(ph['salt']),n=16384,r=8,p=1).hex()
        if not hmac.compare_digest(digest,ph['hash']):raise HTTPException(401,'管理密码不正确')
        attempts[ip]=[];sid=secrets.token_urlsafe(32);csrf=secrets.token_urlsafe(32)
        with s.db() as c:c.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(sid.encode()).hexdigest(),csrf,now()+8*3600))
        res=JSONResponse({'csrf':csrf});res.set_cookie('qqagent_session',sid,httponly=True,samesite='strict',secure=req.url.scheme=='https',max_age=8*3600);return res
    @app.get('/api/session')
    def session(req:Request):return {'csrf':req.state.session['csrf']}
    @app.post('/api/logout')
    def logout(req:Request):
        with s.db() as c:c.execute('DELETE FROM sessions WHERE id=?',(req.state.session['id'],))
        res=JSONResponse({'ok':True});res.delete_cookie('qqagent_session');return res
    def channel_state(channel):
        state=s.get('health_'+channel)
        if not isinstance(state,dict):return {'online':False,'verified':False,'reason':'未检查；待配置/登录'}
        checked=state.get('checked')
        if type(checked) not in (int,float) or not 0<=now()-checked<=300:
            return {**state,'online':False,'verified':False,'reason':'最近检查已过期，请重新检查'}
        return state
    @app.get('/api/status')
    def status():
        p=s.active_persona();usage=s.day_usage(engine.day());stat=os.statvfs(s.root)
        return {'version':'0.1.0','versions':runtime.versions(),'persona':{'active':p['id'] if p else None,'state':'已启用' if p else '人格待填写或未启用'},'controls':{k:s.get(k) for k in ('pause_active','stop_all','social_running')},'channels':{k:channel_state(k) for k in ('qq','qzone','model','search')},'usage':usage,'disk_free':stat.f_bavail*stat.f_frsize,'secrets':s.secret_states(),'recent_errors':s.rows("SELECT * FROM logs WHERE result IN ('failed','unknown','blocked') ORDER BY id DESC LIMIT 5"),'tasks':s.rows('SELECT * FROM tasks'),'state':'全部发信停止' if s.get('stop_all') else '待人格' if not p else '正式社交关闭' if not s.config().policy.enabled or not s.get('social_running') else '主动暂停' if s.get('pause_active') else '运行'}
    @app.get('/api/config')
    def configuration():
        # 返回经校验并补齐新字段的配置，避免旧库缺少 search/reasoning_effort 时前端字段为空。
        return {'revision':s.get('revision'),'config':s.config().model_dump(),'secrets':s.secret_states(),'schema':s.config().model_json_schema()}
    @app.get('/api/model-catalog')
    def model_catalog():
        return {'models':[dict(item) for item in MODEL_CATALOG],
                'efforts':[{'id':'low','name':'低（更快更省）'},{'id':'medium','name':'中'},
                           {'id':'high','name':'高'},{'id':'max','name':'最高'}],
                'note':'条目为建议参数；保存前请核对供应商价格与上下文。OpenCode Go 需要的会话头由后端自动附带。'}
    @app.put('/api/config')
    def save_configuration(data:ConfigInput):
        rev=s.save_config(data.config,data.revision);s.log('','config','saved','配置已应用到管理后端；渠道连接按配置重新建立')
        return {'revision':rev,'state':'已应用','component_note':'桥接凭据/组件配置另行同步，必要时重启组件'}
    @app.put('/api/secrets')
    def secret(data:SecretInput):
        if data.name not in s.secret_states():raise ValueError('不支持的凭据名')
        if data.clear:
            with s.db() as c:
                c.execute('DELETE FROM secrets WHERE k=?',(data.name,))
                c.execute("DELETE FROM meta WHERE k LIKE 'health_%'")
        else:s.put_secret(data.name,data.value)
        return {'configured':bool(s.secret(data.name)),'state':'已安全保存；组件凭据同步后生效' if data.name.startswith('qzone') else '已保存'}
    @app.post('/api/control')
    def control(data:Control):
        s.control(data.pause,data.stop,data.running)
        return {k:s.get(k) for k in ('pause_active','stop_all','social_running')}
    @app.post('/api/components')
    async def components(data:Component):
        if data.action=='stop':s.control(stop=True,running=False)
        return await runtime.control(data.component,data.action)
    @app.post('/api/check/{channel}')
    async def check(channel:str):
        if channel not in ('qq','qzone','model','search'):raise ValueError('检查类型无效')
        try:
            if channel=='model':
                text=await engine.model.complete([{'role':'user','content':'工程连通测试：仅回复 OK。'}],test=True);state={'online':True,'verified':True,'reason':'最小请求完成','sample':text[:80]}
            elif channel=='search':
                results=await engine.search.search('联网搜索连通测试');state={'online':True,'verified':True,'reason':'检索请求完成','sample':'返回 '+str(len(results))+' 条'}
            else:state=await engine.channels.health(channel)
            state['checked']=now();s.set('health_'+channel,state);return state
        except Exception as e:
            state={'online':False,'verified':True,'checked':now(),'reason':str(e) if isinstance(e,Rejected) else '连接失败；请检查组件与凭据'};s.set('health_'+channel,state);return state
    @app.post('/api/qzone/apply')
    async def qzone_apply():
        cookie=s.secret('qzone_cookie')
        if not cookie:return {'note':'没有新 Cookie；可使用扫码登录。'}
        try:
            async with httpx.AsyncClient(timeout=30,trust_env=False) as c:
                r=await c.post(s.config().qzone.http_url+'/auth-cookie',json={'cookie':cookie},headers={'Authorization':'Bearer '+s.secret('qzone_token')})
                if r.status_code!=200:raise Rejected('空间鉴权应用失败，请检查 Cookie 或重新扫码')
            return {'note':'Cookie 已提交给独立桥接；请执行连接自检确认实际登录状态'}
        except httpx.HTTPError:raise Rejected('空间桥接不可连接；凭据已保存，可稍后重试应用')
    @app.post('/api/login/{channel}')
    async def channel_login(channel:str):
        if channel=='qq':
            qr=Path('/var/lib/qq-agent-napcat/cache/qrcode.png')
            if qr.is_file() and now()-qr.stat().st_mtime<180:
                return {'image':'data:image/png;base64,'+base64.b64encode(qr.read_bytes()).decode(),'note':'NapCat 实际生成的二维码；登录不自动启用社交'}
            return {'note':'QQ 组件尚未生成有效二维码。先启动 NapCat；若版本不兼容，在运行状态中查看故障。不得使用其他账号代测。'}
        if channel=='qzone':
            try:
                async with httpx.AsyncClient(timeout=10,trust_env=False) as c:
                    headers={'Authorization':'Bearer '+s.secret('qzone_token')}
                    r=await c.get(s.config().qzone.http_url+'/qr',headers=headers)
                    if r.status_code==200:return r.json()
                    r=await c.post(s.config().qzone.http_url+'/login-qr',json={},headers=headers)
                    if r.status_code!=200:raise Rejected('空间扫码启动失败')
                    return r.json()
            except httpx.HTTPError:raise Rejected('空间桥接未运行，无法启动扫码')
        raise ValueError('渠道不支持')
    @app.get('/api/personas')
    def personas():return {'active':s.get('persona_active'),'versions':s.rows('SELECT * FROM personas ORDER BY id DESC')}
    @app.get('/api/personas/diff')
    def persona_diff(target:int,base:int=0):
        selected=s.rows('SELECT body FROM personas WHERE id=?',(target,))
        original=s.rows('SELECT body FROM personas WHERE id=?',(base,)) if base else []
        if not selected or (base and not original):raise HTTPException(404,'人格版本不存在')
        before=original[0]['body'] if original else ''
        after=selected[0]['body']
        lines=difflib.unified_diff(before.splitlines(keepends=True),after.splitlines(keepends=True),fromfile='生效版本 #'+str(base),tofile='选中版本 #'+str(target))
        return {'base':base,'target':target,'diff':''.join(lines),'identical':before==after}
    @app.post('/api/personas')
    def persona(data:PersonaInput):
        if data.enable and not data.body.strip():raise ValueError('空白人格不能启用')
        with s.db() as c:cur=c.execute('INSERT INTO personas(body,created) VALUES(?,?)',(data.body,now()));id=cur.lastrowid
        if data.enable:s.set('persona_active',id)
        return {'id':id,'active':s.get('persona_active')}
    @app.post('/api/personas/activate')
    def activate(data:Activate):
        if data.id is not None:
            rows=s.rows('SELECT * FROM personas WHERE id=?',(data.id,))
            if not rows or not rows[0]['body'].strip():raise ValueError('人格不存在或为空')
        s.set('persona_active',data.id);return {'active':data.id}
    @app.get('/api/friends')
    def friends():
        rows=s.rows("""SELECT f.*, a.last_interaction, a.last_proactive FROM friends f
            LEFT JOIN (SELECT friend,
            MAX(CASE WHEN status IN ('success','unknown') THEN updated END) last_interaction,
            MAX(CASE WHEN action='proactive' AND status IN ('sending','success','unknown') THEN updated END) last_proactive
            FROM ledger GROUP BY friend) a ON a.friend=f.id ORDER BY f.updated DESC""")
        cooldown=s.config().policy.cooldown_hours*3600
        for row in rows:
            proactive=row.pop('last_proactive')
            row['cooldown_until']=proactive+cooldown if proactive is not None else None
        return rows
    @app.post('/api/friends/sync')
    async def sync():
        data=await engine.channels.friends()
        with s.db() as c:
            for f in data:
                id=str(f['user_id']);name=str(f.get('remark') or f.get('nickname') or id)
                c.execute("INSERT INTO friends(id,name,updated) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated=excluded.updated",(id,name,now()))
        return {'count':len(data),'source':'QQ 消息通道好友列表'}
    @app.put('/api/friends')
    def friend(data:FriendInput):
        if not s.rows('SELECT id FROM friends WHERE id=?',(data.id,)):raise ValueError('请先同步真实好友列表')
        with s.db() as c:
            c.execute('UPDATE friends SET permissions=?,updated=? WHERE id=?',(js(data.permissions.model_dump()),now(),data.id))
            if data.reset_optout:c.execute("UPDATE friends SET optout='{}' WHERE id=?",(data.id,))
            s.bump(c,'cancel_epoch')
        return {'saved':True}
    @app.get('/api/memories')
    def memories(friend:str='',q:str='',kind:str='memory'):
        if kind not in ('memory','growth'):raise ValueError('记忆类型无效')
        # 只有 kind=growth 允许 friend=''：公开成长素材，不含任何好友私聊记忆。
        if not friend and kind!='growth':return []
        pattern='%'+q.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
        return s.rows("SELECT * FROM memories WHERE friend=? AND kind=? AND body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 500",(friend,kind,pattern))
    @app.post('/api/memories')
    def memory(data:MemoryInput):
        if data.label not in ('fact','inference','unverified') or data.kind not in ('memory','growth'):raise ValueError('记忆类型无效')
        if not data.friend and data.kind!='growth':raise ValueError('只有成长素材允许公开范围')
        if data.friend and (not data.friend.isascii() or not data.friend.isdecimal() or not 5<=len(data.friend)<=12):raise ValueError('好友标识无效')
        if data.kind=='growth' and (not s.active_persona() or not s.config().policy.growth):raise ValueError('人格启用且成长记录开启后方可写入')
        with s.db() as c:cur=c.execute('INSERT INTO memories(friend,kind,body,source,label,created) VALUES(?,?,?,?,?,?)',(data.friend,data.kind,data.body,data.source,data.label,now()))
        return {'id':cur.lastrowid}
    @app.delete('/api/memories/{id}')
    def delete_memory(id:int):
        with s.db() as c:changed=c.execute('DELETE FROM memories WHERE id=?',(id,)).rowcount
        if not changed:raise HTTPException(404,'记录不存在或已删除')
        return {'deleted':True,'note':'运行库已删除；历史备份不会被修改，需按保留策略清理'}
    @app.put('/api/memories/{id}')
    def update_memory(id:int,data:MemoryInput):
        if data.label not in ('fact','inference','unverified') or data.kind not in ('memory','growth'):raise ValueError('记忆类型或事实标记无效')
        with s.db() as c:changed=c.execute('UPDATE memories SET body=?,source=?,label=? WHERE id=? AND friend=? AND kind=?',(data.body,data.source,data.label,id,data.friend,data.kind)).rowcount
        if not changed:raise HTTPException(404,'记录不存在或作用域不匹配')
        return {'updated':True}
    @app.get('/api/activity')
    def activity(friend:str='',result:str='',action:str='',since:float=0):
        args=(friend,friend,result,result,action,action,since)
        # 账本与日志使用同一好友/动作/时间条件；result 在账本中对应 status。
        ledger_args=(friend,friend,action,action,result,result,since)
        return {'logs':s.rows("SELECT * FROM logs WHERE (?='' OR friend=?) AND (?='' OR result=?) AND (?='' OR action=?) AND created>=? ORDER BY id DESC LIMIT 200",args),'ledger':s.rows("SELECT id,event,channel,friend,action,status,detail,created,updated FROM ledger WHERE (?='' OR friend=?) AND (?='' OR action=?) AND (?='' OR status=?) AND created>=? ORDER BY created DESC LIMIT 200",ledger_args),'tasks':s.rows('SELECT * FROM tasks')}
    @app.get('/api/qzone/events')
    def qzone_events():return {'events':s.rows("SELECT id,friend,created,state FROM events WHERE channel='qzone' ORDER BY created DESC LIMIT 100"),'baseline':s.get('qzone_baseline'),'coverage':'未登录时未验证；轮询、分页和解析可能缺项'}
    @app.post('/api/test-send')
    async def test_send(data:TestInput):
        owner=s.config().channel.owner_id
        if not owner:raise ValueError('请先配置主人 QQ ID')
        id=engine.enqueue('owner-test:'+data.request_id,'qq',owner,'reply',{'segments':[{'type':'text','data':{'text':data.text}}]},test=True)
        return await engine.dispatch(id)
    @app.post('/api/simulate')
    async def simulate():
        from .simulation import run_simulation
        return await run_simulation()
    @app.get('/api/backup')
    def make_backup():return JSONResponse(backup.export(s),headers={'Content-Disposition':'attachment; filename=qq-agent-backup.json'})
    @app.post('/api/backup/restore')
    async def restore_backup(req:Request):
        async with engine.decide_lock:
            async with engine.send_lock:return backup.restore(s,await req.json())
    @app.get('/api/diagnostics')
    def diagnostics():return {'version':'0.1.0','versions':runtime.versions(),'config_revision':s.get('revision'),'controls':{k:s.get(k) for k in ('pause_active','stop_all')},'logs':[{'action':r['action'],'result':r['result'],'created':r['created']} for r in s.rows('SELECT * FROM logs ORDER BY id DESC LIMIT 100')],'privacy':'不含凭据、人格、好友标识或聊天内容'}
    app.mount('/static',StaticFiles(directory=root/'qqagent/static'),name='static')
    return app
