/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { getCapabilities, validateConfig } = require("@zmqt-ini/generator-core");

function config() {
  return {
    schemaVersion: "1.0",
    project: { name: "example-project", language: "node" },
    messaging: {
      pattern: "req-rep",
      transport: "tcp",
      bindRole: "rep",
      bindHost: "127.0.0.1",
      connectHost: "localhost",
      port: 5555,
    },
    socketOptions: {
      sendHwm: 1000,
      receiveHwm: 1000,
      sendTimeoutMs: 1000,
      receiveTimeoutMs: 1000,
      lingerMs: 100,
    },
  };
}

function rejects(input, code, path) {
  const result = validateConfig(input);
  assert.equal(result.ok, false);
  assert.equal("value" in result, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === code &&
        diagnostic.path === path &&
        diagnostic.severity === "error",
    ),
    JSON.stringify(result.diagnostics),
  );
}

test("catalog pins versions and matches all 24 supported configurations", () => {
  const catalog = getCapabilities();
  assert.deepEqual(
    [catalog.catalogVersion, catalog.configSchemaVersion, catalog.irVersion],
    [1, "1.0", "1.0"],
  );
  assert.deepEqual(catalog.transports, ["tcp"]);
  assert.deepEqual(
    catalog.languages.map(({ patterns, ...language }) => language),
    [
      {
        id: "python",
        libraryId: "pyzmq",
        libraryVersion: "27.3.0",
        languageVersion: "3.15.2",
      },
      {
        id: "cpp",
        libraryId: "cppzmq",
        libraryVersion: "4.11.0",
        languageVersion: "C++23",
      },
      {
        id: "java",
        libraryId: "jeromq",
        libraryVersion: "0.6.0",
        languageVersion: "27.0.1",
      },
      {
        id: "node",
        libraryId: "zeromq",
        libraryVersion: "6.5.0",
        languageVersion: "26.13.0",
      },
    ],
  );
  assert.deepEqual(catalog.patterns, [
    { id: "req-rep", bindRoles: ["req", "rep"] },
    { id: "pub-sub", bindRoles: ["pub", "sub"] },
    { id: "push-pull", bindRoles: ["push", "pull"] },
  ]);

  for (const language of catalog.languages) {
    assert.deepEqual(
      language.patterns,
      catalog.patterns.map(({ id }) => id),
    );
    for (const { id: pattern, bindRoles } of catalog.patterns) {
      for (const bindRole of bindRoles) {
        const input = config();
        Object.assign(input.project, { language: language.id });
        Object.assign(input.messaging, { pattern, bindRole });
        const result = validateConfig(input);
        assert.equal(result.ok, true);
        assert.deepEqual(result.value, input);
      }
    }
  }

  const copy = getCapabilities();
  copy.languages[0].patterns.pop();
  copy.patterns[0].bindRoles.pop();
  copy.socketOptionRanges.sendHwm.min = 0;
  assert.deepEqual(getCapabilities(), catalog);
});

test("rejects missing and unknown fields, unsupported IDs, and numeric strings", () => {
  for (const value of [null, [], "{}", 1, undefined, Symbol("config")]) {
    rejects(value, "INVALID_TYPE", "");
  }

  for (const section of ["project", "messaging", "socketOptions"]) {
    const input = config();
    delete input[section];
    rejects(input, "MISSING_FIELD", `/${section}`);
    for (const key of Object.keys(config()[section])) {
      const input = config();
      delete input[section][key];
      rejects(input, "MISSING_FIELD", `/${section}/${key}`);
    }
    input[section] = { ...config()[section], "foo~/bar": true };
    rejects(input, "UNKNOWN_FIELD", `/${section}/foo~0~1bar`);
  }
  rejects({ ...config(), extra: true }, "UNKNOWN_FIELD", "/extra");
  rejects(
    { ...config(), schemaVersion: "1.1" },
    "UNSUPPORTED_SCHEMA_VERSION",
    "/schemaVersion",
  );
  const input = config();
  delete input.schemaVersion;
  rejects(input, "MISSING_FIELD", "/schemaVersion");

  const unsupported = config();
  unsupported.project.language = "ruby";
  unsupported.messaging.pattern = "router-dealer";
  unsupported.messaging.transport = "ipc";
  unsupported.messaging.port = "5555";
  const result = validateConfig(unsupported);
  assert.deepEqual(
    result.diagnostics.map(({ code, path }) => [code, path]),
    [
      ["UNSUPPORTED_PATTERN", "/messaging/pattern"],
      ["INVALID_TYPE", "/messaging/port"],
      ["UNSUPPORTED_TRANSPORT", "/messaging/transport"],
      ["UNSUPPORTED_LANGUAGE", "/project/language"],
    ],
  );
  assert.deepEqual(
    validateConfig(Object.fromEntries(Object.entries(unsupported).reverse())),
    result,
  );
});

