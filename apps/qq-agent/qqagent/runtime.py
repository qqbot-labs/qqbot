import asyncio, hashlib, json, os, platform
from pathlib import Path

class Runtime:
    """No caller-supplied commands/paths; only fixed project component executables."""
    def __init__(self,root):self.root=Path(root);self.deployed=Path('/opt/qq-agent')==self.root
    def versions(self):
        path=self.root/'artifacts'/'runtime-proof.json'
        if not path.exists():return {'ok':False,'napcat':None,'qq':None,'reason':'固定组件尚未安装或未验证','expected':{'napcat':'4.6.7','qq':'3.2.16-32793'}}
        try:
            d=json.loads(path.read_text());proof=d.get('napcat')=='4.6.7' and d.get('qq') in ('3.2.16-32793','3.2.34-53644') and d.get('runtime_loaded') is True
            # Proof recorded by launcher only after verifying immutable image contents.
            return {**d,'ok':proof}
        except (ValueError,OSError):return {'ok':False,'reason':'版本证据不可读取'}
    async def control(self,component,action):
        if component not in ('napcat','qzone') or action not in ('start','stop','restart','status'):raise ValueError('组件或动作不允许')
        if not self.deployed:raise ValueError('当前为本地开发，组件控制仅在隔离部署中可用')
        # sudo rule contains exact service and verb combinations only, no arbitrary shell.
        verb='is-active' if action=='status' else action
        p=await asyncio.create_subprocess_exec('/usr/bin/sudo','-n','/usr/bin/systemctl',verb,'qq-agent-'+component+'.service',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        out,err=await asyncio.wait_for(p.communicate(),timeout=45)
        if p.returncode and action!='status':raise ValueError('组件操作失败，请查看项目日志')
        return {'component':component,'action':action,'active':out.decode().strip()=='active','success':p.returncode==0}
