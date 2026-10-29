import asyncio,json,time
import websockets
from .store import now,js
from .adapters import Rejected

async def event_loop(engine,channel):
    delay=5
    while not engine.stopping:
        cfg=engine.s.config();ch=cfg.channel if channel=='qq' else cfg.qzone
        if not ch.enabled:
            await asyncio.sleep(3);continue
        url=ch.ws_url;token=engine.s.secret('qq_token' if channel=='qq' else 'qzone_token')
        try:
            async with websockets.connect(url,additional_headers={'Authorization':'Bearer '+token},max_size=2*1024*1024,open_timeout=10,ping_interval=20) as ws:
                delay=5
                async for raw in ws:
                    try:engine.ingest(channel,json.loads(raw))
                    except (ValueError,TypeError,KeyError):engine.s.log('','inbound','skipped','事件格式不支持或缺少稳定 ID')
        except asyncio.CancelledError:raise
        except Exception:
            engine.s.set('health_'+channel,{'online':False,'verified':True,'checked':now(),'reason':'事件连接断开，有限退避重连'})
        await asyncio.sleep(delay);delay=min(300,delay*2)

async def periodic(engine):
    s=engine.s
    while not engine.stopping:
        cfg=s.config()
        for name,seconds in [('qzone_poll',cfg.qzone.poll_minutes*60),('decision',cfg.policy.decision_minutes*60),('retention',3600)]:
            rows=s.rows('SELECT * FROM tasks WHERE name=?',(name,))
            if not rows:
                with s.db() as c:c.execute('INSERT INTO tasks(name,next) VALUES(?,?)',(name,now()+seconds))
                continue
            task=rows[0]
            if task['next']>now():continue
            stamp=now();started=time.monotonic();detail='无待办，跳过模型调用';failure=0
            # Claim before execution. Single process lock prevents duplicate scheduler owners.
            with s.db() as c:c.execute('UPDATE tasks SET next=?,last=? WHERE name=?',(stamp+seconds,stamp,name))
            try:
                if name=='qzone_poll' and cfg.qzone.enabled and cfg.qzone.read:
                    await poll_qzone(engine);detail='好友流轮询完成；覆盖以接口返回为准'
                elif name=='decision':
                    await autonomous(engine);detail='评估许可与待办；无候选时不调用模型'
                elif name=='retention':
                    with s.db() as c:
                        c.execute("DELETE FROM events WHERE channel='qq' AND created<?",(now()-cfg.policy.retention_days*86400,))
                        c.execute("DELETE FROM events WHERE channel='qzone' AND created<?",(now()-cfg.qzone.retention_days*86400,))
                        c.execute('DELETE FROM logs WHERE created<?',(now()-cfg.policy.log_days*86400,))
                    detail='已执行事件与日志保留策略；不清理发送账本去重锚点'
            except asyncio.CancelledError:raise
            except Exception:failure=1;detail='任务失败；已隔离，等待下个周期'
            detail+='；耗时 '+format(time.monotonic()-started,'.3f')+' 秒'
            with s.db() as c:c.execute('UPDATE tasks SET detail=?,failures=? WHERE name=?',(detail,task['failures']+failure if failure else 0,name))
        await asyncio.sleep(2)

async def poll_qzone(engine):
    async with engine.decide_lock:
        return await _poll_qzone(engine)

async def _poll_qzone(engine):
    s=engine.s;cfg=s.config();stamp=now();baseline=s.get('qzone_baseline')
    try:
        cursor=''
        for page in range(cfg.qzone.pages):
            result=await engine.channels.call('qzone','get_friend_feeds',{'cursor':cursor,'num':cfg.qzone.candidates,'include_image_data':False})
            # Preserve parser metadata, never equate a parse miss with an empty feed.
            if not isinstance(result,dict):raise Rejected('好友流结构无效')
            feeds=result.get('feeds',result.get('items',result.get('msglist')))
            if feeds is None:raise Rejected('未识别到动态列表；不能判断没有新动态')
            for item in feeds[:cfg.qzone.candidates]:
                friend=str(item.get('uin') or item.get('user_id') or '')
                if not engine.permitted(friend,'read'):continue
                tid=str(item.get('tid') or item.get('id') or '')
                if not tid:continue
                created=float(item.get('created_time') or item.get('time') or 0)
                # Missing timestamps are baseline only; never synthesize freshness from polling time.
                e={'user_id':friend,'event_id':'feed:'+friend+':'+tid,'tid':tid,'text':str(item.get('content') or item.get('text') or ''),'time':created or 1}
                r=engine.ingest('qzone',e)
                if not baseline and r.get('id'):
                    with s.db() as c:c.execute("UPDATE events SET state='baseline' WHERE id=?",(r['id'],))
            cursor=str(result.get('next_cursor') or '')
            if not result.get('has_more') or not cursor:break
        if cfg.qzone.reply and cfg.channel.qq_id:
            await poll_own_comments(engine,baseline,stamp)
        s.set('qzone_baseline',baseline or stamp)
        s.set('health_qzone',{'online':True,'verified':True,'checked':stamp,'reason':'读取完成；可能存在接口解析缺项','last_read':stamp})
    except Exception:
        s.set('health_qzone',{'online':False,'verified':True,'checked':stamp,'reason':'动态读取失败，与无新动态不同；私聊独立运行'})
        raise

