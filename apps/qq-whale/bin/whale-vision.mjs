#!/usr/bin/env node
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeImage,ROOT} from './vision-core.mjs';
import {join} from 'node:path';
export {describeImage,analyzeImage} from './vision-core.mjs';
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
 try{
  const probe=process.argv[2]==='--probe';
  const path=probe?join(ROOT,'data/表情包/lib/.vision-probes',process.argv[4]==='gif'?'motion.gif':process.argv[4]==='blue'?'blue.png':'red.png'):process.argv[2];
  if(!path)throw Error('需要图片路径');
  const result=await analyzeImage(path,probe?{model:process.argv[3],probe:true,kind:'admin-probe'}:{kind:'tagger'});
  process.stdout.write(JSON.stringify({result:{summary:result.summary},vision:result})+'\n');
 }catch(e){console.error('[whale-vision] '+e.message);process.exitCode=1}
}
