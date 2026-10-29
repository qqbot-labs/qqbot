"""Fixed-peer proactive QQ check-ins. Worker runs as qqwhale; no shell/tool execution."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import fcntl,hashlib,json,os,re,stat,shutil,subprocess,time,urllib.request,urllib.error,sys
ROOT=Path(os.environ.get('WHALE_ROOT','/home/qqwhale/whale'))
POLICY=ROOT/'etc/proactive.json';DATA=ROOT/'data/qqwhale';STATE=DATA/'proactive-state.json';EVENTS=DATA/'proactive-events.jsonl'
TZ=ZoneInfo('Asia/Shanghai')
DEFAULT={'enabled':False,'appId':'','peer':'','idleMinutes':0,'intervalMinutes':0,'decisionIntervalMinutes':0,'quietStart':'00:00','quietEnd':'00:00','mode':'ai','text':'想起你啦，过来打个招呼。忙的话不用急着回我。'}

def config():
 raw=json.loads(POLICY.read_text()) if POLICY.exists() else {}
 return {**DEFAULT,**{k:v for k,v in raw.items() if k in DEFAULT or k=='appId'}}
def envvalues():return dict(l.split('=',1) for l in (ROOT/'etc/qqbot.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
def atomic(path,obj):
 path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_name('.'+path.name+'.'+str(os.getpid()))
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(fd,'w') as f:json.dump(obj,f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
  os.replace(tmp,path)
 finally:
  if tmp.exists():tmp.unlink()
def read_private(path,limit):
 try:
  directory=os.open(DATA,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
  finally:os.close(directory)
 except FileNotFoundError:return b''
 with os.fdopen(fd,'rb') as f:
  info=os.fstat(f.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>limit:raise RuntimeError('主动消息记录文件不合法')
  return f.read(limit)
def state():
 raw=read_private(STATE,65536)
 return json.loads(raw) if raw else {}

def record(entry):
 DATA.mkdir(parents=True,exist_ok=True)
 if EVENTS.exists() and EVENTS.stat().st_size>512*1024:EVENTS.replace(EVENTS.with_suffix('.jsonl.1'))
 fd=os.open(EVENTS,os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:f.write(json.dumps({'ts':time.time()*1000,**entry},ensure_ascii=False)+'\n')
def read_events():
 raw=read_private(EVENTS,600000)
 if not raw:return []
 out=[]
 for l in raw.decode('utf-8')[-100000:].splitlines()[-40:]:
  try:out.append(json.loads(l))
  except ValueError:pass
 return out[::-1]
def last_inbound(peer):
 # Independent archive contains actual QQ inbound messages only, never automation prompts.
 import sqlite3
 db=ROOT/'data/qqwhale/memory.db'
 if not db.exists():return 0
 with sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True,timeout=3) as c:
  # Schema names are fixed by whale-memory-core; no dynamic SQL.
  row=c.execute('SELECT MAX(ts) FROM msg WHERE peer=? AND scope=?',(peer,'c2c')).fetchone()
 return (row[0] or 0)/1000

def habit_stats(peer):
 import sqlite3,collections
 db=ROOT/'data/qqwhale/memory.db'
 now=time.time();cutoff=int((now-30*86400)*1000)
 hourly=[0]*24;weekday_hour=collections.Counter();days=set();recent7=0
 if db.exists():
  with sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True,timeout=3) as c:
   rows=c.execute('SELECT ts FROM msg WHERE peer=? AND scope=? AND deleted=0 AND ts>=?',(peer,'c2c',cutoff)).fetchall()
  for (ts,) in rows:
   dt=datetime.fromtimestamp(ts/1000,TZ);hourly[dt.hour]+=1;weekday_hour[(dt.weekday(),dt.hour)]+=1;days.add(dt.date())
   if now-ts/1000<7*86400:recent7+=1
 dt=datetime.now(TZ);h=dt.hour
 window=sum(hourly[(h+d)%24] for d in (-1,0,1))
 same=sum(weekday_hour[(dt.weekday(),(h+d)%24)] for d in (-1,0,1))
 top=sorted(((n,i) for i,n in enumerate(hourly) if n),reverse=True)[:6]
 return {'total':sum(hourly),'days':len(days),'recent7':recent7,'hourly':hourly,'currentHour':h,'currentWindow':window,'sameWeekdayWindow':same,'top':top}

def habit_summary(stats,last,s):
 if not stats or not stats.get('total'):return '过去30天没有可用的主动聊天记录，将主要按当前时间与免打扰规则判断。'
 top='、'.join(f'{h:02d}时{n}条' for n,h in stats['top']) or '暂无'
 lasttxt=datetime.fromtimestamp(last,TZ).strftime('%m-%d %H:%M') if last else '无记录'
 sent=s.get('lastSent');senttxt=datetime.fromtimestamp(sent,TZ).strftime('%m-%d %H:%M') if sent else '无记录'
 return f"近30天用户发来{stats['total']}条消息，活跃{stats['days']}天，近7天{stats['recent7']}条；高峰{top}；当前{stats['currentHour']:02d}时前后1小时{stats['currentWindow']}条，近30天同一星期同时段{stats['sameWeekdayWindow']}条；上次用户消息{lasttxt}，上次主动消息{senttxt}。"

def due(c,s,last,now=None,manual=False):
 now=time.time() if now is None else now;dt=datetime.fromtimestamp(now,TZ);date=dt.strftime('%Y-%m-%d')
 if not manual and not c['enabled']:return '已暂停'
 if not re.fullmatch(r'[a-fA-F0-9]{32}',c['peer']):return '尚未选择私聊对象'
 if not last:return '尚无该对象的真实入站消息'
 start=c['quietStart'];end=c['quietEnd'];hh=dt.strftime('%H:%M')
 if not manual and start!=end and (start<=hh<end if start<end else hh>=start or hh<end):return '免打扰时段'
 key=c['appId']+':'+c['peer'];s=s if s.get('target')==key else {}
 status=s.get('status');last_attempt=float(s.get('lastAttempt') or 0);last_sent=float(s.get('lastSent') or 0)
 # flock and the live busy probe own concurrency; stale status is not a timed quota.
 if not manual and last_sent and now-last_sent<c['intervalMinutes']*60:return '距离上次主动消息太近，等待下一次判断'
 if not manual and s.get('lastDecision') and now-float(s['lastDecision'])<c['decisionIntervalMinutes']*60:return '尚未到配置的评估间隔'
 if not manual and now-last<c['idleMinutes']*60:return '最近仍有互动'
 return None

def post(url,body,headers=None,timeout=45):
 req=urllib.request.Request(url,data=json.dumps(body).encode(),headers={'Content-Type':'application/json',**(headers or {})})
 try:
  with urllib.request.urlopen(req,timeout=timeout) as r:raw=r.read(1024*1024+1)
 except urllib.error.HTTPError as e:
  raw=e.read(4096)
  try:code=json.loads(raw).get('code',e.code)
  except ValueError:code=e.code
  raise RuntimeError('接口拒绝，错误码 '+str(code)) from None
 if len(raw)>1024*1024:raise RuntimeError('接口响应过大')
 result=json.loads(raw)
 if isinstance(result,dict) and result.get('code') not in [None,0]:raise RuntimeError('接口拒绝，错误码 '+str(result['code']))
 return result

def bridge(method,**args):
 import socket
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as c:
  c.settimeout(20);c.connect(str(ROOT/'data/.admin-control.sock'));c.sendall((json.dumps({'method':method,**args})+'\n').encode());v=json.loads(c.makefile('rb').readline(1024*1024))
 if not v.get('ok'):raise RuntimeError(v.get('error','本地控制未就绪'))
 return v['data']

def normalize_chat_text(text):
 # Preserve the model's paragraph boundaries, including very short replies.
 return str(text or '').replace('\r\n','\n').replace('\r','\n').strip()

def format_chat(text):
 raw=subprocess.check_output([shutil.which('node') or '/usr/bin/node',str(ROOT/'bin/chat-format.mjs')],input=json.dumps({'text':text}),text=True,timeout=10,env={**os.environ,'WHALE_ROOT':str(ROOT)})
 result=json.loads(raw)
 if not result.get('messages') or not all(isinstance(x,str) and x.strip() for x in result['messages']):raise RuntimeError('主动消息正文为空')
 return result

def _persona_context():
 import yaml
 e=envvalues();rows=yaml.safe_load(Path('/home/qqwhale/.dsh/profiles/web/cordis.patch.yml').read_text())
 def walk(x):
  if isinstance(x,list):
   for v in x:yield from walk(v)
  elif isinstance(x,dict):
   if 'id' in x:yield x
   for v in x.values():yield from walk(v)
 configs={x['id']:x.get('config',{}) for x in walk(rows)}
 persona=configs['persona']['prefix'];model=configs['agent-default-model']['model']
 info=bridge('proactive.meta');model=info.get('model',{}).get('model') or model;sid=info.get('sessionId');recent=[]
 if sid:
  raw=subprocess.check_output(['/usr/bin/node','/opt/whale-admin/read-events.mjs','messages',sid],timeout=20,text=True)
  recent=[{'role':x['role'],'content':x['text'][:800]} for x in json.loads(raw).get('messages',[])[-8:] if x['text'].strip()]
 instructions=(ROOT/'workspace/AGENTS.md').read_text()
 profile_path=ROOT/'data/qqwhale/persona-preferences.json'
 if profile_path.exists():
  profile=json.loads(profile_path.read_text())
  active=[{'id':x.get('id'),'kind':x.get('kind','preference'),'key':x.get('key',''),'text':x['text']} for x in profile.get('items',[]) if x.get('text')]
  instructions+='\n【当前长期熟悉档案，最新值优先】\n'+json.dumps(active,ensure_ascii=False)
  instructions+='\n【已撤销主题，不从旧聊天恢复】'+json.dumps([x['key'] for x in profile.get('revoked',[]) if x.get('key')],ensure_ascii=False)
 return e,persona,model,recent,instructions

def generate_ai(c):
 if c['mode']=='fixed':return c['text'],{'kind':'fixed'}
 e,persona,model,recent,instructions=_persona_context()
 prompt='这是后台主动关心任务，不是用户新发言。请延续人格、结合下方近期对话，主动发一句轻松自然的关心或分享。像熟悉的QQ朋友随口接话，一句够了就停；两个独立意思用空行分开。不凑字数，不反复追问、不制造焦虑、不声称观察到现实情况、不要求用户立即回复、不提后台或定时任务、不输出工具控制标记。只输出要发送的正文。\n北京时间：'+datetime.now(TZ).strftime('%Y-%m-%d %H:%M')+'\n近期对话仅供背景：'+json.dumps(recent,ensure_ascii=False)
 api_base=(e.get('WHALE_API_BASE') or 'https://api.example.com/v1').rstrip('/')
 start=time.time();out=post(api_base+'/chat/completions',{'model':model,'messages':[{'role':'system','content':persona+'\n\n'+instructions},{'role':'user','content':prompt}],'max_tokens':4096,'stream':False,'thinking':{'type':'disabled'},'reasoning_effort':'low'},{'Authorization':'Bearer '+e['WHALE_API_KEY']},timeout=60)
 text=out.get('choices',[{}])[0].get('message',{}).get('content','')
 if not isinstance(text,str) or not text.strip():raise RuntimeError('模型未返回正文')
 text=normalize_chat_text(text).strip()
 if re.search(r'\[MEDIA:|\[RECALL\]',text):raise RuntimeError('主动消息包含未解析的控制标记')
 return text,{'kind':'ai','model':model,'backend':out.get('model'),'durationMs':round((time.time()-start)*1000),'usage':out.get('usage',{})}

def decide_and_generate(c,s,last):
 if c['mode']=='fixed':return True,c['text'],{'kind':'fixed'},'固定文案'
 e,persona,model,recent,instructions=_persona_context()
 stats=habit_stats(c['peer']);habits=habit_summary(stats,last,s)
 prompt='这是后台主动关心调度，不是用户新发言。请结合当前北京时间、用户过去30天的主动聊天习惯、近期对话、上次主动消息后的反馈，判断此刻是否适合主动发一条QQ消息。不存在每日次数、夜间或静默天数限制；根据近期对话和具体话题判断有没有自然想说的话，不按打卡凑消息，不仅凭沉默就假定对方不想聊。如果适合，延续人格随口说一句，两个独立意思用空行分开，不凑字数，不劝睡、不说教、不制造焦虑、不要求立即回复、不声称观察到现实、不提后台或定时任务。\n只输出严格JSON，不要markdown：{"send":true或false,"reason":"一句内部判断理由","text":"适合时发送的正文，不适合时为空字符串"}。\n当前：'+datetime.now(TZ).strftime('%Y-%m-%d %H:%M %A')+'\n习惯摘要：'+habits+'\n上次主动消息（勿重复发送）：'+str(s.get('lastText') or '')+'\n近期对话仅供背景：'+json.dumps(recent,ensure_ascii=False)
 api_base=(e.get('WHALE_API_BASE') or 'https://api.example.com/v1').rstrip('/')
 start=time.time();out=post(api_base+'/chat/completions',{'model':model,'messages':[{'role':'system','content':persona+'\n\n'+instructions},{'role':'user','content':prompt}],'max_tokens':800,'stream':False,'thinking':{'type':'disabled'},'reasoning_effort':'low'},{'Authorization':'Bearer '+e['WHALE_API_KEY']},timeout=60)
 raw=out.get('choices',[{}])[0].get('message',{}).get('content','')
 if not isinstance(raw,str) or not raw.strip():raise RuntimeError('主动判断未返回正文')
 clean=re.sub(r'^```(?:json)?\s*|\s*```$','',raw.strip(),flags=re.I)
 try:
  obj=json.loads(clean)
 except ValueError:
  a=clean.find('{');b=clean.rfind('}')
  if a<0 or b<=a:raise RuntimeError('主动判断未返回有效JSON')
  obj=json.loads(clean[a:b+1])
 if not isinstance(obj,dict) or type(obj.get('send'))!=bool:raise RuntimeError('主动判断缺少send字段')
 reason=str(obj.get('reason') or '')[:160];usage={'kind':'decision','model':model,'backend':out.get('model'),'durationMs':round((time.time()-start)*1000),'usage':out.get('usage',{})}
 if not obj['send']:return False,'',usage,reason or '判断此时不适合打扰'
 text=normalize_chat_text(obj.get('text') or '').strip()
 if not text:raise RuntimeError('判断为发送但正文为空')
 if re.search(r'\[MEDIA:|\[RECALL\]',text):raise RuntimeError('主动消息包含未解析的控制标记')
 return True,text,usage,reason or '适合主动问候'

def generate(c):
 return generate_ai(c)

def tick(manual=False,preview=False):
 DATA.mkdir(parents=True,exist_ok=True);fd=os.open(DATA/'.proactive.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return {'status':'skipped','reason':'已有主动任务执行中'}
  c=config();e=envvalues()
  if not c['peer'] or c['appId']!=e.get('QQBOT_APPID'):return {'status':'skipped','reason':'目标未配置或属于其他AppID'}
  s=state();now=time.time();last=last_inbound(c['peer']);reason=due(c,s,last,now,manual=manual or preview)
  if reason:return {'status':'skipped','reason':reason}
  try:meta=bridge('proactive.meta')
  except Exception:return {'status':'skipped','reason':'QQ服务或目标尚未就绪'}
  if meta.get('busy'):return {'status':'skipped','reason':'当前对话正在回复'}
  if preview:
   text,usage=generate(c);text=normalize_chat_text(text);return {'status':'preview','text':text,'generation':usage}
  key=c['appId']+':'+c['peer'];day=datetime.fromtimestamp(now,TZ).strftime('%Y-%m-%d')
  if s.get('target')!=key:s={}
  if manual:
   text,usage=generate(c);why='手动测试'
  else:
   try:
    should,text,usage,why=decide_and_generate(c,s,last)
   except Exception as error:
    why=re.sub(r'sk-[A-Za-z0-9_-]+','[隐藏]',str(error))[:180]
    s.update(target=key,day=day,lastDecision=now,lastDecisionReason=why,status='deferred');atomic(STATE,s)
    record({'status':'deferred','appId':c['appId'],'peer':c['peer'],'reason':why,'manual':False})
    return {'status':'skipped','reason':'主动判断暂不发送：'+why}
   if not should:
    s.update(target=key,day=day,lastDecision=now,lastDecisionReason=why,status='deferred');atomic(STATE,s)
    record({'status':'deferred','appId':c['appId'],'peer':c['peer'],'reason':why,'manual':False})
    return {'status':'skipped','reason':'主动判断暂不发送：'+why}
  if not manual and s.get('status')=='unknown' and text==s.get('lastPlannedText') and last<=float(s.get('attemptInboundAt') or 0):
   return {'status':'skipped','reason':'上一条相同消息结果未知，不自动重发原文'}
  s.update(lastPlannedText=text,attemptInboundAt=last,target=key,day=day,attempts=(s.get('attempts',0) if s.get('day')==day else 0)+1,lastAttempt=now,lastDecision=now,lastDecisionReason=why,status='preparing')
  # Commit attempt before network; crash/timeout never produces automatic resend.
  atomic(STATE,s)
  try:
   text=normalize_chat_text(text)
   # Cancel if a real message arrived, policy changed or chat became busy during generation.
   if config()!=c:raise RuntimeError('生成期间设置已改变，取消发送')
   if last_inbound(c['peer'])>last or bridge('proactive.meta').get('busy'):raise RuntimeError('生成期间收到新消息或对话忙，取消发送')
   if envvalues().get('QQBOT_APPID')!=c['appId']:raise RuntimeError('生成期间机器人账号已切换，取消发送')
   token=post('https://api.bot.qq.com/app/getAppAccessToken',{'appId':e['QQBOT_APPID'],'clientSecret':e['QQBOT_SECRET']},timeout=20).get('access_token')
   if not token:raise RuntimeError('QQ平台认证失败')
   formatted=format_chat(text);message_ids=[];sent_parts=[];context_recorded=True
   s.update(status='preparing',messageIds=[],sentParts=0,totalParts=len(formatted['messages']));atomic(STATE,s)
   for index,part in enumerate(formatted['messages']):
    if index:
     time.sleep(formatted['delays'][index-1]/1000)
    if config()!=c or last_inbound(c['peer'])>last or bridge('proactive.meta').get('busy'):
     s.update(status='interrupted',lastSent=time.time(),lastText='\n\n'.join(sent_parts));atomic(STATE,s)
     record({'status':'interrupted','sentParts':len(sent_parts),'totalParts':len(formatted['messages'])})
     return {'status':'interrupted','sentParts':len(sent_parts),'message':'分条发送期间收到新消息或配置变化，剩余内容未发送。'}
    s['status']='sending';atomic(STATE,s)
    out=post('https://api.bot.qq.com/v2/users/'+c['peer']+'/messages',{'msg_type':0,'content':part,'msg_seq':(int(now*1000)+index)%2147483647},{'Authorization':'QQBot '+token,'X-Union-Appid':e['QQBOT_APPID']},timeout=20)
    if not out.get('id'):raise RuntimeError('QQ未返回消息ID，状态不确定')
    message_ids.append(out['id']);sent_parts.append(part)
    try:bridge('proactive.context',text=part,messageId=out['id'])
    except Exception:context_recorded=False
    s.update(status='preparing',messageIds=message_ids,sentParts=len(message_ids),lastSent=time.time(),lastText='\n\n'.join(sent_parts));atomic(STATE,s)
   s.update(status='sent',lastSent=time.time(),messageId=out['id'],lastText=text,lastDecisionReason='已发送');atomic(STATE,s)
   note=context_recorded
   record({'status':'sent','appId':c['appId'],'peer':c['peer'],'text':text,'contextRecorded':note,'generation':usage,'manual':manual})
   return {'status':'sent','text':text,'contextRecorded':note,'generation':usage,'sentParts':len(message_ids),'message':'QQ平台已接受主动消息。'}
  except Exception as error:
   uncertain=s.get('status')=='sending' and not str(error).startswith('接口拒绝')
   s.update(status='unknown' if uncertain else 'failed',error=re.sub(r'sk-[A-Za-z0-9_-]+','[隐藏]',str(error))[:180]);atomic(STATE,s);record({'status':s['status'],'error':s['error'],'manual':manual})
   return {'status':s['status'],'message':s['error']+'；本次不自动重试。'}

if __name__=='__main__':
 try:print(json.dumps(tick(manual='--send' in sys.argv,preview='--preview' in sys.argv),ensure_ascii=False))
 except Exception as e:print(json.dumps({'status':'failed','message':str(e)[:180]},ensure_ascii=False));sys.exit(1)

# Privileged GUI policy management; never called by the unprivileged tick entry point.
def get():
 import domain as d,integrations as i
 c=config();s=state();peers=i.bridge('status')['peers'];current=d.envvalues().get('QQBOT_APPID')
 last=last_inbound(c['peer']) if c['peer'] else 0
 stats=habit_stats(c['peer']) if c['peer'] else {}
 reason=due(c,s,last) if c['peer'] and c['appId']==current else '目标未配置或属于其他AppID'
 return {'config':c,'revision':hashlib.sha256(POLICY.read_bytes()).hexdigest() if POLICY.exists() else 'missing','state':s,'reason':reason or '下次检查可评估','peers':[{'peer':p['peer'],'lastActivity':p.get('lastActivity')} for p in peers if p['scope']=='c2c'],'currentAppId':current,'events':read_events(),'timezone':'Asia/Shanghai','checkEveryMinutes':5,'habit':habit_summary(stats,last,s) if stats else '尚未选择联系对象','habitStats':{k:v for k,v in stats.items() if k in ('total','days','recent7','currentHour','currentWindow','sameWeekdayWindow')} if stats else {}}

def save(body):
 import domain as d,integrations as i
 if set(body)!={'config','revision'} or not isinstance(body['config'],dict):raise d.Error('主动关心设置格式无效')
 allowed=set(DEFAULT)-{'appId'};v=body['config']
 if set(v)!=allowed:raise d.Error('主动关心设置包含未知或缺失字段')
 if type(v['enabled'])!=bool:raise d.Error('开关格式无效')
 for k,lo,hi in [('idleMinutes',0,None),('intervalMinutes',0,None),('decisionIntervalMinutes',0,None)]:
  if type(v[k])!=int or v[k]<lo:raise d.Error('数值超出范围：'+k)
 for k in ['quietStart','quietEnd']:
  if not isinstance(v[k],str) or not re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]',v[k]):raise d.Error('免打扰时间应为HH:MM')
 if v['mode'] not in ['ai','fixed'] or not isinstance(v['text'],str) or not v['text'].strip() or '\x00' in v['text']:raise d.Error('主动消息文案格式无效')
 if re.search(r'\[MEDIA:|\[RECALL\]',v['text']):raise d.Error('主动文案不能含未解析的控制标记')
 current=get()
 if body['revision']!=current['revision']:raise d.Error('设置已被修改，请刷新后保存')
 peer=v['peer'];old=current['config']
 if not isinstance(peer,str) or not re.fullmatch(r'[a-fA-F0-9]{32}',peer) or not (peer in [p['peer'] for p in current['peers']] or peer==old['peer'] and old['appId']==current['currentAppId']):raise d.Error('请选择当前机器人实际联系过的私聊对象')
 c={**v,'appId':current['currentAppId']};folder=d.STATE/'proactive-revisions';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
 if POLICY.exists():shutil_path=folder/(d.stamp()+'.json');shutil_path.write_bytes(POLICY.read_bytes());shutil_path.chmod(0o600)
 d.atomic(POLICY,(json.dumps(c,ensure_ascii=False)+'\n').encode(),owner=(0,d.pwd.getpwnam('qqwhale').pw_gid));POLICY.chmod(0o640);d.audit('proactive.save');return {'message':'主动关心设置已保存，无需重启机器人。','proactive':get()}

def test(body):
 import domain as d
 if set(body)!={'action','confirm'} or body['action'] not in ['preview','send'] or body['confirm'] is not True:raise d.Error('请确认有效的主动消息测试')
 out=d.run(['/usr/bin/python3',str(Path(__file__)), '--preview' if body['action']=='preview' else '--send'],as_bot=True,timeout=110)
 d.audit('proactive.'+body['action']);return json.loads(out)
