/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const imports = String.raw`import argparse
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import signal
import socket as tcp
import time

import zmq

from message_codec import decode


`;

const pollSlice = String.raw`_POLL_SLICE_MS = 50
`;

const validation = String.raw`_OPTIONS = {
    "sendHwm": (zmq.SNDHWM, 1, 1000000),
    "receiveHwm": (zmq.RCVHWM, 1, 1000000),
    "sendTimeoutMs": (zmq.SNDTIMEO, 1, 600000),
    "receiveTimeoutMs": (zmq.RCVTIMEO, 1, 600000),
    "lingerMs": (zmq.LINGER, 0, 60000),
}


def _address(host):
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        return None


def _check_host(host, connect):
    if type(host) is not str or "%" in host:
        raise ValueError("Invalid host")
    if host == "*":
        if connect:
            raise ValueError("Connect requires a destination")
        return

    address = _address(host)
    if address is not None:
        mapped = getattr(address, "ipv4_mapped", None)
        if connect and (address.is_unspecified or (mapped is not None and mapped.is_unspecified)):
            raise ValueError("Connect requires a destination")
        return

    name = host.removesuffix(".")
    labels = name.split(".")
    if (len(name) > 253 or re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]*)", labels[-1], re.I | re.ASCII)
            or not all(re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", label, re.I | re.ASCII)
                       for label in labels)):
        raise ValueError("Invalid host")


def _bounded_int(value, minimum, maximum):
    if type(value) not in (int, float) or not minimum <= value <= maximum or value != int(value):
        raise ValueError("Invalid integer option")
    return int(value)


`;

const singleSocketConfig = String.raw`def _load_config():
    parser = argparse.ArgumentParser(exit_on_error=False)
    parser.add_argument("--config", type=Path, default=Path(__file__).resolve().parent / "config" / "zmq.json")
    config = decode(parser.parse_args().config.read_bytes())
    if type(config) is not dict or config.keys() != {"bindHost", "connectHost", "port", "socketOptions"}:
        raise ValueError("Invalid runtime configuration")
    _check_host(config["bindHost"], connect=False)
    _check_host(config["connectHost"], connect=True)
    config["port"] = _bounded_int(config["port"], 1, 65535)

    options = config["socketOptions"]
    if type(options) is not dict or options.keys() != _OPTIONS.keys():
        raise ValueError("Invalid socket options")
    for name, (_, minimum, maximum) in _OPTIONS.items():
        options[name] = _bounded_int(options[name], minimum, maximum)
    return config


`;

const endpoints = String.raw`def _addresses(host, port):
    if host == "*" or _address(host) is not None:
        return [host]
    records = tcp.getaddrinfo(host, port, type=tcp.SOCK_STREAM)
    records.sort(key=lambda record: record[0] != tcp.AF_INET)
    addresses = list(dict.fromkeys(record[4][0] for record in records))
    if not addresses:
        raise OSError("No usable address")
    return addresses


def _endpoint(sock, host, port):
    ipv6 = ":" in host
    sock.setsockopt(zmq.IPV6, int(ipv6))
    address = f"[{host}]" if ipv6 else host
    return f"tcp://{address}:{port}"


def _bind(sock, host, port):
    for address in _addresses(host, port):
        try:
            sock.bind(_endpoint(sock, address, port))
            return
        except zmq.ZMQError:
            pass
    raise OSError("Could not bind any address")


`;

