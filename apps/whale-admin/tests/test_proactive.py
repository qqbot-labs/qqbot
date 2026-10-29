import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('proactive_under_test', SOURCE / 'proactive.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProactiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        data = root / 'data/qqwhale'
        data.mkdir(parents=True)
        (root / 'etc').mkdir()
        # Exercise the real shared Node formatter; only the QQ boundary is fake.
        (root / 'bin').symlink_to(SOURCE.parent / 'qq-whale/bin', target_is_directory=True)
        (root / 'etc/chat-delivery.json').write_text(json.dumps({'messageDelayMs':0,'typingMsPerChar':0}))
        self.config = {**p.DEFAULT,'enabled':True,'appId':'app','peer':'a'*32,'mode':'fixed','text':'刚想起你了\n\n过来聊两句'}
        (root / 'etc/proactive.json').write_text(json.dumps(self.config))
        for name, value in {'ROOT':root,'DATA':data,'STATE':data/'proactive-state.json','EVENTS':data/'events.jsonl','POLICY':root/'etc/proactive.json'}.items():
            q = patch.object(p, name, value)
            q.start()
            self.addCleanup(q.stop)
        q = patch.object(p,'envvalues',return_value={'QQBOT_APPID':'app','QQBOT_SECRET':'fake'})
        q.start()
        self.addCleanup(q.stop)
        q = patch.object(p,'last_inbound',return_value=1)
        self.inbound = q.start()
        self.addCleanup(q.stop)
        self.context = []
        def bridge(method, **args):
            if method == 'proactive.context': self.context.append(args)
            return {'busy':False}
        q = patch.object(p,'bridge',side_effect=bridge)
        q.start()
        self.addCleanup(q.stop)
        self.sent = []
        def post(url, body, headers=None, **kwargs):
            if 'getAppAccessToken' in url:return {'access_token':'fake'}
            self.sent.append(body)
            return {'id':'m'+str(len(self.sent))}
        q = patch.object(p,'post',side_effect=post)
        self.post = q.start()
        self.addCleanup(q.stop)

    def test_many_daily_attempts_and_recent_messages_are_not_quotas(self):
        now = 1800000000
        state = {'target':'app:'+'a'*32,'attempts':9999,'lastSent':now-1,'lastDecision':now-1,'status':'unknown','lastAttempt':now-1}
        self.assertIsNone(p.due(self.config,state,now-1,now=now))

    def test_explicit_cooldown_is_respected_and_can_be_disabled(self):
        now = 1800000000
        state = {'target':'app:'+'a'*32,'lastDecision':now-60}
        self.assertIsNotNone(p.due({**self.config,'decisionIntervalMinutes':10},state,1,now))
        self.assertIsNone(p.due(self.config,state,1,now))

    def test_proactive_sends_distinct_bubbles_and_records_each_in_context(self):
        result = p.tick(manual=True)
        self.assertEqual(result['status'],'sent')
        self.assertEqual([x['content'] for x in self.sent],['刚想起你了','过来聊两句'])
        self.assertEqual([x['text'] for x in self.context],['刚想起你了','过来聊两句'])
        self.assertEqual(len(set(x['msg_seq'] for x in self.sent)),2)
        self.assertEqual(p.state()['messageIds'],['m1','m2'])

    def test_new_real_message_interrupts_remaining_bubbles(self):
        self.inbound.side_effect = [1,1,1,2]
        result = p.tick(manual=True)
        self.assertEqual(result['status'],'interrupted')
        self.assertEqual(len(self.sent),1)
        self.assertEqual(len(self.context),1)

    def test_partial_unknown_send_is_not_retried(self):
        def post(url, body, headers=None, **kwargs):
            if 'getAppAccessToken' in url:return {'access_token':'fake'}
            self.sent.append(body)
            if len(self.sent)==2:raise TimeoutError('test transport timeout')
            return {'id':'m1'}
        self.post.side_effect=post
        result=p.tick(manual=True)
        self.assertEqual(result['status'],'unknown')
        self.assertEqual(len(self.sent),2)
        self.assertEqual(p.state()['messageIds'],['m1'])
        self.assertEqual(len(self.context),1)

    def test_model_failure_does_not_send_canned_fallback(self):
        with patch.object(p,'generate_ai',side_effect=RuntimeError('model unavailable')):
            with self.assertRaises(RuntimeError):p.generate({**self.config,'mode':'ai'})
        self.assertEqual(self.sent,[])


if __name__ == '__main__':unittest.main()
