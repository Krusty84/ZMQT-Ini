# SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
# SPDX-License-Identifier: MIT

"""Exercise the generated wire protocol with independent PyZMQ peers."""

from contextlib import ExitStack, contextmanager
from io import BytesIO
import json
from pathlib import Path
import runpy
import struct
import sys
import tempfile
import time

import cbor2
import zmq


SMOKE = runpy.run_path("tests/integration_test.py")
DEMO = {"deviceId": "sensor-01", "samples": b"\x00\xff"}
LIMIT = 2**53 - 1
PAYLOAD = {"samples": [b"\xff\x00", b""], "meta": ["температура", True, None, -LIMIT, LIMIT, 0.5]}
LOG_PAYLOAD = dict(PAYLOAD, samples=["ff00", ""])


@contextmanager
def exchange():
    with tempfile.TemporaryDirectory() as directory, ExitStack() as resources, zmq.Context() as context:
        path = Path(directory) / "zmq.json"
        if "Project" in SMOKE:
            config = json.loads(Path("config/zmq.json").read_text(encoding="utf-8"))
            config["port"] = SMOKE["free_ports"](SMOKE["PORT_COUNT"])
            path.write_text(json.dumps(config), encoding="utf-8")
            project = SMOKE["Project"](path)
            resources.callback(project.close)
            start = project.start

            def wait(app, predicate, _name):
                project.wait(app, predicate, timeout=5)
        else:
            SMOKE["test_config"](path, False)
            config = json.loads(path.read_text(encoding="utf-8"))
            apps = {}

            def wait(app, predicate, name):
                app.expect(predicate, name, time.monotonic() + 5)

            def start(role):
                app = SMOKE["Application"](role, path, "wire", resources)
                apps[role] = app
                resources.callback(SMOKE["stop"], {role: app}, time.monotonic() + 30)
                wait(app, lambda event: event.get("event") == "READY", "READY")
                return app

        def expect(app, name, **fields):
            wait(app, lambda event: event.get("event") == name and
                 all(event.get(key) == value for key, value in fields.items()), name)

        try:
            yield context, config["port"], start, expect
        except BaseException:
            if "Project" not in SMOKE:
                for app in apps.values():
                    app.report()
            raise


def socket(context, kind, port, *, bind=False, subscribe=None):
    peer = context.socket(kind)
    peer.linger = 0
    peer.sndtimeo = 3000
    if subscribe is not None:
        peer.subscribe(subscribe)
    (peer.bind if bind else peer.connect)(f"tcp://127.0.0.1:{port}")
    return peer


def receive(peer):
    assert peer.poll(5000), "Expected ZeroMQ message"
    return peer.recv_multipart()


def unpack(frame):
    stream = BytesIO(frame)
    value = cbor2.load(stream, read_size=1, allow_duplicate_keys=False)
    assert not stream.read(1), "Extra data after the CBOR item"
    return value


def message(kind, payload=PAYLOAD, message_id="peer"):
    return {"id": message_id, "type": kind, "payload": payload}


def check_demo(body, kind):
    value = unpack(body)
    assert value == message(kind, DEMO, value["id"])
    assert isinstance(value["id"], str) and value["id"]
    return value["id"]


def request_reply():
    with exchange() as (context, port, start, expect):
        app = start("rep")
        requester = socket(context, zmq.REQ, port)
        requester.send(cbor2.dumps(message("other", None, "recover")))
        reply, = receive(requester)
        assert unpack(reply) == message("error", {"code": "INVALID_MESSAGE"}, "recover")
        requester.send(cbor2.dumps(message("request")))
        reply, = receive(requester)
        assert unpack(reply) == message("response")
        requester.send(b"\xa1")
        expect(app, "PROTOCOL_ERROR")
        assert app.process.wait(timeout=3) == 1

    with exchange() as (context, port, start, expect):
        replier = socket(context, zmq.REP, port, bind=True)
        app = start("req")
        frame, = receive(replier)
        message_id = check_demo(frame, "request")
        replier.send(cbor2.dumps(message("response", PAYLOAD, message_id)))
        expect(app, "RESPONSE_RECEIVED", id=message_id, payload=LOG_PAYLOAD)
        assert app.process.wait(timeout=3) == 0


def publish_subscribe():
    with exchange() as (context, port, start, _expect):
        start("pub")
        subscriber = socket(context, zmq.SUB, port, subscribe=b"")
        frame, = receive(subscriber)
        # The test harness supplies a run identifier for the generated PUB demo.
        value = unpack(frame)
        assert value == message("event", dict(DEMO, runId="wire"), value["id"])

    with exchange() as (context, port, start, expect):
        publisher = socket(context, zmq.XPUB, port, bind=True)
        app = start("sub")
        assert receive(publisher) == [b"\x01"]
        publisher.send(cbor2.dumps(message("event")))
        expect(app, "MESSAGE_RECEIVED", id="peer", payload=LOG_PAYLOAD)


