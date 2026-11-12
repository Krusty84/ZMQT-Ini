# SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
# SPDX-License-Identifier: MIT

"""Test the generated applications with independent ZeroMQ peers."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import runpy
import shlex
import signal
import struct
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

import zmq


smoke = runpy.run_path("tests/integration_test.py")
Project, free_ports, commands = (smoke[name] for name in ("Project", "free_ports", "COMMANDS"))
strict_rep = Path(__file__).resolve().parents[1] / "generated-project-ci" / "strict_rep.py"
socket_option_checks = runpy.run_path(str(strict_rep))
runtime_path = Path("config/zmq.json")
config = json.loads(runtime_path.read_text(encoding="utf-8"))
port_count = smoke["PORT_COUNT"]
config["port"] = free_ports(port_count * (2 if "backup" in config else 1))
if "backup" in config:
    config["backup"]["port"] = config["port"] + port_count


def socket(context, kind, offset, *, bind=False, subscribe=None):
    peer = context.socket(kind)
    peer.linger = 0
    if subscribe is not None:
        peer.subscribe(subscribe)
    address = "tcp://127.0.0.1:" + str(config["port"] + offset)
    (peer.bind if bind else peer.connect)(address)
    return peer


def receive(peer, matches=lambda _frames: True, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not peer.poll(max(0, int((deadline - time.monotonic()) * 1000))):
            break
        frames = peer.recv_multipart()
        if matches(frames):
            return frames
    raise AssertionError("Expected ZeroMQ message")


def stream(topic, event_id, timestamp=None):
    body = json.dumps({"id": event_id, "type": "event", "payload": {"value": 7}}).encode()
    return [topic, body] if timestamp is None else [topic, struct.pack("!Q", timestamp), body]


def delivery(project, app, event_id):
    return project.wait(app, lambda event: event.get("event") == "MESSAGE_RECEIVED" and
                        event.get("id") == event_id)


def espresso(project, context):
    proxy = project.start("proxy")
    producer = socket(context, zmq.XPUB, 0)
    watcher = socket(context, zmq.SUB, 1, subscribe=b"quotes/")
    assert receive(producer) == [b"\1quotes/"]
    frames = stream(b"quotes/ask", "trace")
    producer.send_multipart(frames)
    assert receive(watcher) == frames
    for direction, expected in (("subscription", [b"\1quotes/"]), ("publication", frames)):
        project.wait(proxy, lambda event: event.get("event") == "CAPTURE" and
                     event["direction"] == direction and event["frames"] == [part.hex() for part in expected])
    watcher.unsubscribe(b"quotes/")
    assert receive(producer) == [b"\0quotes/"]
    project.wait(proxy, lambda event: event.get("event") == "CAPTURE" and
                 event["direction"] == "subscription" and event["frames"] == [b"\0quotes/".hex()])


def last_value(project, context, timed):
    project.start("proxy")
    producer = socket(context, zmq.XPUB, 0)
    observer = socket(context, zmq.SUB, 1, subscribe=b"")
    assert receive(producer) == [b"\1"]
    if timed:
        socket_option_checks["check_handshake_timeout"](config["port"])
        limit = config["socketOptions"]["maxFrameBytes"]
        oversized = json.dumps({"id": "oversized", "type": "event", "payload": "x" * limit}).encode()
        producer.send_multipart([b"quotes/oversized", struct.pack("!Q", time.time_ns() // 1_000_000), oversized])
        assert not observer.poll(1000), "Proxy forwarded an oversized frame"
        producer.close()
        producer = socket(context, zmq.XPUB, 0)
        assert receive(producer) == [b"\1"]
    old = time.time_ns() // 1_000_000 - 60_000 if timed else None
    for frames in (stream(b"quotes/ask", "old", old),
                   stream(b"quotes/ask", "latest", old),
                   stream(b"quotes/bid", "other-topic", old)):
        deadline = time.monotonic() + 5
        while True:
            producer.send_multipart(frames)
            try:
                assert receive(observer, lambda value: value == frames, timeout=0.1) == frames
                break
            except AssertionError:
                if time.monotonic() >= deadline:
                    raise
    producer.close()
    late = socket(context, zmq.SUB, 1, subscribe=b"quotes/a")
    replay = receive(late)
    assert replay[0] == b"quotes/ask" and json.loads(replay[-1])["id"] == "latest"
    assert receive(observer, lambda value: value[0] == replay[0] and value[-1] == replay[-1]) == replay
    assert not late.poll(100)
    second = socket(context, zmq.SUB, 1, subscribe=b"quotes/a")
    repeated = receive(second)
    assert repeated[0] == replay[0] and repeated[-1] == replay[-1]
    assert receive(late) == repeated
    if timed:
        assert struct.unpack("!Q", replay[1])[0] > old
        sub = project.start("sub")
        delivery(project, sub, "latest")
        delivery(project, sub, "other-topic")


def suicidal_snail(project, context, sub_binds):
    producer = socket(context, zmq.XPUB, 0, bind=not sub_binds)
    sub = project.start("sub")
    assert receive(producer) == [b"\1"]
    producer.send_multipart(stream(b"demo/a", "malformed"))
    project.wait(sub, lambda event: event.get("event") == "PROTOCOL_ERROR")
    producer.send_multipart(stream(b"demo/a", "fresh", time.time_ns() // 1_000_000))
    delivery(project, sub, "fresh")
    producer.send_multipart(stream(b"demo/a", "expired", time.time_ns() // 1_000_000 - 60_000))
    project.wait(sub, lambda event: event.get("event") == "SUBSCRIBER_TOO_SLOW")
    assert sub.wait(timeout=3) == 1
    assert not any(source is sub and event.get("id") == "expired" for source, event in project.history)


def chp(key, sequence, uuid=b"", properties=b"", value=b""):
    return [key, struct.pack("!Q", sequence), uuid, properties, value]


def snapshot(dealer, subtree):
    dealer.send_multipart([b"ICANHAZ?", subtree])
    rows = []
    while True:
        frames = receive(dealer)
        assert len(frames) == 5 and len(frames[1]) == 8 and frames[2:4] == [b"", b""]
        if frames[0] == b"KTHXBAI":
            assert frames[4] == subtree
            assert all(row[1] <= frames[1] for row in rows)
            return rows, struct.unpack("!Q", frames[1])[0]
        rows.append(frames)


def generated_clone_server(project, context):
    server = project.start("server")
    dealer = socket(context, zmq.DEALER, 0)
    subscriber = socket(context, zmq.SUB, 1, subscribe=b"")
    writer = socket(context, zmq.XPUB, 2)
    assert receive(writer) == [b"\1"]
    assert receive(subscriber) == chp(b"HUGZ", 0)
    assert snapshot(dealer, b"/stocks/") == ([], 0)

    writer.send_multipart([b"malformed", b"wrong frame count"])
    project.wait(server, lambda event: event.get("event") == "PROTOCOL_ERROR")

    other_key = b"/other/key"
    other_uuid = uuid4().bytes
    writer.send_multipart(chp(other_key, 0, other_uuid, value=b"keep"))
    assert receive(subscriber, lambda frames: frames[0] == other_key) == chp(other_key, 1, other_uuid, value=b"keep")

    key, value, identity = b"/stocks/quote", b"\0\xff", uuid4().bytes
    writer.send_multipart(chp(key, 0, identity, b"ttl=2\n", value))
    assert receive(subscriber, lambda frames: frames[0] == key) == chp(key, 2, identity, b"ttl=2\n", value)
    assert snapshot(dealer, b"/stocks/") == ([chp(key, 2, value=value)], 2)
    assert receive(subscriber, lambda frames: frames[0] == key) == chp(key, 3)
    assert snapshot(dealer, b"/stocks/") == ([], 3)

    writer.send_multipart(chp(other_key, 0, uuid4().bytes))
    assert receive(subscriber, lambda frames: frames[0] == other_key)[4] == b""
    assert snapshot(dealer, b"") == ([], 4)


def generated_clone_client(project, context):
    router = socket(context, zmq.ROUTER, 0, bind=True)
    publisher = socket(context, zmq.XPUB, 1, bind=True)
    collector = socket(context, zmq.SUB, 2, bind=True, subscribe=b"")
    app = project.start("client")
    subtree = b"/stocks/"
    # This sequence exceeds the integer range that JSON numbers can preserve.
    sequence = (1 << 53) + 3
    key = subtree + b"quote"

    def request():
        identity, command, prefix = receive(router)
        assert command == b"ICANHAZ?" and prefix == subtree
        return identity

    identity = request()
    assert receive(publisher, lambda frames: frames == [b"\1" + subtree]) == [b"\1" + subtree]
    router.send_multipart([identity, *chp(key, sequence, value=b"\0\xff")])
    publisher.send_multipart(chp(key, sequence + 1, value=b"\0\xfe"))
    router.send_multipart([identity, *chp(b"KTHXBAI", sequence, value=subtree)])
    project.wait(app, lambda event: event.get("event") == "CLONE_SNAPSHOT" and
                 event["sequence"] == str(sequence) and event["size"] == 1)
    project.wait(app, lambda event: event.get("event") == "CLONE_UPDATE" and
                 event["sequence"] == str(sequence + 1) and event["valueHex"] == "00fe")

    # The generated client refreshes once after it confirms the SUB pipe is live.
    identity = request()
    router.send_multipart([identity, *chp(key, sequence + 1, value=b"\0\xfe")])
    router.send_multipart([identity, *chp(b"KTHXBAI", sequence + 1, value=subtree)])
    project.wait(app, lambda event: event.get("event") == "CLONE_SNAPSHOT" and event["sequence"] == str(sequence + 1))

    publisher.send_multipart(chp(subtree + b"stale", sequence + 1, value=b"stale"))
    publisher.send_multipart(chp(key, sequence + 2))
    project.wait(app, lambda event: event.get("event") == "CLONE_UPDATE" and
                 event["sequence"] == str(sequence + 2) and event["valueHex"] == "")
    assert not any(event.get("key") == "/stocks/stale" for _, event in project.history)
    write = receive(collector)
    assert write[:2] == [subtree + b"demo", bytes(8)] and len(write[2]) == 16 and write[3:] == [b"", b"42"]


def launcher_failover(project):
    original = runtime_path.read_text(encoding="utf-8")
    runtime_path.write_text(json.dumps(config), encoding="utf-8")
    if commands["server"][0] == "python":
        venv_python = Path(".venv/bin/python")
        venv_python.parent.mkdir(parents=True, exist_ok=True)
        venv_python.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + ' "$@"\n', encoding="utf-8")
        venv_python.chmod(0o755)
    commands["launcher"] = ["bash", "./run.sh"]
    try:
        launcher = project.start("launcher")
        project.wait(launcher, lambda event: event.get("event") == "REPLICA_SYNCED" and event.get("role") == "backup")
        project.wait(launcher, lambda event: event.get("event") == "CLONE_WRITE_CONFIRMED" or
                     (event.get("event") == "CLONE_UPDATE" and event["valueHex"] == "3432"))
        server_entry = commands["server"][-1]
        processes = subprocess.check_output(["ps", "-Ao", "pid=,ppid=,args="], text=True)
        rows = [line.split(maxsplit=2) for line in processes.splitlines()]
        candidates = [int(row[0]) for row in rows if len(row) == 3 and
                      int(row[1]) == launcher.pid and server_entry in row[2].split()]
        assert len(candidates) == 1, candidates
        os.kill(candidates[0], signal.SIGTERM)
        project.wait(launcher, lambda event: event.get("event") == "CLONE_SNAPSHOT" and
                     event["server"] == 1 and event["size"] > 0)
        assert launcher.poll() is None
    finally:
        runtime_path.write_text(original, encoding="utf-8")


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as directory, zmq.Context() as context:
        path = Path(directory) / "zmq.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        project = Project(path)
        try:
            yield project, context
        finally:
            project.close()


def binary_star_immediate():
    peer_offset = config["backup"]["port"] + 3 - config["port"]
    for immediate in (True, False):
        with fixture() as (project, context):
            settings = dict(config, socketOptions=config["socketOptions"] | {"immediate": immediate})
            project.config.write_text(json.dumps(settings), encoding="utf-8")
            project.start("server")
            # The server sends a STATE each second while the peer is unavailable.
            time.sleep(2.2)
            peer = socket(context, zmq.ROUTER, peer_offset, bind=True)
            assert receive(peer)[1] == b"STATE"
            queued = bool(peer.poll(250))
            assert queued == (not immediate), (immediate, queued)


def main(variant):
    if variant == "all-stream":
        command = [sys.executable if part == "python" else part for part in commands["proxy"]]
        socket_option_checks["check_invalid_socket_options"](command)
    if variant == "clone":
        for check in (generated_clone_server, generated_clone_client):
            with fixture() as (project, context):
                check(project, context)
        return
    if variant == "binary-star":
        binary_star_immediate()
    with fixture() as (project, context):
        if variant == "espresso":
            espresso(project, context)
        elif variant in ("last-value-caching", "espresso-cache", "all-stream"):
            last_value(project, context, variant == "all-stream")
        elif variant in ("suicidal-snail", "snail-black-box"):
            suicidal_snail(project, context, variant == "snail-black-box")
        elif variant == "binary-star":
            launcher_failover(project)


if __name__ == "__main__":
    main(sys.argv[1])
