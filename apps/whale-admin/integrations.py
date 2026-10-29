"""Typed DSH/QQ integration; requests never expose raw DSH tokens to the browser."""
import http.cookiejar,json,os,re,socket,time,urllib.request,uuid
from pathlib import Path
import domain as d

ROUTING=d.ROOT/'etc/admin-routing.json'
API_BASE=(os.environ.get('WHALE_API_BASE') or 'https://api.example.com/v1').rstrip('/')

def bridge(method,**args):
    path=d.ROOT/'data/.admin-control.sock'
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(105);s.connect(str(path));s.sendall((json.dumps({'method':method,**args})+'\n').encode())
        raw=s.makefile('rb').readline(2*1024*1024)
    r=json.loads(raw)
    if not r.get('ok'):raise d.Error(d.redact(str(r.get('error','会话操作失败'))))
    return r['data']

def rpc(method,args):
    tokens=re.findall(r'http://127\.0\.0\.1:3080/\?token=([A-Za-z0-9_.~-]+)',(d.ROOT/'logs/dsh.log').read_text(errors='replace'))
    if not tokens:raise d.Error('DSH 当前没有可用的管理凭据')
    base='http://127.0.0.1:3080';op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.open(base+'/?token='+tokens[-1],timeout=10).close()
    body={'type':'client-request','rpcId':str(uuid.uuid4()),'method':method,'payload':{'args':args}}
    req=urllib.request.Request(base+'/api/'+method,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':base})
    with op.open(req,timeout=30) as r:out=json.load(r)['result']
    if not out.get('ok'):raise d.Error(d.redact(str(out.get('error','DSH 请求失败'))))
    return out.get('value')

def catalog():
    e=d.envvalues();req=urllib.request.Request(API_BASE+'/models',headers={'Authorization':'Bearer '+e.get('WHALE_API_KEY','')})
    with urllib.request.urlopen(req,timeout=20) as r:data=json.load(r)
    return [{k:m.get(k) for k in ['id','name','routing_name','context_length','max_output_tokens','supports_images','can_disable_thinking']} for m in data.get('data',[]) if isinstance(m.get('id'),str) and re.fullmatch(r'[A-Za-z0-9_./:-]{1,160}',m['id'])]

def register_models():
    models=catalog();rows=d.load_profile();p=d.conf(rows,'llm-pi-ai')['providers']['whale-gateway'];known={m['id'] for m in p['models']}
    added=[]
    for m in models:
        if m['id'] in known:continue
        try:ctx=int(m.get('context_length') or 131072);output=int(m.get('max_output_tokens') or 8192)
        except (ValueError,TypeError):continue
        p['models'].append({'id':m['id'],'name':m.get('routing_name') or m.get('name') or m['id'],'contextWindow':ctx,'maxTokens':output,'input':['text'],'reasoningEfforts':{'off':None,'low':'low','high':'high','max':'max'}});added.append(m['id'])
    if added:
        backup=d.snapshot('同步网关模型目录');old=d.conf(rows,'persona')['prefix'].encode();text=d.yaml.dump(rows,Dumper=d.Dumper,allow_unicode=True,sort_keys=False,width=100000)
        if d.conf(d.yaml.load(text,Loader=d.Loader),'persona')['prefix'].encode()!=old:raise d.Error('人格字节校验失败')
        d.atomic(d.PROFILE,text.encode());d.audit('models.sync')
    return {'models':models,'added':added,'message':'模型目录已同步。新增模型需应用配置后可在会话中使用。' if added else '运行配置已包含这些模型。'}

def sessions():
    live=bridge('status');result=rpc('session/list',{'_request':{}});items=[]
    for x in result.get('items',[]):
        if x.get('cwd')!=str(d.ROOT/'workspace'):continue
        v=x.get('projections',{}).get('values',{});p=x.get('projections',{})
        items.append({'sessionId':x['sessionId'],'running':x.get('running',False),'updatedAt':x.get('updatedAt'),'title':v.get('title','未命名会话'),'preset':v.get('agentPreset'),'context':v.get('contextPressure',{}),'tokens':v.get('tokenUsage',{}),'stats':v.get('sessionStats',{}),'model':v.get('modelSelection',{}),'turnOutline':v.get('turnOutline',[])[-8:],'seq':p.get('asOfSeq')})
    return {'connection':live,'items':items}

def calls(args):
    sid=str(args.get('sessionId',''))
    if sid and not re.fullmatch(r'[a-zA-Z0-9_-]{6,90}',sid):raise d.Error('会话编号格式无效')
    # Only return session metadata: no hidden reasoning, raw keys or prompt contents.
    raw=d.run(['/usr/bin/node',str(Path(__file__).with_name('read-events.mjs')),'calls',sid],timeout=35)
    data=json.loads(raw)
    probes=d.STATE/'probes.jsonl'
    data['probes']=[json.loads(l) for l in probes.read_text().splitlines()[-50:]][::-1] if probes.exists() else []
    if sid:data['messages']=json.loads(d.run(['/usr/bin/node',str(Path(__file__).with_name('read-events.mjs')),'messages',sid],timeout=35))['messages']
    for c in data.get('calls',[]):c['errorMessage']=d.redact(c.get('errorMessage',''))
    return data

def routing_get():
    policy=json.loads(ROUTING.read_text()) if ROUTING.exists() else {'enabled':False,'models':[],'cooldownSec':0}
    p=d.ROOT/'data/qqwhale/routing-events.jsonl';events=[]
    if p.exists():
        for line in p.read_text()[-40000:].splitlines()[-50:]:
            try:events.append(json.loads(line))
            except ValueError:pass
    return {**policy,'events':list(reversed(events))}

def routing_save(body):
    if set(body)-{'enabled','models','cooldownSec'}:raise d.Error('路由规则包含未知字段')
    if type(body.get('enabled'))!=bool or not isinstance(body.get('models'),list) or len(set(body['models']))!=len(body['models']):raise d.Error('路由配置格式无效')
    available={m['id'] for m in d.conf(d.load_profile(),'llm-pi-ai')['providers']['whale-gateway']['models']}
    if not all(isinstance(m,str) and m in available for m in body['models']):raise d.Error('路由候选必须先同步到本地模型目录')
    if body['enabled'] and len(body['models'])<2:raise d.Error('自动切换至少需要两个不同的模型或分组')
    if type(body.get('cooldownSec'))!=int or body['cooldownSec']<0:raise d.Error('冷却时间应为非负秒数，0 表示关闭')
    # Separate root-owned policy under the bot's read-only etc mount.
    if ROUTING.exists():
        folder=d.STATE/'routing-revisions';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
        d.shutil.copyfile(ROUTING,folder/(d.stamp()+'.json'))
    d.atomic(ROUTING,(json.dumps(body,ensure_ascii=False,indent=2)+'\n').encode(),owner=(0,d.pwd.getpwnam('qqwhale').pw_gid));d.os.chmod(ROUTING,0o640)
    d.audit('routing.save');return {'routing':body,'message':'路由规则已保存，下次失败事件立即按新规则处理。不会自动重发已经失败的消息。'}

def session_action(body):
    scope=body.get('scope');peer=body.get('peer');method=body.get('action')
    if method not in ['new','compact','model','cancel']:raise d.Error('会话操作无效')
    effort=body.get('reasoningEffort')
    if method=='model':
        model=body.get('model');models=d.conf(d.load_profile(),'llm-pi-ai')['providers']['whale-gateway']['models'];selected=next((m for m in models if m['id']==model),None)
        if selected is None:raise d.Error('请先同步模型目录')
        if effort is not None:
            if effort not in d.REASONING_LEVELS:raise d.Error('思考档位无效')
            levels=d.reasoning_efforts(selected)
            if levels and effort not in levels:raise d.Error('该模型不支持所选思考档位')
    if method in ['new','compact','cancel'] and body.get('confirm') is not True:raise d.Error('需要确认后操作')
    result=bridge(method,scope=scope,peer=peer,model=body.get('model'),reasoningEffort=effort if method=='model' else None)
    d.audit('session.'+method);return result


def thinking(args):
    sid=str(args.get('sessionId',''))
    if sid and not re.fullmatch(r'[a-zA-Z0-9_-]{6,90}',sid):raise d.Error('会话编号格式无效')
    raw=d.run(['/usr/bin/node',str(Path(__file__).with_name('read-events.mjs')),'thinking',sid],timeout=45)
    return json.loads(raw)


def probe(body):
    model=body.get('model');available={m['id'] for m in d.conf(d.load_profile(),'llm-pi-ai')['providers']['whale-gateway']['models']}
    if model not in available or body.get('confirm') is not True:raise d.Error('请选择已同步的模型并确认测试')
    payload={'model':model,'messages':[{'role':'user','content':'这是一条部署健康测试，请只回复：连接正常。'}],'max_tokens':256,'stream':False,'thinking':{'type':'disabled'}}
    env=d.envvalues();start=time.time();entry={'ts':int(start*1000),'model':model,'kind':'gateway-probe'}
    req=urllib.request.Request(API_BASE+'/chat/completions',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+env.get('WHALE_API_KEY','')})
    try:
        with urllib.request.urlopen(req,timeout=65) as r:response=json.load(r)
        text=response.get('choices',[{}])[0].get('message',{}).get('content','')
        entry.update({'ok':bool(text),'durationMs':round((time.time()-start)*1000),'usage':response.get('usage',{}),'backend':response.get('model'),'reply':str(text)[:200]})
    except Exception as e:entry.update({'ok':False,'durationMs':round((time.time()-start)*1000),'error':d.redact(str(e))[:400]})
    d.STATE.mkdir(parents=True,mode=0o700,exist_ok=True)
    with (d.STATE/'probes.jsonl').open('a') as f:f.write(json.dumps(entry,ensure_ascii=False)+'\n')
    d.audit('model.probe')
    return entry

