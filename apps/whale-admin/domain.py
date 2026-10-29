"""Whale-only privileged operations. No shell, arbitrary paths, or generic commands."""
import base64, contextlib, copy, datetime, hashlib, json, os, pwd, re, shutil, sqlite3, subprocess, tempfile, threading, time, urllib.request
from pathlib import Path
import yaml

ROOT = Path(os.environ.get('WHALE_ROOT', '/home/qqwhale/whale'))
DSH = Path(os.environ.get('DSH_HOME', '/home/qqwhale/.dsh'))
STATE = Path(os.environ.get('WHALE_ADMIN_STATE', '/var/lib/whale-admin-broker'))
PROFILE = DSH / 'profiles/web/cordis.patch.yml'
MEMCFG = ROOT / 'data/qqwhale/memory-config.json'
MEMDB = ROOT / 'data/qqwhale/memory.db'
MEDIA = ROOT / 'data/表情包'
ENVFILE = ROOT / 'etc/qqbot.env'
AUTHFILE = Path('/var/lib/whale-admin/auth.json')
PREFS = ROOT / 'data/qqwhale/persona-preferences.json'
PREF_MAX_ITEMS = 60
PREF_MAX_CHARS = 300
PERSONA_HASH = '3aafe387ec338bdc6ce1381b59f83963b10a92d91927dcc36b4d307b14110dc6'
PERSONA_MAX_BYTES = 32768
LOCK = threading.RLock()

class Error(Exception): pass
REASONING_LEVELS = ['off','minimal','low','medium','high','xhigh','max']

def reasoning_efforts(model):
    """当前模型真正声明给 DSH 的思考档位；未声明时不臆造可选值。"""
    efforts=model.get('reasoningEfforts') if isinstance(model,dict) else None
    if efforts is False:return ['off']
    if not isinstance(efforts,dict):return []
    return [level for level in REASONING_LEVELS if level in efforts]

def effective_reasoning(model,preferred):
    """把页面或旧配置里的档位收敛到当前模型支持的档位。"""
    levels=reasoning_efforts(model)
    if not levels:return preferred or 'off'
    if preferred in levels:return preferred
    if 'high' in levels:return 'high'
    return levels[-1]

class Loader(yaml.SafeLoader): pass
# Match js-yaml's YAML 1.2 booleans: "off" must remain a string/key.
Loader.yaml_implicit_resolvers = {k:[x for x in v if x[0]!='tag:yaml.org,2002:bool'] for k,v in yaml.SafeLoader.yaml_implicit_resolvers.items()}
Loader.add_implicit_resolver('tag:yaml.org,2002:bool', re.compile(r'^(?:true|false|True|False|TRUE|FALSE)$'), list('tTfF'))
class Dumper(yaml.SafeDumper): pass
def represent_str(dumper, value):
    return dumper.represent_scalar('tag:yaml.org,2002:str', value, style='"' if any(c in value for c in '\r\x85\u2028\u2029') else None)
Dumper.add_representer(str, represent_str)

def load_profile():
    x=yaml.load(PROFILE.read_text(), Loader=Loader)
    if not isinstance(x,list): raise Error('运行配置不是有效的插件列表')
    return x

def walk(rows):
    for row in rows:
        if not isinstance(row,dict): continue
        yield row
        for k in ('insert','config'):
            if isinstance(row.get(k),list): yield from walk(row[k])
        conf=row.get('config',{})
        if isinstance(conf,dict) and isinstance(conf.get('plugins'),list): yield from walk(conf['plugins'])

def row(rows, name):
    found=[r for r in walk(rows) if r.get('id')==name]
    if len(found)!=1: raise Error('配置项不唯一或不存在：'+name)
    return found[0]

def conf(rows,name):
    r=row(rows,name)
    if not isinstance(r.get('config'),dict): r['config']={}
    return r['config']

def digest(b): return hashlib.sha256(b).hexdigest()
def stamp(): return datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+os.urandom(3).hex()

def persona_lock_path(): return STATE/'persona-lock.json'

def persona_lock():
    """当前人格的版本记录；首次升级前回退到内置锁定哈希。"""
    try: data=json.loads(persona_lock_path().read_text())
    except (OSError,ValueError): data={}
    sha=data.get('sha256') if isinstance(data,dict) else None
    if isinstance(sha,str) and re.fullmatch(r'[0-9a-f]{64}',sha):
        return {'sha256':sha,'bytes':data.get('bytes'),'at':data.get('at'),'revision':data.get('revision'),'lineEnding':data.get('lineEnding')}
    return {'sha256':PERSONA_HASH,'bytes':9631,'at':None,'revision':None,'lineEnding':'crlf'}

def persona_line_ending(text):
    crlf=text.count('\r\n');lf=text.count('\n')-crlf;cr=text.count('\r')-crlf
    if crlf and not lf and not cr:return 'crlf'
    if lf and not crlf and not cr:return 'lf'
    if not crlf and not lf and not cr:return 'lf'
    return 'mixed'

def persona_view(text):
    raw=text.encode();lock=persona_lock();style=persona_line_ending(text)
    if not any(c in text for c in '\r\n') and lock.get('lineEnding') in ('crlf','lf'):style=lock['lineEnding']
    return {'text':text,'bytes':len(raw),'sha256':digest(raw),'locked':digest(raw)==lock['sha256'],'crlf':text.count('\r\n'),'lineEnding':style,'maxBytes':PERSONA_MAX_BYTES,'lock':{'sha256':lock['sha256'],'bytes':lock['bytes'],'at':lock['at'],'revision':lock['revision']}}

def persona_archive(raw):
    folder=STATE/'persona-revisions';folder.mkdir(mode=0o700,parents=True,exist_ok=True)
    path=folder/(stamp()+'.txt')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    for old in sorted(folder.glob('*.txt'),key=lambda p:p.stat().st_mtime_ns,reverse=True)[50:]:old.unlink()
    return path.name

