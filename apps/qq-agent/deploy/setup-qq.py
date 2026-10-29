"""固定版本镜像安装和无账号预检；静态清单不能充当运行成功证明。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

NAPCAT_VERSION = "4.6.7"
QQ_VERSION = os.environ.get("QQAGENT_EXPECTED_QQ", "3.2.34-53644")
if QQ_VERSION not in ("3.2.16-32793", "3.2.34-53644"):
    raise ValueError("UNAUTHORIZED_QQ_VERSION")
QQ_BUILD = QQ_VERSION.rsplit("-", 1)[1]
LOADER_NAME = "qqagent-loader.cjs"


class BootstrapError(ValueError):
    """只携带固定错误码，避免把配置值带入日志。"""


def read_object(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise BootstrapError("INVALID_JSON_OBJECT")
    return value


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def qq_app(runtime):
    return runtime / "qq/opt/QQ/resources/app"


def check_versions(runtime):
    meta = read_object(qq_app(runtime) / "package.json")
    nap = read_object(runtime / "napcat/package.json")
    if nap.get("version") != NAPCAT_VERSION:
        raise BootstrapError("NAPCAT_VERSION_MISMATCH")
    if meta.get("version") != QQ_VERSION or str(meta.get("buildVersion")) != QQ_BUILD:
        raise BootstrapError("QQ_VERSION_MISMATCH")
    return meta


def loader_source(napcat, state_path=Path('/tmp/qqagent-napcat-stage.json')):
    # v4.6.7 官方 Shell 同样从 QQ main 动态导入，不能加载 Windows qqnt.json。
    # NCoreInitShell 没有返回给外层的可等待结果，因此 import resolve 不代表已就绪。
    return """'use strict';
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const statePath = %s;
let failed = false;
const mark = (stage) => {
    fs.writeFileSync(statePath, JSON.stringify({schema_version: 1, stage}), {mode: 0o600});
};
const fail = () => {
    failed = true;
    try { mark('bootstrap_failed'); } finally { process.exit(1); }
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
mark('loader_entered');
import(pathToFileURL(%s).href).then(() => {
    if (!failed) mark('module_imported');
}).catch(fail);
""" % (json.dumps(str(state_path)), json.dumps(str(napcat / "napcat.mjs")))


def immutable_files(runtime):
    app = qq_app(runtime)
    return (
        app / "package.json", app / LOADER_NAME,
        runtime / "qq/opt/QQ/qq", app / "wrapper.node", app / "major.node",
        runtime / "napcat/package.json", runtime / "napcat/napcat.mjs",
        runtime / "setup-qq.py", runtime / "launch.sh",
    )


def install(runtime):
    runtime = runtime.resolve()
    app = qq_app(runtime)
    meta = check_versions(runtime)
    # 先检查全部输入；失败时不改 QQ 原始入口。
    for path in immutable_files(runtime):
        if path.name != LOADER_NAME and not path.is_file():
            raise BootstrapError("REQUIRED_COMPONENT_MISSING")
    loader = app / LOADER_NAME
    source = loader_source(runtime / "napcat")
    if loader.exists() and loader.read_text(encoding="utf-8") != source:
        raise BootstrapError("EXISTING_LOADER_CONFLICT")
    backup = app / "package.qqagent-original.json"
    if not backup.exists():
        if meta.get("main") == LOADER_NAME:
            raise BootstrapError("ORIGINAL_METADATA_MISSING")
        backup.write_bytes((app / "package.json").read_bytes())
    # 在 rootfs 变只读之前创建目录。logs 运行时必须挂载为专用 tmpfs。
    for name in ("logs", "config", "cache"):
        (runtime / "napcat" / name).mkdir(exist_ok=True)
    loader.write_text(source, encoding="utf-8")
    meta["main"] = LOADER_NAME
    (app / "package.json").write_text(json.dumps(meta), encoding="utf-8")
    manifest = {
        "schema_version": 2,
        "evidence_kind": "static-integrity-only",
        "napcat": NAPCAT_VERSION, "qq": QQ_VERSION, "qq_build": QQ_BUILD,
        "qq_metadata": str(app / "package.json"),
        "files": {str(path): digest(path) for path in immutable_files(runtime)},
    }
    (runtime / "versions.json").write_text(json.dumps(manifest), encoding="utf-8")
    return manifest


def verify(runtime):
    runtime = runtime.resolve()
    manifest = read_object(runtime / "versions.json")
    if (manifest.get("schema_version") != 2
            or manifest.get("evidence_kind") != "static-integrity-only"
            or manifest.get("napcat") != NAPCAT_VERSION
            or manifest.get("qq") != QQ_VERSION
            or str(manifest.get("qq_build")) != QQ_BUILD):
        raise BootstrapError("MANIFEST_VERSION_MISMATCH")
    paths = {str(path): path for path in immutable_files(runtime)}
    if not isinstance(manifest.get("files"), dict) or set(manifest["files"]) != set(paths):
        raise BootstrapError("MANIFEST_FILES_MISMATCH")
    for name, path in paths.items():
        if path.is_symlink() or not path.is_file() or digest(path) != manifest["files"][name]:
            raise BootstrapError("COMPONENT_HASH_MISMATCH")
    meta = check_versions(runtime)
    if meta.get("main") != LOADER_NAME:
        raise BootstrapError("QQ_ENTRY_MISMATCH")
    return manifest


def preflight(runtime, home):
    manifest = verify(runtime)
    napcat = runtime / "napcat"
    for path in (home, napcat / "config", napcat / "cache", napcat / "logs"):
        if not path.is_dir() or not os.access(path, os.R_OK | os.W_OK | os.X_OK):
            raise BootstrapError("RUNTIME_DIRECTORY_NOT_WRITABLE")
    # 快更可能绕过已固定的原生模块，不能仅凭安装元数据冒充固定运行版本。
    for path in (home / ".config/QQ/versions/config.json", qq_app(runtime) / "versions/config.json"):
        if path.exists():
            raise BootstrapError("QQ_QUICK_UPDATE_PRESENT")
    web = read_object(napcat / "config/webui.json")
    if (web.get("host") != "127.0.0.1" or web.get("port") != 13801
            or not isinstance(web.get("token"), str) or len(web["token"]) < 32
            or web.get("autoLoginAccount", "") or os.environ.get("NAPCAT_QUICK_ACCOUNT")):
        raise BootstrapError("WEBUI_CONFIG_UNSAFE")
    config = read_object(napcat / "config/napcat.json")
    if config.get("fileLog") is not False or config.get("consoleLog") is not False:
        raise BootstrapError("LOG_CONFIG_UNSAFE")
    return manifest


def qq_processes(proc=Path('/proc'), binary=Path('/runtime/qq/opt/QQ/qq')):
    found=[]
    for child in proc.iterdir():
        if not child.name.isdecimal():continue
        try:
            if (child/'exe').resolve()!=binary:continue
            state=(child/'stat').read_text().rsplit(')',1)[1].strip().split()[0]
            if state!='Z':found.append(int(child.name))
        except (OSError,ValueError,IndexError):continue
    return found


def supervise_qq():
    # Older Linux QQ can hand off to another QQ process. Keep Xvfb alive for that process.
    empty_since=None
    while True:
        if qq_processes():empty_since=None
        elif empty_since is None:empty_since=time.monotonic()
        elif time.monotonic()-empty_since>=1:return
        time.sleep(.2)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="只核验静态文件")
    parser.add_argument("--preflight", action="store_true", help="启动前核验，不启动 QQ")
    parser.add_argument("--supervise-qq",action="store_true")
    args = parser.parse_args(argv)
    if args.supervise_qq:
        supervise_qq()
        return 0
    try:
        runtime = Path("/runtime")
        if args.preflight:
            preflight(runtime, Path.home())
        elif args.verify:
            verify(runtime)
        else:
            install(runtime)
    except BootstrapError as error:
        print("QQAGENT_BOOTSTRAP " + str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError):
        print("QQAGENT_BOOTSTRAP INPUT_UNREADABLE", file=sys.stderr)
        return 1
    print("QQAGENT_STATIC_INTEGRITY_OK napcat=" + NAPCAT_VERSION + " qq=" + QQ_VERSION)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
