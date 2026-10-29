from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from urllib.parse import urlsplit
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)

class Channel(Strict):
    qq_id: str = ''
    owner_id: str = ''
    http_url: str = 'http://127.0.0.1:13700'
    ws_url: str = 'ws://127.0.0.1:13701'
    enabled: bool = False
    @field_validator('qq_id','owner_id')
    @classmethod
    def ids(cls,v):
        if v and (not v.isascii() or not v.isdecimal() or not 5 <= len(v) <= 12): raise ValueError('QQ 号格式无效')
        return v
    @field_validator('http_url','ws_url')
    @classmethod
    def urls(cls,v,info):
        u=urlsplit(v)
        scheme='ws' if info.field_name=='ws_url' else 'http'
        if u.scheme!=scheme or u.hostname not in ('127.0.0.1','localhost','::1') or u.username or u.password or u.query or u.fragment or any(c.isspace() for c in v):
            raise ValueError('桥接必须使用匹配协议的本机回环地址，不允许 URL 内凭据')
        if u.port is not None and u.port==0:raise ValueError('桥接端口无效')
        return v.rstrip('/')

REASONING_EFFORTS = ('low', 'medium', 'high', 'max')

class Model(Strict):
    base_url: str = ''
    name: str = ''
    timeout: int = Field(30,ge=3,le=120)
    context_limit: int = Field(12000,ge=1000,le=128000)
    output_limit: int = Field(1000,ge=16,le=8000)
    input_price: float = Field(0.0,ge=0,le=10000)
    output_price: float = Field(0.0,ge=0,le=10000)
    # 留空表示不向供应商发送该参数；默认 low 更快、推理 token 更少。
    reasoning_effort: str = 'low'
    @field_validator('reasoning_effort')
    @classmethod
    def effort(cls,v):
        if v not in ('',)+REASONING_EFFORTS: raise ValueError('推理强度无效，可选 low/medium/high/max 或留空')
        return v
    @field_validator('base_url')
    @classmethod
    def base(cls,v):
        if not v: return v
        u=urlsplit(v)
        if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.query or u.fragment: raise ValueError('模型地址无效')
        if u.scheme=='http' and u.hostname not in ('127.0.0.1','localhost','::1'): raise ValueError('远程模型必须使用 HTTPS')
        return v.rstrip('/')

class Search(Strict):
    base_url: str = 'https://api.example.com/v1'  # override with the provider of your choice
    timeout: int = Field(20,ge=3,le=60)
    max_results: int = Field(5,ge=1,le=10)
    daily: int = Field(50,ge=0,le=1000)
    @field_validator('base_url')
    @classmethod
    def base(cls,v):
        u=urlsplit(v)
        if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.query or u.fragment: raise ValueError('搜索地址无效')
        if u.scheme=='http' and u.hostname not in ('127.0.0.1','localhost','::1'): raise ValueError('远程搜索必须使用 HTTPS')
        return v.rstrip('/')

class Permissions(Strict):
    reply: bool = False
    proactive: bool = False
    read: bool = False
    like: bool = False
    comment: bool = False

class Policy(Strict):
    timezone: str = 'Asia/Shanghai'
    quiet_start: int = Field(23,ge=0,le=23)
    quiet_end: int = Field(9,ge=0,le=23)
    reply_in_quiet: bool = True
    enabled: bool = False
    growth: bool = False
    proactive_daily: int = Field(2,ge=0,le=20)
    comment_daily: int = Field(3,ge=0,le=30)
    publish_daily: int = Field(1,ge=0,le=10)
    like_daily: int = Field(5,ge=0,le=50)
    total_daily: int = Field(100,ge=0,le=1000)
    model_daily: int = Field(100,ge=0,le=2000)
    token_daily: int = Field(100000,ge=0,le=10000000)
    cost_daily: float = Field(5.0,ge=0,le=1000)
    cooldown_hours: int = Field(24,ge=1,le=720)
    decision_minutes: int = Field(30,ge=5,le=1440)
    retention_days: int = Field(30,ge=1,le=3650)
    log_days: int = Field(14,ge=1,le=365)
    defaults: Permissions = Field(default_factory=Permissions)
    @field_validator('timezone')
    @classmethod
    def zone(cls,v):
        try:ZoneInfo(v)
        except (ZoneInfoNotFoundError,ValueError) as e:raise ValueError('时区无效，请使用 IANA 时区名称') from e
        return v

class Qzone(Strict):
    enabled: bool = False
    http_url: str = 'http://127.0.0.1:13702'
    ws_url: str = 'ws://127.0.0.1:13702/event'
    read: bool = False
    like: bool = False
    comment: bool = False
    reply: bool = False
    publish: bool = False
    poll_minutes: int = Field(10,ge=2,le=1440)
    pages: int = Field(1,ge=1,le=5)
    candidates: int = Field(5,ge=1,le=30)
    retention_days: int = Field(7,ge=1,le=365)
    _urls = field_validator('http_url','ws_url')(Channel.urls.__func__)

class Tools(Strict):
    vision: bool = False
    stickers: bool = False
    search: bool = False
    image_generation: bool = False

class Configuration(Strict):
    channel: Channel = Field(default_factory=Channel)
    model: Model = Field(default_factory=Model)
    vision_model: Model = Field(default_factory=Model)
    judge_model: Model = Field(default_factory=Model)
    policy: Policy = Field(default_factory=Policy)
    qzone: Qzone = Field(default_factory=Qzone)
    search: Search = Field(default_factory=Search)
    tools: Tools = Field(default_factory=Tools)
    @model_validator(mode='after')
    def unsupported(self):
        if self.tools.image_generation or self.tools.stickers:
            raise ValueError('当前版本未接入生图供应商或表情库，不能启用')
        return self
