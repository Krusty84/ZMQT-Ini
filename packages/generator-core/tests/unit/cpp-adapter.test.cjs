/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { cppAdapter } = require("../../dist/adapters/cpp/adapter.js");
const { assembleProject } = require("../../dist/artifacts/assemble.js");
const { planProject } = require("../../dist/planning/build.js");

function project(bindRole) {
  const plan = planProject({
    schemaVersion: "2.0",
    project: { name: "cpp-adapter-test", language: "cpp" },
    messaging: {
      pattern: "pub-sub",
      transport: "tcp",
      bindRole,
      bindHost: "zmqt-bind.example",
      connectHost: "zmqt-connect.example",
      port: 49123,
    },
    socketOptions: {
      sendHwm: 17,
      receiveHwm: 19,
      sendTimeoutMs: 71,
      receiveTimeoutMs: 79,
      lingerMs: 5,
    },
  });
  assert.equal(plan.ok, true);
  const result = assembleProject(plan.value, cppAdapter);
  assert.equal(result.ok, true);
  assert.deepEqual(result, assembleProject(plan.value, cppAdapter));
  return Object.fromEntries(
    result.value.files.map(({ path, content }) => [path, content]),
  );
}

test("C++ emits two virtual entry points, runtime config, and pinned C++23 builds", () => {
  const files = project("pub");
  assert.deepEqual(Object.keys(files), [
    "CMakeLists.txt",
    "README.md",
    "app_pub.cpp",
    "app_sub.cpp",
    "build.ps1",
    "build.sh",
    "config/zmq.json",
    "message_codec.cpp",
    "message_codec.hpp",
    "run.ps1",
    "run.sh",
    "tests/integration_test.py",
    "zmqt_runtime.cpp",
    "zmqt_runtime.hpp",
  ]);
  const cmake = files["CMakeLists.txt"];
  assert.match(cmake, /CXX_STANDARD 23/);
  for (const version of ["4.11.0", "4.3.5", "3.12.0"])
    assert.ok(cmake.includes(version));
  assert.equal(
    [...cmake.matchAll(/URL_HASH SHA256=[0-9a-f]{64}\b/g)].length,
    3,
  );
  for (const script of ["build", "run"]) {
    assert.ok(files[`${script}.ps1`].includes(`wsl.exe --cd "$PSScriptRoot" --exec bash ./${script}.sh`));
  }

  assert.match(files["app_pub.cpp"], /zmq::socket_type::pub, true/);
  assert.match(files["app_sub.cpp"], /zmq::socket_type::sub, false/);
  const connectOptions = '"reconnectIntervalMs", "reconnectMaxIntervalMs", "immediate", ';
  assert.ok(files["app_sub.cpp"].includes(connectOptions));
  const reversed = project("sub");
  assert.equal(
    reversed["app_pub.cpp"],
    files["app_pub.cpp"]
      .replace("socket_type::pub, true", "socket_type::pub, false")
      .replace('"heartbeatIntervalMs"', connectOptions + '"heartbeatIntervalMs"'),
  );
  assert.equal(
    reversed["app_sub.cpp"],
    files["app_sub.cpp"]
      .replace("socket_type::sub, false", "socket_type::sub, true")
      .replace(connectOptions, ""),
  );

  const config = JSON.parse(files["config/zmq.json"]);
  assert.equal(config.bindHost, "zmqt-bind.example");
  assert.equal(config.connectHost, "zmqt-connect.example");
  assert.equal(config.port, 49123);
  for (const path of ["app_pub.cpp", "app_sub.cpp", "zmqt_runtime.cpp"]) {
    assert.doesNotMatch(files[path], /zmqt-(bind|connect)\.example|49123/);
  }
});
