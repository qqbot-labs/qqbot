"""Bounded diagnostic: captures only our fixed bootstrap status codes, never upstream text."""
import re
import subprocess
command=['docker','start','-a','qq-agent-napcat']
p=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
try:
 output,_=p.communicate(timeout=12)
except subprocess.TimeoutExpired:
 subprocess.run(['docker','stop','-t','2','qq-agent-napcat'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 output,_=p.communicate(timeout=10)
allowed=[]
for line in output.splitlines():
 if re.fullmatch(r'QQAGENT_BOOTSTRAP [A-Z_]+',line) or re.fullmatch(r'QQAGENT_STATIC_INTEGRITY_OK napcat=[0-9.]+ qq=[0-9.\-]+',line):allowed.append(line)
print({'exit':p.returncode,'bootstrap_codes':allowed})
