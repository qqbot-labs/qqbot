"""Untrusted backup files must never change state unless completely valid."""
import copy
import hashlib
import json
import sqlite3
import pytest
from qqagent.backup import export, restore, validate
from qqagent.store import Store, js, now
from test_core import seed

@pytest.fixture
def state(tmp_path):
    s = Store(tmp_path)
    seed(s)
    s.set('qzone_baseline', now())
    with s.db() as c:
        c.execute('INSERT INTO tasks VALUES(?,?,?,?,?)', ('decision', now()+60, None, 0, ''))
        c.execute('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', ('L', None, 'qq', '10001', 'reply', '{}', 'unknown', '', now(), now(), 0, 0))
        c.execute('INSERT INTO events VALUES(?,?,?,?,?,?)', ('qq:E', 'qq', '10001', '{}', now(), 'processing'))
    return s

def resign(b):
    b['sha256'] = hashlib.sha256(js(b['data']).encode()).hexdigest()
    return b

def test_valid_nullable_and_blank_draft(state):
    with state.db() as c:
        c.execute('INSERT INTO personas(body,created) VALUES(?,?)', ('', now()))
    validate(export(state))

@pytest.mark.parametrize('mutate', [
    lambda b: b['data']['meta'].update(stop_all='false'),
    lambda b: b['data']['meta'].update(revision=True),
    lambda b: b['data']['meta'].update(qzone_baseline=float('nan')),
    lambda b: b['data']['tables']['friends'][0].update(permissions='{"reply":"true"}'),
    lambda b: b['data']['tables']['friends'][0].update(optout='{"all":0}'),
    lambda b: b['data']['tables']['personas'][0].update(body='   '),
    lambda b: b['data']['tables']['personas'].append(copy.deepcopy(b['data']['tables']['personas'][0])),
    lambda b: b['data']['tables']['ledger'][0].update(test=True),
    lambda b: b['data']['tables']['ledger'][0].update(status='go'),
    lambda b: b['data']['tables']['ledger'][0].update(action='shell'),
    lambda b: b['data']['tables']['ledger'][0].update(payload='[]'),
    lambda b: b['data']['tables']['tasks'][0].update(last='yesterday'),
    lambda b: b['data']['tables']['events'][0].update(created=float('inf')),
    lambda b: b['data']['tables'].update(unknown=[]),
])
def test_invalid_restore_has_no_effect(state,mutate):
    before = export(state)['data']
    b = export(state);mutate(b);resign(b)
    with pytest.raises(ValueError):restore(state,b)
    after = export(state)['data']
    assert after['meta'] == before['meta'] and after['tables'] == before['tables']
    assert not list((state.root/'backups').glob('*'))

def test_restore_keeps_newer_optout_usage_secrets_and_forces_baseline(state):
    b = export(state)
    state.set('health_qq', {'online':True})
    state.put_secret('model_key','SECRET_SENTINEL')
    with state.db() as c:
        c.execute("UPDATE friends SET optout=? WHERE id='10001'",(js({'proactive':True}),))
        c.execute('INSERT INTO usage(model,input,output,cost,created) VALUES(?,?,?,?,?)',('mock',None,None,None,now()))
        c.execute('INSERT INTO sessions VALUES(?,?,?)',('ID','CSRF',now()+60))
    old_revision = state.get('revision')
    restore(state,b)
    assert state.get('revision') == old_revision+1
    assert state.get('qzone_baseline') is None and state.get('health_qq') is None
    assert state.secret('model_key') == 'SECRET_SENTINEL' and len(state.rows('SELECT * FROM usage'))==1
    assert json.loads(state.rows('SELECT optout FROM friends')[0]['optout'])['proactive']
    assert not state.rows('SELECT * FROM sessions')
    assert state.rows('SELECT state FROM events')[0]['state']=='expired'
    assert state.get('stop_all') and state.get('pause_active') and not state.get('social_running')

def test_sql_failure_rolls_back_every_table(state):
    b=export(state);before=export(state)['data']
    with state.db() as c:
        c.execute("CREATE TRIGGER abort_restore BEFORE INSERT ON personas BEGIN SELECT RAISE(ABORT,'test'); END;")
    with pytest.raises(sqlite3.IntegrityError):restore(state,b)
    after=export(state)['data']
    assert before['meta']==after['meta'] and before['tables']==after['tables']
    assert list((state.root/'backups').glob('*.sqlite3'))
