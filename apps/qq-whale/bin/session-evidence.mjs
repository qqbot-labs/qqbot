// Actual model-event timestamps and current-session end states; no cache-mtime inference.
import { readFileSync,readdirSync,statSync } from 'node:fs';
import { join,basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const magic=Buffer.from([0x28,0xb5,0x2f,0xfd]);
export function scanProofs(dshHome) {
  const proofs=new Map();let count=0;
  function walk(dir,depth=0){
    if(depth>5||count>=400)return;
    let entries;try{entries=readdirSync(dir,{withFileTypes:true})}catch{return}
    for(const entry of entries){
      if(count>=400)break;
      const p=join(dir,entry.name);
      if(entry.isDirectory()){walk(p,depth+1);continue}
      if(!entry.isFile()||!/^session.*\.jsonl(?:\.zstd)?$/.test(entry.name))continue;
      count++;
      try{
        if(statSync(p).size>32*1024*1024)continue;
        const buf=readFileSync(p);let text='';
        if(entry.name.endsWith('.zstd')){
          const starts=[];let i=0;while((i=buf.indexOf(magic,i))>=0){starts.push(i);i+=4}
          for(let k=0;k<starts.length;k++){
            try{text+=zstdDecompressSync(buf.subarray(starts[k],starts[k+1]||buf.length),{maxOutputLength:16*1024*1024}).toString('utf8')}catch{}
            if(text.length>64*1024*1024)throw Error('oversized history');
          }
        }else text=buf.toString('utf8');
        const proof={lastModel:null,ends:[]};
        for(const line of text.split('\n')){
          let e;try{e=JSON.parse(line)}catch{continue}
          if(e.type==='assistant/message'&&Number(e.data?.usage?.outputTokens)>0&&Number(e.time)>0){
            const source=e.data.message?.source||{};
            proof.lastModel={ts:Number(e.time),turn:e.data.turn,provider:source.provider||'',model:source.model||''};
          }
          if(e.type==='turn/end')proof.ends.push({ts:Number(e.time)||0,turn:e.data?.turn,kind:e.data?.reason?.kind,code:e.data?.reason?.error?.code||'UNKNOWN'});
        }
        proof.ends=proof.ends.slice(-3);proofs.set(basename(dir),proof);
      }catch{}
    }
  }
  walk(join(dshHome,'sessions'));return proofs;
}
export function replyProof(proofs,dataRoot){
  let prefs={};try{prefs=JSON.parse(readFileSync(join(dataRoot,'.qqbot/model-prefs.json'),'utf8'))}catch{}
  let activeKeys=null;
  try {
    const y=createRequire(join(dataRoot,'..','app','package.json'))('js-yaml');
    const config=y.load(readFileSync(join(dshHome,'profiles/web/cordis.patch.yml'),'utf8'));
    const q=config.find(r=>r.id==='im-qqbot')?.config;
    const appId=(readFileSync(join(dataRoot,'..','etc/qqbot.env'),'utf8').match(/^QQBOT_APPID=([0-9]+)$/m)||[])[1];
    if(q&&appId){activeKeys=[];for(const [scope,mode,list]of [['c2c','c2cMode','c2cAllow'],['group','groupMode','groupAllow']])if(q.access?.[mode]==='allowlist')for(const peer of q.access[list]||[])activeKeys.push(`qqbot:${appId}:${scope}:${peer}`);}
  }catch{}
  const keys=activeKeys||[...new Set([...Object.keys(prefs.sessionIds||{}),...Object.keys(prefs.sessionCfg||{})])].filter(k=>/^qqbot:[0-9]+:(?:c2c|group):[A-Fa-f0-9]{32}$/.test(k));
  const ids=keys.map(k=>{if(prefs.sessionIds?.[k])return prefs.sessionIds[k];const h=createHash('sha256').update(k).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`});
  const candidates=(activeKeys!==null||ids.length)?ids.map(id=>proofs.get(id)).filter(Boolean):[...proofs.values()];
  const ends=candidates.flatMap(p=>p.ends);
  const bad=ends.filter(e=>e.kind==='error');
  if(bad.length)return {status:'error',codes:[...new Set(bad.map(e=>e.code))].join(',')};
  if(!ends.length)return {status:'none',codes:''};
  return {status:'ok',codes:''};
}