def persona_lock_bytes(raw,style,revision):
    return (json.dumps({'sha256':digest(raw),'bytes':len(raw),'crlf':raw.count(b'\r\n'),'lineEnding':style,'at':time.time(),'revision':revision},ensure_ascii=False,indent=2)+'\n').encode()

def profile_revision(raw):
    return digest(raw+MEMCFG.read_bytes()+ENVFILE.read_bytes())

def persona_semantics(rows):
    data=copy.deepcopy(rows)
    for row_ in walk(data):
        if row_.get('id')=='persona' and isinstance(row_.get('config'),dict):row_['config'].pop('prefix',None)
    return data
def envvalues():
    return dict(l.split('=',1) for l in ENVFILE.read_text().splitlines() if '=' in l and not l.startswith('#'))

def redact(s):
    try:
        for k,v in envvalues().items():
            if v and any(x in k for x in ['SECRET','KEY','TOKEN']): s=s.replace(v,'[已隐藏]')
    except OSError: pass
    s=re.sub(r'(token=)[^\s\"\'<>]+',r'\1[已隐藏]',s,flags=re.I)
    s=re.sub(r'\bsk-[A-Za-z0-9_-]{12,}', '[已隐藏]', s)
    s=re.sub(r'(Bearer\s+)[A-Za-z0-9_.-]+',r'\1[已隐藏]',s,flags=re.I)
    return s

def run(args,timeout=30,as_bot=False,input=None):
    opts={}
    if as_bot:
        u=pwd.getpwnam('qqwhale'); opts=dict(user=u.pw_uid,group=u.pw_gid,extra_groups=[])
    p=subprocess.run(args,input=input,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,cwd=str(ROOT),env={**os.environ,'DSH_HOME':str(DSH),'WHALE_ROOT':str(ROOT),'HOME':'/home/qqwhale'},**opts)
    if p.returncode: raise Error(redact((p.stderr or p.stdout)[-1800:]))
    return p.stdout

def atomic(path,data,owner=None):
    path=Path(path)
    if path.is_symlink(): raise Error('拒绝写入符号链接')
    st=path.stat() if path.exists() else None
    fd,tmp=tempfile.mkstemp(prefix='.admin-',dir=path.parent)
    try:
        os.fchmod(fd,st.st_mode & 0o777 if st else 0o600)
        uid,gid=owner if owner else ((st.st_uid,st.st_gid) if st else (pwd.getpwnam('qqwhale').pw_uid,pwd.getpwnam('qqwhale').pw_gid))
        os.fchown(fd,uid,gid)
        with os.fdopen(fd,'wb') as f: f.write(data);f.flush();os.fsync(f.fileno())
        os.replace(tmp,path)
        dirfd=os.open(path.parent,os.O_DIRECTORY)
        try:os.fsync(dirfd)
        finally:os.close(dirfd)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def snapshot(label):
    STATE.mkdir(mode=0o700,parents=True,exist_ok=True)
    folder=STATE/'revisions'/stamp();folder.mkdir(parents=True,mode=0o700)
    for name,path in [('profile.yml',PROFILE),('memory.json',MEMCFG),('qqbot.env',ENVFILE)]:
        if path.exists(): shutil.copyfile(path,folder/name);os.chmod(folder/name,0o600)
    (folder/'meta.json').write_text(json.dumps({'label':label,'at':time.time()},ensure_ascii=False))
    return folder.name

def audit(action,result='ok'):
    STATE.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (STATE/'audit.jsonl').open('a') as f:f.write(json.dumps({'at':time.time(),'action':action,'result':result},ensure_ascii=False)+'\n')

def get_config():
    rows=load_profile();qq=conf(rows,'im-qqbot');p=conf(rows,'llm-pi-ai')['providers']['whale-gateway'];m=next((x for x in p['models'] if x['id']==conf(rows,'agent-default-model').get('model')),p['models'][0]);d=conf(rows,'agent-default-model');cp=conf(rows,'compaction-basic')
    prefix=conf(rows,'persona')['prefix'];e=envvalues()
    mem=json.loads(MEMCFG.read_text()) if MEMCFG.exists() else {}
    models=[{'id':x.get('id'),'name':x.get('name',x.get('id')),'contextWindow':x.get('contextWindow'),'maxTokens':x.get('maxTokens'),'reasoningEfforts':reasoning_efforts(x)} for x in p['models']]
    return {'revision':digest(PROFILE.read_bytes()+MEMCFG.read_bytes()+ENVFILE.read_bytes()),'model':{'baseURL':p['baseURL'],'id':m['id'],'name':m.get('name',m['id']),'contextWindow':m['contextWindow'],'maxTokens':m['maxTokens'],'reasoningEffort':effective_reasoning(m,d.get('reasoningEffort','off')),'reasoningEfforts':reasoning_efforts(m),'timeoutMs':p.get('timeoutMs',90000),'streamIdleTimeoutMs':p.get('streamIdleTimeoutMs',30000)},'compaction':{k:cp.get(k,v) for k,v in {'thresholdRatio':0.55,'retainRatio':0.25,'maxOverflowRetries':2}.items()},'qq':{'appid':e.get('QQBOT_APPID',''),'c2cMode':qq['access']['c2cMode'],'c2cAllow':qq['access'].get('c2cAllow',[]),'groupMode':qq['access'].get('groupMode','disabled'),'groupAllow':qq['access'].get('groupAllow',[]),'textChunkLimit':qq.get('textChunkLimit',4500),'processingTimeoutMs':qq.get('processingTimeoutMs',120000),'sessionIdleTimeout':qq.get('sessionIdleTimeout',1800000),'streaming':qq.get('streaming',False)},'sticker':copy.deepcopy(qq['sticker']),'memory':mem,'persona':persona_view(prefix),'credentials':{'qqSecret':bool(e.get('QQBOT_SECRET')),'modelKey':bool(e.get('WHALE_API_KEY'))},'availableModels':models,'settingsApplied':pending_status()}

