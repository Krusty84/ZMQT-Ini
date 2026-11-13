/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const pythonAdvanced = (cbor: boolean) => String.raw`
import threading

from message_codec import ${cbor ? "INVALID, decode, " : ""}encode, validate_message


def _subtree(value):
    return type(value) is str and (value == "" or re.fullmatch(r"/(?:[^/\0]+/)+", value))


def _advanced_config(spec):
    parser = argparse.ArgumentParser(exit_on_error=False)
    parser.add_argument("--config", type=Path, default=Path(__file__).resolve().parent / "config" / "zmq.json")
    config = ${cbor ? "decode_json" : "decode"}(parser.parse_args().config.read_bytes())
    fields = {"bindHost", "connectHost", "port", "socketOptions"}
    if spec["timed"]:
        fields.add("maxAgeMs")
    if spec["program"].startswith("clone"):
        fields.add("subtree")
    if "binaryStarTransitions" in spec:
        fields.add("backup")
    if type(config) is not dict or config.keys() != fields:
        raise ValueError("Invalid runtime configuration")

    groups = [config]
    if "backup" in config:
        backup = config["backup"]
        if type(backup) is not dict or backup.keys() != {"bindHost", "connectHost", "port"}:
            raise ValueError("Invalid backup configuration")
        groups.append(backup)
    for group in groups:
        _check_host(group["bindHost"], connect=False)
        _check_host(group["connectHost"], connect=True)
        group["port"] = _bounded_int(group["port"], 1, 65536 - spec["portCount"])
    if "maxAgeMs" in config:
        config["maxAgeMs"] = _bounded_int(config["maxAgeMs"], 1, 600000)
    if "subtree" in config and not _subtree(config["subtree"]):
        raise ValueError("Invalid subtree")

    _validate_socket_options(config["socketOptions"])
    return config


def _wall_ms():
    return time.time_ns() // 1000000


def _clock_ms():
    return time.monotonic_ns() // 1000000


def _number(value):
    return value.to_bytes(8, "big")


def _from_number(frame):
    if len(frame) != 8:
        raise ValueError("Expected an eight-byte number")
    return int.from_bytes(frame, "big")


class _Advanced:
    def __init__(self, spec, config):
        self.spec = spec
        self.config = config
        self.options = config["socketOptions"]
        self.context = zmq.Context()
        self.poller = zmq.Poller()
        self.sockets = {}
        self.definitions = {definition["name"]: definition for definition in spec["sockets"]}
        self.threads = []
        self.stopping = False
        self.status = 0
        self.log_lock = threading.Lock()

    def log(self, event, **data):
        with self.log_lock:
            print(json.dumps({"event": event, **data}, ensure_ascii=True, separators=(",", ":")${cbor ? ", default=log_bytes" : ""}), flush=True)

    def fail(self, event):
        with self.log_lock:
            if self.status == 0:
                print(json.dumps({"event": event}, separators=(",", ":")), flush=True)
            self.status = 1
            self.stopping = True

    def open_socket(self, definition):
        sock = self.context.socket(getattr(zmq, definition["type"]))
        try:
            for name, (option, _, _) in _OPTIONS.items():
                if name not in self.options:
                    continue
                if (name == "lingerMs" or (name.startswith("send") and definition["send"])
                        or (name.startswith("receive") and definition["receive"]) or name in definition["tcpOptions"]):
                    sock.setsockopt(option, int(self.options[name]))
            if definition.get("verbose"):
                sock.setsockopt(zmq.XPUB_VERBOSE, 1)
            if definition["type"] == "ROUTER":
                sock.setsockopt(zmq.ROUTER_MANDATORY, 1)
            if definition["name"] == "peerOut" and "immediate" not in self.options:
                sock.setsockopt(zmq.IMMEDIATE, 1)
            subscription = definition.get("subscriptions")
            if subscription == "all":
                sock.setsockopt(zmq.SUBSCRIBE, b"")
            elif subscription == "subtree":
                prefix = self.config["subtree"].encode()
                sock.setsockopt(zmq.SUBSCRIBE, prefix)
                if prefix:
                    sock.setsockopt(zmq.SUBSCRIBE, b"HUGZ")

            if definition["target"] == "inproc":
                getattr(sock, definition["mode"])(definition["endpoint"])
            else:
                group = self.config["backup"] if definition["target"] == "backup" else self.config
                port = group["port"] + definition["offset"]
                if definition["mode"] == "bind":
                    _bind(sock, group["bindHost"], port)
                else:
                    host = _addresses(group["connectHost"], port)[0]
                    sock.connect(_endpoint(sock, host, port))
            return sock
        except BaseException:
            sock.close(0)
            raise

    def open(self, name):
        definition = self.definitions[name]
        if name in self.sockets:
            old = self.sockets.pop(name)
            if definition["receive"]:
                self.poller.unregister(old)
            old.close(0)
        sock = self.open_socket(definition)
        self.sockets[name] = sock
        if definition["receive"]:
            self.poller.register(sock, zmq.POLLIN)

    def send(self, name, frames, wait=False):
        sock = self.sockets[name]
        deadline = _clock_ms() + self.options["sendTimeoutMs"]
        while not self.stopping:
            try:
                sock.send_multipart(frames, flags=zmq.DONTWAIT)
                return True
            except zmq.ZMQError as error:
                if error.errno == zmq.EHOSTUNREACH:
                    return False
                if error.errno != zmq.EAGAIN:
                    raise
                remaining = deadline - _clock_ms()
                if not wait or remaining <= 0:
                    return False
                sock.poll(min(20, remaining), zmq.POLLOUT)
        return False

    def loop(self, receive, tick=lambda: None):
        while not self.stopping:
            tick()
            ready = dict(self.poller.poll(20))
            for name, sock in list(self.sockets.items()):
                if not self.stopping and sock in ready and self.sockets.get(name) is sock:
                    receive(name, sock.recv_multipart())


def run_advanced(spec_json, program):
    spec = json.loads(spec_json)
    try:
        config = _advanced_config(spec)
    except (argparse.ArgumentError, OSError, ValueError):
        print('{"event":"CONFIG_ERROR"}', flush=True)
        return 1
    runtime = _Advanced(spec, config)

    def stop(_signum, _frame):
        runtime.stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    error_event = "TRANSPORT_ERROR"
    try:
        for name, definition in runtime.definitions.items():
            if "worker" not in definition:
                error_event = "BIND_ERROR" if definition["mode"] == "bind" else "TRANSPORT_ERROR"
                runtime.open(name)
        error_event = "TRANSPORT_ERROR"
        program(runtime)
    except (OSError, zmq.ZMQError):
        if not runtime.stopping:
            runtime.fail(error_event)
    finally:
        runtime.stopping = True
        for thread in runtime.threads:
            thread.join()
        for sock in reversed(runtime.sockets.values()):
            sock.close()
        runtime.context.term()
    if runtime.status == 0:
        runtime.log("SHUTDOWN")
    return runtime.status
`;

