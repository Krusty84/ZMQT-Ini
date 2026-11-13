/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { cborLogPayload } from "./cbor";

export function renderIntegrationTest(
  commands: Readonly<Record<string, readonly string[]>>,
  pattern: string,
  bindRole: string,
  cbor = false,
): string {
  const payload = cbor ? cborLogPayload : '{"value": 42}';
  return `import json
import os
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import deque
from contextlib import ExitStack
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMMANDS = ${JSON.stringify(commands)}
PATTERN = ${JSON.stringify(pattern)}
BIND_ROLE = ${JSON.stringify(bindRole)}
OBSERVERS = {"req-rep": "req", "pub-sub": "sub", "push-pull": "pull"}


def remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise TimeoutError("Integration test deadline exceeded")
    return seconds


class Application:
    def __init__(self, role, config, run_id, resources):
        self.role = role
        self.lines = queue.Queue()
        self.tail = deque(maxlen=100)
        self.stderr = resources.enter_context(tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace"))
        command = list(COMMANDS[role])
        if command[0] == "python":
            command[0] = sys.executable
        self.process = subprocess.Popen(
            [*command, "--config", str(config)], cwd=ROOT,
            env={**os.environ, "ZMQT_TEST_RUN_ID": run_id},
            stdout=subprocess.PIPE, stderr=self.stderr, text=True, encoding="utf-8",
        )
        resources.callback(self.process.stdout.close)
        self.reader = threading.Thread(target=self.capture, daemon=True)
        self.reader.start()

    def capture(self):
        try:
            for line in self.process.stdout:
                self.tail.append(line.rstrip())
                self.lines.put(line)
        finally:
            self.lines.put(None)

    def expect(self, predicate, description, deadline):
        while True:
            try:
                line = self.lines.get(timeout=remaining(deadline))
            except queue.Empty as error:
                raise TimeoutError(f"{self.role} did not emit {description}") from error
            if line is None:
                raise AssertionError(f"{self.role} closed stdout before {description}")
            event = json.loads(line)
            if not isinstance(event, dict) or not isinstance(event.get("event"), str):
                raise AssertionError(f"{self.role} emitted an invalid event")
            if predicate(event):
                return

    def report(self):
        self.stderr.seek(0)
        print(f"[{self.role}] exit {self.process.returncode}", file=sys.stderr)
        for line in self.tail:
            print(line, file=sys.stderr)
        print(self.stderr.read(), end="", file=sys.stderr)


def stop(apps, deadline):
    for app in apps.values():
        if app.process.poll() is None:
            app.process.terminate()
    for app in apps.values():
        try:
            app.process.wait(timeout=max(0, min(1, deadline - time.monotonic())))
        except subprocess.TimeoutExpired:
            app.process.kill()
            app.process.wait()
        app.reader.join()


def test_config(path, timeout_case):
    config = json.loads((ROOT / "config" / "zmq.json").read_text(encoding="utf-8"))
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        config.update(bindHost="127.0.0.1", connectHost="127.0.0.1", port=probe.getsockname()[1])
        timeout_ms = 350 if timeout_case else 3000
        config["socketOptions"].update(sendTimeoutMs=timeout_ms, receiveTimeoutMs=timeout_ms, lingerMs=0)
        path.write_text(json.dumps(config), encoding="utf-8")


def matches_message(event, run_id):
    message_id = event.get("id")
    if PATTERN == "req-rep":
        return (event.get("event") == "RESPONSE_RECEIVED" and message_id == f"{run_id}-0001"
                and event.get("type") == "response" and event.get("payload") == ${payload})

    prefix = f"{run_id}-"
    if not isinstance(message_id, str) or not message_id.startswith(prefix):
        return False
    sequence = message_id[len(prefix):]
    if not (sequence.isascii() and sequence.isdecimal() and sequence.strip("0")):
        return False

    if PATTERN == "pub-sub":
        return (event.get("event") == "MESSAGE_RECEIVED" and event.get("type") == "event"
                and event.get("runId") == run_id and event.get("payload") == {"runId": run_id, ${payload.slice(1, -1)}})
    return (event.get("event") == "TASK_PROCESSED" and event.get("type") == "task"
            and event.get("payload") == ${payload} and event.get("result") == "processed")


def run_case(timeout_case=False):
    deadline = time.monotonic() + 10
    run_id = "test-" + uuid.uuid4().hex
    apps = {}
    with tempfile.TemporaryDirectory() as temporary, ExitStack() as resources:
        config = Path(temporary) / "zmq.json"
        test_config(config, timeout_case)

        def start(role):
            app = Application(role, config, run_id, resources)
            apps[role] = app
            app.expect(lambda event: event["event"] == "READY", "READY", deadline)
            return app

        try:
            try:
                if timeout_case:
                    req = start("req")
                    req.expect(lambda event: event["event"] in {"SEND_TIMEOUT", "RECEIVE_TIMEOUT"}, "a timeout", deadline)
                    req.process.wait(timeout=remaining(deadline))
                else:
                    start(BIND_ROLE)
                    start(next(role for role in COMMANDS if role != BIND_ROLE))
                    observer = apps[OBSERVERS[PATTERN]]
                    observer.expect(lambda event: matches_message(event, run_id), "a verified message", deadline)
                    if PATTERN == "req-rep":
                        observer.process.wait(timeout=remaining(deadline))
            finally:
                stop(apps, deadline)

            expected = 1 if timeout_case else 0
            for app in apps.values():
                if app.process.returncode != expected:
                    raise AssertionError(f"{app.role} exited with {app.process.returncode}, expected {expected}")
        except BaseException:
            for app in apps.values():
                app.report()
            raise


if __name__ == "__main__":
    run_case()
    if PATTERN == "req-rep":
        run_case(timeout_case=True)
    print("Integration test passed")
`;
}
