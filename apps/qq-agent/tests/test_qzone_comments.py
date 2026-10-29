"""本人动态评论轮询：兼容上游小写 commentid 与时间字段。"""
import json

import pytest

from qqagent.engine import Engine
from qqagent.store import Store, now
from qqagent.worker import poll_own_comments


class Bridge:
    def __init__(self):
        self.calls = []

    async def call(self, channel, action, params=None, write=False):
        self.calls.append((action, params))
        if action == 'get_emotion_list':
            return {'msglist': [{'tid': 't1'}]}
        if action == 'get_comment_list':
            return {'comments': [{'commentid': 'c1', 'uin': '20002', 'content': 'PUBLIC', 'createTime': int(now()) - 5}]}
        raise AssertionError(action)


@pytest.mark.asyncio
async def test_comment_poll_reads_lowercase_commentid(tmp_path):
    s = Store(tmp_path)
    cfg = s.get('config')
    cfg['channel']['qq_id'] = '90000'
    cfg['qzone']['reply'] = True
    s.save_config(cfg, s.get('revision'))
    e = Engine(s, lambda: {'ok': True})
    e.channels = Bridge()
    await poll_own_comments(e, now() - 100, now())
    rows = s.rows("SELECT * FROM events WHERE channel='qzone'")
    assert len(rows) == 1
    body = json.loads(rows[0]['body'])
    assert body['comment_id'] == 'c1' and body['user_id'] == '20002'
    assert rows[0]['id'] == 'qzone:comment:t1:c1'
    assert rows[0]['created'] > 1000000000
