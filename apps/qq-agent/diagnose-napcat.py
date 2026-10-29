import subprocess,time,re
subprocess.run(['systemctl','stop','qq-agent-napcat'],capture_output=True)
p=subprocess.Popen(['docker','start','-a','qq-agent-napcat'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
try:out,_=p.communicate(timeout=20)
except subprocess.TimeoutExpired:
 subprocess.run(['docker','stop','-t','2','qq-agent-napcat'],capture_output=True);out,_=p.communicate(timeout=10)
print('diagnostic_exit',p.returncode)
for line in out.splitlines():
 if any(x in line for x in ('QQAGENT_FIXED_VERSIONS','Error','error','ERR_','not found','Cannot','Traceback','failed','Failed')):
  line=re.sub(r'https?://\S+','[URL]',line);line=re.sub(r'[A-Za-z0-9+/=_-]{70,}','[REDACTED]',line)
  print(line[:350])
