/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { pythonAdapter } = require("../../dist/adapters/python/adapter.js");
const { assembleProject } = require("../../dist/artifacts/assemble.js");
const { planProject } = require("../../dist/planning/build.js");

function pythonPlan() {
  const result = planProject({
    schemaVersion: "1.0",
    project: { name: "python-adapter-test", language: "python" },
    messaging: {
      pattern: "req-rep",
      transport: "tcp",
      bindRole: "rep",
      bindHost: "zmqt-bind.example",
      connectHost: "zmqt-connect.example",
      port: 49123,
    },
    socketOptions: {
      sendHwm: 123456,
      receiveHwm: 234567,
      sendTimeoutMs: 345678,
      receiveTimeoutMs: 456789,
      lingerMs: 5,
    },
  });
  assert.equal(result.ok, true);
  return result.value;
}

test("Python artifacts are complete, virtual, and reproducible", () => {
  const plan = pythonPlan();
  const result = assembleProject(plan, pythonAdapter);
  assert.equal(result.ok, true);
  assert.deepEqual(result, assembleProject(plan, pythonAdapter));
  const { manifest, files } = result.value;
  assert.equal(manifest.language, "python");
  assert.equal(manifest.irVersion, "1.0");
  assert.deepEqual(
    files.map(({ path }) => path),
    [
      "README.md",
      "app_rep.py",
      "app_req.py",
      "config/zmq.json",
      "message_codec.py",
      "requirements.txt",
      "tests/integration_test.py",
      "zmqt_runtime.py",
    ],
  );
  assert.deepEqual(
    files.filter(({ executable }) => executable).map(({ path }) => path),
    ["app_rep.py", "app_req.py"],
  );
  assert.equal(
    files.find(({ path }) => path === "requirements.txt").content,
    "pyzmq==27.3.0\n",
  );
  const runtime = JSON.parse(
    files.find(({ path }) => path === "config/zmq.json").content,
  );
  assert.deepEqual(runtime, {
    bindHost: "zmqt-bind.example",
    connectHost: "zmqt-connect.example",
    port: 49123,
    socketOptions: {
      lingerMs: 5,
      sendHwm: 123456,
      sendTimeoutMs: 345678,
      receiveHwm: 234567,
      receiveTimeoutMs: 456789,
    },
  });
  for (const file of files) {
    assert.equal(file.encoding, "utf-8");
    assert.ok(!file.content.includes("\r"));
    if (file.path.startsWith("app_")) {
      for (const value of [
        runtime.bindHost,
        runtime.connectHost,
        runtime.port,
        123456,
        234567,
        345678,
        456789,
      ]) {
        assert.ok(!file.content.includes(String(value)));
      }
    }
  }
  files[0].content = "changed";
  assert.notEqual(
    assembleProject(plan, pythonAdapter).value.files[0].content,
    "changed",
  );
});

test("assembly rejects unsupported IR before emitting and rejects unsafe output paths", () => {
  const plan = pythonPlan();
  const denied = {
    ...pythonAdapter,
    capabilities: () => ({
      ...pythonAdapter.capabilities(),
      operations: ["stop"],
    }),
    generate: () => assert.fail("Invalid IR reached the adapter"),
  };
  const result = assembleProject(plan, denied);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(({ code }) => code === "IR_UNSUPPORTED_OPERATION"),
  );

  const unsafe = {
    ...pythonAdapter,
    generate: () => [
      {
        path: "../escape",
        content: "test",
        encoding: "utf-8",
        executable: false,
      },
      {
        path: "readme.md",
        content: "test",
        encoding: "utf-8",
        executable: false,
      },
    ],
  };
  const rejected = assembleProject(plan, unsafe);
  assert.equal(rejected.ok, false);
  const codes = rejected.diagnostics.map(({ code }) => code);
  assert.ok(codes.includes("INVALID_ARTIFACT_PATH"));
  assert.ok(codes.includes("DUPLICATE_ARTIFACT_PATH"));
});

test("assembly rejects incomplete, conflicting, or malformed artifacts", () => {
  const plan = pythonPlan();
  const adapter = {
    ...pythonAdapter,
    generate: () =>
      pythonAdapter
        .generate(plan)
        .filter(({ path }) => path !== "message_codec.py")
        .map((file) =>
          file.path === "app_req.py" ? { ...file, executable: false } : file,
        )
        .concat({
          path: "config",
          content: "file used as directory",
          encoding: "utf-8",
          executable: false,
        }),
    generateRuntimeConfig: () => [
      {
        path: "config/zmq.json",
        content: "{}",
        encoding: "utf-8",
        executable: false,
      },
    ],
    generateReadme: () => ({
      path: "README.md",
      content: "{{ UNRENDERED }}\ud800",
      encoding: "utf-8",
      executable: false,
    }),
  };
  const result = assembleProject(plan, adapter);
  assert.equal(result.ok, false);
  const codes = result.diagnostics.map(({ code }) => code);
  for (const code of [
    "MISSING_ARTIFACT",
    "ARTIFACT_PATH_CONFLICT",
    "INVALID_ARTIFACT_MODE",
    "INVALID_RUNTIME_ARTIFACT",
    "UNRESOLVED_ARTIFACT_PLACEHOLDER",
    "INVALID_ARTIFACT_ENCODING",
  ])
    assert.ok(codes.includes(code), code);
  assert.deepEqual(
    result.diagnostics.find(({ code }) => code === "MISSING_ARTIFACT").params,
    { path: "message_codec.py" },
  );
});

test("assembly enforces the exact aggregate UTF-8 byte limit", () => {
  const plan = pythonPlan();
  const base = assembleProject(plan, pythonAdapter).value;
  const readme = base.files.find(({ path }) => path === "README.md");
  const spare =
    2_097_152 -
    base.files.reduce(
      (bytes, { content }) => bytes + Buffer.byteLength(content),
      0,
    );
  const filler = "🧪".repeat(Math.floor(spare / 4)) + "x".repeat(spare % 4);
  const adapter = {
    ...pythonAdapter,
    generateReadme: () => ({ ...readme, content: readme.content + filler }),
  };
  assert.equal(assembleProject(plan, adapter).ok, true);
  const result = assembleProject(plan, {
    ...adapter,
    generateReadme: () => ({
      ...readme,
      content: readme.content + filler + "x",
    }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.find(({ code }) => code === "ARTIFACT_SIZE_LIMIT")
      .params,
    { maxBytes: 2_097_152 },
  );
});
