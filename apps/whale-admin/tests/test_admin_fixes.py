import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
if str(SOURCE) not in sys.path:
    sys.path.insert(0, str(SOURCE))

import domain as d
import integrations as integ
import server as srv
import workspace as ws


def _sample_profile(prefix='你好\r\n我是大鲸鱼'):
    return [
        {'id': 'persona', 'config': {'prefix': prefix}},
        {'id': 'agent-default-model', 'config': {'model': 'm1', 'reasoningEffort': 'off'}},
        {'id': 'compaction-basic', 'config': {'thresholdRatio': 0.55, 'retainRatio': 0.25, 'maxOverflowRetries': 2}},
        {'id': 'llm-pi-ai', 'config': {'providers': {'whale-gateway': {
            'baseURL': 'https://api.example.com/v1',
            'models': [{'id': 'm1', 'name': 'Model 1', 'contextWindow': 64000, 'maxTokens': 4096, 'reasoningEfforts': {'off': None, 'high': 'high'}}],
        }}}},
        {'id': 'im-qqbot', 'config': {
            'access': {'c2cMode': 'allowlist', 'c2cAllow': ['a' * 32], 'groupMode': 'disabled', 'groupAllow': []},
            'sticker': {'collectEnabled': False, 'autoTagEnabled': False, 'gates': {'enabled': False, 'perTurnMax': 0, 'perWindowSec': 0, 'maxPerWindow': 0, 'dailyBudgetPerGroup': 0, 'dupTTLHours': 0}},
        }},
    ]


class _JsonYamlShim:
    @staticmethod
    def load(raw, Loader=None):
        return json.loads(raw.decode('utf-8') if isinstance(raw, (bytes, bytearray)) else raw)

    @staticmethod
    def dump(obj, Dumper=None, **kwargs):
        return json.dumps(obj, ensure_ascii=False)


class AdminFixesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'whale'
        self.dsh = Path(self.tmp.name) / '.dsh'
        self.state = Path(self.tmp.name) / 'state'
        self.web_state = Path(self.tmp.name) / 'web-state'
        (self.root / 'etc').mkdir(parents=True)
        (self.root / 'data/qqwhale').mkdir(parents=True)
        (self.root / 'workspace').mkdir(parents=True)
        (self.dsh / 'profiles/web').mkdir(parents=True)
        self.state.mkdir(parents=True)
        self.web_state.mkdir(parents=True)

        patches = [
            patch.object(d, 'ROOT', self.root),
            patch.object(d, 'DSH', self.dsh),
            patch.object(d, 'STATE', self.state),
            patch.object(d, 'PROFILE', self.dsh / 'profiles/web/cordis.patch.yml'),
            patch.object(d, 'MEMCFG', self.root / 'data/qqwhale/memory-config.json'),
            patch.object(d, 'MEMDB', self.root / 'data/qqwhale/memory.db'),
            patch.object(d, 'MEDIA', self.root / 'data/表情包'),
            patch.object(d, 'ENVFILE', self.root / 'etc/qqbot.env'),
            patch.object(d, 'AUTHFILE', self.web_state / 'auth.json'),
            patch.object(d, 'PREFS', self.root / 'data/qqwhale/persona-preferences.json'),
            patch.object(d, 'CHATFILE', self.root / 'etc/chat-delivery.json'),
            patch.object(integ, 'ROUTING', self.root / 'etc/admin-routing.json'),
            patch.object(integ, 'VISION', self.root / 'etc/vision-routing.json'),
            patch.object(srv, 'DATA', self.web_state),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _local_atomic(self, path, data, owner=None):
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def test_persona_save_revision_matches_get_config_with_chat_delivery(self):
        """P0-1: get_config().revision and persona_save() must both include chat-delivery.json."""
        d.PROFILE.write_text(json.dumps(_sample_profile(), ensure_ascii=False))
        d.MEMCFG.write_text('{"archiveEnabled":true}')
        d.ENVFILE.write_text('QQBOT_APPID=123456\nWHALE_API_KEY=sk-test\n')
        d.CHATFILE.write_text('{"shortLimit":40}\n')

        yaml_mod = d.yaml if d.yaml is not None else _JsonYamlShim
        with patch.object(d, 'yaml', yaml_mod), \
             patch.object(d, 'atomic', side_effect=self._local_atomic), \
             patch.object(d, 'run', side_effect=lambda args, input=None, **kw: input):
            cfg = d.get_config()
            self.assertEqual(cfg['revision'], d.profile_revision(d.PROFILE.read_bytes()))
            res = d.persona_save({
                'revision': cfg['revision'],
                'text': '你好\n我是更新后的大鲸鱼',
                'confirm': True,
            })
            self.assertTrue(res['changed'])
            self.assertEqual(res['persona']['text'], '你好\r\n我是更新后的大鲸鱼')

    def test_prefs_lock_permissions_are_0700(self):
        lock_path = Path(str(d.PREFS) + '.lock')
        with d.prefs_lock():
            mode = stat.S_IMODE(lock_path.stat().st_mode)
            self.assertEqual(mode, 0o700)
        self.assertFalse(lock_path.exists())

    def test_dispatch_does_not_block_concurrent_reads_on_global_lock(self):
        entered = threading.Event()
        release = threading.Event()

        def slow_status():
            entered.set()
            release.wait(timeout=3)
            return {'ActiveState': 'active'}

        with patch.object(d, 'service_status', side_effect=slow_status):
            t = threading.Thread(target=lambda: d.dispatch('status', {}))
            t.start()
            self.assertTrue(entered.wait(timeout=2))
            start = time.monotonic()
            # Another read-only method must complete immediately without waiting on slow_status
            res = d.dispatch('preferences', {})
            elapsed = time.monotonic() - start
            release.set()
            t.join(timeout=2)
        self.assertIn('items', res)
        self.assertLess(elapsed, 0.5)

    def test_cold_start_missing_files_do_not_crash(self):
        self.assertEqual(d.envvalues(), {})
        self.assertEqual(d.chat_config(), d.CHAT_DEFAULT)
        self.assertEqual(d.pending_status()['known'], False)
        self.assertEqual(d.prefs_view()['items'], [])
        self.assertEqual(d.backups_list(), {'archives': [], 'revisions': [], 'managementArchives': []})
        # Corrupt JSON files also degrade cleanly
        d.PREFS.write_text('{bad json')
        self.assertEqual(d.prefs_view()['revoked'], [])
        d.CHATFILE.write_text('{bad json')
        self.assertEqual(d.chat_config(), d.CHAT_DEFAULT)
        # admin_backup works even if AUTHFILE does not exist yet
        (self.state / 'audit.jsonl').write_text('{"action":"test"}\n')
        res = d.admin_backup()
        self.assertTrue(res['name'].startswith('admin-'))
        # workspace search_get / search_save on cold start (no etc/search-config.json)
        self.assertFalse(ws.search_get()['enabled'])
        fake_pw = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        with patch.object(d, 'atomic', side_effect=self._local_atomic), \
             patch.object(d.pwd, 'getpwnam', return_value=fake_pw):
            ws.search_save({'enabled': True})
        self.assertTrue(ws.search_get()['enabled'])
        # integrations vision_get / routing_get on cold start
        with patch.object(integ, 'vision_models', return_value=[]):
            v = integ.vision_get()
            self.assertEqual(v['revision'], 'missing')
            self.assertFalse(v['config']['enabled'])
        self.assertFalse(integ.routing_get()['enabled'])
        # server load_auth on cold start
        self.assertIsNone(srv.load_auth())

    def test_service_action_checks_harden_and_chat_splitter(self):
        calls = []
        def fake_run(args, **kw):
            calls.append(args)
            return 'ActiveState=active\n'

        with patch.object(d, 'run', side_effect=fake_run):
            d.service_action('restart')
        scripts = [Path(c[1]).name for c in calls if c[0].endswith('python3')]
        self.assertEqual(scripts, ['harden-plugin.py', 'apply-chat-splitter.py'])
        self.assertIn('--check', calls[0])
        self.assertIn('--check', calls[1])

    def test_read_events_respects_dsh_home_and_handles_enoent(self):
        empty_dsh = Path(self.tmp.name) / 'nonexistent-dsh'
        out = subprocess.check_output(
            ['node', str(SOURCE / 'read-events.mjs'), 'calls'],
            env={**os.environ, 'DSH_HOME': str(empty_dsh)},
            text=True,
            timeout=10,
        )
        data = json.loads(out)
        self.assertEqual(data['calls'], [])

    def test_app_js_fixes_and_syntax(self):
        js_path = SOURCE / 'static/app.js'
        subprocess.check_call(['node', '--check', str(js_path)])
        text = js_path.read_text(encoding='utf-8')
        self.assertNotIn('kv(esc(x.key)', text)
        self.assertIn("kv(x.key,'不从旧聊天恢复", text)
        self.assertNotIn("let logs;try{logs=await api('calls')}", text)
        # AGENTS.md editor sets and clears dirtyGuard
        idx = text.index('async function renderInstructions()')
        end = text.index('async function renderSearch()', idx)
        snippet = text[idx:end]
        self.assertIn('dirtyGuard=dirty', snippet)
        self.assertIn('dirtyGuard=false', snippet)


if __name__ == '__main__':
    unittest.main()
