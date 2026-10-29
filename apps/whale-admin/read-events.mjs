import { readFileSync,readdirSync,statSync } from 'node:fs';
import { join,basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
const root='/home/qqwhale/.dsh/sessions',magic=Buffer.from([0x28,0xb5,0x2f,0xfd]);
const mode=process.argv[2]||'calls',wanted=process.argv[3]||'';
const files=[];
function walk(d,depth=0){if(depth>4||files.length>=250)return;for(const e of readdirSync(d,{withFileTypes:true})){const p=join(d,e.name);if(e.isDirectory())walk(p,depth+1);else if(e.isFile()&&e.name==='session.v4.jsonl.zstd'&&statSync(p).size<=32*1024*1024)files.push(p)}}
function events(file){const b=readFileSync(file),starts=[];let p=0;while((p=b.indexOf(magic,p))!==-1){starts.push(p);p+=4}let lines='';for(let i=0;i<starts.length;i++){try{lines+=zstdDecompressSync(b.subarray(starts[i],starts[i+1]||b.length),{maxOutputLength:16*1024*1024}).toString('utf8')}catch{}}return lines.split('\n').flatMap(s=>{try{return [JSON.parse(s)]}catch{return []}})}
walk(root);
const calls=[],messages=[],thinking=[];let types={};
const sessionMeta={};
const maxThinkingChars=12000,maxThinkingItems=250,maxPerSession=80;
const text=c=>Array.isArray(c)?c.filter(x=>x.type==='text').map(x=>x.text||'').join('\n'):typeof c==='string'?c:'';
const reasoning=c=>Array.isArray(c)?c.filter(x=>x.type==='reasoning'||x.type==='thinking').map(x=>String(x.text??x.thinking??'')).filter(Boolean).join('\n\n'):'';
for(const file of files){const sid=basename(join(file,'..'));if(wanted&&sid!==wanted)continue;let model=null,start=null,assistant=null,usage={},turn=0;
 const all=events(file);const header=all.find(e=>e.type==='session')||{};const seedLength=Number(header.seedLength||0);
 let title='';for(const e of all)if(e.type==='session/title'&&typeof e.data?.title==='string')title=e.data.title;
 sessionMeta[sid]={sessionId:sid,title:title||'未命名会话'};
 let perSession=0;
 for(const e of all){
  const d=e.data||{};types[e.type]=(types[e.type]||0)+1;
  if(e.type==='model/selection')model=d;
  if(e.type==='turn/start'){start=e.time;turn=d.turn;assistant=null;usage={}}
  if(e.type==='assistant/message'){assistant=d;for(const [k,v]of Object.entries(d.usage||{})){if(typeof v==='number')usage[k]=(usage[k]||0)+v}
   const source=d.message?.source||{};
   const think=reasoning(d.message?.content);
   if(mode==='messages')messages.push({ts:e.time,role:'assistant',text:text(d.message?.content),thinking:think.length>maxThinkingChars?think.slice(0,maxThinkingChars):think,turn:d.turn,seq:e.seq});
   if(mode==='thinking'&&think&&perSession<maxPerSession&&!(seedLength>0&&e.seq<seedLength)){perSession++;const raw=think.length>maxThinkingChars?think.slice(0,maxThinkingChars):think;const han=(think.match(/[\u4e00-\u9fff]/g)||[]).length;const latin=(think.match(/[A-Za-z]/g)||[]).length;thinking.push({ts:e.time,sessionId:sid,title:title||'未命名会话',turn:d.turn||turn,step:d.step,model:source.model||model?.model||'',backend:source.replayState?.response?.responseModel||'',text:raw,chars:think.length,truncated:think.length>maxThinkingChars,legacy:han<20&&latin>20,seq:e.seq})}
  }
  if(e.type==='user/message'&&mode==='messages'&&(!d.source?.kind||d.source.kind==='user'))messages.push({ts:e.time,role:'user',text:text(d.content),seq:e.seq});
  if(e.type==='turn/end'&&!(seedLength>0&&e.seq<seedLength))calls.push({ts:e.time,sessionId:sid,turn:d.turn||turn,reason:d.reason?.kind||'',errorCode:d.reason?.error?.code||null,errorMessage:String(d.reason?.error?.message||'').slice(0,240),durationMs:start?e.time-start:null,model:(()=>{const s=assistant?.message?.source||model||{};return {provider:s.provider,model:s.model,backend:s.replayState?.response?.responseModel}})(),replyChars:text(assistant?.message?.content).length,usage,source:'session-log'});
 }
}
if(mode==='thinking'){
 const sorted=thinking.sort((a,b)=>b.ts-a.ts).slice(0,maxThinkingItems);
 const bySession=new Map();
 for(const item of thinking){const hit=bySession.get(item.sessionId)||{sessionId:item.sessionId,title:item.title,count:0,latest:0};hit.count+=1;hit.latest=Math.max(hit.latest,item.ts);bySession.set(item.sessionId,hit)}
 const sessions=[...bySession.values()].sort((a,b)=>b.latest-a.latest);
 process.stdout.write(JSON.stringify({items:sorted,sessions,total:thinking.length,truncated:thinking.length>maxThinkingItems}));
}else{
 const out=mode==='messages'?{messages:messages.sort((a,b)=>a.ts-b.ts).slice(-80)}:{calls:calls.sort((a,b)=>b.ts-a.ts).slice(0,300),eventTypes:mode==='types'?types:undefined};
 process.stdout.write(JSON.stringify(out));
}
