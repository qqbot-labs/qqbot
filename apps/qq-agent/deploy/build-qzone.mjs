import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'vendor/onebot-qzone/package.json'));
const {build}=require('esbuild');
await build({entryPoints:[path.join(root,'deploy/qzone-entry.ts')],bundle:true,platform:'node',target:'node24',format:'esm',outfile:path.join(root,'bridge/qzone-entry.mjs'),
 external:['playwright','axios','axios-cookiejar-support','tough-cookie','ws','zod','p-limit','dotenv'],
 plugins:[{name:'no-raw-responses',setup(builder){builder.onResolve({filter:/(?:^|\/)rawLogger(?:\.js|\.ts)?$/},()=>({path:path.join(root,'deploy/qzone-no-raw-log.ts')}))}}]});
