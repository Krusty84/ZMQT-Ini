/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { delimiter, dirname, join } = require("node:path");
const { test } = require("node:test");
const { generateProject } = require("../../dist/index.js");
const { projectCases } = require("../golden/project-cases.cjs");

const windows = process.platform === "win32";

function fixture(t, bindRole, bind, connect) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "zmqt scripts ")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, "generated project");
  const project = generateProject(projectCases.find(
    ({ project }) => project.name === `node-req-rep-${bindRole}`,
  ));
  assert.equal(project.ok, true, JSON.stringify(project.diagnostics));
  for (const { path, content, executable } of project.value.files) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode: executable ? 0o755 : 0o644 });
  }
  const connectRole = bindRole === "rep" ? "req" : "rep";
  for (const [role, mode, body] of [
    [bindRole, "bind", bind],
    [connectRole, "connect", connect],
  ]) {
    writeFileSync(join(root, `app_${role}.mjs`), `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
readFileSync("config/zmq.json");
writeFileSync("${mode}.pid", String(process.pid));
setTimeout(() => process.exit(99), 15_000).unref();
${body}
`);
  }
  const env = {
    ...process.env,
    PATH: [cwd, dirname(process.execPath), process.env.PATH].join(delimiter),
  };
  return {
    root,
    cwd,
    env,
    command(script) {
      const file = join(root, `${script}.${windows ? "ps1" : "sh"}`);
      return windows
        ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file]]
        : [file, []];
    },
  };
}

const bindReady = `
await new Promise(resolve => setTimeout(resolve, 150));
writeFileSync("bind.ready", "");
console.log('{"event":"READY"}');
`;
const connectReady = `
readFileSync("bind.ready");
console.log('{"event":"READY"}');
writeFileSync("connect.ready", "");
`;
const hold = "await new Promise(resolve => setTimeout(resolve, 15_000));";
const response = "console.log('{\"event\":\"RESPONSE_RECEIVED\"}');";

function run(project, script) {
  return spawnSync(...project.command(script), {
    cwd: project.cwd,
    env: project.env,
    encoding: "utf8",
    timeout: 12_000,
  });
}

function assertStopped(root, ...modes) {
  for (const mode of modes) {
    const pid = Number(readFileSync(join(root, `${mode}.pid`), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
}

test("build uses the project directory and returns the tool's failure", (t) => {
  const project = fixture(t, "rep", "", "");
  const [file, content] = windows
    ? ["npm.cmd", "@echo off\r\necho %CD%\r\necho %*\r\nexit /b 23\r\n"]
    : ["npm", "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$*\"\nexit 23\n"];
  writeFileSync(join(project.cwd, file), content, { mode: 0o755 });
  const result = run(project, "build");
  assert.ifError(result.error);
  assert.equal(result.status, 23, result.stderr);
  const [cwd, args] = result.stdout.trim().split(/\r?\n/);
  assert.equal(realpathSync(cwd), project.root);
  assert.equal(args, "ci");
});

for (const role of ["req", "rep"]) {
  test(`run waits for ${role} Bind and stops the pair after a response`, (t) => {
    const waitForConnect = `
while (!existsSync("connect.ready")) {
  await new Promise(resolve => setTimeout(resolve, 20));
}
`;
    const project = fixture(
      t,
      role,
      bindReady + (role === "req" ? waitForConnect + response : hold),
      connectReady + (role === "rep" ? response : hold),
    );
    const result = run(project, "run");
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line).event), [
      "READY", "READY", "RESPONSE_RECEIVED",
    ]);
    assertStopped(project.root, "bind", "connect");
  });
}

test("run does not start Connect when Bind fails before READY", (t) => {
  const project = fixture(t, "rep", 'console.log(\'{"event":"BIND_ERROR"}\'); process.exitCode = 1;', hold);
  const result = run(project, "run");
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /BIND_ERROR/);
  assert.equal(existsSync(join(project.root, "connect.pid")), false);
  assertStopped(project.root, "bind");
});

test("run propagates a Connect failure and stops Bind", (t) => {
  const project = fixture(t, "rep", bindReady + hold, connectReady + "process.exitCode = 19;");
  const result = run(project, "run");
  assert.ifError(result.error);
  assert.equal(result.status, 19, result.stderr);
  assertStopped(project.root, "bind", "connect");
});

test("Bash run stops both apps on SIGINT even if one ignores SIGTERM", { skip: windows }, async (t) => {
  const project = fixture(
    t, "rep",
    'process.on("SIGTERM", () => {});' + bindReady + hold,
    connectReady + 'console.log("STREAM_RUNNING");' + hold,
  );
  const child = spawn(...project.command("run"), {
    cwd: project.cwd,
    env: project.env,
    timeout: 12_000,
  });
  let output = "";
  let interrupted = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!interrupted && output.includes("STREAM_RUNNING")) {
      interrupted = true;
      child.kill("SIGINT");
    }
  });
  const [status, signal] = await once(child, "close");
  assert.equal(signal, null);
  assert.equal(status, 130, output);
  assertStopped(project.root, "bind", "connect");
});

test("advanced Bash run cleans up when FIFO creation fails before any app starts", { skip: windows }, (t) => {
  const project = fixture(t, "rep", "", "");
  const config = structuredClone(projectCases.find(({ project }) => project.name === "node-pub-sub-pub"));
  config.schemaVersion = "1.1";
  config.messaging.bindRole = "proxy";
  config.messaging.extensions = ["espresso"];
  const result = generateProject(config);
  assert.equal(result.ok, true);
  const script = result.value.files.find(({ path }) => path === "run.sh").content;
  writeFileSync(join(project.root, "run.sh"), script, { mode: 0o755 });
  writeFileSync(join(project.cwd, "mkfifo"), "#!/bin/sh\nexit 23\n", { mode: 0o755 });
  project.env.TMPDIR = project.cwd;
  const runResult = run(project, "run");
  assert.ifError(runResult.error);
  assert.equal(runResult.status, 23, runResult.stderr);
  assert.equal(runResult.stderr, "");
  assert.deepEqual(readdirSync(project.cwd).sort(), ["generated project", "mkfifo"]);
});
