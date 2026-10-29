"""准备 NapCat 专用目录和配置，不自动启动、启用或登录 QQ。"""

import argparse
import grp
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys

ROOT = Path('/opt/qq-agent')
DATA = Path('/var/lib/qq-agent-napcat')


def config_plan(directory):
    """复用已安装的凭据及自定义配置，拒绝静默轮换或损坏的配置。"""
    existing = {}
    for name in ('onebot11.json', 'webui.json', 'napcat.json'):
        path = directory / name
        if path.is_symlink():
            raise ValueError('配置路径不允许符号链接')
        if path.exists():
            try:
                value = json.loads(path.read_text())
            except (OSError, ValueError):
                raise ValueError('现有配置不可读取，未覆盖') from None
            if not isinstance(value, dict):
                raise ValueError('现有配置格式无效，未覆盖')
            existing[name] = value
    if 'onebot11.json' in existing:
        try:
            network = existing['onebot11.json']['network']
            servers = network['httpServers'] + network['websocketServers']
            tokens = {server['token'] for server in servers if server.get('enable')}
        except (KeyError, TypeError, AttributeError):
            raise ValueError('现有 OneBot 配置无效，未覆盖') from None
        if len(tokens) != 1 or not all(isinstance(value, str) and len(value) >= 32 for value in tokens):
            raise ValueError('现有 OneBot 凭据不一致或过短，未覆盖')
        token = tokens.pop()
    else:
        token = secrets.token_urlsafe(32)
    if 'webui.json' in existing:
        web = existing['webui.json'].get('token')
        if not isinstance(web, str) or len(web) < 32:
            raise ValueError('现有 WebUI 凭据无效，未覆盖')
    else:
        web = secrets.token_urlsafe(32)
    defaults = {
        'onebot11.json': {
            'network': {
                'httpServers': [{'name': 'qqagent-http', 'enable': True, 'host': '127.0.0.1',
                                 'port': 13700, 'token': token, 'enableCors': False,
                                 'enableWebsocket': False, 'messagePostFormat': 'array', 'debug': False}],
                'websocketServers': [{'name': 'qqagent-events', 'enable': True, 'host': '127.0.0.1',
                                      'port': 13701, 'token': token, 'messagePostFormat': 'array',
                                      'reportSelfMessage': False, 'enableForcePushEvent': True, 'debug': False}],
            },
            'musicSignUrl': '', 'enableLocalFile2Url': False, 'parseMultMsg': False,
        },
        'webui.json': {'host': '127.0.0.1', 'port': 13801, 'token': web, 'loginRate': 3,
                       'autoLoginAccount': ''},
        'napcat.json': {'fileLog': False, 'consoleLog': False, 'fileLogLevel': 'error',
                        'consoleLogLevel': 'error', 'packetBackend': 'auto', 'packetServer': '', 'o3HookMode': 1},
    }
    return {name: existing.get(name, value) for name, value in defaults.items()}, token, web


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply-after-full-backup', action='store_true',
                        help='仅在本批完整恢复点已核实且获部署授权后使用；本脚本不验证备份')
    parser.add_argument('--image',choices=('qq-agent-napcat:4.6.7-qq3.2.16','qq-agent-napcat:4.6.7-qq3.2.34'),default='qq-agent-napcat:4.6.7-qq3.2.16')
    args=parser.parse_args(argv)
    if not args.apply_after_full_backup:
        parser.error('默认不变更；需要独立确认本批完整恢复点和部署授权')
    if os.geteuid() != 0:
        raise SystemExit('安装必须由 root 在目标 Linux 主机执行')
    # 在改动目录与凭据前确认目标镜像存在；只读取镜像ID，不运行容器。
    image = subprocess.check_output(
        ['docker', 'image', 'inspect', args.image, '--format', '{{.Id}}'],
        text=True, timeout=15,
    ).strip()
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise ValueError('镜像ID格式错误')
    configs, token, web = config_plan(DATA / 'config')
    sys.path.insert(0, str(ROOT))
    from qqagent.store import Store
    store = Store('/var/lib/qq-agent')
    for name, value in (('qq_token', token), ('napcat_web_token', web)):
        current = store.secret(name)
        if current and current != value:
            raise ValueError('组件与控制台凭据不一致；未覆盖，请先核对既有配置')
    gid = grp.getgrnam('qqagent').gr_gid
    for path in (DATA, DATA / 'home', DATA / 'config', DATA / 'cache'):
        if path.is_symlink():
            raise ValueError('数据路径不允许符号链接')
        path.mkdir(exist_ok=True)
        os.chown(path, 19340, 19340)
        path.chmod(0o700)
    os.chown(DATA, 19340, gid)
    DATA.chmod(0o710)
    os.chown(DATA / 'cache', 19340, gid)
    (DATA / 'cache').chmod(0o750)
    for name, value in configs.items():
        path = DATA / 'config' / name
        if not path.exists():
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                json.dump(value, stream)
        os.chown(path, 19340, 19340)
        path.chmod(0o600)
    for name, value in (('qq_token', token), ('napcat_web_token', web)):
        if not store.secret(name):
            store.put_secret(name, value)
    subprocess.run(['chown', '-R', 'qqagent:qqagent', '/var/lib/qq-agent'], check=True, timeout=15)
    (ROOT / 'napcat-image.lock').write_text(image + '\n')
    shutil.copy2(ROOT / 'deploy/qq-agent-napcat.service', '/etc/systemd/system/qq-agent-napcat.service')
    (ROOT / 'deploy/run-napcat.sh').chmod(0o755)
    # 精确服务、精确动作，无通配符；与既有控制台接口保持兼容。
    commands = ', '.join('/usr/bin/systemctl ' + verb + ' qq-agent-' + component + '.service'
                         for component in ('napcat', 'qzone')
                         for verb in ('start', 'stop', 'restart', 'is-active'))
    path = Path('/etc/sudoers.d/qq-agent-components')
    path.write_text('qqagent ALL=(root) NOPASSWD: ' + commands + '\n')
    path.chmod(0o440)
    subprocess.run(['visudo', '-cf', str(path)], check=True, timeout=15)
    subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=15)
    print('NapCat 配置准备完成；未启动或启用服务，未生成运行验收证明。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
