"""仅合成安装目录/假进程验证，绝不启动真实 QQ、连接账号或读取打包的 NapCat。"""

import importlib.util
import tempfile
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load_script(relative, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


setup = load_script('deploy/setup-qq.py', 'napcat_setup_test')
installer = load_script('deploy/install-napcat.py', 'napcat_install_test')
diagnostics = load_script('scripts/diagnose-napcat.py', 'napcat_diagnostics_test')


@pytest.fixture
def runtime(tmp_path):
    root = tmp_path / 'runtime'
    app = setup.qq_app(root)
    app.mkdir(parents=True)
    (root / 'napcat').mkdir()
    (root / 'home').mkdir()
    metadata = {'name': 'QQ', 'version': '3.2.34-53644', 'buildVersion': '53644',
                'main': './application.asar/app_launcher/index.js', 'privateField': 'preserve'}
    (app / 'package.json').write_text(json.dumps(metadata))
    (root / 'napcat/package.json').write_text(json.dumps({'version': '4.6.7', 'type': 'module'}))
    (root / 'napcat/napcat.mjs').write_text('export const fixtureOnly = true;\n')
    for file in (root / 'qq/opt/QQ/qq', app / 'wrapper.node', app / 'major.node'):
        file.write_bytes(b'SYNTHETIC-NOT-AN-EXECUTABLE')
    shutil.copyfile(ROOT / 'deploy/setup-qq.py', root / 'setup-qq.py')
    shutil.copyfile(ROOT / 'deploy/launch-napcat.sh', root / 'launch.sh')
    return root


def configure(runtime):
    setup.install(runtime)
    configs, _, _ = installer.config_plan(runtime / 'napcat/config')
    for name, value in configs.items():
        (runtime / 'napcat/config' / name).write_text(json.dumps(value))


def test_setup_preserves_metadata_and_precreates_runtime_directories(runtime):
    app = setup.qq_app(runtime)
    original = (app / 'package.json').read_bytes()
    manifest = setup.install(runtime)
    updated = json.loads((app / 'package.json').read_text())
    assert updated == {**json.loads(original), 'main': setup.LOADER_NAME}
    assert (app / 'package.qqagent-original.json').read_bytes() == original
    assert all((runtime / 'napcat' / name).is_dir() for name in ('logs', 'config', 'cache'))
    assert manifest['evidence_kind'] == 'static-integrity-only'
    assert 'runtime_loaded' not in manifest
    assert not (runtime / 'runtime-proof.json').exists()
    assert setup.verify(runtime) == manifest
    assert setup.install(runtime) == manifest
    assert (app / 'package.qqagent-original.json').read_bytes() == original


@pytest.mark.parametrize('component,field,value', [
    ('qq', 'version', '3.2.34-99999'), ('qq', 'version', '3.2.34-malicious'),
    ('qq', 'buildVersion', '99999'), ('napcat', 'version', '4.6.8'),
])
def test_wrong_component_version_fails_before_mutating_entry(runtime, component, field, value):
    app = setup.qq_app(runtime)
    target = app / 'package.json' if component == 'qq' else runtime / 'napcat/package.json'
    data = json.loads(target.read_text())
    data[field] = value
    target.write_text(json.dumps(data))
    original = (app / 'package.json').read_bytes()
    with pytest.raises(setup.BootstrapError, match='VERSION_MISMATCH'):
        setup.install(runtime)
    assert (app / 'package.json').read_bytes() == original
    assert not (app / setup.LOADER_NAME).exists()
    assert not (runtime / 'versions.json').exists()


def test_missing_native_dependency_does_not_rewrite_entry(runtime):
    wrapper = setup.qq_app(runtime) / 'wrapper.node'
    wrapper.unlink()
    original = (setup.qq_app(runtime) / 'package.json').read_bytes()
    with pytest.raises(setup.BootstrapError, match='REQUIRED_COMPONENT_MISSING'):
        setup.install(runtime)
    assert (setup.qq_app(runtime) / 'package.json').read_bytes() == original


@pytest.mark.parametrize('index', range(9))
def test_immutable_bootstrap_file_tamper_is_rejected(runtime, index):
    setup.install(runtime)
    path = setup.immutable_files(runtime)[index]
    path.write_bytes(path.read_bytes() + b'\nTAMPER')
    with pytest.raises(setup.BootstrapError, match='COMPONENT_HASH_MISMATCH'):
        setup.verify(runtime)


def test_manifest_cannot_remove_a_file_from_verification(runtime):
    manifest = setup.install(runtime)
    manifest['files'].pop(str(setup.qq_app(runtime) / setup.LOADER_NAME))
    (runtime / 'versions.json').write_text(json.dumps(manifest))
    with pytest.raises(setup.BootstrapError, match='MANIFEST_FILES_MISMATCH'):
        setup.verify(runtime)


def test_preflight_accepts_synthetic_safe_configuration(runtime):
    configure(runtime)
    assert setup.preflight(runtime, runtime / 'home')['qq'] == '3.2.34-53644'


@pytest.mark.parametrize('field,value', [('host', '0.0.0.0'), ('port', 6099), ('token', 'napcat'),
                                        ('autoLoginAccount', '10001')])
def test_webui_unsafe_config_fails_closed(runtime, field, value):
    configure(runtime)
    path = runtime / 'napcat/config/webui.json'
    config = json.loads(path.read_text())
    config[field] = value
    path.write_text(json.dumps(config))
    with pytest.raises(setup.BootstrapError, match='WEBUI_CONFIG_UNSAFE'):
        setup.preflight(runtime, runtime / 'home')


def test_quick_login_environment_is_rejected(runtime, monkeypatch):
    configure(runtime)
    monkeypatch.setenv('NAPCAT_QUICK_ACCOUNT', '10001')
    with pytest.raises(setup.BootstrapError, match='WEBUI_CONFIG_UNSAFE'):
        setup.preflight(runtime, runtime / 'home')


@pytest.mark.parametrize('name', ['fileLog', 'consoleLog'])
def test_persistent_log_setting_is_rejected(runtime, name):
    configure(runtime)
    path = runtime / 'napcat/config/napcat.json'
    value = json.loads(path.read_text())
    value[name] = True
    path.write_text(json.dumps(value))
    with pytest.raises(setup.BootstrapError, match='LOG_CONFIG_UNSAFE'):
        setup.preflight(runtime, runtime / 'home')


def test_read_only_logs_failure_is_detected_before_qq(runtime, monkeypatch):
    configure(runtime)
    original_access = setup.os.access
    monkeypatch.setattr(setup.os, 'access', lambda path, mode:
                        False if path == runtime / 'napcat/logs' else original_access(path, mode))
    with pytest.raises(setup.BootstrapError, match='RUNTIME_DIRECTORY_NOT_WRITABLE'):
        setup.preflight(runtime, runtime / 'home')


def test_quick_update_state_cannot_override_pinned_qq(runtime):
    configure(runtime)
    directory = runtime / 'home/.config/QQ/versions'
    directory.mkdir(parents=True)
    (directory / 'config.json').write_text('{}')
    with pytest.raises(setup.BootstrapError, match='QQ_QUICK_UPDATE_PRESENT'):
        setup.preflight(runtime, runtime / 'home')


@pytest.mark.parametrize('code,expected,status', [
    ('export const fixtureOnly=true;', 'module_imported', 0),
    ('throw new Error("PRIVATE_SENTINEL");', 'bootstrap_failed', 1),
    ('Promise.reject(new Error("PRIVATE_SENTINEL"));', 'bootstrap_failed', 1),
])
def test_loader_reports_only_fixed_stage_without_claiming_runtime_success(tmp_path, code, expected, status):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node 不可用；不能执行加载器合成测试')
    nap = tmp_path / 'nap cat #测试'
    nap.mkdir()
    (nap / 'napcat.mjs').write_text(code)
    stage = tmp_path / 'stage.json'
    loader = tmp_path / 'loader.cjs'
    loader.write_text(setup.loader_source(nap, stage))
    result = subprocess.run([node, str(loader)], capture_output=True, text=True, timeout=10)
    assert result.returncode == status
    assert result.stdout == '' and result.stderr == ''
    assert json.loads(stage.read_text()) == {'schema_version': 1, 'stage': expected}
    assert stage.stat().st_mode & 0o777 == 0o600
    assert not (tmp_path / 'runtime-proof.json').exists()


def test_installer_preserves_existing_tokens_and_custom_fields(tmp_path):
    first, token, web = installer.config_plan(tmp_path)
    first['webui.json']['custom'] = 'preserve'
    for name, value in first.items():
        (tmp_path / name).write_text(json.dumps(value))
    second, second_token, second_web = installer.config_plan(tmp_path)
    assert first == second and token == second_token and web == second_web


def test_installer_rejects_corrupt_config_without_overwriting(tmp_path):
    path = tmp_path / 'webui.json'
    path.write_text('PRIVATE_SENTINEL_INVALID_JSON')
    with pytest.raises(ValueError, match='未覆盖') as error:
        installer.config_plan(tmp_path)
    assert 'PRIVATE_SENTINEL' not in str(error.value)
    assert path.read_text() == 'PRIVATE_SENTINEL_INVALID_JSON'


def test_installer_default_has_no_side_effects(monkeypatch):
    monkeypatch.setattr(installer.subprocess, 'check_output', lambda *a, **k: pytest.fail('不能调用docker'))
    with pytest.raises(SystemExit) as error:
        installer.main([])
    assert error.value.code == 2
    source = (ROOT / 'deploy/install-napcat.py').read_text()
    assert "['systemctl', 'enable'" not in source
    assert '--now' not in source


def test_diagnostics_only_runs_read_only_commands_and_discards_private_fields(tmp_path):
    calls = []
    def run(command):
        calls.append(command)
        if command == diagnostics.SERVICE_COMMAND:
            return 'ActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nToken=PRIVATE_SENTINEL\n'
        if command == diagnostics.CONTAINER_COMMAND:
            return json.dumps({'status': 'exited', 'running': False, 'exit_code': 1,
                               'read_only': True, 'tmpfs': {'/runtime/napcat/logs': 'PRIVATE_SENTINEL'},
                               'mounts': [{'Source': 'PRIVATE_SENTINEL', 'Destination': '/runtime/napcat/cache', 'RW': True}],
                               'error': 'PRIVATE_SENTINEL'})
        if command == diagnostics.LISTEN_COMMAND:
            return 'LISTEN 0 4096 127.0.0.1:13801 0.0.0.0:*\n'
        pytest.fail('意外诊断命令')
    report = diagnostics.diagnose(run, tmp_path)
    assert calls == [diagnostics.SERVICE_COMMAND, diagnostics.CONTAINER_COMMAND, diagnostics.LISTEN_COMMAND]
    assert 'PRIVATE_SENTINEL' not in json.dumps(report)
    assert report['runtime_loaded'] == 'unknown'
    assert report['container']['logs_tmpfs'] is True
    assert report['listening'] == {'13700': False, '13701': False, '13801': True}
    assert report['service']['ActiveState'] == 'inactive'


def test_diagnostics_failures_remain_unknown(tmp_path):
    report = diagnostics.diagnose(lambda command: None, tmp_path)
    assert report['runtime_loaded'] == 'unknown'
    assert not report['container']['available']
    assert all(value is None for value in report['listening'].values())


def executable(path, body):
    path.write_text('#!' + sys.executable + '\n' + body)
    path.chmod(0o755)


@pytest.mark.parametrize('xvfb_works', [True, False])
def test_launcher_with_fake_processes_is_quiet_and_cleans_xvfb(runtime, tmp_path, xvfb_works):
    # 真实shell与Python预检，仅将QQ/Xvfb换成合成程序；没有账号或外部网络。
    fake_bin = tmp_path / 'bin'
    fake_bin.mkdir()
    # macOS 的 UNIX socket 路径上限约 104 字节，pytest 临时目录可能超限，故使用系统临时根。
    socket_path = Path(tempfile.mkdtemp(prefix='qqagent-x11-', dir='/tmp')) / 'x99.sock'
    stop_marker = tmp_path / 'xvfb-stopped'
    qq_marker = tmp_path / 'qq-started'
    executable(fake_bin / 'Xvfb', (
        "import os,signal,socket\nfrom pathlib import Path\n"
        "def stop(*args):\n    Path(os.environ['MOCK_X_STOP']).write_text('stopped')\n    raise SystemExit(0)\n"
        "signal.signal(signal.SIGTERM,stop)\n"
        "s=socket.socket(socket.AF_UNIX)\ns.bind(os.environ['MOCK_X_SOCKET'])\n"
        "while True: signal.pause()\n" if xvfb_works else 'raise SystemExit(3)\n'
    ))
    executable(runtime / 'qq/opt/QQ/qq',
               "import os,sys,json\nfrom pathlib import Path\n"
               "Path(os.environ['MOCK_QQ_MARK']).write_text(json.dumps({'cwd':os.getcwd(),'argv':sys.argv[1:]}))\n"
               "print('PRIVATE_SENTINEL')\nprint('PRIVATE_SENTINEL',file=sys.stderr)\nraise SystemExit(7)\n")
    launcher = runtime / 'launch.sh'
    launcher.write_text(launcher.read_text().replace('/runtime/', str(runtime) + '/')
                        .replace('/tmp/.X11-unix/X99', str(socket_path)))
    bootstrap = runtime / 'setup-qq.py'
    bootstrap.write_text(bootstrap.read_text().replace('Path("/runtime")', 'Path(' + repr(str(runtime)) + ')'))
    configure(runtime)
    env = {**os.environ, 'HOME': str(runtime / 'home'), 'PATH': str(fake_bin) + ':' + os.environ['PATH'],
           'MOCK_X_SOCKET': str(socket_path), 'MOCK_X_STOP': str(stop_marker), 'MOCK_QQ_MARK': str(qq_marker)}
    env.pop('NAPCAT_QUICK_ACCOUNT', None)
    result = subprocess.run(['/bin/sh', str(launcher)], env=env, capture_output=True, text=True, timeout=15)
    assert 'PRIVATE_SENTINEL' not in result.stdout + result.stderr
    if xvfb_works:
        assert result.returncode == 7
        assert stop_marker.exists()
        called = json.loads(qq_marker.read_text())
        assert called['cwd'] == str(runtime / 'napcat')
        assert called['argv'] == ['--no-sandbox']
    else:
        assert result.returncode == 1
        assert 'XVFB_EXITED' in result.stderr
        assert not qq_marker.exists()


def test_runner_keeps_logs_ephemeral_and_image_inputs_pinned():
    runner = (ROOT / 'deploy/run-napcat.sh').read_text()
    dockerfile = (ROOT / 'deploy/Dockerfile.napcat').read_text()
    assert '--read-only' in runner and '--log-driver none' in runner
    assert '--tmpfs /runtime/napcat/logs:' in runner
    assert 'uid=19340,gid=19340,mode=0700' in runner
    assert '--memory ' not in runner and '--memory-swap ' not in runner
    assert '--pids-limit ' not in runner
    assert '--init' in runner and '--ulimit core=0:0' in runner
    assert 'NapCat.Shell.4.6.7.zip' in dockerfile
    assert 'a4ac67ebe93c1ad2ccd43231e71c50021f20a673e9297a25a87ed45f8f8d20ea' in dockerfile
    assert '436c65e1dd28422e128a21cbddb5fe4e2e6c079d7f27fec2541e014d38cc336e' in dockerfile
    assert dockerfile.index('COPY launch-napcat.sh') < dockerfile.index('RUN python3 /runtime/setup-qq.py')

def test_qq_supervisor_identifies_live_native_processes(tmp_path):
    setup=load_script('deploy/setup-qq.py','setup_supervisor')
    binary=tmp_path/'native-qq';binary.write_bytes(b'fixture')
    proc=tmp_path/'proc';proc.mkdir()
    for ident,state in ((123,'S'),(456,'Z')):
        folder=proc/str(ident);folder.mkdir();(folder/'exe').symlink_to(binary)
        (folder/'stat').write_text(f'{ident} (qq) {state} 1 2 3')
    assert setup.qq_processes(proc,binary)==[123]