async def autonomous(engine):
    async with engine.decide_lock:
        return await _autonomous(engine)

async def _autonomous(engine):
    s=engine.s;cfg=s.config()
    if s.get('stop_all') or s.get('pause_active') or not s.get('social_running') or not cfg.policy.enabled or not s.active_persona():return
    # Only explicit, sourced memory candidates can trigger proactive decisions.
    friends=s.rows('SELECT id FROM friends')
    for f in friends:
        friend=f['id'];probe={'channel':'qq','friend':friend,'action':'proactive','proactive':1,'test':0}
        if engine.gate(probe):continue
        memories=s.rows('SELECT body,source,label FROM memories WHERE friend=? AND kind=? ORDER BY id DESC LIMIT 10',(friend,'memory'))
        if not memories:continue
        # One decision candidate per day, even when model skips.
        key='decision:'+str(int(engine.day()))+':'+friend
        if s.get(key):continue
        s.set(key,True)
        context=engine.context(True)
        try:
            text=await engine.model.complete([{'role':'system','content':s.active_persona()['body']+'\n仅根据有来源的本好友记忆，判断是否值得主动联系。可以不行动；无必要则输出 <SKIP>。不得编造经历。'},{'role':'user','content':js(memories)}])
            if text.strip()!='<SKIP>':
                id=engine.generated(key,'qq',friend,'proactive',{'segments':[{'type':'text','data':{'text':text}}]},context)
                if id:await engine.dispatch(id)
        except Exception:s.log(friend,'proactive','failed','模型不可用；不自动补发')

    if cfg.qzone.enabled and cfg.qzone.publish:
        public=s.rows("SELECT body,source,label FROM memories WHERE friend='' AND kind='growth' AND label='fact' ORDER BY id DESC LIMIT 10")
        probe={'channel':'qzone','friend':'','action':'publish','proactive':1,'test':0}
        key='publish-decision:'+str(int(engine.day()))
        if public and not engine.gate(probe) and not s.get(key):
            s.set(key,True)
            context=engine.context(True)
            try:
                text=await engine.model.complete([{'role':'system','content':s.active_persona()['body']+'\n仅根据主人明确标为公开的成长素材决定是否发布说说，不引用私聊，不编造经历；不发布则输出 <SKIP>。'},{'role':'user','content':js(public)}])
                if text.strip()!='<SKIP>':
                    id=engine.generated(key,'qzone','','publish',{'message':[{'type':'text','data':{'text':text}}]},context)
                    if id:await engine.dispatch(id)
            except Exception:s.log('','publish','failed','模型不可用；不补发')


async def poll_own_comments(engine,baseline,stamp):
    s=engine.s;cfg=s.config();owner=cfg.channel.qq_id
    posts=await engine.channels.call('qzone','get_emotion_list',{'user_id':owner,'num':cfg.qzone.candidates,'max_pages':1,'include_image_data':False})
    for post in posts.get('msglist',[])[:cfg.qzone.candidates]:
        tid=str(post.get('tid') or '')
        if not tid:continue
        result=await engine.channels.call('qzone','get_comment_list',{'user_id':owner,'tid':tid,'num':20,'pos':0})
        if result.get('availability')=='not_embedded':
            s.log('','qzone-comments','skipped','评论内容未嵌入，不能视为没有评论');continue
        for comment in result.get('comments',[]):
            # 上游移动端评论键为小写 commentid；同时兼容驼峰与包装层字段。
            friend=str(comment.get('uin') or comment.get('user_id') or '')
            cid=str(comment.get('commentid') or comment.get('commentId') or comment.get('comment_id') or comment.get('id') or '')
            if not friend.isdecimal() or not cid or friend==owner:continue
            created=float(comment.get('createdTime') or comment.get('createTime') or comment.get('createtime') or comment.get('created_time') or comment.get('time') or 1)
            if created>100000000000:created/=1000
            event={'event_id':'comment:'+tid+':'+cid,'user_id':friend,'sub_type':'comment','tid':tid,'owner_uin':owner,'comment_id':cid,'text':str(comment.get('content') or ''),'time':created}
            r=engine.ingest('qzone',event)
            if not baseline and r.get('id'):
                with s.db() as c:c.execute("UPDATE events SET state='baseline' WHERE id=?",(r['id'],))
