"""Only the bot's fixed workspace AGENTS.md and fixed search service policy."""
import hashlib,json,time
from pathlib import Path
import domain as d

def instruction_path():
    folder=d.ROOT/'workspace';path=folder/'AGENTS.md'
    if folder.is_symlink() or path.is_symlink() or not path.is_file() or path.stat().st_nlink!=1:raise d.Error('工作区指令文件路径不合法')
    if path.resolve().parent!=folder.resolve():raise d.Error('工作区指令文件路径不合法')
    return path

def runtime_info():
    import integrations as i
    try:
        state=i.bridge('status');peer=next(p for p in state['peers'] if p['scope']=='c2c')
        return i.bridge('inspect',scope=peer['scope'],peer=peer['peer'])
    except Exception:return {'fsAvailable':None,'tools':[],'instructionChanges':[],'pending':True}

def instructions_get():
    path=instruction_path();raw=path.read_bytes()
    if len(raw)>32768:raise d.Error('指令超过32768字节预算')
    text=raw.decode('utf-8');info=runtime_info();sha1=hashlib.sha1(raw).hexdigest()
    changes=info.get('instructionChanges',[])
    return {'path':str(path),'text':text,'bytes':len(raw),'maxBytes':32768,'revision':d.digest(raw),'sha1':sha1,'runtime':info,'loaded':bool(changes and changes[-1].get('digest')==sha1 and changes[-1].get('action')!='remove')}

def instructions_save(body):
    if set(body)-{'text','revision'} or not isinstance(body.get('text'),str):raise d.Error('只允许修改工作区指令正文')
    raw=body['text'].encode('utf-8')
    if not raw.strip() or len(raw)>32768 or '\x00' in body['text']:raise d.Error('指令不能为空、含NUL或超过32768字节')
    path=instruction_path();old=path.read_bytes()
    if body.get('revision')!=d.digest(old):raise d.Error('指令已被其他操作修改，请刷新后保存')
    folder=d.STATE/'instruction-revisions';folder.mkdir(mode=0o700,parents=True,exist_ok=True)
    backup=folder/(d.stamp()+'.md');backup.write_bytes(old);backup.chmod(0o600)
    d.atomic(path,raw);d.audit('instructions.save')
    return {'message':'工作区指令已保存并备份。下一次消息由DSH重新核对加载；当前人格原文保持不变。','instructions':instructions_get()}

def search_get():
    path=d.ROOT/'etc/search-config.json';enabled=json.loads(path.read_text()).get('enabled') if path.exists() else False
    events=[];log=d.ROOT/'data/qqwhale/search-calls.jsonl'
    if log.exists():
        for line in log.read_text()[-120000:].splitlines()[-50:]:
            try:events.append(json.loads(line))
            except ValueError:pass
    return {'enabled':enabled,'endpoint':(d.envvalues().get('WHALE_API_BASE') or 'https://api.example.com/v1'),'transport':'固定 REST 工具桥接','tools':['web_search','web_fetch'],'credentialConfigured':bool(d.envvalues().get('WHALE_API_KEY')),'events':list(reversed(events))}

def search_save(body):
    if set(body)!={'enabled'} or type(body['enabled'])!=bool:raise d.Error('搜索开关格式无效')
    path=d.ROOT/'etc/search-config.json';folder=d.STATE/'search-revisions';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    if path.exists():d.shutil.copyfile(path,folder/(d.stamp()+'.json'))
    d.atomic(path,(json.dumps(body)+'\n').encode(),owner=(0,d.pwd.getpwnam('qqwhale').pw_gid));path.chmod(0o640)
    d.audit('search.save');return {'message':'联网搜索设置已保存，立即生效。'}

def search_test(body):
    if body.get('confirm') is not True or set(body)-{'name','arguments','confirm'} or body.get('name') not in ['web_search','web_fetch'] or not isinstance(body.get('arguments'),dict):raise d.Error('请确认有效的联网测试')
    output=d.run(['/usr/bin/node',str(d.ROOT/'bin/whale-search.mjs'),body['name'],json.dumps(body['arguments'],ensure_ascii=False)],as_bot=True,timeout=70)
    d.audit('search.test');return json.loads(output)
