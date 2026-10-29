// Root-owned startup hook. Local admin IPC only; no LLM tools or network listener.
import net from 'node:net';
import { chmodSync, existsSync, readFileSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const PACKAGE='/home/qqwhale/.dsh/profiles/web/node_modules/@zaofan/dsh-qqbot/dist';
export const name='whale-admin-local-control';
export function chooseNext(route,current,at=Date.now()) {
  if (!route?.enabled || !Array.isArray(route.models) || route.models.length<2) return null;
  if (at-Number(route.lastSwitchAt||0)<Number(route.cooldownSec??0)*1000) return null;
  const i=route.models.indexOf(current);return route.models[(i+1)%route.models.length];
}
export function providerFailure(event) {
  const r=event?.data?.reason;
  if (!r?.error) return false;
  const s=JSON.stringify(r.error);
  if (/CONTEXT_WINDOW_EXCEEDED|context overflow|abort|cancel/i.test(s)) return false;
  return /429|50[234]|rate.?limit|timeout|timed.out|ECONN|ETIMEDOUT|overloaded|unavailable|provider.?error/i.test(s);
}
export async function run(env) {
  const registry=await import(pathToFileURL(join(PACKAGE,'features/session-registry.js')).href);
  const socket=join(env.dataRoot,'.admin-control.sock'),dir=join(env.dataRoot,'qqwhale');
  mkdirSync(dir,{recursive:true,mode:0o700});
  let lastSwitch=0;
  const routeFile=join(env.dataRoot,'..','etc','admin-routing.json'),callFile=join(dir,'calls.jsonl'),routeLog=join(dir,'routing-events.jsonl');
  const ns=env.config.settingsNs||'qqwhale';
  const manager=()=>registry.managersOf().find(m=>m.settingsNs===ns);
  const peers=()=>{
    const configured=[...(env.config.access?.c2cAllow||[]).map(peer=>({scope:'c2c',peer})),...(env.config.access?.groupAllow||[]).map(peer=>({scope:'group',peer}))];
    const active=env.config.access?.c2cMode==='open'?(manager()?.listSessions()||[]).filter(r=>r.scope==='c2c').map(r=>({scope:r.scope,peer:r.peerId})):[];
    return [...new Map([...configured,...active].map(p=>[p.scope+':'+p.peer,p])).values()];
  };
  const getPeer=(scope,peer)=>{
    if(!['c2c','group'].includes(scope)||!/^[a-fA-F0-9]{32}$/.test(peer)||!peers().some(p=>p.scope===scope&&p.peer===peer))throw Error('目标不是本机器人已授权或已连接的会话');
    const m=manager();if(!m)throw Error('QQ 连接尚未就绪');return m;
  };
  const routeConfig=()=>{try{return JSON.parse(readFileSync(routeFile,'utf8'))}catch{return {enabled:false,models:[],cooldownSec:0}}};
  try { const history=readFileSync(routeLog,'utf8').trim().split('\n').slice(-30).map(x=>JSON.parse(x));lastSwitch=Math.max(0,...history.filter(x=>x.status==='switched').map(x=>x.ts)); } catch {}
  let chain=Promise.resolve();
  async function handle(x){
    if(x.method==='status'){
      const m=manager();return {appId:env.config.appId,namespace:ns,online:registry.isBotOnline(ns),peers:peers().map(p=>({...p,...m?.getStatus(p.scope,p.peer),sessionId:m?.sessionIdFor(p.scope,p.peer),model:m?.getEffectiveModel(p.scope,p.peer),reasoningEffort:m?.getSessionRecord(p.scope,p.peer)?.agent?.options?.reasoningEffort??null,usage:m?.getTokenUsage(p.scope,p.peer)})),routing:routeConfig()};
    }
    if (['media.tag','media.promote','media.trash','media.restore','media.delete'].includes(x.method)) {
      const m=manager();if(!m)throw Error('QQ 实例未就绪');
      if(!/^[A-Za-z0-9_-]{6,80}$/.test(String(x.id||'')))throw Error('图片 ID 无效');
      const mod=await import(pathToFileURL(join(PACKAGE,'features/sticker-store.js')).href);
      const store=mod.getStickerStore(m.stickerDataDir,env.logger,ns);
      if(!store.pathOf(x.id))throw Error('图库中没有这张图片');
      if(x.method==='media.tag'){
        if(!Array.isArray(x.tags)||x.tags.length>12||!x.tags.every(t=>typeof t==='string'&&t.length<=30)||typeof x.desc!=='string'||x.desc.length>500)throw Error('标签或描述格式无效');
        store.setDescTags(x.id,x.tags,x.desc);
      } else if(x.method==='media.promote')store.promote(x.id);
      else if(x.method==='media.trash')store.markTrash(x.id);
      else if(x.method==='media.delete'){
        const item=store.get(x.id);
        if(!item)throw Error('图库中没有这张图片');
        if(item.layer!=='trash')throw Error('只能永久删除回收站中的图片');
        if(!store.purge(x.id))throw Error('永久删除失败');
      } else store.restore(x.id);
      store.flush();return {message:x.method==='media.delete'?'图片文件与索引已永久删除。':'图库更新已保存。'};
    }
    if(['proactive.meta','proactive.context'].includes(x.method)){
      const policy=JSON.parse(readFileSync(join(env.dataRoot,'..','etc/proactive.json'),'utf8'));
      if(String(policy.appId)!==String(env.config.appId)||!/^[a-fA-F0-9]{32}$/.test(policy.peer))throw Error('主动消息目标与当前机器人不匹配');
      if(env.config.access?.c2cMode==='disabled'||env.config.access?.c2cMode==='allowlist'&&!env.config.access.c2cAllow?.includes(policy.peer))throw Error('目标私聊已关闭');
      const m=manager();if(!m)throw Error('QQ连接尚未就绪');
      let r=m.findByPeer('c2c',policy.peer);
      if(!r)r=await m.getOrCreate('c2c',policy.peer,policy.peer,{scope:'c2c',targetId:policy.peer});
      const busy=r.turnActive||r.agent.status==='running';
      if(x.method==='proactive.meta')return {sessionId:r.sessionId,busy:!!busy,lastInboundAt:r.lastInboundAt,model:m.getEffectiveModel('c2c',policy.peer)};
      if(typeof x.text!=='string'||busy||typeof r.agent.inject!=='function')throw Error('无法记录主动消息上下文');
      const {createUserMessage}=await import('/home/qqwhale/whale/app/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
      const deliveryId=String(x.messageId||'');
      if(deliveryId&&(r.agent.session.log||[]).some(e=>e.type==='user/message'&&e.data?.source?.kind==='whale-proactive-notice'&&e.data.source.deliveryId===deliveryId))return {recorded:true,persisted:true};
      const message=createUserMessage({source:{kind:'whale-proactive-notice',deliveryId},content:[{type:'text',text:'【后台发送记录，并非用户发言】机器人刚刚主动发送给当前用户：'+x.text+'。仅作后续对话背景，现在无需回复。'}]});
      const {canSilentlyAppend}=await import(pathToFileURL(join(PACKAGE,'session/surface-guard.js')).href);
      if(canSilentlyAppend(r.agent.session)&&typeof r.agent.session.append==='function'){
        r.agent.session.append('user/message',message,{surfaceOp:'append'});return {recorded:true,persisted:true};
      }
      r.agent.inject(message);return {recorded:true,persisted:false};
    }
    const scope=String(x.scope||''),peer=String(x.peer||'');const m=getPeer(scope,peer);
    let record=m.findByPeer(scope,peer);
    if(!record)record=await m.getOrCreate(scope,peer,peer,{scope,targetId:peer});
    if(x.method==='inspect'){
      const changes=[];
      for(const seq of record.agent.session?.surface?.nodes||[]){
        const e=record.agent.session.eventAt(seq);
        if(e?.type==='user/message'&&e.data?.source?.kind==='agent-instructions'){
          for(const c of e.data.source.changes||[])if(c.path==='AGENTS.md')changes.push({action:c.action,path:c.path,digest:c.digest});
        }
      }
      return {sessionId:record.sessionId,fsAvailable:!!record.agent.ctx.get('fs'),tools:record.agent.ctx.tools.schemas(record.agent).map(t=>t.name),instructionChanges:changes.slice(-5)};
    }
    if(x.method==='cancel'){record.agent.cancel({kind:'user'});return {message:'已请求停止当前生成'};}
    if(record.turnActive||record.agent.status==='running')throw Error('会话正在处理消息，请先等待结束或停止生成');
    if(x.method==='new'){
      const previous=record.sessionId;const result=await m.startNewSession(scope,peer,false);
      if(result==='failed')throw Error('新会话创建失败，原会话保留');
      return {message:'已开启无历史上下文的新会话；旧档与独立记忆保留。',previous,result,sessionId:m.sessionIdFor(scope,peer)};
    }
    if(x.method==='model'){
      const models=await m.listAvailableModels();
      if(!models.some(v=>v.provider==='whale-gateway'&&(v.model===x.model||v.id===x.model)))throw Error('模型不在运行中的授权供应商目录');
      const effort=x.reasoningEffort??undefined;
      if(effort!==undefined&&!['off','minimal','low','medium','high','xhigh','max'].includes(effort))throw Error('思考档位无效');
      const route={provider:'whale-gateway',model:x.model};
      if(effort!==undefined)route.reasoningEffort=effort;
      await m.setModelOverride(scope,peer,route);
      if(m.getEffectiveModel(scope,peer)?.model!==x.model)throw Error('模型切换未能验证生效，请刷新后检查');
      const applied=m.getSessionRecord(scope,peer)?.agent?.options?.reasoningEffort??null;
      return {message:'已切换会话模型'+(effort!==undefined?'与思考档位':'')+'，保留对话历史。',sessionId:m.sessionIdFor(scope,peer),model:m.getEffectiveModel(scope,peer),reasoningEffort:applied};
    }
    if(x.method==='compact'){
      const service=record.agent.ctx.get('compaction');if(!service?.compactNow)throw Error('当前会话没有手动压缩服务');
      const out=await service.compactNow(record.agent,AbortSignal.timeout(90000));
      return {message:out?'上下文已压缩并持久化。':'目前没有可安全压缩的历史片段。',compacted:!!out};
    }
    throw Error('不支持的会话操作');
  }
  if(existsSync(socket))unlinkSync(socket);
  const server=net.createServer(conn=>{
    let raw='';conn.setEncoding('utf8');conn.setTimeout(110000,()=>conn.destroy());
    conn.on('data',chunk=>{raw+=chunk;if(Buffer.byteLength(raw)>32768){conn.destroy();return}if(!raw.includes('\n'))return;
      conn.pause();chain=chain.catch(()=>{}).then(async()=>{let out;try{out={ok:true,data:await handle(JSON.parse(raw.split('\n')[0]))}}catch(e){out={ok:false,error:String(e.message||e)}}conn.end(JSON.stringify(out)+'\n')});
    });
    conn.on('error',()=>{});
  });
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(socket,()=>{chmodSync(socket,0o600);ok()})});
  const host=env.ctx.root||env.ctx;
  let switching=false;
  const dispose=host.on('session/event',(session,event)=>{
    if(event.type!=='turn/end')return;
    const m=manager(),r=m?.findBySessionId(session.id);if(!r)return;
    const result={ts:Date.now(),sessionId:session.id,scope:r.scope,peer:r.peerId,turn:event.data?.turn,reason:event.data?.reason?.kind||null,errorCode:event.data?.reason?.error?.code||null,model:m.getEffectiveModel(r.scope,r.peerId),usage:m.getTokenUsage(r.scope,r.peerId)};
    try{appendFileSync(callFile,JSON.stringify(result)+'\n',{mode:0o600})}catch{}
    const route={...routeConfig(),lastSwitchAt:lastSwitch};const current=m.getEffectiveModel(r.scope,r.peerId)?.model;
    const next=providerFailure(event)&&chooseNext(route,current);
    if(!next||switching)return;
    switching=true;
    setTimeout(async()=>{
      try{
        if(r.turnActive||r.agent.status==='running')throw Error('会话忙，未执行自动切换');
        const models=await m.listAvailableModels();if(!models.some(v=>v.provider==='whale-gateway'&&(v.model===next||v.id===next)))throw Error('候选模型未加载');
        await m.setModelOverride(r.scope,r.peerId,{provider:'whale-gateway',model:next});
        if(m.getEffectiveModel(r.scope,r.peerId)?.model!==next)throw Error('切换后模型未生效');
        // The route file is admin-owned and read-only to this service. Persist cooldown separately.
        appendFileSync(routeLog,JSON.stringify({ts:Date.now(),peer:r.peerId,from:current,to:next,status:'switched',errorCode:result.errorCode})+'\n',{mode:0o600});
        lastSwitch=Date.now();
      }catch(e){try{appendFileSync(routeLog,JSON.stringify({ts:Date.now(),from:current,to:next,status:'failed',error:String(e.message)})+'\n',{mode:0o600})}catch{}}
      finally{switching=false;}
    },100);
  });

  env.registerDispose(()=>{dispose();server.close();try{unlinkSync(socket)}catch{}});
  env.logger?.info?.('[whale-admin] private session control ready');
}
