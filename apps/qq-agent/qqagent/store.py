import json, os, sqlite3, time, secrets, hashlib, threading
from contextlib import contextmanager
from pathlib import Path
from cryptography.fernet import Fernet
from .config import Configuration

def now(): return time.time()
def js(v): return json.dumps(v, ensure_ascii=False, separators=(',',':'))

class Store:
    def __init__(self, root):
        self.root=Path(root); self.root.mkdir(parents=True,exist_ok=True); self.root.chmod(0o700)
        self.lock=threading.RLock()
        key=self.root/'vault.key'
        if not key.exists():
            fd=os.open(key,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'wb') as f:f.write(Fernet.generate_key())
        self.vault=Fernet(key.read_bytes())
        self.path=self.root/'state.sqlite3'
        with self.db() as c:
            c.executescript('''
            CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS secrets(k TEXT PRIMARY KEY,v TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS personas(id INTEGER PRIMARY KEY,body TEXT NOT NULL,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS friends(id TEXT PRIMARY KEY,name TEXT NOT NULL,permissions TEXT NOT NULL DEFAULT '{}',optout TEXT NOT NULL DEFAULT '{}',updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY,friend TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,source TEXT NOT NULL,label TEXT NOT NULL,created REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS memory_friend ON memories(friend,kind);
            CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,channel TEXT NOT NULL,friend TEXT NOT NULL,body TEXT NOT NULL,created REAL NOT NULL,state TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,event TEXT UNIQUE,channel TEXT NOT NULL,friend TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,proactive INTEGER NOT NULL,test INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,friend TEXT NOT NULL,action TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY,model TEXT NOT NULL,input INTEGER,output INTEGER,cost REAL,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks(name TEXT PRIMARY KEY,next REAL NOT NULL,last REAL,failures INTEGER NOT NULL DEFAULT 0,detail TEXT NOT NULL DEFAULT '尚未运行');
            CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires REAL NOT NULL);
            ''')
            usage_columns = {row['name'] for row in c.execute('PRAGMA table_info(usage)')}
            for column in ('reserved_tokens', 'reserved_cost'):
                if column not in usage_columns:
                    c.execute('ALTER TABLE usage ADD COLUMN ' + column + ' REAL')
            defaults={'schema':1,'config':Configuration().model_dump(),'revision':1,'persona_active':None,'pause_active':True,'stop_all':True,'social_running':False,'cancel_epoch':0,'active_epoch':0}
            for k,v in defaults.items(): c.execute('INSERT OR IGNORE INTO meta VALUES(?,?)',(k,js(v)))
            # Never replay backlog after a restart, and never retry uncertain network sends.
            c.execute("UPDATE ledger SET status='unknown',detail='进程重启时仍在发送，禁止盲重试' WHERE status='sending'")
            c.execute("UPDATE ledger SET status='cancelled',detail='重启不补发旧任务' WHERE status='pending'")
            c.execute("UPDATE events SET state='expired' WHERE state IN ('pending','processing')")
            c.execute('DELETE FROM sessions WHERE expires<?',(now(),))
        self.path.chmod(0o600)
    @contextmanager
    def db(self):
        with self.lock:
            c=sqlite3.connect(self.path,timeout=20); c.row_factory=sqlite3.Row
            c.execute('PRAGMA foreign_keys=ON'); c.execute('PRAGMA journal_mode=WAL')
            try:
                yield c
                c.commit()
            except BaseException:
                c.rollback(); raise
            finally:c.close()
    def get(self,k):
        with self.db() as c:r=c.execute('SELECT v FROM meta WHERE k=?',(k,)).fetchone()
        return json.loads(r['v']) if r else None
    @staticmethod
    def bump(c, key):
        row = c.execute('SELECT v FROM meta WHERE k=?', (key,)).fetchone()
        value = json.loads(row[0]) if row else 0
        c.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', (key, js(value + 1)))

    def set(self,k,v):
        with self.db() as c:
            c.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',(k,js(v)))
            if k == 'persona_active':
                self.bump(c, 'cancel_epoch')
                c.execute("UPDATE events SET state='expired' WHERE state='processing'")
                c.execute("UPDATE ledger SET status='cancelled',detail='人格版本变更' WHERE status='pending'")
    def config(self): return Configuration.model_validate(self.get('config'))
    def save_config(self,data,revision):
        cfg=Configuration.model_validate(data).model_dump()
        with self.db() as c:
            current=json.loads(c.execute("SELECT v FROM meta WHERE k='revision'").fetchone()[0])
            if revision!=current:raise ValueError('配置已变化，请刷新后重新编辑')
            c.execute("UPDATE meta SET v=? WHERE k='config'",(js(cfg),))
            c.execute("UPDATE meta SET v=? WHERE k='revision'",(js(current+1),))
            c.execute("DELETE FROM meta WHERE k LIKE 'health_%'")
            self.bump(c, "cancel_epoch")
        return current+1
    def secret(self,k):
        with self.db() as c:r=c.execute('SELECT v FROM secrets WHERE k=?',(k,)).fetchone()
        return self.vault.decrypt(r[0].encode()).decode() if r else ''
    def put_secret(self,k,v):
        if not v:return
        if v.strip('*')=='':raise ValueError('不能保存掩码为凭据')
        with self.db() as c:
            c.execute('INSERT OR REPLACE INTO secrets VALUES(?,?)',(k,self.vault.encrypt(v.encode()).decode()))
            c.execute("DELETE FROM meta WHERE k LIKE 'health_%'")
    def secret_states(self):
        return {k:bool(self.secret(k)) for k in ('model_key','vision_key','judge_key','search_key','qq_token','qzone_token','qzone_cookie')}
    def log(self,friend,action,result,detail=''):
        # Only application-owned reason codes are accepted by callers. Never log raw provider errors.
        with self.db() as c:c.execute('INSERT INTO logs(friend,action,result,detail,created) VALUES(?,?,?,?,?)',(friend,action,result,detail[:500],now()))
    def rows(self,sql,args=()):
        with self.db() as c:return [dict(r) for r in c.execute(sql,args).fetchall()]
    def active_persona(self):
        active=self.get('persona_active')
        rows=self.rows('SELECT * FROM personas WHERE id=?',(active,)) if active else []
        return rows[0] if rows and rows[0]['body'].strip() else None
    def control(self,pause=None,stop=None,running=None):
        with self.db() as c:
            for k,v in [('pause_active',pause),('stop_all',stop),('social_running',running)]:
                if v is not None:c.execute('UPDATE meta SET v=? WHERE k=?',(js(v),k))
            if stop is True or running is False:
                self.bump(c, "cancel_epoch")
                c.execute("UPDATE ledger SET status='cancelled',detail='主人停止，冻结待发' WHERE status='pending'")
                c.execute("UPDATE events SET state='expired' WHERE state IN ('pending','processing')")
            if pause is True:
                self.bump(c, "active_epoch")
                c.execute("UPDATE ledger SET status='cancelled',detail='主人暂停主动行为，冻结待发' WHERE status='pending' AND proactive=1")
                c.execute("UPDATE events SET state='expired' WHERE channel='qzone' AND state IN ('pending','processing')")
    def snapshot(self,target):
        with self.db() as src:
            dst=sqlite3.connect(target);src.backup(dst);dst.close()
        Path(target).chmod(0o600)
    def day_usage(self,start):
        r=self.rows('SELECT count(*) requests, sum(input) input, sum(output) output, sum(cost) cost, sum(CASE WHEN input IS NULL OR output IS NULL THEN 1 ELSE 0 END) unknown, sum(CASE WHEN input IS NULL OR output IS NULL THEN reserved_tokens ELSE input+output END) budget_tokens, sum(CASE WHEN cost IS NULL THEN reserved_cost ELSE cost END) budget_cost FROM usage WHERE created>=?',(start,))[0]
        return r
