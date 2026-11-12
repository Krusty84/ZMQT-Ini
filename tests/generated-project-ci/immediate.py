#
# SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
# SPDX-License-Identifier: MIT
#

import json
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory


def check_timeout(command, path, runtime, expected):
    path.write_text(json.dumps(runtime), encoding="utf-8")
    child = subprocess.run([*command, "--config", str(path)], capture_output=True, text=True, timeout=5)
    events = [json.loads(line)["event"] for line in child.stdout.splitlines()]
    assert child.returncode == 1 and events == ["READY", expected], (expected, child)


command = sys.argv[1:]
runtime = json.loads(Path("config/zmq.json").read_text(encoding="utf-8"))
options = runtime["socketOptions"]
options.update(sendTimeoutMs=400, receiveTimeoutMs=400, handshakeTimeoutMs=3000, lingerMs=0)

with TemporaryDirectory() as directory, socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    runtime.update(connectHost="127.0.0.1", port=listener.getsockname()[1])
    path = Path(directory) / "zmq.json"
    for immediate, expected in ((True, "SEND_TIMEOUT"), (False, "RECEIVE_TIMEOUT"), (None, "RECEIVE_TIMEOUT")):
        if immediate is None:
            options.pop("immediate")
        else:
            options["immediate"] = immediate
        check_timeout(command, path, runtime, expected)

    # TCP can now connect. The listener sends no ZMTP greeting.
    listener.listen()
    options["immediate"] = True
    expected = "RECEIVE_TIMEOUT" if Path(command[0]).name == "java" else "SEND_TIMEOUT"
    check_timeout(command, path, runtime, expected)
