import asyncio, base64, hashlib, ipaddress, json, re, secrets, socket
from urllib.parse import urlsplit, urlunsplit
import httpx

class Uncertain(Exception): pass
class Rejected(Exception): pass

QQ_ACTIONS={'reply':'send_private_msg','proactive':'send_private_msg'}
QZONE_ACTIONS={'publish':'send_private_msg','like':'send_like','comment':'send_comment','reply_comment':'send_comment'}

class Channels:
    def __init__(self,store):self.store=store
    async def call(self, channel, action, params=None, write=False):
        if channel not in ('qq', 'qzone'):
            raise Rejected('渠道无效')
        allowed = ({'get_status', 'get_login_info', 'get_friend_list', 'send_private_msg'} if channel == 'qq' else
                   {'get_status', 'get_login_info', 'check_cookie', 'get_friend_feeds', 'get_emotion_list', 'get_comment_list', 'send_private_msg', 'send_like', 'send_comment'})
        if action not in allowed:
            raise Rejected('渠道动作不允许')
        cfg = self.store.config()
        url = cfg.channel.http_url if channel == 'qq' else cfg.qzone.http_url
        token = self.store.secret('qq_token' if channel == 'qq' else 'qzone_token')
        try:
            async with httpx.AsyncClient(timeout=20, trust_env=False, follow_redirects=False) as client:
                response = await client.post(url + '/' + action, json=params or {}, headers={'Authorization': 'Bearer ' + token})
            if response.status_code in (401, 403):
                raise Rejected('渠道鉴权失败')
            if write and (response.status_code >= 500 or 300 <= response.status_code < 400):
                raise Uncertain('上游响应不能确认是否已写入；禁止重发')
            response.raise_for_status()
            if len(response.content) > 8*1024*1024:
                raise ValueError()
            data = response.json()
            if not isinstance(data, dict) or type(data.get('retcode')) is not int:
                raise ValueError()
            if write and data.get('status') == 'async':
                raise Uncertain('上游异步受理，结果尚不明确；禁止重发')
            if data['retcode'] != 0 or data.get('status') == 'failed':
                raise Rejected('渠道明确拒绝请求')
            if data.get('status', 'ok') != 'ok' or 'data' not in data:
                raise ValueError()
            if write and not isinstance(data['data'], (dict, type(None))):
                raise ValueError()
            return data['data']
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError, ValueError) as error:
            if write:
                raise Uncertain('响应不可确认，禁止盲重发') from error
            raise Rejected('渠道连接失败或响应格式错误') from error
        except httpx.HTTPStatusError as error:
            raise Rejected('渠道 HTTP 请求被拒绝') from error

    async def health(self, channel):
        cfg = self.store.config()
        if channel == 'qq':
            status = await self.call('qq', 'get_status')
            info = await self.call('qq', 'get_login_info')
            if not isinstance(status, dict) or not isinstance(info, dict) or type(status.get('online')) is not bool:
                raise Rejected('QQ 状态响应格式无效')
            return {'online': status['online'], 'qq_id': str(info.get('user_id', '')), 'verified': True}
        if channel != 'qzone':
            raise Rejected('渠道无效')
        # 只有真实会话探测成功才算在线；/health 的缓存状态不作为在线证据。
        try:
            value = await self.call('qzone', 'check_cookie', {'probe': True})
        except Rejected:
            return {'online': False, 'qq_id': '', 'verified': True, 'reason': '空间桥接不可用或未登录',
                    'coverage': '轮询与尽力解析，不保证完整'}
        if not isinstance(value, dict) or type(value.get('valid')) is not bool:
            raise Rejected('空间会话响应格式无效')
        return {'online': value['valid'], 'qq_id': str(value.get('qq') or ''), 'verified': True,
                'reason': 'Cookie 有效' if value['valid'] else '空间未登录或会话已过期',
                'coverage': '轮询与尽力解析，不保证完整'}

    async def friends(self):
        data = await self.call('qq', 'get_friend_list')
        if not isinstance(data, list) or len(data) > 20000:
            raise Rejected('好友列表响应格式无效')
        for friend in data:
            if not isinstance(friend, dict) or isinstance(friend.get('user_id'), bool):
                raise Rejected('好友条目格式无效')
            ident = str(friend.get('user_id', ''))
            if not ident.isascii() or not ident.isdecimal() or not 5 <= len(ident) <= 12:
                raise Rejected('好友标识格式无效')
        return data

    async def send(self, row):
        try:
            payload = json.loads(row['payload'])
            if not isinstance(payload, dict):
                raise ValueError()
            if row['channel'] == 'qq' and row['action'] in QQ_ACTIONS:
                return await self.call('qq', QQ_ACTIONS[row['action']], {'user_id': int(row['friend']), 'message': payload['segments']}, write=True)
            if row['channel'] == 'qzone' and row['action'] in QZONE_ACTIONS:
                return await self.call('qzone', QZONE_ACTIONS[row['action']], payload, write=True)
        except (ValueError, KeyError, TypeError):
            raise Rejected('发送参数无效') from None
        raise Rejected('发送动作与渠道不匹配')

