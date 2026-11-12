/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { before, test } = require("node:test");

const { core, createProject, orientations } = require("./project.cjs");

const python = process.env.ZMQT_PYTHON || "python3";

before(() => {
  const { languageVersion, libraryVersion } = core
    .getCapabilities()
    .languages.find(({ id }) => id === "python");
  const actual = execFileSync(
    python,
    [
      "-c",
      "import platform, zmq; print(platform.python_version(), zmq.__version__)",
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(
    actual,
    `${languageVersion} ${libraryVersion}`,
    "Set ZMQT_PYTHON to the interpreter with the pinned PyZMQ version.",
  );
});

for (const [pattern, bindRole] of orientations) {
  test(`generated Python ${pattern}, ${bindRole} binds`, (t) => {
    const cwd = createProject(t, "python", pattern, bindRole);
    execFileSync(python, ["tests/integration_test.py"], {
      cwd,
      timeout: 25_000,
      encoding: "utf8",
    });
    if (bindRole === "rep") {
      for (const [script, role] of [["strict_rep.py", "rep"], ["immediate.py", "req"]]) {
        execFileSync(python, [join(__dirname, script), python, `app_${role}.py`], {
          cwd,
          timeout: 35_000,
          encoding: "utf8",
        });
      }
    }
  });
}

test("generated Python codec rejects invalid UTF-8, duplicate keys, non-finite numbers and lone surrogates", (t) => {
  const cwd = createProject(t, "python", "req-rep", "rep");
  execFileSync(
    python,
    [
      "-c",
      String.raw`
from message_codec import INVALID, decode, encode, validate_message

for invalid in (
    b'"\xff"', b'{"payload":{"x":1,"x":2}}', b'{"x":NaN}', b'{"x":1e400}',
    br'{"x":"\ud800"}', br'{"\udc00":0}',
):
    assert decode(invalid) is INVALID, invalid

value = decode(br'{"id":"msg-0001","type":"request","payload":{"pair":"\ud83e\uddea","number":9007199254740993}}')
assert value['payload'] == {'pair': '🧪', 'number': 9007199254740992}
assert validate_message(value, ('request',), 'msg-0001')
assert not validate_message(dict(value, extra=1), ('request',))
assert not validate_message(dict(value, id=''), ('request',))
assert decode(encode(value)) == value
`,
    ],
    { cwd, timeout: 5000 },
  );
});

for (const [label, host, local, family] of [
  ["Bind DNS", "localhost", "127.0.0.1", "AF_INET"],
  ["IPv6", "::1", "::1", "AF_INET6"],
]) {
  test(`generated Python REP recovers an invalid request and echoes payload over ${label}`, (t) => {
    const cwd = createProject(t, "python", "req-rep", "rep", [host, local]);
    execFileSync(
      python,
      [
        "-c",
        `
import json
import pathlib
import socket
import subprocess
import sys

import zmq

host = ${JSON.stringify(local)}
family = socket.${family}
config = pathlib.Path('config/zmq.json')
runtime = json.loads(config.read_text())
with socket.socket(family) as reserve:
    reserve.bind((host, 0))
    runtime['port'] = reserve.getsockname()[1]
config.write_text(json.dumps(runtime))

with subprocess.Popen([sys.executable, 'app_rep.py'], stdout=subprocess.PIPE, text=True) as child:
    try:
        assert json.loads(child.stdout.readline())['event'] == 'READY'
        with zmq.Context() as context, context.socket(zmq.REQ) as peer:
            peer.setsockopt(zmq.LINGER, 0)
            peer.setsockopt(zmq.SNDTIMEO, 2000)
            peer.setsockopt(zmq.RCVTIMEO, 2000)
            if family == socket.AF_INET6:
                peer.setsockopt(zmq.IPV6, 1)
            address = '[' + host + ']' if ':' in host else host
            peer.connect(f"tcp://{address}:{runtime['port']}")
            peer.send_json({'id':'recover', 'type':'other', 'payload':None})
            assert peer.recv_json() == {'id':'recover', 'type':'error', 'payload':{'code':'INVALID_MESSAGE'}}
            payload = ['🧪', None, {'value': 42}]
            peer.send_json({'id':'next', 'type':'request', 'payload':payload})
            assert peer.recv_json() == {'id':'next', 'type':'response', 'payload':payload}
            peer.send(b'{"payload":')
            assert child.wait(timeout=3) == 1
    finally:
        if child.poll() is None:
            child.kill()
`,
      ],
      { cwd, timeout: 10_000, encoding: "utf8" },
    );
  });
}
