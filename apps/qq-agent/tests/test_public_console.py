"""Public origin must retain authentication, secure cookies and CSRF boundaries."""
import pytest
from fastapi.testclient import TestClient
from qqagent.app import create_app


@pytest.mark.parametrize('public_origin',['https://YOUR_VPS_IP:13843','https://qqbot.example.com'])
def test_public_origin_https_login_csrf(tmp_path, monkeypatch,public_origin):
    monkeypatch.setenv('QQAGENT_PUBLIC_ORIGIN',public_origin)
    app=create_app(tmp_path,background=False)
    with TestClient(app,base_url=public_origin) as c:
        assert c.get('/').status_code==200
        assert c.get('/api/status').status_code==401
        password=(tmp_path/'admin-password.txt').read_text().strip()
        r=c.post('/api/login',json={'password':password},headers={'origin':str(c.base_url).rstrip('/')})
        assert r.status_code==200
        assert 'Secure' in r.headers['set-cookie'] and 'HttpOnly' in r.headers['set-cookie']
        headers={'x-csrf-token':r.json()['csrf'],'origin':str(c.base_url).rstrip('/')}
        assert c.get('/api/status').status_code==200
        assert c.post('/api/control',json={'stop':True},headers=headers).status_code==200
        assert c.post('/api/control',json={'stop':False},headers={**headers,'origin':'https://evil.example'}).status_code==403
        assert c.post('/api/control',json={'stop':False},headers={**headers,'x-csrf-token':''}).status_code==403
    for origin in ('http://YOUR_VPS_IP:13843','https://YOUR_VPS_IP:443','https://evil.example:13843'):
        with TestClient(app,base_url=origin) as c:assert c.get('/').status_code==400


def test_public_origin_default_denies(tmp_path,monkeypatch):
    monkeypatch.delenv('QQAGENT_PUBLIC_ORIGIN',raising=False)
    with TestClient(create_app(tmp_path,background=False),base_url='https://YOUR_VPS_IP:13843') as c:
        assert c.get('/').status_code==400


@pytest.mark.parametrize('origin',['http://example.org','https://example.org/path','https://user:secret@example.org','https://example.org?x=y'])
def test_invalid_public_origin_rejected(tmp_path,monkeypatch,origin):
    monkeypatch.setenv('QQAGENT_PUBLIC_ORIGIN',origin)
    with pytest.raises(ValueError,match='HTTPS origin'):create_app(tmp_path,background=False)
