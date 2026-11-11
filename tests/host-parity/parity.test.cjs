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
  realpathSync,
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
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "zmqt-parity-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const input = join(cwd, "input.json");
  writeFileSync(input, JSON.stringify(config));
  return { cwd, input, output: join(cwd, "output") };
}

function runCli(cwd, args, execArgs = []) {
  const result = spawnSync(
    process.execPath,
    [...execArgs, cli, ...args],
    { cwd, encoding: "utf8", timeout: 5_000 },
  );
  assert.ifError(result.error);
  return result;
}

function runJsonCli({ cwd, input, output }, execArgs) {
  return runCli(cwd, ["--json", input, output], execArgs);
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
      const local = runJsonCli(workspace);
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

test("CLI prints a text summary with the absolute output path", (t) => {
  const { cwd, input } = setup(t, projectConfig("python", "req-rep", "rep"));
  const directory = "new project";
  const output = join(cwd, directory);
  const result = runCli(cwd, [input, directory]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `Generated project (python, req-rep) in ${JSON.stringify(output)}.\n`,
  );
  assert.equal(result.stderr, "");
  assert.ok(existsSync(join(output, "README.md")));
});

test("Core, CLI and Web generate the same advanced PUB/SUB project", async (t) => {
  const config = projectConfig("python", "pub-sub", "proxy");
  config.schemaVersion = "1.1";
  config.messaging.extensions = ["last-value-caching", "espresso"];
  const direct = core.generateProject(config);
  assert.equal(direct.ok, true);
  const workspace = setup(t, config);
  const local = runJsonCli(workspace);
  assert.equal(local.status, 0, local.stderr);
  assert.deepEqual(JSON.parse(local.stdout), { manifest: direct.value.manifest, diagnostics: direct.diagnostics });
  assert.deepEqual(diskFiles(workspace.output), direct.value.files.map((file) => ({
    path: file.path,
    bytes: Buffer.from(file.content, "utf8"),
    ...mode((file.executable ? 0o755 : 0o644) & ~process.umask()),
  })));
  const response = await runWeb(config);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), direct);
});

test("Core, CLI and Web reject the same incompatible PUB/SUB extensions", async (t) => {
  const config = projectConfig("node", "pub-sub", "server");
  config.schemaVersion = "1.1";
  config.messaging.extensions = ["clone", "black-box"];
  const direct = core.generateProject(config);
  assert.equal(direct.ok, false);
  const workspace = setup(t, config);
  const local = runJsonCli(workspace);
  assert.equal(local.status, 1);
  assert.deepEqual(JSON.parse(local.stderr), { diagnostics: direct.diagnostics });
  assert.equal(existsSync(workspace.output), false);
  const response = await runWeb(config);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), direct);
});

test("CLI prints warnings to stderr and still creates the project", (t) => {
  const config = projectConfig("cpp", "req-rep", "rep", ["0.0.0.0", "localhost"]);
  const { cwd, input, output } = setup(t, config);
  const result = runCli(cwd, [input, output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `Generated project (cpp, req-rep) in ${JSON.stringify(output)}.\n`,
  );
  assert.equal(
    result.stderr,
    "Warning [/messaging/bindHost] Binding outside loopback exposes unencrypted traffic.\n",
  );
  assert.ok(existsSync(join(output, "README.md")));
});

test("CLI reports usage in the selected format when paths are missing", (t) => {
  const { cwd, output } = setup(t, {});
  const result = runCli(cwd, []);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Usage: node apps/cli/index.cjs [--json] CONFIG_JSON NEW_OUTPUT_DIR\n",
  );

  const json = runCli(cwd, ["--json"]);
  assert.equal(json.status, 1, json.stderr);
  assert.equal(json.stdout, "");
  assert.deepEqual(JSON.parse(json.stderr), {
    diagnostics: [
      {
        code: "CLI_USAGE",
        severity: "error",
        path: "",
        message: "Usage: node apps/cli/index.cjs CONFIG_JSON NEW_OUTPUT_DIR",
      },
    ],
  });
  assert.equal(existsSync(output), false);
});

test("CLI reports invalid JSON without creating output", (t) => {
  const { cwd, input, output } = setup(t, {});
  writeFileSync(input, "{");
  const result = runCli(cwd, [input, output]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Error The configuration must be valid UTF-8 JSON.\n",
  );
  assert.equal(existsSync(output), false);
});

test("invalid configuration yields the same diagnostics without creating output", async (t) => {
  const config = projectConfig("python", "req-rep", "rep");
  config.messaging.port = 0;
  config.project["extra\nfield"] = true;
  config.socketOptions.lingerMs = "10";
  const direct = core.generateProject(config);
  assert.equal(direct.ok, false);

  const workspace = setup(t, config);
  const local = runJsonCli(workspace);
  assert.equal(local.status, 1, local.stderr);
  assert.equal(local.stdout, "");
  assert.deepEqual(JSON.parse(local.stderr), {
    diagnostics: direct.diagnostics,
  });
  assert.equal(existsSync(workspace.output), false);

  const text = runCli(workspace.cwd, [workspace.input, workspace.output]);
  assert.equal(text.status, 1, text.stderr);
  assert.equal(text.stdout, "");
  assert.equal(
    text.stderr,
    "Error [/messaging/port] Value is below the minimum. (min=1)\n" +
      "Error [/project/extra\\nfield] Unknown field.\n" +
      "Error [/socketOptions/lingerMs] Invalid field type. (expected=integer)\n",
  );
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

  const result = runJsonCli(workspace);
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

  const result = runJsonCli(workspace, ["--require", preload]);
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
