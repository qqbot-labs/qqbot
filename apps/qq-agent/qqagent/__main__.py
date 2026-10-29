import argparse,fcntl,os,sys
from pathlib import Path
import uvicorn
from .app import create_app
p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=13800);p.add_argument('--data',default=os.environ.get('QQAGENT_DATA','.runtime'));args=p.parse_args()
root=Path(args.data);root.mkdir(parents=True,exist_ok=True);root.chmod(0o700)
lock=open(root/'process.lock','a')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except OSError:sys.exit('该数据目录已有调度进程，拒绝重复启动')
uvicorn.run(create_app(root),host='127.0.0.1',port=args.port,access_log=False,log_level='warning')