test("validates names, integer bounds, and compact UTF-8 byte length", () => {
  const input = config();
  for (const name of ["a", "a".repeat(63), "a--b"]) {
    input.project.name = name;
    assert.equal(validateConfig(input).ok, true);
  }
  for (const name of ["a-", "-ab", "Ab", "é", "a/b", "a\n"]) {
    input.project.name = name;
    rejects(input, "INVALID_PROJECT_NAME", "/project/name");
  }
  input.project.name = "a".repeat(64);
  rejects(input, "PROJECT_NAME_TOO_LONG", "/project/name");

  const ranges = getCapabilities().socketOptionRanges;
  assert.deepEqual(ranges, {
    sendHwm: { min: 1, max: 1_000_000 },
    receiveHwm: { min: 1, max: 1_000_000 },
    sendTimeoutMs: { min: 1, max: 600_000 },
    receiveTimeoutMs: { min: 1, max: 600_000 },
    lingerMs: { min: 0, max: 60_000 },
  });
  for (const [field, { min, max }] of Object.entries({
    ...ranges,
    port: { min: 1, max: 65535 },
  })) {
    const input = config();
    const section = field === "port" ? "messaging" : "socketOptions";
    const path = `/${section}/${field}`;
    for (const valid of [min, max]) {
      input[section][field] = valid;
      assert.equal(validateConfig(input).ok, true);
    }
    input[section][field] = min - 1;
    rejects(input, "VALUE_BELOW_MINIMUM", path);
    input[section][field] = max + 1;
    rejects(input, "VALUE_ABOVE_MAXIMUM", path);
    for (const invalid of [1.5, Infinity, NaN, "1"]) {
      input[section][field] = invalid;
      rejects(input, "INVALID_TYPE", path);
    }
  }

  const sized = config();
  sized.messaging.connectHost = "";
  const spare = 32_768 - Buffer.byteLength(JSON.stringify(sized), "utf8");
  sized.messaging.connectHost =
    "🧪".repeat(Math.floor(spare / 4)) + "a".repeat(spare % 4);
  assert.equal(Buffer.byteLength(JSON.stringify(sized), "utf8"), 32_768);
  rejects(sized, "INVALID_HOST", "/messaging/connectHost");
  sized.messaging.connectHost += "a";
  rejects(sized, "INPUT_TOO_LARGE", "");
});

test("validates endpoints and emits sorted warnings with role parameters", () => {
  const input = config();
  input.messaging.bindRole = "pub";
  rejects(input, "INVALID_BIND_ROLE", "/messaging/bindRole");
  input.messaging.pattern = "pub-sub";
  input.messaging.bindHost = "*";
  input.messaging.connectHost = "::1";
  input.socketOptions.lingerMs = 0;
  const result = validateConfig(input);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.diagnostics.map(({ path, code, severity, params }) => [
      path,
      code,
      severity,
      params?.role,
    ]),
    [
      [
        "/messaging/bindHost",
        "UNENCRYPTED_EXTERNAL_BIND",
        "warning",
        undefined,
      ],
      ["/messaging/pattern", "PUB_SUB_MESSAGE_LOSS", "warning", undefined],
      ["/socketOptions/lingerMs", "ZERO_LINGER", "warning", undefined],
      ["/socketOptions/receiveHwm", "INACTIVE_SOCKET_OPTION", "warning", "pub"],
      [
        "/socketOptions/receiveTimeoutMs",
        "INACTIVE_SOCKET_OPTION",
        "warning",
        "pub",
      ],
      ["/socketOptions/sendHwm", "INACTIVE_SOCKET_OPTION", "warning", "sub"],
      [
        "/socketOptions/sendTimeoutMs",
        "INACTIVE_SOCKET_OPTION",
        "warning",
        "sub",
      ],
    ],
  );
  for (const connectHost of [
    "0.0.0.0",
    "::",
    "0:0:0:0:0:0:0:0",
    "::ffff:0.0.0.0",
    "*",
  ]) {
    input.messaging.connectHost = connectHost;
    rejects(input, "UNSPECIFIED_CONNECT_HOST", "/messaging/connectHost");
  }
  for (const connectHost of [
    "[::1]",
    "fe80::1%en0",
    "tcp://localhost",
    "1.2.3.999",
    "a b",
  ]) {
    input.messaging.connectHost = connectHost;
    rejects(input, "INVALID_HOST", "/messaging/connectHost");
  }
});

test("normalization copies input data and does not read accessor values", () => {
  const input = config();
  for (const value of Object.values(input)) Object.freeze(value);
  Object.freeze(input);
  const result = validateConfig(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, input);
  assert.notEqual(result.value, input);
  for (const section of ["project", "messaging", "socketOptions"]) {
    assert.notEqual(result.value[section], input[section]);
  }
  result.value.project.name = "modified";
  assert.deepEqual(validateConfig(input).value, input);

  const accessor = config();
  let calls = 0;
  Object.defineProperty(accessor.project, "name", {
    get() {
      calls += 1;
      return "wrong";
    },
  });
  rejects(accessor, "INVALID_JSON_INPUT", "");
  assert.equal(calls, 0);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  rejects(revoked.proxy, "INVALID_JSON_INPUT", "");
});
