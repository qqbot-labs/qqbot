/** Read-only HTTPS console check. Password via stdin; no HAR, cookies or secrets saved. */
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire('/opt/qq-agent/vendor/onebot-qzone/package.json');
const {chromium}=require('playwright');
const origin=process.argv[2];
if(!origin||!origin.startsWith('https://'))throw Error('HTTPS_REQUIRED');
const password=fs.readFileSync(0,'utf8').trim();
const executable=JSON.parse(fs.readFileSync('/opt/qq-agent/bridge/browser.lock.json','utf8')).executable;
const directory=fs.mkdtempSync('/tmp/qq-agent-public-ui-');
const result={origin,mode:'VPS headless browser through actual HTTPS listener; not external-network reachability',tls_verification:true,viewports:[],real_social_actions:0,page_errors:0};
const browser=await chromium.launch({executablePath:executable,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:950}});
  const page=await context.newPage();page.on('pageerror',()=>result.page_errors++);
  if((await context.request.get(origin+'/api/config')).status()!==401)throw Error('AUTH_REQUIRED');
  await page.goto(origin,{waitUntil:'networkidle'});
  await page.locator('#password').fill(password);await page.locator('#login-form button').click();
  await page.locator('#shell').waitFor({state:'visible'});
  const cookies=await context.cookies();if(!cookies.some(c=>c.name==='qqagent_session'&&c.secure&&c.httpOnly))throw Error('COOKIE_FLAGS');
  const state=await (await context.request.get(origin+'/api/status')).json();
  if(!state.controls.stop_all||!state.controls.pause_active||state.controls.social_running||state.persona.active!==null)throw Error('SAFETY_STATE');
  for(const target of ['overview','connection','models','persona','friends','qzone','memory','system']){
   await page.locator('#nav [data-page="'+target+'"]').click();
   await page.waitForTimeout(120);
   if(!(await page.locator('#main').innerText()))throw Error('EMPTY_PAGE');
  }
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('OVERFLOW');
  await page.locator('#nav [data-page="overview"]').click();await page.waitForTimeout(100);
  await page.screenshot({path:directory+'/'+width+'.png',fullPage:true});
  await page.locator('#logout').click();await page.locator('#login').waitFor({state:'visible'});
  if((await context.request.get(origin+'/api/status')).status()!==401)throw Error('LOGOUT');
  result.viewports.push({width,pages:8,secure_cookie:true,stop_controls_held:true,logout_invalidated:true});
  await context.close();
 }
 if(result.page_errors)throw Error('PAGE_ERRORS');
 fs.writeFileSync(directory+'/summary.json',JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,directory,...result}));
}finally{await browser.close();}
