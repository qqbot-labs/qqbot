import fs from 'node:fs';
import { QzoneClient } from '../vendor/onebot-qzone/src/qzone/client.js';
import { ActionHandler } from '../vendor/onebot-qzone/src/bridge/actions.js';
import { EventHub } from '../vendor/onebot-qzone/src/bridge/hub.js';
import { EventPoller } from '../vendor/onebot-qzone/src/bridge/poller.js';
import { fromEnv } from '../vendor/onebot-qzone/src/bridge/config.js';
import { createBridge } from './qzone-http.js';
// Never pass upstream console text, errors, QR, cookies or raw responses to journald.
console.log=()=>{};console.warn=()=>{};console.error=()=>{};
const token=fs.readFileSync(process.env.QQAGENT_BRIDGE_TOKEN_FILE!,'utf8').trim();
if(token.length<32)process.exit(1);
const data=process.env.QQAGENT_QZONE_DATA||'/var/lib/qq-agent-qzone';
const config=fromEnv();config.host='127.0.0.1';config.port=13702;config.accessToken=token;
const client=new QzoneClient({cachePath:data});
const hub=new EventHub({eventDebug:false});
const poller=new EventPoller(client,hub,config);
const handler=new ActionHandler(client,hub,poller,config);
// No poller.start or reverse-network manager: the Python scheduler is the only owner.
const bridge=createBridge({client,handler,token,data});
bridge.server.listen(13702,'127.0.0.1');
process.on('SIGTERM',()=>{bridge.close();process.exit(0)});
process.on('uncaughtException',()=>{bridge.close();process.exit(1)});
process.on('unhandledRejection',()=>{bridge.close();process.exit(1)});
