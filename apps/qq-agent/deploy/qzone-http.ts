/** Restricted owner-only bridge. Upstream responses and login side effects stay behind explicit routes. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

type Options = { client: any; handler: any; token: string; data: string; now?: () => number; ttl?: number };
export function createBridge({client, handler, token, data, now=Date.now, ttl=300_000}: Options) {
  const qrPath=path.join(data,'qrcode.png');
  let verifiedAt: number|null=null, qrStartedAt: number|null=null, qrRunning=false, error='not_checked';
  const reads=new Set(['get_login_info','get_status','check_cookie','get_friend_feeds','get_emotion_list','get_comment_list']);
  const writes=new Set(['send_private_msg','send_comment','send_like']);
  const clearQR=()=>{try{fs.unlinkSync(qrPath)}catch{}};
  const online=()=>verifiedAt!==null && client.loggedIn===true && now()-verifiedAt>=0 && now()-verifiedAt<=ttl;
  const failure=(code:string)=>({status:'failed',retcode:1500,data:null,reason:code});
  const invalidate=()=>{verifiedAt=null;error='authentication_unverified'};
  async function verify() {
    invalidate();
    const response=await handler.handle('check_cookie',{probe:true});
    if(response?.status!=='ok' || response?.retcode!==0 || response?.data?.valid!==true) {
      client.qqNumber=null;throw Error('authentication_failed');
    }
    verifiedAt=now();error='';
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    res.setHeader('X-Content-Type-Options','nosniff');
    const send=(code:number,value:any)=>{res.writeHead(code);res.end(JSON.stringify(value))};
    const auth=Buffer.from(req.headers.authorization||''), expected=Buffer.from('Bearer '+token);
    if(auth.length!==expected.length||!crypto.timingSafeEqual(auth,expected))return send(401,{reason:'unauthorized'});
    const action=(req.url||'/').split('?')[0].slice(1);
    if(req.method==='GET' && action==='health')return send(200,{ok:online(),qq:online()?client.qqNumber:null,verified_at:verifiedAt===null?null:verifiedAt/1000,qr_running:qrRunning,reason:error||(!online()?'check_expired':'')});
    if(req.method==='GET' && action==='qr') {
      if(!qrRunning || qrStartedAt===null || now()-qrStartedAt>180_000){clearQR();return send(404,{reason:'qr_unavailable'})}
      try {
        const stat=fs.lstatSync(qrPath);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.mtimeMs<qrStartedAt-1000||stat.size>1_000_000)throw Error();
        const image=fs.readFileSync(qrPath);
        if(!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error();
        return send(200,{image:'data:image/png;base64,'+image.toString('base64'),expires_at:(qrStartedAt+180_000)/1000,note:'仅供主人扫码，登录不会启用自动社交'});
      }catch{return send(404,{reason:'qr_not_ready'})}
    }
    if(req.method!=='POST')return send(405,{reason:'method_not_allowed'});
    try {
      const buffers:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>65536)return send(413,{reason:'too_large'});buffers.push(chunk)}
      const body=buffers.length?JSON.parse(Buffer.concat(buffers).toString('utf8')):{};
      if(!body||Array.isArray(body)||typeof body!=='object')return send(400,{reason:'invalid_body'});
      if(action==='logout'){
        if(qrRunning)return send(409,{reason:'login_in_progress'});
        invalidate();client.qqNumber=null;client.cookies={};clearQR();
        try{fs.unlinkSync(path.join(data,'cookies.json'))}catch{}
        return send(200,{logged_out:true});
      }
      if(action==='auth-cookie') {
        if(qrRunning)return send(409,{reason:'login_in_progress'});
        if(typeof body.cookie!=='string'||!body.cookie||body.cookie.length>20000)return send(400,{reason:'invalid_cookie'});
        invalidate();clearQR();
        await client.loginWithCookieString(body.cookie);await verify();
        return send(200,{configured:true,online:online()});
      }
      if(action==='login-qr') {
        if(online())return send(200,{note:'空间已登录，未改变社交开关'});
        if(!qrRunning) {
          invalidate();client.qqNumber=null;clearQR();qrRunning=true;qrStartedAt=now();
          Promise.resolve().then(()=>client.loginWithPlaywright(180,true)).then(verify).catch(()=>{invalidate();client.qqNumber=null;error='qr_login_failed'}).finally(()=>{qrRunning=false;clearQR()});
        }
        return send(200,{note:'已启动无头扫码；稍后再次获取二维码',expires_at:(qrStartedAt!+180_000)/1000});
      }
      if(!reads.has(action)&&!writes.has(action))return send(404,{reason:'action_not_allowed'});
      // GET health is read-only. Explicit checks and successful protected API calls refresh evidence.
      if(action==='check_cookie') {
        await verify();return send(200,{status:'ok',retcode:0,data:{valid:true}});
      }
      if(!online())await verify();
      const result=await handler.handle(action,body);
      if(result?.retcode!==0 || result?.status!=='ok') {
        if(result?.retcode===1401)invalidate();
        if(writes.has(action))return send(502,failure('write_result_unconfirmed'));
        return send(200,{status:'failed',retcode:1500,data:null,reason:'upstream_rejected'});
      }
      verifiedAt=now();
      return send(200,{status:'ok',retcode:0,data:result.data??null});
    } catch {
      invalidate();clearQR();
      return send(502,failure('bridge_operation_failed'));
    }
  });
  return {server,close:()=>{clearQR();server.closeAllConnections();server.close()}};
}