class MockChannels:
    def __init__(self,outcome='success'):self.sent=[];self.outcome=outcome
    async def send(self,row):
        self.sent.append(dict(row))
        if self.outcome=='unknown':raise Uncertain('模拟网络超时')
        if self.outcome=='failed':raise Rejected('模拟明确失败')
        return {'message_id':'mock-'+row['id']}

CDN=('qpic.cn','gtimg.cn','qq.com')
async def image_data(raw, max_bytes=5*1024*1024):
    """Download only public, allowlisted HTTPS images, pinning the resolved address."""
    try:
        parsed = urlsplit(raw)
        if parsed.scheme != 'https' or parsed.port not in (None, 443) or parsed.username or parsed.password:
            raise Rejected('图片仅允许 HTTPS 公共 CDN')
        host = parsed.hostname or ''
        if not any(host == domain or host.endswith('.' + domain) for domain in CDN):
            raise Rejected('图片域名不在允许列表')
        addresses = await asyncio.to_thread(socket.getaddrinfo, host, 443, type=socket.SOCK_STREAM)
        ips = list(dict.fromkeys(address[4][0] for address in addresses))
        if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
            raise Rejected('图片地址指向非公网')
        ip = next((ip for ip in ips if ':' not in ip), ips[0])
        target = urlunsplit(('https', '['+ip+']' if ':' in ip else ip, parsed.path, parsed.query, ''))
        async with httpx.AsyncClient(timeout=15, trust_env=False, follow_redirects=False) as client:
            async with client.stream('GET', target, headers={'Host': host}, extensions={'sni_hostname': host}) as response:
                if response.status_code != 200:
                    raise Rejected('图片下载失败')
                length = response.headers.get('content-length')
                if length is not None and (not length.isascii() or not length.isdecimal() or int(length) > max_bytes):
                    raise Rejected('图片长度头无效或超过限制')
                chunks, size = [], 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise Rejected('图片超过限制')
                    chunks.append(chunk)
        data = b''.join(chunks)
        mime = ('image/png' if data.startswith(b'\x89PNG\r\n\x1a\n') else
                'image/jpeg' if data.startswith(b'\xff\xd8\xff') else
                'image/gif' if data.startswith((b'GIF87a', b'GIF89a')) else None)
        if not mime:
            raise Rejected('图片实际类型不支持')
        return 'data:' + mime + ';base64,' + base64.b64encode(data).decode()
    except (ValueError, OSError, httpx.HTTPError, TypeError):
        raise Rejected('图片读取失败或地址无效；详情已脱敏') from None


