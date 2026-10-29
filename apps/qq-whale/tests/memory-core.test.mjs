import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync,copyFileSync,writeFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb,archiveMessage,searchMessages,recentMessages } from '../bin/whale-memory-core.mjs';
import { add,load,remove,loadRevoked } from '../bin/persona-prefs-core.mjs';

test('检索超过旧20/50条上限仍完整返回，0表示全部，保持当前对象隔离',()=>{
  const dir=mkdtempSync(join(tmpdir(),'whale-query-'));const db=openDb(join(dir,'memory.db'));
  try {
    for(let i=0;i<85;i++)archiveMessage(db,{scope:'c2c',peer:'self',sender:'self',ts:100+i,text:'乌龙奶茶偏好'+i,msgKey:'m'+i});
    archiveMessage(db,{scope:'c2c',peer:'other',sender:'other',ts:300,text:'乌龙奶茶偏好他人',msgKey:'other'});
    assert.equal(searchMessages(db,{q:'奶茶',peer:'self',limit:80}).length,80);
    assert.equal(searchMessages(db,{q:'奶茶',peer:'self',limit:0}).length,85);
    assert.equal(recentMessages(db,{peer:'self',limit:80}).length,80);
    assert.equal(recentMessages(db,{peer:'self',limit:0}).length,85);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('真实入站扩展完整归档、按主题提醒保存、更正后注入新档案与撤销标记',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'whale-inbound-'));const base=fileURLToPath(new URL('..',import.meta.url));
  for(const path of ['bin','etc','data/qqwhale','data/.qqbot-extensions/inbound'])mkdirSync(join(dir,path),{recursive:true});
  copyFileSync(join(base,'bin/whale-memory-core.mjs'),join(dir,'bin/whale-memory-core.mjs'));
  copyFileSync(join(base,'bin/persona-prefs-core.mjs'),join(dir,'bin/persona-prefs-core.mjs'));
  copyFileSync(join(base,'extensions/inbound/whale-memory.mjs'),join(dir,'data/.qqbot-extensions/inbound/whale-memory.mjs'));
  const peer='b'.repeat(32),file=join(dir,'data/qqwhale/persona-preferences.json');
  writeFileSync(join(dir,'etc/proactive.json'),JSON.stringify({peer}));
  writeFileSync(join(dir,'data/qqwhale/memory-config.json'),JSON.stringify({maxTextChars:0,recallEnabled:false}));
  const hook=await import(join(dir,'data/.qqbot-extensions/inbound/whale-memory.mjs'));
  const injected=[];
  const invoke=async(text,id)=>hook.onInbound({text,message:{kind:'c2c',senderId:peer,content:text,id,timestamp:Date.now()},silentInto:text=>injected.push(text)},async()=>{});
  try {
    const long='以后叫我阿澈。'.repeat(700);
    await invoke(long,'first');
    assert.equal(existsSync(file),false,'复合原话不应又变成一条与主题档案冲突的偏好');
    assert.ok(injected.some(x=>x.includes('按主题保存')));
    const db=openDb(join(dir,'data/qqwhale/memory.db'));
    assert.equal(recentMessages(db,{peer,limit:1})[0].text,long);db.close();
    await add(file,'叫我阿澈','chat',{key:'称呼',kind:'fact'});
    await add(file,'叫我小澈','chat',{key:'称呼',kind:'fact'});
    const setting=await add(file,'我们设定是海边邻居','chat',{key:'共同设定',kind:'setting'});
    await remove(file,{id:setting.item.id});
    injected.length=0;
    await invoke('我回来了','next');
    const context=injected.join('\n');
    assert.ok(context.includes('叫我小澈'));
    assert.ok(!context.includes('叫我阿澈'));
    assert.ok(context.includes('已撤销的主题'));
    assert.equal(loadRevoked(file)[0].key,'共同设定');
    await add(file,'我们重新设定为海边邻居','chat',{key:'共同设定',kind:'setting'});
    assert.equal(loadRevoked(file).length,0);
  }finally{hook.dispose();rmSync(dir,{recursive:true,force:true});}
});