VISION=d.ROOT/'etc/vision-routing.json'
def vision_models(refresh=False):
    path=d.STATE/'vision-catalog.json'
    if refresh or not path.exists():
        data=[m for m in catalog() if m.get('supports_images') is True]
        d.atomic(path,(json.dumps(data,ensure_ascii=False)+'\n').encode(),owner=(0,0))
    return json.loads(path.read_text())

def vision_get():
    policy=json.loads(VISION.read_text())
    events=[];path=d.ROOT/'data/qqwhale/vision-calls.jsonl'
    if path.exists():
        for line in path.read_text()[-160000:].splitlines()[-50:]:
            try:events.append(json.loads(line))
            except ValueError:pass
    probes=[];proof=d.STATE/'vision-probes.jsonl'
    if proof.exists():
        for line in proof.read_text().splitlines()[-30:]:
            try:probes.append(json.loads(line))
            except ValueError:pass
    return {'config':policy,'revision':d.digest(VISION.read_bytes()),'models':vision_models(),'events':list(reversed(events)),'probes':list(reversed(probes))}

def vision_save(body):
    if set(body)-{'enabled','model','fallbackModel','gifFrames','maxImages','timeoutMs','revision'}:raise d.Error('视觉规则包含未知字段')
    if body.get('revision')!=d.digest(VISION.read_bytes()):raise d.Error('视觉配置已更改，请刷新后保存')
    models={m['id'] for m in vision_models()}
    if type(body.get('enabled'))!=bool or body.get('model') not in models or body.get('fallbackModel') not in models:raise d.Error('请选择网关公告支持图片的视觉模型')
    for name,lo,hi in [('gifFrames',1,None),('maxImages',0,None),('timeoutMs',1,None)]:
        if type(body.get(name))!=int or body[name]<lo:raise d.Error('视觉参数超出范围：'+name)
    folder=d.STATE/'vision-revisions';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    d.shutil.copyfile(VISION,folder/(d.stamp()+'.json'))
    policy={k:v for k,v in body.items() if k!='revision'}
    d.atomic(VISION,(json.dumps(policy,ensure_ascii=False,indent=2)+'\n').encode(),owner=(0,d.pwd.getpwnam('qqwhale').pw_gid));d.os.chmod(VISION,0o640)
    d.audit('vision.save');return {'message':'视觉路由已保存，新图片立即按新规则处理；文字聊天模型不变。'}

def vision_probe(body):
    if body.get('confirm') is not True or body.get('model') not in {m['id'] for m in vision_models()} or body.get('kind') not in ['red','blue','gif']:raise d.Error('请选择视觉模型与测试图片并确认')
    result=json.loads(d.run(['/usr/bin/node',str(d.ROOT/'bin/whale-vision.mjs'),'--probe',body['model'],body['kind']],as_bot=True,timeout=85))['vision']
    text=result.get('analysis','')
    result['verified']=bool(('红' in text if body['kind']=='red' else '蓝' in text if body['kind']=='blue' else result.get('animated') and result.get('frames',0)>1 and '红' in text and re.search(r'左.{0,10}右|右移|向右',text)))
    result['verificationMessage']='固定素材的颜色/运动方向核对通过' if result['verified'] else '模型返回了正文，但未通过固定素材内容核对；请更换视觉模型'
    with (d.STATE/'vision-probes.jsonl').open('a') as stream:stream.write(json.dumps({'ts':int(time.time()*1000),'model':body['model'],'kind':body['kind'],'verified':result['verified'],'message':result['verificationMessage']},ensure_ascii=False)+'\n')
    d.audit('vision.probe');return result
