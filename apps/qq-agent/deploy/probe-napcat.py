"""Root-only runtime evidence. Never prints tokens, QR codes, login data or raw errors."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT=Path('/opt/qq-agent')
PROOF=ROOT/'artifacts/runtime-proof.json'

def command(*args):
    result=subprocess.run(args,capture_output=True,text=True,timeout=10,check=True)
    return result.stdout

def post(action,body,credential=None):
    headers={'Content-Type':'application/json'}
    if credential:headers['Authorization']='Bearer '+credential
    req=urllib.request.Request('http://127.0.0.1:13801/api/'+action,data=json.dumps(body).encode(),headers=headers)
    with urllib.request.urlopen(req,timeout=3) as response:
        if response.status!=200:raise ValueError()
        value=json.load(response)
    if value.get('code')!=0:raise ValueError()
    return value.get('data')

def observe():
    locked=(ROOT/'napcat-image.lock').read_text().strip()
    info=json.loads(command('docker','inspect','qq-agent-napcat','--format','{"image":{{json .Image}},"running":{{json .State.Running}}}'))
    if not info.get('running') or info.get('image')!=locked:raise ValueError()
    # Hash verification happens inside the immutable running image, not from its tag.
    command('docker','exec','qq-agent-napcat','python3','/runtime/setup-qq.py','--verify')
    manifest=json.loads(command('docker','exec','qq-agent-napcat','cat','/runtime/versions.json'))
    stage=json.loads(command('docker','exec','qq-agent-napcat','cat','/tmp/qqagent-napcat-stage.json'))
    if stage.get('stage')!='module_imported' or manifest.get('napcat')!='4.6.7' or manifest.get('qq') not in ('3.2.16-32793','3.2.34-53644'):raise ValueError()
    token=json.loads(Path('/var/lib/qq-agent-napcat/config/webui.json').read_text())['token']
    credential=post('auth/login',{'token':token})['Credential']
    status=post('QQLogin/CheckLoginStatus',{},credential)
    if not isinstance(status,dict) or type(status.get('isLogin')) is not bool:raise ValueError()
    return {'schema':1,'napcat':manifest['napcat'],'qq':manifest['qq'],'runtime_loaded':True,
            'checked':time.time(),'image':locked,'qq_online':status['isLogin'],
            'evidence':['immutable-file-hashes','module-imported','authenticated-login-api'],
            'note':'实际组件已加载；账号在线与真实收发需要另行验证'}

def main():
    PROOF.unlink(missing_ok=True)
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        try:
            proof=observe()
            PROOF.parent.mkdir(parents=True,exist_ok=True)
            temp=PROOF.with_suffix('.tmp')
            fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o644)
            with os.fdopen(fd,'w') as stream:json.dump(proof,stream)
            temp.replace(PROOF)
            print('QQAGENT_NAPCAT_RUNTIME_API_VERIFIED')
            return 0
        except Exception:
            time.sleep(1)
    print('QQAGENT_NAPCAT_RUNTIME_NOT_READY')
    return 1
if __name__=='__main__':raise SystemExit(main())
