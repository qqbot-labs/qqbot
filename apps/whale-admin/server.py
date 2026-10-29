#!/usr/bin/env python3
"""Private HTTP GUI + a separate Unix socket broker. Standard library server."""
import ipaddress
from urllib.parse import urlsplit
import base64, hashlib, hmac, http.cookies, json, os, re, secrets, socket, socketserver, sqlite3, struct, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE=Path(__file__).resolve().parent
PORT=int(os.environ.get('WHALE_ADMIN_PORT','3090'))
SOCKET=Path(os.environ.get('WHALE_ADMIN_SOCKET','/run/whale-admin/control.sock'))
DATA=Path(os.environ.get('WHALE_ADMIN_WEB_STATE','/var/lib/whale-admin'))
PUBLIC_ORIGIN=os.environ.get('WHALE_ADMIN_PUBLIC_ORIGIN','').rstrip('/')
PUBLIC_HOST=urlsplit(PUBLIC_ORIGIN).netloc
if PUBLIC_ORIGIN and (urlsplit(PUBLIC_ORIGIN).scheme!='https' or not PUBLIC_HOST or urlsplit(PUBLIC_ORIGIN).path or urlsplit(PUBLIC_ORIGIN).username):raise ValueError('Invalid public HTTPS origin')
SESSIONS={};ATTEMPTS={};AUTH_LOCK=threading.RLock()

