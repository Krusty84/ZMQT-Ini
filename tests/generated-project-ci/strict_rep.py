#
# SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
# SPDX-License-Identifier: MIT
#

import json
from pathlib import Path
from queue import Queue
import socket
import subprocess
import sys
from threading import Thread

import zmq


def check_rep(command, bind_host, peer_host, ipv6, invalid_frame):
    config_path = Path("config/zmq.json")
    runtime = json.loads(config_path.read_text(encoding="utf-8"))
    family = socket.AF_INET6 if ipv6 else socket.AF_INET
    with socket.socket(family) as reserve:
        reserve.bind((peer_host, 0))
        runtime["port"] = reserve.getsockname()[1]
    runtime["bindHost"] = bind_host
    runtime["connectHost"] = peer_host
    config_path.write_text(json.dumps(runtime), encoding="utf-8")

    with subprocess.Popen(command, stdout=subprocess.PIPE, text=True, encoding="utf-8") as child:
        try:
            first_line = Queue()
            Thread(target=lambda: first_line.put(child.stdout.readline()), daemon=True).start()
            assert json.loads(first_line.get(timeout=5))["event"] == "READY"

            with zmq.Context() as context, context.socket(zmq.REQ) as peer:
                peer.setsockopt(zmq.LINGER, 0)
                peer.setsockopt(zmq.SNDTIMEO, 2000)
                peer.setsockopt(zmq.RCVTIMEO, 2000)
                peer.setsockopt(zmq.IPV6, int(ipv6))
                address = f"[{peer_host}]" if ipv6 else peer_host
                peer.connect(f"tcp://{address}:{runtime['port']}")
                peer.send_json({"id": "recover", "type": "other", "payload": None})
                assert peer.recv_json() == {"id": "recover", "type": "error", "payload": {"code": "INVALID_MESSAGE"}}

                peer.send(br'{"id":"next","type":"request","payload":["\ud83e\uddea",null,9007199254740993]}')
                assert peer.recv_json() == {
                    "id": "next", "type": "response", "payload": ["🧪", None, 9007199254740992],
                }

                if isinstance(invalid_frame, tuple):
                    peer.send_multipart(invalid_frame)
                else:
                    peer.send(invalid_frame)
                assert child.wait(timeout=3) == 1, invalid_frame
                assert any(json.loads(line)["event"] == "PROTOCOL_ERROR" for line in child.stdout)
        finally:
            if child.poll() is None:
                child.kill()


if __name__ == "__main__":
    for invalid in (
        b'{"payload":', b'{"id":"bad","type":"request","payload":{"x":1,"x":2}}',
        b'{"id":"bad","type":"request","payload":1e400}',
        br'{"id":"bad","type":"request","payload":"\ud800"}',
        b'{"id":"bad","type":"request","payload":"\xff"}',
        b'\xef\xbb\xbf{"id":"bad","type":"request","payload":null}',
        b'{"id":"bad","type":"request","payload":null}\x00trailing',
        (b'{"id":"bad","type":"request","payload":null}', b"extra frame"),
    ):
        check_rep(sys.argv[1:], "localhost", "127.0.0.1", False, invalid)
    check_rep(sys.argv[1:], "::1", "::1", True, b"{")