def segments(raw):
    allowed = {'text', 'image', 'face', 'reply'}
    if isinstance(raw, list):
        out = []
        for item in raw[:100]:
            if not isinstance(item, dict) or not isinstance(item.get('type'),str) or item.get('type') not in allowed or not isinstance(item.get('data'), dict):
                continue
            data = {key: str(value) for key, value in item['data'].items()
                    if isinstance(key, str) and type(value) in (str, int, float) and len(str(value)) <= 32000}
            out.append({'type': item['type'], 'data': data})
        return out
    if not isinstance(raw, str):
        return []
    raw = raw[:100000]
    out, position = [], 0
    for match in re.finditer(r'\[CQ:(\w+)((?:,[^\]]*)*)\]', raw):
        if match.start() > position:
            out.append({'type': 'text', 'data': {'text': raw[position:match.start()]}})
        data = {key: value.replace('&#44;', ',').replace('&#91;', '[').replace('&#93;', ']').replace('&amp;', '&')
                for key, value in (pair.split('=', 1) for pair in match[2].split(',') if '=' in pair)}
        if match[1] in allowed:
            out.append({'type': match[1], 'data': data})
        position = match.end()
    if position < len(raw):
        out.append({'type': 'text', 'data': {'text': raw[position:]}})
    return out

class ModelClient:
    def __init__(self,store):self.store=store;self.lock=asyncio.Lock()
    async def complete(self,messages,kind='model',test=False):
        async with self.lock:return await self._complete(messages,kind,test)
    async def _complete(self,messages,kind='model',test=False):
        cfg=self.store.config();model=cfg.model if kind=='model' else cfg.vision_model if kind=='vision' else cfg.judge_model
        key=self.store.secret(kind+'_key')
        if not key or not model.base_url or not model.name:raise Rejected('模型未配置')
        # Limit entire serialized context before upload; no unrelated friend is ever retrieved.
        if len(json.dumps(messages,ensure_ascii=False))>model.context_limit*3:raise Rejected('上下文超过配置上限')
        start=__import__('datetime').datetime.now(__import__('zoneinfo').ZoneInfo(cfg.policy.timezone)).replace(hour=0,minute=0,second=0,microsecond=0).timestamp()
        usage=self.store.day_usage(start)
        # Immutable reservations prevent missing usage, failure or model changes from erasing spend.
        old_unknown=self.store.rows('SELECT count(*) n FROM usage WHERE created>=? AND (input IS NULL OR output IS NULL) AND reserved_tokens IS NULL',(start,))[0]['n']
        old_cost=self.store.rows('SELECT count(*) n FROM usage WHERE created>=? AND cost IS NULL AND reserved_cost IS NULL',(start,))[0]['n']
        token_spend=(usage['budget_tokens'] or 0)+old_unknown*(model.context_limit+model.output_limit)
        cost_spend=(usage['budget_cost'] or 0)+old_cost*(model.context_limit*model.input_price+model.output_limit*model.output_price)/1000000
        if (cfg.policy.model_daily>0 and usage['requests']>=cfg.policy.model_daily) or (cfg.policy.token_daily>0 and token_spend>=cfg.policy.token_daily) or (cfg.policy.cost_daily>0 and cost_spend>=cfg.policy.cost_daily):raise Rejected('模型调用预算已用完')
        # Record reservation before network call; failures still consume one request.
        with self.store.db() as c:
            cur=c.execute('INSERT INTO usage(model,created,reserved_tokens,reserved_cost) VALUES(?,?,?,?)',(model.name,__import__('time').time(),model.context_limit+model.output_limit,(model.context_limit*model.input_price+model.output_limit*model.output_price)/1000000));usage_id=cur.lastrowid
        try:
            host=(urlsplit(model.base_url).hostname or '').lower()
            opencode=host=='opencode.ai' or host.endswith('.opencode.ai')
            reasoning=opencode or host=='api.deepseek.com' or host.endswith('.deepseek.com')
            headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'}
            # OpenCode Go 要求会话亲和头；加实例随机盐，避免不同实例/账号被上游聚合。
            if opencode:
                salt=self._instance_salt()
                headers['x-opencode-session']='qqagent-'+hashlib.sha256((salt+'|'+model.base_url+'|'+model.name).encode()).hexdigest()[:32]
            payload={'model':model.name,'messages':messages,'max_tokens':model.output_limit}
            # 只对已知支持 reasoning_effort 的供应商发送，避免严格网关整体拒绝。
            if model.reasoning_effort and reasoning:payload['reasoning_effort']=model.reasoning_effort
            async with httpx.AsyncClient(timeout=model.timeout,trust_env=False,follow_redirects=False) as c:
                r=await c.post(model.base_url+'/chat/completions',json=payload,headers=headers)
            if r.status_code!=200:raise Rejected('模型请求失败，HTTP '+str(r.status_code))
            data=r.json();text=data['choices'][0]['message']['content'];u=data.get('usage') or {}
            if not isinstance(u,dict):u={}
            inp=u.get('prompt_tokens');out=u.get('completion_tokens');cost=None
            if type(inp) is not int or not 0<=inp<=10**9:inp=None
            if type(out) is not int or not 0<=out<=10**9:out=None
            if inp is not None and out is not None:cost=(inp*model.input_price+out*model.output_price)/1000000
            # 先结算已知用量，再判断正文：空正文已产生的 token 也必须计入预算。
            with self.store.db() as c:c.execute('UPDATE usage SET input=?,output=?,cost=? WHERE id=?',(inp,out,cost,usage_id))
            if not isinstance(text,str):raise Rejected('模型响应缺少正文')
            # 推理模型可能把 max_tokens 全部用于思考而返回空正文；空内容绝不能当成功。
            if not text.strip():raise Rejected('模型未返回正文（输出上限可能被推理占用）；请提高输出上限或降低推理强度')
            return text[:16000]
        except (httpx.HTTPError,KeyError,ValueError,TypeError,IndexError) as e:raise Rejected('模型连接失败或响应无效，详情已脱敏') from e

    def _instance_salt(self):
        value=self.store.get('instance_id')
        if not isinstance(value,str) or len(value)<16:
            value=secrets.token_hex(16);self.store.set('instance_id',value)
        return value


