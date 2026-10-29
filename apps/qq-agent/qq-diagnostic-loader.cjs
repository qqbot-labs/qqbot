const fs=require('node:fs');
const report=(error)=>{
 const message=String(error?.message||'');const stack=String(error?.stack||'');
 const flags={};for(const [key,value] of Object.entries({readonly:'EROFS',permission:'EACCES',missing:'ENOENT',native:'.node',wrapper:'wrapper',major:'major',undefined:'undefined',require:'require'}))flags[key]=message.includes(value);
 const method=message.match(/([a-zA-Z0-9_$.]+) is not a function/)?.[1]||null;
 const property=message.match(/reading ['"]([a-zA-Z0-9_]+)['"]/)?.[1]||null;
 const frames=[...stack.matchAll(/\bat ([a-zA-Z0-9_$.]+)\s/g)].map(m=>m[1]).slice(0,8);
 console.log('QQAGENT_DIAG '+JSON.stringify({name: /^[a-zA-Z]+Error$/.test(error?.name)?error.name:'Error',flags,method,property,frames}));process.exit(1);
};
process.on('uncaughtException',report);process.on('unhandledRejection',report);
import('file:///runtime/napcat/napcat.mjs').catch(report);