def pending_status():
    marker=STATE/'applied.json'
    current=digest(PROFILE.read_bytes()+MEMCFG.read_bytes()+ENVFILE.read_bytes())
    applied=json.loads(marker.read_text()).get('hash') if marker.exists() else None
    return {'pendingRestart':current!=applied,'known':applied is not None}

def validate_payload(body):
    if set(body)-{'revision','model','compaction','qq','sticker','memory','credentials'}:raise Error('存在不支持的配置类别')
    rules={'model':{'contextWindow':(32768,1000000),'maxTokens':(512,32000),'timeoutMs':(10000,180000),'streamIdleTimeoutMs':(5000,120000)},'compaction':{'thresholdRatio':(.2,.8),'retainRatio':(.1,.5),'maxOverflowRetries':(0,3)},'qq':{'textChunkLimit':(500,4500),'processingTimeoutMs':(30000,240000),'sessionIdleTimeout':(300000,86400000)},'memory':{'recallMax':(1,10),'recallCooldownSec':(0,3600),'minQueryChars':(2,100),'maxTextChars':(500,20000),'excludeRecent':(0,50),'minGapMs':(0,86400000)},'sticker':{'perTurnMax':(1,3),'perWindowSec':(10,3600),'maxPerWindow':(1,10),'dailyBudgetPerGroup':(0,100),'dupTTLHours':(1,720)}}
    bools={'qq':{'streaming'},'sticker':{'collectEnabled','autoTagEnabled','gatesEnabled'},'memory':{'archiveEnabled','recallEnabled'}}
    extra={'model':{'reasoningEffort','id'},'qq':{'appid','c2cMode','c2cAllow','groupMode','groupAllow'},'credentials':{'qqSecret','modelKey'}}
    for section,values in body.items():
        if section=='revision':continue
        if not isinstance(values,dict):raise Error('配置类别必须是对象')
        for k,v in values.items():
            if k in rules.get(section,{}):
                lo,hi=rules[section][k]
                if type(v) not in (int,float) or not lo<=v<=hi or (section!='compaction' or k=='maxOverflowRetries') and not float(v).is_integer():raise Error('数值超出范围：'+k)
            elif k in bools.get(section,set()):
                if type(v)!=bool:raise Error('开关必须为布尔值：'+k)
            elif k in extra.get(section,set()):
                if k=='id' and (not isinstance(v,str) or not re.fullmatch(r'[A-Za-z0-9_./:-]{1,160}',v)):raise Error('模型编号无效')
                elif k=='appid' and (not isinstance(v,str) or not re.fullmatch(r'[0-9]{6,20}',v)):raise Error('AppID 格式无效')
                elif k=='reasoningEffort' and v not in REASONING_LEVELS:raise Error('推理档位无效')
                elif k=='c2cMode' and v not in ['disabled','allowlist','open']:raise Error('私聊模式无效')
                elif k=='groupMode' and v not in ['disabled','allowlist']:raise Error('群聊仅允许关闭或白名单模式')
                elif k in ['c2cAllow','groupAllow'] and (not isinstance(v,list) or len(v)>30 or not all(isinstance(i,str) and re.fullmatch(r'[a-fA-F0-9]{32}',i) for i in v)):raise Error('白名单必须是平台 32 位十六进制 ID')
                elif section=='credentials' and (not isinstance(v,str) or len(v)>300 or any(c in v for c in '\r\n\x00') or v and not re.fullmatch(r'[A-Za-z0-9_.-]{10,300}',v)):raise Error('凭据格式无效')
            else:raise Error('不允许修改：'+section+'.'+k)