def encode(value):return (json.dumps(value,ensure_ascii=False)+'\n').encode()
def password_hash(password,salt):return hashlib.scrypt(password.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex()
def set_password(password):
    if not isinstance(password,str) or len(password)>200 or len(password)<(3 if re.fullmatch(r'[\u3400-\u4dbf\u4e00-\u9fff]+',password) else 6):raise ValueError('纯中文密码至少3个汉字，其他密码至少6个字符；最多200字符')
    salt=secrets.token_hex(16);payload={'salt':salt,'hash':password_hash(password,salt)}
    path=DATA/'auth.json';tmp=DATA/'.auth.tmp'
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:json.dump(payload,f);f.flush();os.fsync(f.fileno())
    os.replace(tmp,path)

def broker_call(method,args):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(115);s.connect(str(SOCKET));s.sendall(encode({'method':method,'args':args}))
        f=s.makefile('rb');raw=f.readline(10*1024*1024)
        if not raw or len(raw)>=10*1024*1024:raise ValueError('管理服务返回异常')
        return json.loads(raw)

class BrokerHandler(socketserver.StreamRequestHandler):
    def handle(self):
        from domain import dispatch,Error,redact
        self.request.settimeout(120)
        try:
            uid=struct.unpack('3i',self.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]
            import pwd
            if uid not in [0,pwd.getpwnam('whaleadmin').pw_uid]:raise Error('不允许访问')
            raw=self.rfile.readline(1024*1024)
            if len(raw)>=1024*1024:raise Error('请求过大')
            x=json.loads(raw)
            if not isinstance(x,dict) or not isinstance(x.get('args',{}),dict):raise Error('请求格式无效')
            result={'ok':True,'data':dispatch(x.get('method'),x.get('args',{}))}
        except Exception as e:
            result={'ok':False,'error':redact(str(e))[:2000]}
        try:self.wfile.write(encode(result))
        except (BrokenPipeError,ConnectionResetError):pass

class BrokerServer(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):daemon_threads=True

class Handler(BaseHTTPRequestHandler):
    server_version='WhaleConsole'
    protocol_version='HTTP/1.1'
    def setup(self):super().setup();self.connection.settimeout(120)
    def log_message(self,fmt,*args):pass # Request bodies, credentials, and query strings are never logged.
    def public_request(self):return bool(PUBLIC_HOST) and self.headers.get('Host') in [PUBLIC_HOST,PUBLIC_HOST+':443']
    def host_valid(self):return self.headers.get('Host') in ['127.0.0.1:'+str(PORT),'localhost:'+str(PORT)] or self.public_request()
    def origin_valid(self):
        return self.headers.get('Origin') in ([PUBLIC_ORIGIN] if self.public_request() else ['http://127.0.0.1:'+str(PORT),'http://localhost:'+str(PORT)])
    def login_ip(self):
        # Only this loopback listener is reachable by nginx; nginx overwrites X-Real-IP.
        if self.public_request() and self.client_address[0]=='127.0.0.1':
            try:return str(ipaddress.ip_address(self.headers.get('X-Real-IP','')))
            except ValueError:pass
        return self.client_address[0]
    def reply(self,code,data,mime='application/json; charset=utf-8',cookie=None):
        raw=encode(data) if mime.startswith('application/json') else data
        self.send_response(code);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(raw)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer')
        self.send_header('X-Frame-Options','DENY');self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; connect-src 'self'")
        if cookie:self.send_header('Set-Cookie',cookie+('; Secure' if self.public_request() else ''))
        self.end_headers()
        try:self.wfile.write(raw)
        except (BrokenPipeError,ConnectionResetError):pass
    def session(self):
        c=http.cookies.SimpleCookie()
        try:c.load(self.headers.get('Cookie',''));token=c['whale_session'].value
        except (KeyError,http.cookies.CookieError):return None,None
        with AUTH_LOCK:
            s=SESSIONS.get(token)
            if not s or s['expires']<time.time():SESSIONS.pop(token,None);return None,None
            return token,s
    def do_GET(self):
        from urllib.parse import urlsplit,parse_qs
        if not self.host_valid():return self.reply(403,{'ok':False,'error':'访问地址不被允许'})
        url=urlsplit(self.path);path=url.path
        if path in ['/','/app.js','/style.css']:
            name='index.html' if path=='/' else path[1:];mime={'index.html':'text/html; charset=utf-8','app.js':'text/javascript; charset=utf-8','style.css':'text/css; charset=utf-8'}[name]
            return self.reply(200,(HERE/'static'/name).read_bytes(),mime)
        token,s=self.session()
        if not s:return self.reply(401,{'ok':False,'error':'请先登录'})
        if path=='/api/session':return self.reply(200,{'ok':True,'data':{'csrf':s['csrf']}})
        allowed={'/api/proactive':'proactive','/api/instructions':'instructions','/api/search':'search','/api/status':'status','/api/binding':'binding','/api/connection':'connection','/api/sessions':'sessions','/api/calls':'calls','/api/thinking':'thinking','/api/preferences':'preferences','/api/routing':'routing','/api/vision':'vision','/api/overview':'overview','/api/config':'config','/api/memory':'memory','/api/media':'media','/api/backups':'backups','/api/logs':'logs'}
        try:
            args={k:v[-1] for k,v in parse_qs(url.query).items()}
            if path.startswith('/api/image/'):
                result=broker_call('media.image',{'id':path[len('/api/image/'):]})
                if result['ok']:return self.reply(200,base64.b64decode(result['data']['data']),result['data']['mime'])
                return self.reply(404,result)
            if path not in allowed:return self.reply(404,{'ok':False,'error':'页面不存在'})
            result=broker_call(allowed[path],args);return self.reply(200 if result['ok'] else 400,result)
        except Exception:return self.reply(503,{'ok':False,'error':'管理服务暂时不可用，请稍后重试'})
    def do_POST(self):
        if not self.host_valid():return self.reply(403,{'ok':False,'error':'访问地址不被允许'})
        if not self.origin_valid():return self.reply(403,{'ok':False,'error':'请求来源不被允许'})
        if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.reply(415,{'ok':False,'error':'请使用 JSON 请求'})
        try:
            n=int(self.headers.get('Content-Length','0'))
            if n<2 or n>512000:raise ValueError()
            body=json.loads(self.rfile.read(n))
            if not isinstance(body,dict):raise ValueError()
        except Exception:
            self.close_connection=True;return self.reply(400,{'ok':False,'error':'请求格式或大小无效'})
        if self.path=='/api/login':
            now=time.time();ip=self.login_ip()
            with AUTH_LOCK:
                if len(ATTEMPTS)>4096:
                    for key in list(ATTEMPTS):
                        if not any(now-t<300 for t in ATTEMPTS[key]):ATTEMPTS.pop(key,None)
                    while len(ATTEMPTS)>4096:ATTEMPTS.pop(next(iter(ATTEMPTS)))
                attempts=[t for t in ATTEMPTS.get(ip,[]) if now-t<300];ATTEMPTS[ip]=attempts
                if len(attempts)>=8:return self.reply(429,{'ok':False,'error':'尝试过于频繁，请五分钟后重试'})
                password=body.get('password','')
                if not isinstance(password,str) or len(password)>200:return self.reply(400,{'ok':False,'error':'密码格式无效'})
                attempts.append(now)
                auth=json.loads((DATA/'auth.json').read_text())
                if not hmac.compare_digest(password_hash(password,auth['salt']),auth['hash']):return self.reply(401,{'ok':False,'error':'密码不正确'})
                ATTEMPTS[ip]=[]
                # Bound memory even when old browsers never log out.
                for t in list(SESSIONS):
                    if SESSIONS[t]['expires']<now:SESSIONS.pop(t,None)
                if len(SESSIONS)>=32:SESSIONS.pop(next(iter(SESSIONS)))
                token=secrets.token_urlsafe(32);csrf=secrets.token_urlsafe(24);SESSIONS[token]={'csrf':csrf,'expires':now+28800}
            return self.reply(200,{'ok':True,'data':{'csrf':csrf}},cookie='whale_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800')
        token,s=self.session()
        if not s:return self.reply(401,{'ok':False,'error':'请先登录'})
        if not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),s['csrf']):return self.reply(403,{'ok':False,'error':'页面验证已失效，请刷新'})
        if self.path=='/api/logout':
            with AUTH_LOCK:SESSIONS.pop(token,None)
            return self.reply(200,{'ok':True,'data':{}},cookie='whale_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
        if self.path=='/api/password':
            try:
                with AUTH_LOCK:
                    auth=json.loads((DATA/'auth.json').read_text())
                    old=body.get('old','');new=body.get('password','')
                    if not isinstance(old,str) or not isinstance(new,str) or not hmac.compare_digest(password_hash(old,auth['salt']),auth['hash']):raise ValueError('当前密码不正确')
                    set_password(new)
                    for key in list(SESSIONS):
                        if key!=token:SESSIONS.pop(key,None)
                return self.reply(200,{'ok':True,'data':{'message':'管理密码已修改，其他登录已失效。'}})
            except ValueError as e:return self.reply(400,{'ok':False,'error':str(e)})
        routes={'/api/proactive/save':'proactive.save','/api/proactive/test':'proactive.test','/api/instructions/save':'instructions.save','/api/search/save':'search.save','/api/search/test':'search.test','/api/binding/open':'binding.open','/api/binding/confirm':'binding.confirm','/api/model/probe':'model.probe','/api/vision/save':'vision.save','/api/vision/probe':'vision.probe','/api/vision/models':'vision.models','/api/media/action':'media.action','/api/models/sync':'models.sync','/api/session/action':'session.action','/api/routing/save':'routing.save','/api/config/save':'config.save','/api/persona/save':'persona.save','/api/preferences/add':'preferences.add','/api/preferences/delete':'preferences.delete','/api/config/restore':'config.restore','/api/service':'service','/api/backup':'backup.create','/api/memory/forget':'memory.forget','/api/models':'models'}
        if self.path not in routes:return self.reply(404,{'ok':False,'error':'操作不存在'})
        try:result=broker_call(routes[self.path],body);return self.reply(200 if result['ok'] else 400,result)
        except Exception:return self.reply(503,{'ok':False,'error':'管理服务暂时不可用；可刷新状态确认操作结果'})

def main():
    if sys.argv[1:]==['broker']:
        import grp
        SOCKET.parent.mkdir(parents=True,exist_ok=True)
        if SOCKET.exists():SOCKET.unlink()
        with BrokerServer(str(SOCKET),BrokerHandler) as s:
            os.chown(SOCKET,0,grp.getgrnam('whaleadmin').gr_gid);os.chmod(SOCKET,0o660);s.serve_forever()
    elif sys.argv[1:]==['admin-backup']:
        from domain import admin_backup
        print(json.dumps(admin_backup()))
    elif sys.argv[1:]==['init-auth']:
        DATA.mkdir(mode=0o700,parents=True,exist_ok=True)
        if (DATA/'auth.json').exists():raise SystemExit('Auth already exists')
        set_password(sys.stdin.readline().strip())
    elif len(sys.argv)==3 and sys.argv[1]=='forget':
        from domain import MEMDB
        ident=int(sys.argv[2]);db=sqlite3.connect('file:'+str(MEMDB)+'?mode=rw',uri=True,timeout=3)
        db.execute('UPDATE msg SET deleted=1 WHERE id=? AND deleted=0',(ident,));db.commit();db.close()
    else:
        with ThreadingHTTPServer(('127.0.0.1',PORT),Handler) as s:s.daemon_threads=True;s.serve_forever()
if __name__=='__main__':main()
