"""Recover the requested QQ from a digest-pinned upstream historical image, without running it."""
import hashlib,json,tarfile,urllib.request,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'artifacts/napcat-4.6.7-image-manifest.json').read_text())
layer=manifest['layers'][5]
assert layer['digest'].startswith('sha256:')
token=json.load(urllib.request.urlopen('https://auth.docker.io/token?service=registry.docker.io&scope=repository:mlikiowa/napcat-docker:pull',timeout=20))['token']
archive=root/'artifacts/qq-original-layer.tar.gz'
if not archive.exists():
 req=urllib.request.Request('https://registry-1.docker.io/v2/mlikiowa/napcat-docker/blobs/'+layer['digest'],headers={'Authorization':'Bearer '+token})
 with urllib.request.urlopen(req,timeout=60) as response,archive.open('wb') as target:
  while chunk:=response.read(1024*1024):target.write(chunk)
assert archive.stat().st_size==layer['size']
assert hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()==layer['digest'].split(':')[1]
destination=root/'artifacts/qq-original-tree';destination.mkdir(exist_ok=True)
with tarfile.open(archive,'r:gz') as source:
 members=[member for member in source if member.name.startswith('opt/QQ/') and '/.wh.' not in member.name]
 source.extractall(destination,members=members,filter='data')
meta=json.loads((destination/'opt/QQ/resources/app/package.json').read_text())
assert meta.get('version')=='3.2.16-32793' or meta.get('linuxVersion')=='3.2.16-32793'
files={str(p.relative_to(destination)):hashlib.file_digest(p.open('rb'),'sha256').hexdigest() for p in (destination/'opt/QQ').rglob('*') if p.is_file() and not p.is_symlink()}
report={'origin':'https://hub.docker.com/r/mlikiowa/napcat-docker/tags?name=v4.6.7','image':'sha256:f397aa271e4c3e04912c23656ff1b4d28a078b62be8e5d6192316f1a8da30c3a','layer':layer['digest'],'version':meta.get('version'),'linuxVersion':meta.get('linuxVersion'),'build':meta.get('buildVersion'),'files':files,'note':'历史上游镜像中提取的文件；不是重新取得原始官方 deb，也不冒称官方签名。镜像构建历史记录官方 ee4bd910/32793 下载来源。'}
(root/'artifacts/qq-original-provenance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
if '--tree-only' not in sys.argv:
 with tarfile.open(root/'artifacts/QQ-3.2.16-32793-recovered.tar.gz','w:gz') as output:output.add(destination/'opt',arcname='opt')
if '--remove-download' in sys.argv:archive.unlink()
print({k:report[k] for k in ('version','linuxVersion','build','layer')})
print('QQ_ORIGINAL_RECOVERED_AND_LAYER_VERIFIED')
