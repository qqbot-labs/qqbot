#!/usr/bin/env python3
"""Fetch official public stable installer via official unauthenticated signing endpoint."""
import hashlib,json,subprocess,urllib.request
from pathlib import Path
base='https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/9ee04bef/QQ_3.2.34_260924_amd64_01.deb'
req=urllib.request.Request('https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign',data=json.dumps({'url':base}).encode(),headers={'Content-Type':'application/json','Origin':'https://im.qq.com','Referer':'https://im.qq.com/','x-oidb':'{"uint32_command":"0x9b8e","uint32_service_type":1}'})
p=json.load(urllib.request.urlopen(req,timeout=20));url=p['data']['url'];assert url.startswith('https://qqdl.gtimg.cn/')
path=Path('QQ_3.2.34_260924_amd64_01.deb')
r=subprocess.run(['curl','-fsSL','--max-time','240',url,'-o',str(path)],capture_output=True)
assert r.returncode==0,'Official download failed'
assert hashlib.sha256(path.read_bytes()).hexdigest()=='436c65e1dd28422e128a21cbddb5fe4e2e6c079d7f27fec2541e014d38cc336e'
print('official stable QQ downloaded and SHA-256 verified')
