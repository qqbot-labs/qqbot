"""Run real HTTP + headless browser acceptance against an owned temporary empty database."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

root=Path(__file__).resolve().parents[1]
data=Path(tempfile.mkdtemp(prefix='qqagent-accept-'))
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
env={**os.environ,'QQAGENT_DATA':str(data),'PYTHONDONTWRITEBYTECODE':'1'}
server=subprocess.Popen([sys.executable,'-c',f"from qqagent.app import create_app; import uvicorn; uvicorn.run(create_app({str(data)!r},background=False),host='127.0.0.1',port={port},access_log=False,log_level='critical')"],cwd=root,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
 for _ in range(100):
  if server.poll() is not None:raise RuntimeError('Temporary backend failed')
  try:
   with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz',timeout=1) as r:
    if r.status==200:break
  except OSError:time.sleep(.1)
 else:raise RuntimeError('Temporary backend did not become ready')
 env.update(QQAGENT_TEST_URL=f'http://127.0.0.1:{port}',QQAGENT_BROWSER_TEST_DATA=str(data),QQAGENT_BROWSER_TEST_ALLOW_MUTATION='1')
 subprocess.run([sys.executable,str(root/'scripts/browser_acceptance.py')],cwd=root,env=env,check=True)
finally:
 server.terminate()
 try:server.wait(timeout=10)
 except subprocess.TimeoutExpired:server.kill();server.wait()
 shutil.rmtree(data)