def push_pull():
    with exchange() as (context, port, start, _expect):
        start("push")
        consumer = socket(context, zmq.PULL, port)
        frame, = receive(consumer)
        check_demo(frame, "task")

    with exchange() as (context, port, start, expect):
        producer = socket(context, zmq.PUSH, port, bind=True)
        app = start("pull")
        valid = cbor2.dumps(message("task"))
        # Replace the last value of a valid envelope with an invalid CBOR value.
        envelope = cbor2.dumps(message("task", None))[:-1]
        for frames in (
            [valid[:-1]], [valid + b"\xf6"], [valid, b"extra frame"],
            [envelope + bytes.fromhex("a261780178017802")],  # Duplicate text key with different encodings.
            [envelope + bytes.fromhex("a161fff6")],  # Invalid UTF-8 text key.
            [envelope + bytes.fromhex("7f61c361a9ff")],  # UTF-8 split across text chunks.
        ):
            producer.send_multipart(frames)
            expect(app, "PROTOCOL_ERROR")
        for payload in ({1: "numeric key"}, float("nan"), float("inf"), LIMIT + 1, -LIMIT - 1,
                        -(2**64), cbor2.CBORTag(55799, b"\xff")):
            producer.send(cbor2.dumps(message("task", payload)))
            expect(app, "PROTOCOL_ERROR")
        producer.send(envelope + bytes.fromhex("5f410041ffff"))
        expect(app, "TASK_PROCESSED", id="peer", payload="00ff", result="processed")
        producer.send(valid)
        expect(app, "TASK_PROCESSED", id="peer", payload=LOG_PAYLOAD, result="processed")


def timestamp():
    return time.time_ns() // 1_000_000


def stream_packet(sent_at):
    return [b"quotes/ask", struct.pack("!Q", sent_at), cbor2.dumps(message("event"))]


def outgoing_stream(proxy):
    with exchange() as (context, port, start, _expect):
        if proxy:
            start("proxy")
        start("pub")
        watcher = socket(context, zmq.SUB, port + proxy, subscribe=b"demo/")
        topic, sent_at, body = receive(watcher)
        assert topic in (b"demo/a", b"demo/b")
        assert abs(timestamp() - struct.unpack("!Q", sent_at)[0]) < 5000
        check_demo(body, "event")


def suicidal_snail():
    outgoing_stream(False)
    with exchange() as (context, port, start, expect):
        publisher = socket(context, zmq.XPUB, port, bind=True)
        sub = start("sub")
        assert receive(publisher) == [b"\x01"]
        frames = stream_packet(timestamp())
        publisher.send_multipart([*frames[:-1], frames[-1][:-1]])
        expect(sub, "PROTOCOL_ERROR")
        publisher.send_multipart(stream_packet(timestamp()))
        expect(sub, "MESSAGE_RECEIVED", id="peer", topic="quotes/ask", payload=LOG_PAYLOAD)
        publisher.send_multipart(stream_packet(timestamp() - 60_000))
        expect(sub, "SUBSCRIBER_TOO_SLOW")
        assert sub.wait(timeout=3) == 1


def all_stream():
    outgoing_stream(True)
    with exchange() as (context, port, start, expect):
        proxy = start("proxy")
        publisher = socket(context, zmq.XPUB, port)
        assert receive(publisher) == [b"\x01"]
        observer = socket(context, zmq.SUB, port + 1, subscribe=b"quotes/")
        expect(proxy, "CAPTURE", direction="subscription", frames=[b"\x01quotes/".hex()])
        frames = stream_packet(timestamp() - 60_000)
        publisher.send_multipart(frames)
        assert receive(observer) == frames
        expect(proxy, "CAPTURE", direction="publication", frames=[frame.hex() for frame in frames])
        late = socket(context, zmq.SUB, port + 1, subscribe=b"quotes/a")
        topic, sent_at, body = receive(late)
        assert topic == frames[0] and body == frames[-1]
        assert struct.unpack("!Q", sent_at)[0] > struct.unpack("!Q", frames[1])[0]
        sub = start("sub")
        expect(sub, "MESSAGE_RECEIVED", id="peer", topic="quotes/ask", payload=LOG_PAYLOAD)


if __name__ == "__main__":
    checks = {
        "req-rep": request_reply, "pub-sub": publish_subscribe, "push-pull": push_pull,
        "suicidal-snail": suicidal_snail, "all-stream": all_stream,
    }
    checks[sys.argv[1]]()
