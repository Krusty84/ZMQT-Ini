/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { cborLogPayload } from "./cbor";

export function renderAdvancedIntegration(
  commands: Readonly<Record<string, readonly string[]>>,
  extensions: readonly string[],
  portCount: number,
  cbor = false,
) {
  return String.raw`import contextlib
import json
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time

COMMANDS = json.loads('${JSON.stringify(commands)}')
EXTENSIONS = ${JSON.stringify(extensions)}
PORT_COUNT = ${portCount}


def free_ports(count):
    for _ in range(64):
        with contextlib.ExitStack() as sockets:
            first = sockets.enter_context(socket.socket())
            first.bind(("127.0.0.1", 0))
            port = first.getsockname()[1]
            if port + count - 1 > 65535:
                continue
            try:
                for offset in range(1, count):
                    extra = sockets.enter_context(socket.socket())
                    extra.bind(("127.0.0.1", port + offset))
            except OSError:
                continue
            return port
    raise RuntimeError("No consecutive loopback ports available")


class Project:
    def __init__(self, config):
        self.config = config
        self.events = queue.Queue()
        self.processes = []
        self.history = []

    def start(self, role):
        command = [sys.executable if part == "python" else part for part in COMMANDS[role]]
        app = subprocess.Popen([*command, "--config", str(self.config)], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding="utf-8")
        self.processes.append(app)

        def read():
            for line in app.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    event = {"output": line.rstrip()}
                self.events.put((app, event))
            self.events.put((app, {"exit": app.wait()}))

        threading.Thread(target=read, daemon=True).start()
        self.wait(app, lambda event: event.get("event") == "READY")
        return app

    def wait(self, app, condition, timeout=20):
        deadline = time.monotonic() + timeout
        while True:
            for source, event in self.history:
                if source is app and condition(event):
                    return event
            if any(source is app and "exit" in event for source, event in self.history):
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                self.history.append(self.events.get(timeout=min(remaining, 0.1)))
            except queue.Empty:
                continue
        raise AssertionError("Expected event from " + str(app.args) + ": " +
                             repr([event for source, event in self.history if source is app][-20:]))

    def close(self):
        for app in self.processes:
            if app.poll() is None:
                app.terminate()
        for app in self.processes:
            try:
                app.wait(timeout=3)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait()


def main():
    config = json.loads(Path("config/zmq.json").read_text(encoding="utf-8"))
    replicas = "binary-star" in EXTENSIONS
    port = free_ports(PORT_COUNT * (2 if replicas else 1))
    config.update(bindHost="127.0.0.1", connectHost="127.0.0.1", port=port)
    if replicas:
        config["backup"] = dict(bindHost="127.0.0.1", connectHost="127.0.0.1", port=port + PORT_COUNT)
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "zmq.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        project = Project(path)
        try:
            apps = {role: project.start(role) for role in COMMANDS}
            if "clone" in EXTENSIONS:
                client = apps["client"]
                project.wait(client, lambda event: event.get("event") == "CLONE_SNAPSHOT" and event["server"] == 0)
                project.wait(client, lambda event: event.get("event") == "CLONE_WRITE_CONFIRMED" or
                             (event.get("event") == "CLONE_UPDATE" and event["valueHex"] == "3432"))
                if replicas:
                    project.wait(apps["backup"], lambda event: event.get("event") == "REPLICA_SYNCED")
                    apps["server"].terminate()
                    apps["server"].wait(timeout=3)
                    project.wait(client, lambda event: event.get("event") == "CLONE_SNAPSHOT" and
                                 event["server"] == 1 and event["size"] > 0)
                    restored = project.start("server")
                    project.wait(restored, lambda event: event.get("event") == "REPLICA_SYNCED")
            else:
                sub = apps["sub"]
                project.wait(sub, lambda event: event.get("event") == "MESSAGE_RECEIVED"${cbor ? ` and event.get("payload") == ${cborLogPayload}` : ""})
                if "black-box" in EXTENSIONS:
                    for worker in (1, 2):
                        project.wait(sub, lambda event: event.get("event") == "MESSAGE_RECEIVED" and
                                     event.get("worker") == worker)
                if "espresso" in EXTENSIONS:
                    for direction in ("publication", "subscription"):
                        project.wait(apps["proxy"], lambda event: event.get("event") == "CAPTURE" and
                                     event["direction"] == direction)
        finally:
            project.close()


if __name__ == "__main__":
    main()
`;
}