export const pythonStream = (cbor: boolean) => String.raw`

def _handle_event(runtime, frames, worker=None):
    timed = runtime.spec["timed"]
    try:
        if len(frames) != (3 if timed else 2):
            raise ValueError("Wrong event frame count")
        topic = frames[0].decode("utf-8")
        message = decode(frames[-1])
        if not validate_message(message, ("event",)):
            raise ValueError("Invalid event ${cbor ? "CBOR" : "JSON"}")
        sent_at = _from_number(frames[1]) if timed else None
    except ValueError:
        runtime.log("PROTOCOL_ERROR")
        return
    if timed and _wall_ms() - sent_at > runtime.config["maxAgeMs"]:
        runtime.fail("SUBSCRIBER_TOO_SLOW")
        return
    # Process a validated application event here. Workers can run this concurrently.
    data = {"topic": topic, "id": message["id"], "payload": message["payload"]}
    if worker is not None:
        data["worker"] = worker
    runtime.log("MESSAGE_RECEIVED", **data)


def _stream_worker(runtime, definition, started):
    try:
        with runtime.open_socket(definition) as sock:
            started.set()
            while not runtime.stopping:
                if sock.poll(20, zmq.POLLIN):
                    _handle_event(runtime, sock.recv_multipart(), definition["worker"])
    except (OSError, zmq.ZMQError):
        if not runtime.stopping:
            runtime.fail("TRANSPORT_ERROR")
    finally:
        started.set()


def _stream_proxy(runtime):
    cache = {} if runtime.spec["cache"] else None
    capture = "captureOut" in runtime.sockets

    def trace(direction, frames):
        if capture:
            runtime.send("captureOut", [direction, *frames])

    def receive(name, frames):
        if name == "captureIn":
            runtime.log("CAPTURE", direction=frames[0].decode(),
                        frames=[frame.hex() for frame in frames[1:]])
        elif name == "upstream":
            trace(b"publication", frames)
            if cache is not None and len(frames) == (3 if runtime.spec["timed"] else 2):
                cache[frames[0]] = frames
            runtime.send("downstream", frames)
        elif len(frames) == 1 and frames[0][:1] in (b"\0", b"\1"):
            trace(b"subscription", frames)
            if cache is None:
                runtime.send("upstream", frames)
            elif frames[0][0] == 1:
                prefix = frames[0][1:]
                for topic, saved in cache.items():
                    if topic.startswith(prefix):
                        replay = [topic, _number(_wall_ms()), saved[-1]] if runtime.spec["timed"] else saved
                        trace(b"replay", replay)
                        runtime.send("downstream", replay)

    if cache is not None:
        runtime.send("upstream", [b"\1"], wait=True)
    runtime.log("READY")
    runtime.loop(receive)


def stream_program(runtime):
    program = runtime.spec["program"]
    if program == "proxy":
        _stream_proxy(runtime)
    elif program == "subscribe":
        for definition in runtime.definitions.values():
            if "worker" in definition:
                started = threading.Event()
                thread = threading.Thread(target=_stream_worker, args=(runtime, definition, started))
                thread.start()
                runtime.threads.append(thread)
                started.wait()
        if runtime.stopping:
            return
        runtime.log("READY")
        if runtime.spec["workers"]:
            def dispatch(_name, frames):
                if not runtime.send("dispatch", frames, wait=True) and not runtime.stopping:
                    runtime.log("SEND_TIMEOUT")
            runtime.loop(dispatch)
        else:
            runtime.loop(lambda _name, frames: _handle_event(runtime, frames))
    else:
        runtime.log("READY")
        sequence = 0
        next_send = 0

        def publish():
            nonlocal sequence, next_send
            now = _clock_ms()
            if now < next_send:
                return
            next_send = now + 100
            sequence += 1
            # Replace the example topic and payload with your application data.
            frames = [b"demo/a" if sequence % 2 else b"demo/b"]
            if runtime.spec["timed"]:
                frames.append(_number(_wall_ms()))
${cbor ? `            event = encode({"id": f"event-{sequence}", "type": "event", "payload": telemetry_payload()})
            if event is INVALID:
                runtime.fail("PROTOCOL_ERROR")
                return
            frames.append(event)` : `            frames.append(encode({"id": f"event-{sequence}", "type": "event", "payload": {"value": 42}}))`}
            runtime.send("stream", frames)

        runtime.loop(lambda _name, _frames: None, publish)
`;
