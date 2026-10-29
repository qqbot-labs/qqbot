import json,pathlib,hashlib
root=pathlib.Path('/runtime/qq/opt/QQ')
p=root/'resources/app/package.json'
meta=json.loads(p.read_text());assert meta.get('linuxVersion','').startswith('3.2.34') or meta.get('version','').startswith('3.2.34')
nap=pathlib.Path('/runtime/napcat');assert json.loads((nap/'package.json').read_text())['version']=='4.6.7'
# Keep all QQ metadata; change only JS bootstrap. Do not copy the release's Windows qqnt.json.
meta['main']='qqagent-loader.cjs';p.write_text(json.dumps(meta))
(root/'resources/app/qqagent-loader.cjs').write_text("import('file:///runtime/napcat/napcat.mjs');")
proof={'napcat':'4.6.7','qq':meta.get('linuxVersion',meta.get('version')),'qq_build':meta.get('buildVersion'),'qq_metadata':str(p),'files':{str(p):hashlib.sha256(p.read_bytes()).hexdigest(),str(nap/'napcat.mjs'):hashlib.sha256((nap/'napcat.mjs').read_bytes()).hexdigest()}}
pathlib.Path('/runtime/versions.json').write_text(json.dumps(proof))
