import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { add, load, remove } from '../bin/persona-prefs-core.mjs';

test('偏好超过旧的60条及300字后仍能保存、读取、去重和删除', async () => {
  const dir=mkdtempSync(join(tmpdir(),'whale-prefs-'));
  try {
    const file=join(dir,'preferences.json');
    for (let i=0;i<65;i++) await add(file,`第${i}条明确偏好`,'admin');
    const text='这是用户明确要求保留的长偏好。'.repeat(30);
    await add(file,text,'admin');
    assert.equal(load(file).length,66);
    assert.equal(load(file).at(-1).text,text);
    assert.equal((await add(file,text)).duplicate,true);
    assert.equal((await remove(file,{text})).removed,true);
    assert.equal(load(file).length,65);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('更正主题会替换当前值，历史版本保留，重载后不同时注入冲突值', async () => {
  const dir=mkdtempSync(join(tmpdir(),'whale-profile-'));
  try {
    const file=join(dir,'preferences.json');
    const first=await add(file,'我喜欢喝全糖奶茶','chat',{kind:'preference',key:'奶茶口味'});
    const second=await add(file,'以后奶茶只要三分糖','chat',{kind:'preference',key:'奶茶口味'});
    assert.equal(second.updated,true);
    assert.equal(second.item.id,first.item.id);
    assert.equal(load(file).length,1);
    assert.equal(load(file)[0].text,'以后奶茶只要三分糖');
    assert.equal(load(file)[0].history[0].text,'我喜欢喝全糖奶茶');
    await add(file,'我们设定是住在海边的邻居','chat',{kind:'setting',key:'共同设定'});
    assert.equal(load(file)[1].kind,'setting');
    assert.equal((await remove(file,{id:first.item.id})).removed,true);
    assert.deepEqual(load(file).map(x=>x.kind),['setting']);
    await assert.rejects(add(file,'新设定','chat',{replaceId:'p-0-missing'}),/不存在/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