def save_config(body):
    validate_payload(body)
    current=get_config()
    if body.get('qq',{}).get('appid',current['qq']['appid'])!=current['qq']['appid'] and not body.get('credentials',{}).get('qqSecret'):raise Error('更换 AppID 时必须同时提供匹配的 AppSecret')
    if body.get('revision')!=current['revision']:raise Error('配置已被其他操作修改，请刷新后重试')
    if body.get('credentials',{}).get('qqSecret'):
        verify_qq_credentials(body.get('qq',{}).get('appid',current['qq']['appid']),body['credentials']['qqSecret'])
    rows=load_profile();original=conf(rows,'persona')['prefix'].encode()
    qq=conf(rows,'im-qqbot');p=conf(rows,'llm-pi-ai')['providers']['whale-gateway'];m=next((x for x in p['models'] if x['id']==conf(rows,'agent-default-model').get('model')),p['models'][0]);d=conf(rows,'agent-default-model');cp=conf(rows,'compaction-basic')
    if 'id' in body.get('model',{}):
        selected=next((x for x in p['models'] if x['id']==body['model']['id']),None)
        if selected is None:raise Error('请先同步模型目录')
        m=selected;d['model']=m['id'];qq['model']=m['id']
    levels=reasoning_efforts(m)
    if 'reasoningEffort' in body.get('model',{}):
        requested=body['model']['reasoningEffort']
        if levels and requested not in levels:raise Error('所选模型不支持该思考档位')
        d['reasoningEffort']=requested;p['reasoning']=requested
    elif 'id' in body.get('model',{}):
        d['reasoningEffort']=effective_reasoning(m,d.get('reasoningEffort','off'));p['reasoning']=d['reasoningEffort']
    for k,v in body.get('model',{}).items():
        if k in ['id','reasoningEffort']:continue
        if k in ['contextWindow','maxTokens']:m[k]=v
        else:p[k]=v
    if m['maxTokens']>=m['contextWindow']*.5:raise Error('输出预算必须小于上下文的一半')
    cp.update(body.get('compaction',{}))
    if float(cp.get('retainRatio',.25))>=float(cp.get('thresholdRatio',.55)):raise Error('压缩保留比例必须小于触发比例')
    if float(cp.get('thresholdRatio',.55))*m['contextWindow']+m['maxTokens']>=m['contextWindow']:raise Error('压缩阈值和输出预算未留下足够上下文余量')
    q=body.get('qq',{})
    for k,v in q.items():
        if k=='appid':continue
        if k in ['c2cMode','c2cAllow','groupMode','groupAllow']:qq['access'][k]=v
        else:qq[k]=v
    for mode,key in [('c2cMode','c2cAllow'),('groupMode','groupAllow')]:
        if qq['access'][mode]=='allowlist' and not qq['access'].get(key):raise Error('启用白名单时至少需要一个平台 ID')
    for k,v in body.get('sticker',{}).items():
        if k in ['collectEnabled','autoTagEnabled']:qq['sticker'][k]=v
        else:qq['sticker']['gates']['enabled' if k=='gatesEnabled' else k]=v
    mem=current['memory'];mem.update(body.get('memory',{}))
    text=yaml.dump(rows,Dumper=Dumper,allow_unicode=True,sort_keys=False,width=100000)
    parsed=yaml.load(text,Loader=Loader)
    if conf(parsed,'persona')['prefix'].encode()!=original:raise Error('人格字节校验失败，已拒绝保存')
    # Verify the real DSH parser before writing production configuration.
    js="const fs=require('fs');const {createRequire}=require('module');const r=createRequire('/home/qqwhale/whale/app/package.json');const y=r('js-yaml');const x=y.load(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(x));"
    reparsed=json.loads(run(['/usr/bin/node','-e',js],input=text,as_bot=True))
    if conf(reparsed,'persona')['prefix'].encode()!=original:raise Error('DSH YAML 解析后人格字节不一致')
    env=envvalues()
    if 'appid' in q:env['QQBOT_APPID']=q['appid']
    for k,v in body.get('credentials',{}).items():
        if v:env['QQBOT_SECRET' if k=='qqSecret' else 'WHALE_API_KEY']=v
    revision=snapshot('保存配置')
    folder=STATE/'revisions'/revision
    try:
        atomic(PROFILE,text.encode())
        atomic(MEMCFG,(json.dumps(mem,ensure_ascii=False,indent=2)+'\n').encode())
        atomic(ENVFILE,(''.join(k+'='+v+'\n' for k,v in env.items())).encode())
    except Exception:
        for n,pth in [('profile.yml',PROFILE),('memory.json',MEMCFG),('qqbot.env',ENVFILE)]:
            if (folder/n).exists():atomic(pth,(folder/n).read_bytes())
        raise
    audit('config.save')
    return {'backup':revision,'config':get_config(),'message':'已保存并创建配置快照。点击应用配置使机器人生效。'}

