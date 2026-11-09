/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, sep } = require("node:path");
const test = require("node:test");
const {
  core,
  orientations,
  projectConfig,
} = require("../generated-project-ci/project.cjs");

const cli = resolve(__dirname, "../../apps/cli/index.cjs");

function setup(t, config) {
  const cwd = mkdtempSync(join(tmpdir(), "zmqt-parity-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const input = join(cwd, "input.json");
  writeFileSync(input, JSON.stringify(config));
  return { cwd, input, output: join(cwd, "output") };
}

function runCli({ cwd, input, output }, execArgs = []) {
  const result = spawnSync(
    process.execPath,
    [...execArgs, cli, input, output],
    { cwd, encoding: "utf8", timeout: 5_000 },
  );
  assert.ifError(result.error);
  return result;
}

async function webHost(request) {
  const result = core.generateProject(await request.json());
  return Response.json(result, { status: result.ok ? 200 : 400 });
}

function runWeb(config) {
  return webHost(
    new Request("https://zmqt.invalid/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }),
  );
}

function mode(bits) {
  return process.platform === "win32" ? {} : { mode: bits & 0o777 };
}

function diskFiles(directory) {
  return readdirSync(directory, { recursive: true })
    .flatMap((relative) => {
      const path = join(directory, relative);
      const info = lstatSync(path);
      if (info.isDirectory()) return [];
      assert.ok(info.isFile(), `Unexpected entry ${relative}`);
      return [
        {
          path: relative.split(sep).join("/"),
          bytes: readFileSync(path),
          ...mode(info.mode),
        },
      ];
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
}

for (const { id: language } of core.getCapabilities().languages) {
  for (const [pattern, bindRole] of orientations) {
    test(`Core, CLI, and Web agree on ${language} ${pattern} with ${bindRole} Bind`, async (t) => {
      const config = projectConfig(language, pattern, bindRole, [
        "0.0.0.0",
        "localhost",
      ]);
      const direct = core.generateProject(config);
      assert.equal(direct.ok, true, JSON.stringify(direct.diagnostics));

      const workspace = setup(t, config);
      const local = runCli(workspace);
      assert.equal(local.status, 0, local.stderr);
      assert.equal(local.stderr, "");
      const { manifest, files } = direct.value;
      assert.deepEqual(JSON.parse(local.stdout), {
        manifest,
        diagnostics: direct.diagnostics,
      });
      assert.deepEqual(
        diskFiles(workspace.output),
        files.map((file) => ({
          path: file.path,
          bytes: Buffer.from(file.content, "utf8"),
          ...mode((file.executable ? 0o755 : 0o644) & ~process.umask()),
        })),
      );

      const response = await runWeb(config);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), direct);
    });
  }
}

test("invalid configuration yields the same diagnostics without creating output", async (t) => {
  const config = projectConfig("python", "req-rep", "rep");
  config.messaging.port = 0;
  config.socketOptions.lingerMs = "10";
  const direct = core.generateProject(config);
  assert.equal(direct.ok, false);

  const workspace = setup(t, config);
  const local = runCli(workspace);
  assert.equal(local.status, 1, local.stderr);
  assert.equal(local.stdout, "");
  assert.deepEqual(JSON.parse(local.stderr), {
    diagnostics: direct.diagnostics,
  });
  assert.equal(existsSync(workspace.output), false);

  const response = await runWeb(config);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), direct);
});

test("CLI preserves an existing destination", (t) => {
  const workspace = setup(t, projectConfig("python", "req-rep", "rep"));
  mkdirSync(workspace.output);
  writeFileSync(join(workspace.output, "README.md"), "existing file\n", {
    mode: 0o640,
  });
  const before = diskFiles(workspace.output);

  const result = runCli(workspace);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(
    JSON.parse(result.stderr).diagnostics.some(
      ({ code, severity }) =>
        code === "CLI_OUTPUT_EXISTS" && severity === "error",
    ),
  );
  assert.deepEqual(diskFiles(workspace.output), before);
});

test("CLI rolls back files after a partial write failure", (t) => {
  const workspace = setup(t, projectConfig("java", "req-rep", "rep"));
  const sibling = join(workspace.cwd, "keep.txt");
  const preload = join(workspace.cwd, "fail-write.cjs");
  writeFileSync(sibling, "preserve this file\n");
  writeFileSync(
    preload,
    `
    const fs = require("node:fs");
    const write = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = function (file, data, options) {
      if (typeof file === "number" && ++writes === 2) {
        write(file, "partial", options);
        throw Object.assign(new Error("Injected write failure"), { code: "EIO" });
      }
      return write(file, data, options);
    };
  `,
  );
  const before = diskFiles(workspace.cwd);

  const result = runCli(workspace, ["--require", preload]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.ok(
    JSON.parse(result.stderr).diagnostics.some(
      ({ code, severity }) =>
        code === "CLI_OUTPUT_WRITE_FAILED" && severity === "error",
    ),
  );
  assert.equal(existsSync(workspace.output), false);
  assert.deepEqual(diskFiles(workspace.cwd), before);
});