const singleSocketRuntime = String.raw`class _Runtime:
    def __init__(self):
        self.stopping = False
        self.run_id = os.environ.get("ZMQT_TEST_RUN_ID") or None
        self.sequence = 0

    def next_id(self):
        self.sequence += 1
        return f"{self.run_id or 'msg'}-{self.sequence:04d}"

    def example_payload(self, include_test_run_id):
        payload = {"value": 42}
        if include_test_run_id and self.run_id is not None:
            payload["runId"] = self.run_id
        return payload

    def log(self, event, data=None):
        entry = {"event": event}
        if data is not None:
            entry.update(data)
            payload = data["payload"]
            if event == "MESSAGE_RECEIVED" and type(payload) is dict and "runId" in payload:
                entry["runId"] = payload["runId"]
        print(json.dumps(entry, ensure_ascii=True, allow_nan=False, separators=(",", ":")), flush=True)

    def _transfer(self, operation, events, timeout_ms):
        # sendTimeoutMs or receiveTimeoutMs limits the wait for one operation.
        # Poll in short intervals to check for shutdown.
        deadline = time.monotonic() + timeout_ms / 1000
        try:
            while not self.stopping:
                try:
                    return "ok", operation()
                except zmq.Again:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return "timeout", None
                    self.socket.poll(min(_POLL_SLICE_MS, math.ceil(remaining * 1000)), events)
                    if not self.stopping and time.monotonic() >= deadline:
                        return "timeout", None
        except zmq.ZMQError:
            if not self.stopping:
                return "error", None
        return "shutdown", None

    def send(self, frame):
        outcome, _ = self._transfer(lambda: self.socket.send(frame, flags=zmq.DONTWAIT),
                                    zmq.POLLOUT, self.options["sendTimeoutMs"])
        return outcome

    def receive(self):
        outcome, frames = self._transfer(lambda: self.socket.recv_multipart(flags=zmq.DONTWAIT),
                                         zmq.POLLIN, self.options["receiveTimeoutMs"])
        frame = frames[0] if frames is not None and len(frames) == 1 else None
        return outcome, frame

    def wait(self, milliseconds):
        deadline = time.monotonic() + milliseconds / 1000
        while not self.stopping:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return "ok"
            time.sleep(min(_POLL_SLICE_MS / 1000, remaining))
        return "shutdown"


def _cleanup(context, sock, linger):
    # lingerMs limits how long pending sends can stay queued after socket close.
    # Close the socket before terminating its context.
    try:
        if sock is not None:
            try:
                sock.setsockopt(zmq.LINGER, linger)
            finally:
                sock.close()
    finally:
        if context is not None:
            context.term()


def run(socket_type, mode, active_options, subscription, behavior):
    # Use your application's configuration, logger, and shutdown hook here.
    runtime = _Runtime()

    def stop(_signum, _frame):
        runtime.stopping = True

    # Register these signal handlers on the main thread.
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        config = _load_config()
    except (argparse.ArgumentError, OSError, ValueError):
        # Use CONFIG_ERROR when startup settings cannot be read or validated.
        runtime.log("CONFIG_ERROR")
        return 1

    options = config["socketOptions"]
    context = None
    sock = None
    result = 1
    # Socket setup, connect, and I/O failures use TRANSPORT_ERROR.
    error_event = "TRANSPORT_ERROR"
    try:
        context = zmq.Context()
        sock = context.socket(getattr(zmq, socket_type))
        runtime.socket = sock
        runtime.options = options
        # Apply the role's options before bind or connect.
        # sendHwm and receiveHwm limit the number of queued messages.
        for name in active_options:
            sock.setsockopt(_OPTIONS[name][0], options[name])
        # An empty SUB prefix matches every message.
        if subscription is not None:
            sock.setsockopt_string(zmq.SUBSCRIBE, subscription)

        port = config["port"]
        if mode == "bind":
            # Report a failure to open the local endpoint as BIND_ERROR.
            error_event = "BIND_ERROR"
            _bind(sock, config["bindHost"], port)
        else:
            host = _addresses(config["connectHost"], port)[0]
            sock.connect(_endpoint(sock, host, port))

        error_event = "TRANSPORT_ERROR"
        runtime.log("READY")
        result = 0 if runtime.stopping else behavior(runtime)
    except (OSError, zmq.ZMQError):
        if not runtime.stopping:
            runtime.log(error_event)
        else:
            result = 0
    finally:
        try:
            _cleanup(context, sock, options["lingerMs"])
        except zmq.ZMQError:
            runtime.log("TRANSPORT_ERROR")
            result = 1

    if runtime.stopping:
        runtime.log("SHUTDOWN")
    return result
`;

export const pythonRuntime =
  imports +
  pollSlice +
  validation +
  singleSocketConfig +
  endpoints +
  singleSocketRuntime;

export const pythonAdvancedBase =
  imports +
  validation +
  endpoints;
