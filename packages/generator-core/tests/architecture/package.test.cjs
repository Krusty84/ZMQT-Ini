/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const packageRoot = resolve(__dirname, "../..");
const packageName = "@zmqt-ini/generator-core";
const schemaPath = "resources/config.schema.json";

function runNpm(args, cwd, cache) {
  const [command, ...prefix] = process.env.npm_execpath
    ? [process.execPath, process.env.npm_execpath]
    : ["npm"];

  return execFileSync(
    command,
    [
      ...prefix,
      ...args,
      "--cache",
      cache,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
      "--logs-max=0",
    ],
    { cwd, encoding: "utf8" },
  );
}

test("packed Core installs and runs in a read-only, restricted Node app", (t) => {
  const workspace = realpathSync(
    mkdtempSync(join(tmpdir(), "zmqt-core-consumer-")),
  );
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const cache = join(workspace, "npm-cache");
  const [packed] = JSON.parse(
    runNpm(
      ["pack", "--json", "--pack-destination", workspace],
      packageRoot,
      cache,
    ),
  );
  assert.equal(packed.name, packageName);
  const paths = packed.files.map(({ path }) => path);
  const buildFiles = readdirSync(join(packageRoot, "dist"), { recursive: true })
    .filter((path) => /\.(?:js|d\.ts)$/.test(path))
    .map((path) => `dist/${path.split(sep).join("/")}`);
  for (const path of [
    "LICENSE",
    schemaPath,
    "resources/config-advanced.schema.json",
    "dist/index.js",
    "dist/index.d.ts",
    ...buildFiles,
  ]) {
    assert.ok(paths.includes(path), `Missing ${path} in the npm package`);
  }

  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ private: true }),
  );
  runNpm(["install", join(workspace, packed.filename)], workspace, cache);

  const installed = join(workspace, "node_modules", packageName);
  const manifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  );
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(
    readFileSync(join(installed, "LICENSE")),
    readFileSync(join(packageRoot, "../../LICENSE")),
  );
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    assert.deepEqual(manifest[field] ?? {}, {});
  }

  const flags = process.allowedNodeEnvironmentFlags;
  const permissionFlag = flags.has("--permission")
    ? "--permission"
    : "--experimental-permission";
  assert.ok(
    flags.has(permissionFlag),
    "Node.js must support the permission model",
  );
  const consumer = `
    const assert = require("node:assert/strict");
    const { execFileSync } = require("node:child_process");
    const { readdirSync, realpathSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    assert.throws(() => writeFileSync("unexpected-output", ""), { code: "ERR_ACCESS_DENIED" });
    assert.throws(() => execFileSync(process.execPath, ["--version"]), { code: "ERR_ACCESS_DENIED" });
    if (${flags.has("--allow-net")}) {
      const { createServer } = require("node:net");
      assert.throws(() => createServer().listen(0), { code: "ERR_ACCESS_DENIED" });
    }
    const before = readdirSync(".").sort();
    const name = ${JSON.stringify(packageName)};
    const installed = realpathSync(join("node_modules", name));
    assert.equal(require.resolve(name), join(installed, "dist", "index.js"));
    const core = require(name);
    assert.deepEqual(Object.keys(core).sort(), ["generateProject", "getCapabilities", "inspectProject", "validateConfig"]);
    const config = {
      schemaVersion: "2.0",
      project: { name: "standalone-host", language: "python" },
      messaging: {
        pattern: "req-rep", transport: "tcp", bindRole: "rep",
        bindHost: "127.0.0.1", connectHost: "localhost", port: 5555,
      },
      socketOptions: {
        sendHwm: 100, receiveHwm: 100, sendTimeoutMs: 500, receiveTimeoutMs: 500, lingerMs: 10,
      },
    };
    const capabilities = core.getCapabilities();
    assert.equal(capabilities.configSchemaVersion, config.schemaVersion);
    assert.deepEqual(capabilities.transports, ["tcp"]);
    assert.deepEqual(core.validateConfig(config), { ok: true, value: config, diagnostics: [] });
    assert.deepEqual(core.inspectProject(config).value.roles.map(({ role, mode }) => [role, mode]),
      [["req", "connect"], ["rep", "bind"]]);
    const project = core.generateProject(config);
    assert.equal(project.ok, true, JSON.stringify(project.diagnostics));
    assert.ok(project.value.files.some(({ path }) => path === "config/zmq.json"));
    const advanced = core.generateProject({
      ...config,
      messaging: { ...config.messaging, pattern: "pub-sub", bindRole: "proxy", extensions: ["espresso"] },
    });
    assert.equal(advanced.ok, true, JSON.stringify(advanced.diagnostics));
    assert.deepEqual(advanced.value.manifest.extensions, ["espresso"]);
    assert.deepEqual(readdirSync(".").sort(), before);
    const rejected = core.validateConfig(null);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.diagnostics.some(({ severity }) => severity === "error"));
    assert.throws(() => require(name + "/dist/index.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    assert.throws(() => require(name + "/resources/config.schema.json"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    (async () => {
      const imported = await import(name);
      assert.equal(imported.default, core);
      for (const key of Object.keys(core)) assert.equal(imported[key], core[key]);
      await assert.rejects(import(name + "/dist/index.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  writeFileSync(join(workspace, "consumer.cjs"), consumer);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  execFileSync(
    process.execPath,
    [permissionFlag, `--allow-fs-read=${workspace}`, "consumer.cjs"],
    {
      cwd: workspace,
      env,
    },
  );
});

test("Core runtime imports stay within its own package", () => {
  const dist = join(packageRoot, "dist");
  for (const path of readdirSync(dist, { recursive: true }).filter((path) =>
    path.endsWith(".js"),
  )) {
    const file = join(dist, path);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );

    function checkImport(specifier) {
      assert.ok(
        specifier && ts.isStringLiteralLike(specifier),
        `Computed import in ${path}`,
      );
      assert.match(specifier.text, /^\.\.?\//, `External import in ${path}`);
      const target = relative(
        packageRoot,
        resolve(dirname(file), specifier.text),
      );
      assert.ok(
        target !== ".." &&
          !target.startsWith(`..${sep}`) &&
          !isAbsolute(target),
        `Import outside Core in ${path}`,
      );
    }

    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      ) {
        checkImport(node.moduleSpecifier);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        checkImport(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }
});
