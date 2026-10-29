"""只读 NapCat 部署诊断；不启动组件，不读取配置、日志、账号或二维码。"""

import json
from pathlib import Path
import subprocess

SERVICE_COMMAND = (
    "systemctl", "show", "qq-agent-napcat.service",
    "--property=ActiveState,SubState,UnitFileState",
)
CONTAINER_COMMAND = (
    "docker", "container", "inspect", "qq-agent-napcat", "--format",
    '{"status":{{json .State.Status}},"running":{{json .State.Running}},'
    '"exit_code":{{json .State.ExitCode}},"read_only":{{json .HostConfig.ReadonlyRootfs}},'
    '"tmpfs":{{json .HostConfig.Tmpfs}},"mounts":{{json .Mounts}}}',
)
LISTEN_COMMAND = ("ss", "-H", "-ltn")


def query(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout if result.returncode == 0 else None


def diagnose(run=query, data=Path("/var/lib/qq-agent-napcat")):
    report = {
        "mode": "read-only", "runtime_loaded": "unknown",
        "note": "进程与监听端口不证明 NapCat 加载、账号登录或版本兼容。",
    }
    service = run(SERVICE_COMMAND)
    allowed = {
        "ActiveState": {"active", "inactive", "failed", "activating", "deactivating"},
        "SubState": {"running", "dead", "failed", "start", "stop"},
        "UnitFileState": {"enabled", "disabled", "static", "masked", "not-found"},
    }
    report["service"] = {key: "unknown" for key in allowed}
    for line in (service or "").splitlines():
        key, _, value = line.partition("=")
        if key in allowed and value in allowed[key]:
            report["service"][key] = value
    container = run(CONTAINER_COMMAND)
    report["container"] = {"available": False}
    if container:
        try:
            info = json.loads(container)
            if not isinstance(info, dict):
                raise ValueError
            tmpfs = info.get("tmpfs") or {}
            mounts = info.get("mounts") or []
            status = info.get("status")
            report["container"] = {
                "available": True,
                "status": status if status in ("created", "running", "paused", "restarting", "exited", "dead", "removing") else "unknown",
                "running": info.get("running") if type(info.get("running")) is bool else None,
                "exit_code": info.get("exit_code") if type(info.get("exit_code")) is int else None,
                "read_only": info.get("read_only") if type(info.get("read_only")) is bool else None,
                "logs_tmpfs": isinstance(tmpfs, dict) and "/runtime/napcat/logs" in tmpfs,
                "writable_mounts": {
                    target: any(isinstance(mount, dict) and mount.get("Destination") == target
                                and mount.get("RW") is True for mount in mounts)
                    for target in ("/home/qqruntime", "/runtime/napcat/config", "/runtime/napcat/cache")
                },
            }
        except (ValueError, TypeError):
            report["container"] = {"available": False}
    listeners = run(LISTEN_COMMAND)
    ports = (13700, 13701, 13801)
    report["listening"] = {str(port): None if listeners is None else False for port in ports}
    for line in (listeners or "").splitlines():
        columns = line.split()
        if len(columns) > 3:
            for port in ports:
                if columns[3].endswith(":" + str(port)):
                    report["listening"][str(port)] = True
    report["data_directories"] = {}
    for name in ("home", "config", "cache"):
        try:
            path = data / name
            value = path.stat()
            report["data_directories"][name] = {
                "exists": path.is_dir(), "uid": value.st_uid, "gid": value.st_gid,
                "mode": oct(value.st_mode & 0o777),
            }
        except OSError:
            report["data_directories"][name] = {"exists": False}
    return report


if __name__ == "__main__":
    print(json.dumps(diagnose(), ensure_ascii=False, indent=2))