def persona_save(body):
    """把编辑后的人格写入真实 profile；换行符按当前版本风格还原以保持字节可复现。"""
    if set(body)-{'revision','text','confirm'} or not isinstance(body.get('text'),str):raise Error('只允许修改人格原文')
    if body.get('confirm') is not True:raise Error('请确认后保存人格原文')
    text=body['text']
    if '\x00' in text:raise Error('人格原文不能包含 NUL 字符')
    if not text.strip():raise Error('人格原文不能为空')
    profile_raw=PROFILE.read_bytes();rows=yaml.load(profile_raw,Loader=Loader)
    old=conf(rows,'persona')['prefix'];oldraw=old.encode();style=persona_line_ending(old)
    if style=='mixed':raise Error('当前人格原文含混合换行符，页面编辑无法逐字节保真；请先在服务器侧统一换行符')
    if not any(c in old for c in '\r\n'):
        # 无换行原文无法自行判断风格，沿用最近一次记录的风格，避免首次加行时改变行尾。
        style=persona_lock().get('lineEnding') if persona_lock().get('lineEnding') in ['crlf','lf'] else 'lf'
    # 浏览器 textarea 会把 CRLF 规范为 LF；保存时按原风格还原，未改动的原文可逐字节重现。
    normalized=text.replace('\r\n','\n').replace('\r','\n')
    new=normalized.replace('\n','\r\n') if style=='crlf' else normalized
    raw=new.encode()
    if len(raw)>PERSONA_MAX_BYTES:raise Error('人格原文超过 32768 字节预算')
    lockpath=persona_lock_path()
    if raw==oldraw:
        lock=persona_lock()
        if digest(raw)==lock['sha256']:return {'message':'人格原文没有变化，未写入。','changed':False,'persona':persona_view(old),'backup':None}
        # 原文未变但版本记录陈旧（例如上次保存后进程崩溃）：允许重新记录当前版本。
        revision=snapshot('记录当前人格版本')
        try:atomic(lockpath,persona_lock_bytes(raw,style,revision),owner=(0,0))
        except Exception as error:raise Error('原文未变化，但更新版本记录失败：'+redact(str(error))) from error
        audit('persona.relock')
        return {'message':'人格原文没有变化；已把当前内容记录为当前版本。','changed':False,'relocked':True,'backup':revision,'persona':persona_view(old)}
    if body.get('revision')!=profile_revision(profile_raw):raise Error('配置已被其他操作修改，请刷新后重试')
    conf(rows,'persona')['prefix']=new
    rendered=yaml.dump(rows,Dumper=Dumper,allow_unicode=True,sort_keys=False,width=100000)
    parsed=yaml.load(rendered,Loader=Loader)
    if conf(parsed,'persona')['prefix'].encode()!=raw:raise Error('人格字节校验失败，已拒绝保存')
    # Verify the real DSH parser (js-yaml) before writing production configuration.
    js="const fs=require('fs');const {createRequire}=require('module');const r=createRequire('/home/qqwhale/whale/app/package.json');const y=r('js-yaml');const x=y.load(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(x));"
    original_js=json.loads(run(['/usr/bin/node','-e',js],input=profile_raw.decode('utf-8'),as_bot=True))
    reparsed=json.loads(run(['/usr/bin/node','-e',js],input=rendered,as_bot=True))
    if conf(reparsed,'persona')['prefix'].encode()!=raw:raise Error('DSH YAML 解析后人格字节不一致')
    if json.dumps(persona_semantics(original_js),sort_keys=True,ensure_ascii=False)!=json.dumps(persona_semantics(reparsed),sort_keys=True,ensure_ascii=False):
        raise Error('保存会改变人格以外的配置解析结果，已拒绝；请检查 profile 中易混淆的 YAML 值')
    revision=snapshot('编辑人格原文')
    folder=STATE/'revisions'/revision
    try:(folder/'persona.source.txt').write_bytes(oldraw);os.chmod(folder/'persona.source.txt',0o600)
    except OSError:pass
    persona_archive(oldraw)
    previous_lock=lockpath.read_bytes() if lockpath.is_file() else None
    if PROFILE.read_bytes()!=profile_raw:raise Error('配置在保存前被其他操作修改，请刷新后重试')
    try:
        atomic(PROFILE,rendered.encode())
        atomic(lockpath,persona_lock_bytes(raw,style,revision),owner=(0,0))
    except Exception as error:
        problems=[]
        try:
            current=PROFILE.read_bytes()
            if current==rendered.encode():atomic(PROFILE,profile_raw)
            elif current!=profile_raw:problems.append('配置已被其他进程修改，未覆盖回滚')
        except Exception as rollback_error:problems.append('配置回滚失败：'+redact(str(rollback_error)))
        try:
            if previous_lock is None:
                if lockpath.exists():lockpath.unlink()
            else:atomic(lockpath,previous_lock,owner=(0,0))
        except Exception as lock_error:problems.append('版本记录回滚失败：'+redact(str(lock_error)))
        if problems:
            try:
                fd=os.open(STATE/'persona-recovery-needed.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
                with os.fdopen(fd,'w') as f:json.dump({'at':time.time(),'backup':revision,'problems':problems},f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
            except OSError:pass
            raise Error('保存失败且回滚不完整，请立即检查：'+'；'.join(problems)) from error
        raise
    audit('persona.save')
    return {'message':'人格原文已保存并创建快照；点击“应用配置”重启大鲸鱼后生效。','changed':True,'backup':revision,'persona':persona_view(new)}

def verify_qq_credentials(appid,secret):
    request=urllib.request.Request('https://api.bot.qq.com/app/getAppAccessToken',data=json.dumps({'appId':appid,'clientSecret':secret}).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=20) as response:result=json.load(response)
    except Exception as error:
        code=getattr(error,'code',None)
        raise Error('QQ平台凭据校验失败'+('（HTTP '+str(code)+'）' if code else '，请确认网络及AppID/AppSecret')) from None
    if not result.get('access_token'):raise Error('QQ平台没有接受这组AppID/AppSecret，配置未保存')

def service_status():
    raw=run(['/usr/bin/systemctl','show','qqwhale.service','-p','ActiveState','-p','SubState','-p','MainPID','-p','NRestarts','-p','MemoryCurrent','-p','ActiveEnterTimestamp'])
    return dict(l.split('=',1) for l in raw.splitlines() if '=' in l)

def overview():
    p=subprocess.run([str(ROOT/'bin/whale-monitor.sh'),'--json'],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35,cwd=str(ROOT))
    try:health=json.loads(p.stdout)
    except ValueError:health={'overall':'unknown','checks':[],'note':redact(p.stderr[-500:])}
    st=memory_info({});media=media_list({})
    return {'service':service_status(),'health':health,'memory':st['stats'],'media':media['counts'],'settingsApplied':pending_status(),'defaultModel':get_config()['model'],'time':time.time()}

def memory_info(args):
    if not MEMDB.exists():return {'items':[],'stats':{'messages':0,'deleted':0,'peers':0}}
    q=str(args.get('q',''))[:100];peer=str(args.get('peer',''))[:64];page=max(0,min(1000,int(args.get('page',0))))
    db=sqlite3.connect('file:'+str(MEMDB)+'?mode=ro',uri=True,timeout=3);db.row_factory=sqlite3.Row
    try:
        stats=dict(db.execute('SELECT count(*) messages,sum(deleted) deleted,count(distinct peer) peers,min(ts) firstTs,max(ts) lastTs FROM msg').fetchone())
        peers=[{'peer':r[0],'count':r[1]} for r in db.execute('SELECT peer,count(*) FROM msg GROUP BY peer')]
        cond='deleted=0';ps=[]
        if q:cond+=' AND text LIKE ? ESCAPE \'\\\'';ps.append('%'+q.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%')
        if peer:cond+=' AND peer=?';ps.append(peer)
        items=[dict(r) for r in db.execute('SELECT id,ts,scope,peer,sender_name,text FROM msg WHERE '+cond+' ORDER BY ts DESC LIMIT 30 OFFSET ?',ps+[page*30])]
        total=db.execute('SELECT count(*) FROM msg WHERE '+cond,ps).fetchone()[0]
        return {'items':items,'stats':stats,'peers':peers,'total':total,'page':page}
    finally:db.close()

@contextlib.contextmanager
def prefs_lock():
    lock=Path(str(PREFS)+'.lock');deadline=time.time()+5
    while True:
        try:os.mkdir(lock,0o777);os.chmod(lock,0o777);break
        except FileExistsError:
            try:
                if time.time()-lock.stat().st_mtime>10:shutil.rmtree(lock,ignore_errors=True);continue
            except OSError:pass
            if time.time()>deadline:raise Error('人格偏好正在更新，请稍后重试')
            time.sleep(.02)
    try:yield
    finally:shutil.rmtree(lock,ignore_errors=True)

def prefs_load():
    try:items=json.loads(PREFS.read_text()).get('items',[])
    except (OSError,ValueError):items=[]
    valid=[];seen=set()
    for x in items if isinstance(items,list) else []:
        if not isinstance(x,dict):continue
        text=re.sub(r'\s+',' ',str(x.get('text',''))).strip()
        if not text or len(text)>PREF_MAX_CHARS:continue
        key=text.lower()
        if key in seen:continue
        seen.add(key)
        ident=str(x.get('id',''))
        if not re.fullmatch(r'p-\d+-[a-z0-9]+',ident):ident='p-'+str(int(x.get('ts') or time.time()*1000))+'-'+os.urandom(3).hex()
        source=x.get('source') if x.get('source') in ['chat','chat-auto','admin'] else 'chat'
        valid.append({'id':ident,'ts':int(x.get('ts') or time.time()*1000),'text':text,'source':source})
    return valid[-PREF_MAX_ITEMS:]

def prefs_write(items,label):
    STATE.mkdir(mode=0o700,parents=True,exist_ok=True)
    folder=STATE/'persona-prefs-revisions';folder.mkdir(mode=0o700,parents=True,exist_ok=True)
    if PREFS.exists() and not PREFS.is_symlink():shutil.copyfile(PREFS,folder/(stamp()+'.json'))
    raw=(json.dumps({'version':1,'items':items[-PREF_MAX_ITEMS:]},ensure_ascii=False,indent=2)+'\n').encode()
    u=pwd.getpwnam('qqwhale')
    atomic(PREFS,raw,owner=(u.pw_uid,u.pw_gid));os.chmod(PREFS,0o600)
    audit(label)
    return prefs_view()

def prefs_view():
    return {'items':prefs_load(),'maxItems':PREF_MAX_ITEMS,'maxChars':PREF_MAX_CHARS,'revision':digest(PREFS.read_bytes()) if PREFS.exists() else ''}

def prefs_add(args):
    if args.get('confirm') is not True:raise Error('需要确认后添加长期偏好')
    text=re.sub(r'\s+',' ',str(args.get('text',''))).strip()
    if not text:raise Error('偏好内容不能为空')
    if len(text)>PREF_MAX_CHARS:raise Error('偏好内容不能超过 300 字')
    if '\x00' in text:raise Error('偏好内容包含非法字符')
    with prefs_lock():
        items=prefs_load()
        if any(x['text'].lower()==text.lower() for x in items):raise Error('这条长期偏好已经存在')
        if len(items)>=PREF_MAX_ITEMS:raise Error('长期偏好最多 60 条，请先删除旧条目')
        items.append({'id':'p-'+str(int(time.time()*1000))+'-'+os.urandom(3).hex(),'ts':int(time.time()*1000),'text':text,'source':'admin'})
        result=prefs_write(items,'preferences.add')
    return {**result,'message':'长期人格偏好已添加，下一条消息开始生效。'}

def prefs_delete(args):
    if args.get('confirm') is not True:raise Error('需要确认后删除长期偏好')
    ident=str(args.get('id',''))
    if not re.fullmatch(r'p-\d+-[a-z0-9]+',ident):raise Error('偏好编号无效')
    with prefs_lock():
        items=prefs_load();kept=[x for x in items if x['id']!=ident]
        if len(kept)==len(items):raise Error('偏好不存在或已删除')
        result=prefs_write(kept,'preferences.delete')
    return {**result,'message':'长期人格偏好已删除，后续对话不再注入。'}

def media_list(args):
    try:items=json.loads((MEDIA/'index.json').read_text()).get('items',[])
    except (OSError,ValueError):items=[]
    counts={k:sum(i.get('layer')==k for i in items) for k in ['candidate','library','negative','trash']};counts['total']=len(items)
    q=str(args.get('q',''))[:100];layer=args.get('layer','');offset=max(0,min(10000,int(args.get('offset',0))))
    matches=[i for i in reversed(items) if (not layer or i.get('layer')==layer) and (not q or q.lower() in (str(i.get('desc',''))+' '+str(i.get('tags',''))).lower())]
    return {'items':[{k:i.get(k) for k in ['id','ext','layer','size','capturedAt','useCount','tags','desc','needsDescribe']} for i in matches[offset:offset+36]],'counts':counts,'total':len(matches),'offset':offset}

def media_image(args):
    ident=str(args.get('id',''));items=json.loads((MEDIA/'index.json').read_text()).get('items',[])
    item=next((i for i in items if i.get('id')==ident),None)
    if not item or not re.fullmatch(r'[a-zA-Z0-9_-]{6,80}',ident):raise Error('图片不存在')
    ext=str(item.get('ext','')).lower();layer=item.get('layer')
    if ext not in ['png','jpg','jpeg','gif','webp'] or layer not in ['candidate','library','negative','trash']:raise Error('图片格式不支持')
    path=MEDIA/'lib'/layer/(ident+'.'+ext)
    if path.is_symlink() or not path.resolve().is_relative_to((MEDIA/'lib').resolve()):raise Error('图片路径无效')
    if not path.is_file() or path.stat().st_size>6*1024*1024 or path.stat().st_nlink!=1:raise Error('图片过大或不合法')
    return {'mime':'image/jpeg' if ext in ['jpg','jpeg'] else 'image/'+ext,'data':base64.b64encode(path.read_bytes()).decode()}

def backups_list():
    items=[]
    for p in sorted((ROOT/'backups').glob('whale-*.tar.gz'),reverse=True):
        if p.is_file() and not p.is_symlink():items.append({'name':p.name,'bytes':p.stat().st_size,'at':p.stat().st_mtime})
    current=digest(conf(load_profile(),'persona')['prefix'].encode())
    rev=[]
    for p in sorted((STATE/'revisions').glob('*'),reverse=True):
        if p.is_dir() and (p/'meta.json').exists():
            item={'id':p.name,**json.loads((p/'meta.json').read_text())};item['restorable']=False
            try:item['restorable']=digest(conf(yaml.load((p/'profile.yml').read_text(),Loader=Loader),'persona')['prefix'].encode())==current
            except Exception:pass
            rev.append(item)
    return {'archives':items[:30],'revisions':rev[:30],'managementArchives':[{'name':p.name,'bytes':p.stat().st_size,'at':p.stat().st_mtime} for p in sorted((STATE/'backups').glob('admin-*.tar.gz'),reverse=True)]}

def mark_applied():
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    (STATE/'applied.json').write_text(json.dumps({'hash':digest(PROFILE.read_bytes()+MEMCFG.read_bytes()+ENVFILE.read_bytes()),'at':time.time()}))

def service_action(action):
    if action not in ['start','stop','restart','apply']:raise Error('不支持的服务操作')
    cmd='restart' if action=='apply' else action
    if cmd!='stop':run(['/usr/bin/python3',str(ROOT/'bin/harden-plugin.py'),'--check',str(DSH/'profiles/web/node_modules/@zaofan/dsh-qqbot')])
    run(['/usr/bin/systemctl',cmd,'qqwhale.service'],timeout=40)
    status=service_status()
    if cmd!='stop' and status.get('ActiveState')=='active':
        STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
        (STATE/'applied.json').write_text(json.dumps({'hash':digest(PROFILE.read_bytes()+MEMCFG.read_bytes()+ENVFILE.read_bytes()),'at':time.time()}))
    audit('service.'+action)
    return {'service':status,'message':'服务操作已完成。请留意最新会话和健康状态。'}

def dispatch(method,args):
    with LOCK:
        if method in ['proactive','proactive.save','proactive.test']:
            import proactive as p
            if method=='proactive':return p.get()
            if method=='proactive.save':return p.save(args)
            return p.test(args)
        if method in ['instructions','instructions.save','search','search.save','search.test']:
            import workspace as w
            if method=='instructions':return w.instructions_get()
            if method=='instructions.save':return w.instructions_save(args)
            if method=='search':return w.search_get()
            if method=='search.save':return w.search_save(args)
            if method=='search.test':return w.search_test(args)
        if method in ['connection','sessions','calls','thinking','models.sync','session.action','routing','routing.save','media.action','model.probe','vision','vision.save','vision.probe','vision.models']:
            import integrations as i
            if method=='thinking':return i.thinking(args)
            if method=='vision':return i.vision_get()
            if method=='vision.save':return i.vision_save(args)
            if method=='vision.probe':return i.vision_probe(args)
            if method=='vision.models':return {'models':i.vision_models(True),'message':'已刷新网关公告支持图片的模型目录。'}
            if method=='connection':return i.bridge('status')
            if method=='sessions':return i.sessions()
            if method=='calls':return i.calls(args)
            if method=='model.probe':return i.probe(args)
            if method=='models.sync':return i.register_models()
            if method=='session.action':return i.session_action(args)
            if method=='routing':return i.routing_get()
            if method=='routing.save':return i.routing_save(args)
            if method=='media.action':
                if args.get('action') not in ['tag','promote','trash','restore','delete']:raise Error('图库操作无效')
                if args.get('confirm') is not True:raise Error('需要确认图库操作')
                index=MEDIA/'index.json'; folder=STATE/'media-revisions';folder.mkdir(mode=0o700,parents=True,exist_ok=True);shutil.copyfile(index,folder/(stamp()+'.json'))
                result=i.bridge('media.'+args['action'],id=args.get('id'),tags=args.get('tags'),desc=args.get('desc'));audit('media.'+args['action']);return result
        if method=='binding':
            until=ROOT/'data/.bind-until';ids=ROOT/'data/.bind-openids'
            if until.is_symlink() or ids.is_symlink():raise Error('绑定记录路径无效')
            deadline=int(until.read_text().strip() or '0') if until.exists() else 0
            captured=sorted(set(x for x in ids.read_text().splitlines() if re.fullmatch(r'[a-fA-F0-9]{32}',x))) if ids.exists() else []
            return {'until':deadline,'active':deadline>time.time()*1000,'senders':captured}
        if method=='binding.open':
            if args.get('confirm') is not True:raise Error('需要确认后捕获身份')
            run([str(ROOT/'bin/whale-ctl'),'bind-capture'],timeout=45);mark_applied();audit('binding.open');return {'message':'已关闭私聊并打开 5 分钟身份捕获。请用自己的 QQ 私聊后刷新候选列表。'}
        if method=='binding.confirm':
            peer=args.get('peer');ids=ROOT/'data/.bind-openids'
            if args.get('confirm') is not True or not isinstance(peer,str) or not re.fullmatch(r'[a-fA-F0-9]{32}',peer) or ids.is_symlink() or not ids.exists() or peer not in ids.read_text().splitlines():raise Error('只能绑定你已确认的捕获身份')
            snapshot('绑定 QQ 身份')
            run([str(ROOT/'bin/whale-ctl'),'allow-admin',peer],timeout=45)
            for name in ['.bind-until','.bind-openids']:
                path=ROOT/'data'/name
                if path.exists():path.unlink()
            mark_applied();audit('binding.confirm');return {'message':'该 QQ 身份已绑定为私聊管理员，服务已应用新白名单。'}
        if method=='status':return service_status()
        if method=='overview':return overview()
        if method=='preferences':return prefs_view()
        if method=='preferences.add':return prefs_add(args)
        if method=='preferences.delete':return prefs_delete(args)
        if method=='config':return get_config()
        if method=='config.save':return save_config(args)
        if method=='persona.save':return persona_save(args)
        if method=='service':return service_action(args.get('action'))
        if method=='memory':return memory_info(args)
        if method=='memory.forget':
            ident=args.get('id')
            if type(ident)!=int or ident<=0 or args.get('confirm') is not True:raise Error('请确认有效的记录编号')
            run(['/usr/bin/python3',str(Path(__file__).with_name('server.py')),'forget',str(ident)],as_bot=True)
            audit('memory.forget:'+str(ident));return {'message':'记录已软删除；可通过管理员备份审计恢复。'}
        if method=='media':return media_list(args)
        if method=='media.image':return media_image(args)
        if method=='backups':return backups_list()
        if method=='backup.create':
            text=run([str(ROOT/'bin/whale-backup.sh')],timeout=90,as_bot=True)
            admin=admin_backup();audit('backup.create');return {'message':'机器人与管理台私有备份均已生成','management':admin,'backups':backups_list()}
        if method=='config.restore':
            ident=str(args.get('id',''))
            if not re.fullmatch(r'\d{8}T\d{6}-[a-f0-9]{6}',ident) or args.get('confirm') is not True:raise Error('配置快照编号无效')
            folder=STATE/'revisions'/ident
            if not (folder/'profile.yml').is_file():raise Error('快照不存在')
            candidate=yaml.load((folder/'profile.yml').read_text(),Loader=Loader)
            current_rows=load_profile();current_persona=conf(current_rows,'persona')['prefix'].encode()
            # 与当前实际运行人格比较，绝不通过恢复快照改动人格；锁文件缺失或写入崩溃也不能绕过。
            if digest(conf(candidate,'persona')['prefix'].encode())!=digest(current_persona):raise Error('快照人格与当前人格不一致，拒绝恢复')
            restore_credentials=args.get('restoreCredentials') is True
            if not restore_credentials:
                current_qq=conf(current_rows,'im-qqbot');restored_qq=conf(candidate,'im-qqbot')
                snapshot_env=dict(l.split('=',1) for l in (folder/'qqbot.env').read_text().splitlines() if '=' in l and not l.startswith('#')) if (folder/'qqbot.env').exists() else {}
                if snapshot_env.get('QQBOT_APPID')!=envvalues().get('QQBOT_APPID'):
                    restored_qq['access']=copy.deepcopy(current_qq['access'])
                    restored_qq.setdefault('groupAdmin',{})['owners']=copy.deepcopy(current_qq.get('groupAdmin',{}).get('owners',[]))
                restored_qq['appId']='__FROM_ENV__';restored_qq['appSecret']='__FROM_ENV__'
            revision=snapshot('恢复前备份')
            # Routine settings rollback must not revive a revoked QQ/API key.
            atomic(PROFILE,yaml.dump(candidate,Dumper=Dumper,allow_unicode=True,sort_keys=False,width=100000).encode())
            for n,pth in [('memory.json',MEMCFG),*([('qqbot.env',ENVFILE)] if restore_credentials else [])]:
                if (folder/n).exists():atomic(pth,(folder/n).read_bytes())
            audit('config.restore');return {'message':'配置已恢复，当前凭据保留。点击应用配置后生效。' if not restore_credentials else '配置与所选快照凭据已恢复，请确认平台密钥仍有效后应用。','backup':revision,'config':get_config()}
        if method=='logs':
            logs=[]
            for name in ['dsh.log','dsh.err.log']:
                path=ROOT/'logs'/name
                if path.exists():
                    with path.open('rb') as f:f.seek(max(0,path.stat().st_size-24000));text=f.read().decode('utf-8','replace')
                    logs.append({'name':name,'text':redact('\n'.join(text.splitlines()[-90:]))})
            auditpath=STATE/'audit.jsonl'
            return {'logs':logs,'audit':auditpath.read_text()[-16000:] if auditpath.exists() else ''}
        if method=='models':
            p=get_config()['model'];e=envvalues()
            # Endpoint is fixed to the configured gateway, never supplied by an HTTP request.
            expected=(os.environ.get('WHALE_API_BASE') or 'https://api.example.com/v1').rstrip('/')
            if p['baseURL'].rstrip('/')!=expected:raise Error('模型网关地址不在配置范围')
            req=urllib.request.Request(p['baseURL']+'/models',headers={'Authorization':'Bearer '+e.get('WHALE_API_KEY','')})
            with urllib.request.urlopen(req,timeout=15) as r:x=json.load(r)
            data=[{k:m.get(k) for k in ['id','name','routing_name','context_length','max_output_tokens']} for m in x.get('data',[])]
            return {'models':data,'message':'网关模型列表可读取；这不等于真实对话验收。'}
        raise Error('不支持的管理操作')

def admin_backup():
    import tarfile
    out=STATE/'backups';out.mkdir(parents=True,exist_ok=True,mode=0o700)
    name='admin-'+stamp()+'.tar.gz';tmp=out/('.'+name);target=out/name
    selected=[AUTHFILE]
    for name_ in ['audit.jsonl','probes.jsonl','applied.json','revisions','routing-revisions','media-revisions','vision-revisions','vision-catalog.json','vision-probes.jsonl','instruction-revisions','search-revisions','proactive-revisions','persona-lock.json','persona-revisions','persona-prefs-revisions']:
        p=STATE/name_
        if p.is_file():selected.append(p)
        elif p.is_dir() and not p.is_symlink():selected.extend(f for f in p.rglob('*') if f.is_file() and not f.is_symlink())
    with tarfile.open(tmp,'w:gz') as archive:
        for p in selected:
            if not p.is_file() or p.is_symlink():raise Error('管理备份路径无效')
            arc='web/auth.json' if p==selected[0] else 'broker/'+str(p.relative_to(STATE))
            archive.add(p,arcname=arc,recursive=False)
    os.chmod(tmp,0o600);os.replace(tmp,target)
    for old in sorted(out.glob('admin-*.tar.gz'),key=lambda p:p.stat().st_mtime_ns,reverse=True)[7:]:old.unlink()
    audit('admin.backup')
    return {'name':target.name,'bytes':target.stat().st_size}