class SearchClient:
    """受控联网搜索：固定供应商地址，模型只能提供查询词。"""
    def __init__(self,store):self.store=store
    async def search(self,query):
        cfg=self.store.config();key=self.store.secret('search_key')
        if not key:raise Rejected('联网搜索未配置')
        q=' '.join(str(query).split())[:200]
        if not q:raise Rejected('搜索词为空')
        start=__import__('datetime').datetime.now(__import__('zoneinfo').ZoneInfo(cfg.policy.timezone)).replace(hour=0,minute=0,second=0,microsecond=0).timestamp()
        used=self.store.rows("SELECT count(*) n FROM logs WHERE action='search' AND result='ok' AND created>=?",(start,))[0]['n']
        if cfg.search.daily>0 and used>=cfg.search.daily:raise Rejected('今日搜索预算已用完')
        try:
            async with httpx.AsyncClient(timeout=cfg.search.timeout,trust_env=False,follow_redirects=False) as c:
                r=await c.post(cfg.search.base_url+'/search',json={'query':q,'max_results':cfg.search.max_results},headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
            if r.status_code in (401,403):raise Rejected('搜索鉴权失败')
            if r.status_code!=200:raise Rejected('搜索请求失败，HTTP '+str(r.status_code))
            data=r.json();results=data.get('results')
            if not isinstance(results,list):raise ValueError()
            out=[]
            for item in results[:cfg.search.max_results]:
                if not isinstance(item,dict):continue
                title=str(item.get('title') or '').strip()[:300]
                url=str(item.get('url') or '').strip()[:1000]
                snippet=str(item.get('snippet') or '').strip()[:800]
                if url and not url.startswith(('https://','http://')):continue
                if title or snippet:out.append({'title':title,'url':url,'snippet':snippet})
            self.store.log('','search','ok','检索完成')
            return out
        except (httpx.HTTPError,ValueError,TypeError) as e:
            raise Rejected('搜索连接失败或响应无效') from e
