/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { cppAdapter } = require("../../dist/adapters/cpp/adapter.js");
const { javaAdapter } = require("../../dist/adapters/java/adapter.js");
const { nodeAdapter } = require("../../dist/adapters/node/adapter.js");
const { pythonAdapter } = require("../../dist/adapters/python/adapter.js");
const { assembleProject } = require("../../dist/artifacts/assemble.js");
const { planProject } = require("../../dist/planning/build.js");

function projectPlan(adapter, pattern = "req-rep", bindRole = "rep", serialization) {
  const result = planProject({
    schemaVersion: "2.0",
    project: { name: "output-validator-test", language: adapter.id },
    messaging: {
      pattern,
      ...(serialization && { serialization }),
      transport: "tcp",
      bindRole,
      bindHost: "127.0.0.1",
      connectHost: "127.0.0.1",
      port: 49123,
    },
    socketOptions: {
      sendHwm: 100,
      receiveHwm: 100,
      sendTimeoutMs: 500,
      receiveTimeoutMs: 500,
      lingerMs: 5,
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.value;
}

function rejectsArtifact(adapter, method, path, change, code, serialization) {
  const plan = projectPlan(adapter, "req-rep", "rep", serialization);
  const files = adapter[method](plan);
  const file = files.find((item) => item.path === path);
  assert.ok(file, path);
  const content = change(file.content, files, plan);
  assert.notEqual(content, file.content);

  const result = assembleProject(plan, {
    ...adapter,
    [method]: () =>
      files.map((item) => (item === file ? { ...item, content } : item)),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), [code]);
}

for (const adapter of [pythonAdapter, cppAdapter, javaAdapter, nodeAdapter]) {
  test(`Output Validator rejects the wrong role in a ${adapter.id} entry point`, () => {
    rejectsArtifact(
      adapter,
      "generate",
      adapter.layout.entryPoint("req"),
      (_, files) =>
        files.find(({ path }) => path === adapter.layout.entryPoint("rep"))
          .content,
      "INVALID_ARTIFACT_SOURCE",
    );
  });
}

test("Output Validator rejects a Python entry point with Node source", () => {
  const nodeSource = nodeAdapter
    .generate(projectPlan(nodeAdapter))
    .find(({ path }) => path === nodeAdapter.layout.entryPoint("req")).content;
  rejectsArtifact(
    pythonAdapter,
    "generate",
    "app_req.py",
    () => nodeSource,
    "INVALID_ARTIFACT_SOURCE",
  );
});

test("Output Validator rejects a Python runtime helper with Node source", () => {
  const nodeRuntime = nodeAdapter
    .generate(projectPlan(nodeAdapter))
    .find(({ path }) => path === "zmqt_runtime.mjs").content;
  rejectsArtifact(
    pythonAdapter,
    "generate",
    "zmqt_runtime.py",
    () => nodeRuntime,
    "INVALID_ARTIFACT_SOURCE",
  );
});

test("Output Validator rejects PUB behavior under the expected REQ bootstrap", () => {
  const bootstrap = '\nif __name__ == "__main__":';
  const pubSource = pythonAdapter
    .generate(projectPlan(pythonAdapter, "pub-sub", "sub"))
    .find(({ path }) => path === "app_pub.py").content;
  rejectsArtifact(
    pythonAdapter,
    "generate",
    "app_req.py",
    (content) =>
      pubSource.split(bootstrap)[0] + content.slice(content.indexOf(bootstrap)),
    "INVALID_ARTIFACT_SOURCE",
  );
});

test("Output Validator rejects the wrong pattern in the integration test", () => {
  rejectsArtifact(
    pythonAdapter,
    "generateTests",
    "tests/integration_test.py",
    (content) => content.replace('PATTERN = "req-rep"', 'PATTERN = "pub-sub"'),
    "INVALID_ARTIFACT_SOURCE",
  );
});

test("Output Validator requires the launch scripts and their executable modes", () => {
  const plan = projectPlan(pythonAdapter);
  const files = pythonAdapter.generateBuildFiles(plan);
  const result = assembleProject(plan, {
    ...pythonAdapter,
    generateBuildFiles: () => files
      .filter(({ path }) => path !== "run.ps1")
      .map((file) => file.path === "build.sh" ? { ...file, executable: false } : file),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), [
    "MISSING_ARTIFACT",
    "INVALID_ARTIFACT_MODE",
  ]);
  assert.deepEqual(result.diagnostics[0].params, { path: "run.ps1" });
});

const dependencyChanges = [
  ["Python requirement", pythonAdapter, "requirements.txt", "pyzmq==VERSION"],
  ["Node manifest", nodeAdapter, "package.json", '"zeromq": "VERSION"'],
  ["Node root lock", nodeAdapter, "package-lock.json", '"zeromq": "VERSION"'],
  ["Node locked package", nodeAdapter, "package-lock.json", '"version": "VERSION"'],
  ["Java dependency", javaAdapter, "pom.xml", "<version>VERSION</version>"],
  [
    "C++ installed dependency",
    cppAdapter,
    "CMakeLists.txt",
    "FIND_PACKAGE_ARGS VERSION EXACT CONFIG",
  ],
  ["C++ fetched dependency", cppAdapter, "CMakeLists.txt", "/refs/tags/vVERSION"],
];

for (const [label, adapter, path, declaration] of dependencyChanges) {
  test(`Output Validator rejects a version mismatch in the ${label}`, () => {
    rejectsArtifact(
      adapter,
      "generateBuildFiles",
      path,
      (content, _, plan) =>
        content.replace(
          declaration.replace("VERSION", plan.dependencies[0].version),
          declaration.replace("VERSION", "0.0.0"),
        ),
      "INVALID_ARTIFACT_DEPENDENCIES",
    );
  });
}

test("Output Validator rejects malformed Node package JSON", () => {
  rejectsArtifact(
    nodeAdapter,
    "generateBuildFiles",
    "package.json",
    () => '{"dependencies":',
    "INVALID_ARTIFACT_DEPENDENCIES",
  );
});

for (const [adapter, path, declaration] of [
  [pythonAdapter, "requirements.txt", "cbor2==VERSION"],
  [cppAdapter, "CMakeLists.txt", "PJK/libcbor/tar.gz/refs/tags/vVERSION"],
  [javaAdapter, "pom.xml", "<version>VERSION</version>"],
  [nodeAdapter, "package.json", '"cbor2": "VERSION"'],
]) {
  test(`Output Validator checks the CBOR pin for ${adapter.id}`, () => {
    rejectsArtifact(adapter, "generateBuildFiles", path, (content, _, plan) =>
      content.replace(declaration.replace("VERSION", plan.dependencies[1].version), declaration.replace("VERSION", "0.0.0")),
    "INVALID_ARTIFACT_DEPENDENCIES", "cbor");
  });
}

test("Output Validator checks the transitive Node CBOR lock entry", () => {
  rejectsArtifact(nodeAdapter, "generateBuildFiles", "package-lock.json", (content) => {
    const lock = JSON.parse(content);
    delete lock.packages["node_modules/@cto.af/wtf8"].integrity;
    return JSON.stringify(lock);
  }, "INVALID_ARTIFACT_DEPENDENCIES", "cbor");
});

test("Output Validator rejects an unresolved template placeholder", () => {
  rejectsArtifact(
    pythonAdapter,
    "generate",
    "app_req.py",
    (content) => `${content}# {{ UNRENDERED }}\n`,
    "UNRESOLVED_ARTIFACT_PLACEHOLDER",
  );
});
