import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBridge} from '../deploy/qzone-http.ts';
const token='T'.repeat(40);
async function fixture(run,overrides={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'qqagent-qzone-test-'));
 const client={loggedIn:true,qqNumber:'10001',cookies:{},loginWithCookieString:async()=>{},loginWithPlaywright:async()=>{},...overrides.client};
 let clock=1000000;
 const handler=overrides.handler||{handle:async(action)=>({status:'ok',retcode:0,data:action==='check_cookie'?{valid:true}:{result:true}})};
 const bridge=createBridge({client,handler,token,data,now:()=>clock});
 await new Promise(resolve=>bridge.server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+bridge.server.address().port;
 async function call(action,method='GET',body,auth=true){return fetch(url+'/'+action,{method,headers:{...(auth?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})}
 try{await run({call,client,data,time:(v)=>clock=v})}finally{bridge.close();fs.rmSync(data,{recursive:true,force:true})}
}
test('requires auth; cached uin does not prove online',()=>fixture(async({call})=>{
 assert.equal((await call('health','GET',undefined,false)).status,401);
 assert.equal((await (await call('health')).json()).ok,false);
}));
test('only explicit successful probe verifies and TTL expires',()=>fixture(async({call,time})=>{
 assert.equal((await call('check_cookie','POST',{})).status,200);
 assert.equal((await (await call('health')).json()).ok,true);
 time(1400000);assert.equal((await (await call('health')).json()).ok,false);
}));
test('upstream private error message never escapes',()=>fixture(async({call})=>{
 const response=await call('get_friend_feeds','POST',{});
 assert(!JSON.stringify(await response.json()).includes('PRIVATE_SENTINEL'));
},{handler:{handle:async(a)=>a==='check_cookie'?{status:'ok',retcode:0,data:{valid:true}}:{status:'failed',retcode:1500,message:'PRIVATE_SENTINEL'}}}));
test('write error never becomes known success',()=>fixture(async({call})=>{
 assert.equal((await call('send_comment','POST',{})).status,502);
},{handler:{handle:async(a)=>a==='check_cookie'?{status:'ok',retcode:0,data:{valid:true}}:{status:'failed',retcode:1500}}}));
test('expired/stale QR is removed',()=>fixture(async({call,data})=>{
 fs.writeFileSync(path.join(data,'qrcode.png'),Buffer.from([137,80,78,71,13,10,26,10]));
 assert.equal((await call('qr')).status,404);assert(!fs.existsSync(path.join(data,'qrcode.png')));
}));
test('failed QR clears old files and does not mark logged in',()=>fixture(async({call,client,data})=>{
 client.loginWithPlaywright=async()=>{fs.writeFileSync(path.join(data,'qrcode.png'),'PRIVATE_SENTINEL');throw Error('PRIVATE_SENTINEL')};
 const r=await call('login-qr','POST',{});assert.equal(r.status,200);
 await new Promise(r=>setTimeout(r,10));
 assert.equal((await (await call('health')).json()).ok,false);
 assert(!fs.existsSync(path.join(data,'qrcode.png')));
}));
test('invalid cookie probe cannot prove login',()=>fixture(async({call})=>{
 assert.equal((await call('auth-cookie','POST',{cookie:'COOKIE_SENTINEL'})).status,502);
 assert.equal((await (await call('health')).json()).ok,false);
},{handler:{handle:async()=>({status:'ok',retcode:0,data:{valid:false}})}}));
test('body shape and action whitelist enforced',()=>fixture(async({call})=>{
 assert.equal((await call('get_friend_feeds','POST',[])).status,400);
 assert.equal((await call('delete_msg','POST',{})).status,404);
 assert.equal((await call('send_like','GET')).status,405);
}));
