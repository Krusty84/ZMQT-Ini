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
from tempfile import TemporaryDirectory
from threading import Thread

import zmq


def check_invalid_socket_options(command):
    runtime = json.loads(Path("config/zmq.json").read_text(encoding="utf-8"))
    with TemporaryDirectory() as directory:
        path = Path(directory) / "zmq.json"
        for overrides in (
            {"maxFrameBytes": 2147483648}, {"maxFrameBytes": None},
            {"heartbeatIntervalMs": 0}, {"reconnectMaxIntervalMs": 1},
            {"handshakeTimeoutMs": -1},
            {"immediate": 0},
            {"unknownOption": 1},
        ):
            invalid = dict(runtime, socketOptions=runtime["socketOptions"] | overrides)
            path.write_text(json.dumps(invalid), encoding="utf-8")
            child = subprocess.run([*command, "--config", str(path)], capture_output=True, text=True, timeout=5)
            assert child.returncode == 1 and json.loads(child.stdout)["event"] == "CONFIG_ERROR", child


def check_handshake_timeout(port):
    with socket.create_connection(("127.0.0.1", port), timeout=4) as stalled:
        while stalled.recv(64):
            pass


def request_socket(context, address, ipv6):
    peer = context.socket(zmq.REQ)
    peer.setsockopt(zmq.LINGER, 0)
    peer.setsockopt(zmq.SNDTIMEO, 2000)
    peer.setsockopt(zmq.RCVTIMEO, 2000)
    peer.setsockopt(zmq.IPV6, int(ipv6))
    peer.connect(address)
    return peer


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
    host = f"[{peer_host}]" if ipv6 else peer_host
    address = f"tcp://{host}:{runtime['port']}"

    with subprocess.Popen(command, stdout=subprocess.PIPE, text=True, encoding="utf-8") as child:
        try:
            first_line = Queue()
            Thread(target=lambda: first_line.put(child.stdout.readline()), daemon=True).start()
            assert json.loads(first_line.get(timeout=5))["event"] == "READY"

            with zmq.Context() as context, request_socket(context, address, ipv6) as peer:
                peer.send_json({"id": "recover", "type": "other", "payload": None})
                assert peer.recv_json() == {"id": "recover", "type": "error", "payload": {"code": "INVALID_MESSAGE"}}

                peer.send(br'{"id":"next","type":"request","payload":["\ud83e\uddea",null,9007199254740993]}')
                assert peer.recv_json() == {
                    "id": "next", "type": "response", "payload": ["🧪", None, 9007199254740992],
                }

                if invalid_frame is None:
                    check_handshake_timeout(runtime["port"])
                    peer.send_json({
                        "id": "oversized", "type": "request",
                        "payload": "x" * runtime["socketOptions"]["maxFrameBytes"],
                    })
                    assert not peer.poll(1000), "REP accepted an oversized frame"
                    with request_socket(context, address, ipv6) as fresh:
                        fresh.send_json({"id": "after-limit", "type": "request", "payload": 42})
                        assert fresh.recv_json() == {"id": "after-limit", "type": "response", "payload": 42}
                    return

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
    check_invalid_socket_options(sys.argv[1:])
    check_rep(sys.argv[1:], "127.0.0.1", "127.0.0.1", False, None)
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
