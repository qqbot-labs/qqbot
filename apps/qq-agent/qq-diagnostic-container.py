import subprocess,time,os,pathlib,json,re
if os.geteuid()==0:
 subprocess.run(['dbus-uuidgen','--ensure=/etc/machine-id'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 pathlib.Path('/opt/QQ').symlink_to('/runtime/qq/opt/QQ')
 app=pathlib.Path('/runtime/qq/opt/QQ/resources/app')
 (app/'qqagent-loader.js').write_text((app/'qqagent-loader.cjs').read_text())
 meta=json.loads((app/'package.json').read_text());meta['main']='./qqagent-loader.js';(app/'package.json').write_text(json.dumps(meta))
 pass
x=subprocess.Popen(['Xvfb',':98','-screen','0','1280x720x24','-nolisten','tcp','-ac'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(.5)
env={**os.environ,'DISPLAY':':98'}
p=subprocess.Popen(['/strace','-f','-e','trace=openat,access,execve','-s','120','/runtime/qq/opt/QQ/qq','--no-sandbox'],cwd='/runtime/napcat',env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
try:output,_=p.communicate(timeout=12)
except subprocess.TimeoutExpired:p.terminate();output,_=p.communicate(timeout=5)
x.terminate();x.wait()
flags={}
for code,pattern in {'missing_library':'error while loading shared libraries','sandbox':'sandbox','permission':'Permission denied','missing_module':'Cannot find module','missing_display':'Missing X server','unhandled':'Unhandled','failed':'Failed','error':'Error','bootstrap':'QQAGENT_BOOTSTRAP','readonly_text':'Read-only file system','user_data':'user data','crashpad':'crashpad','module_load':'Unable to load','display':'display','dbus':'dbus','asar':'asar','js_exception':'Exception','segfault':'Segmentation'}.items():
 flags[code]=pattern.lower() in output.lower()
paths=re.findall(r'(?:Cannot find module|error while loading shared libraries)[: ]+[\'\"]?([a-zA-Z0-9_./-]+)',output)
stage=pathlib.Path('/tmp/qqagent-napcat-stage.json')
diagnostic=[json.loads(line.removeprefix('QQAGENT_DIAG ')) for line in output.splitlines() if line.startswith('QQAGENT_DIAG ')]
print(json.dumps({'app_files':sorted(set(re.findall(r'\"([^\"]*(?:qqagent-loader|package.json|application.asar)[^\"]*)\"',output)))[:35],'trace_permission_denied':'ptrace' in output.lower() and 'permitted' in output.lower(),'diagnostic':diagnostic,'error_sites':re.findall(r'(?:ERROR|WARNING):([a-zA-Z0-9_./]+)\(\d+\)',output),'exit':p.returncode,'flags':flags,'missing_components':paths,'stage':json.loads(stage.read_text()) if stage.exists() else None}))
