/** Deterministic browser selection and headless-only preflight, without visiting QQ. */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const require=createRequire(path.join(root,'vendor/onebot-qzone/package.json'));
async function main(){
 const playwright=require('playwright');
 const core=path.dirname(require.resolve('playwright-core/package.json'));
 const {registry}=require(path.join(core,'lib/server/registry/index.js'));
 const browser=registry.findExecutable('chromium-headless-shell');
 const executable=browser?.executablePath();
 if(!executable||!fs.existsSync(executable))throw Error('BROWSER_NOT_INSTALLED');
 fs.accessSync(executable,fs.constants.X_OK);
 if(process.argv.includes('--write-lock')){
  const lock=path.join(root,'bridge/browser.lock.json');
  fs.writeFileSync(lock,JSON.stringify({schema:1,playwright:require('playwright/package.json').version,executable})+'\n',{mode:0o644});
  console.log('BROWSER_LOCK_WRITTEN');return;
 }
 const locked=JSON.parse(fs.readFileSync(path.join(root,'bridge/browser.lock.json'),'utf8'));
 if(locked.executable!==executable||locked.playwright!==require('playwright/package.json').version)throw Error('BROWSER_LOCK_MISMATCH');
 const version=spawnSync(executable,['--version'],{timeout:10000,stdio:'ignore'});
 if(version.status!==0)throw Error('BROWSER_RUNTIME_LIBRARIES_OR_PERMISSIONS');
 const instance=await playwright.chromium.launch({executablePath:executable,headless:true,timeout:15000,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{const page=await instance.newPage();await page.goto('about:blank');}finally{await instance.close()}
 if(process.argv.includes('--run')){
  process.env.QZONE_PLAYWRIGHT_EXECUTABLE=executable;
  process.env.QZONE_PLAYWRIGHT_HEADLESS='1';
  await import('../bridge/qzone-entry.mjs');
 }else console.log('BROWSER_HEADLESS_PREFLIGHT_OK');
}
main().catch(error=>{const message=String(error?.message||'');const reason=message.includes('EACCES')?'EXEC_PERMISSION':message.includes('shared libraries')?'MISSING_LIBRARY':message.includes('Timeout')||message.includes('timeout')?'START_TIMEOUT':message.includes('BROWSER_')?message.split('\n')[0]:'BROWSER_START_FAILED';console.error('QQAGENT_QZONE_BROWSER_PREFLIGHT_FAILED '+reason);process.exit(1)});
