# -*- coding: utf-8 -*-
"""开发模式启动垫片（重建版适配层）。

原版开发模式下，Electron 主进程会执行 `python python/api.py` 启动后端，
并以 stdout 中出现 "Uvicorn running on" 作为就绪标记（electron/src/python-server.js）。

重建版后端是 Node.js 服务（server/index.js）。本垫片保持主进程源码零改动：
以子进程拉起 Node 后端并继承 stdio，使主进程看到与原版一致的启动输出。

可用环境变量：
    KNOWLY_BACKEND_CMD  覆盖默认的 node 命令（默认 "node"）
"""

import os
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVER_ENTRY = PROJECT_ROOT / "server" / "index.js"


def main() -> int:
    if not SERVER_ENTRY.exists():
        print(f"ERROR:    后端入口不存在: {SERVER_ENTRY}", flush=True)
        return 1

    node = os.environ.get("KNOWLY_BACKEND_CMD", "node")
    cmd = [node, str(SERVER_ENTRY)]

    env = dict(os.environ)
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")

    try:
        proc = subprocess.run(cmd, env=env, cwd=str(PROJECT_ROOT))
        return proc.returncode
    except FileNotFoundError:
        print("ERROR:    未找到 node 可执行文件（重建版后端需要 Node.js >= 20）。", flush=True)
        print('ERROR:    可设置 KNOWLY_BACKEND_CMD 指向 node 的完整路径。', flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
