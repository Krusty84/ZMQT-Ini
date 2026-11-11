/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getCapabilities, validateConfig, inspectProject, generateProject } = require("@zmqt-ini/generator-core");
const { planProject } = require("../../dist/planning/build");
const { validatePubSubPlan } = require("../../dist/planning/pub-sub");

function config(extensions, bindRole = "proxy", language = "python") {
  return {
    schemaVersion: "1.1",
    project: { name: "advanced-example", language },
    messaging: {
      pattern: "pub-sub", transport: "tcp", bindRole,
      bindHost: "127.0.0.1", connectHost: "localhost", port: 5555, extensions,
      ...(extensions.includes("binary-star") && {
        backup: { bindHost: "127.0.0.1", connectHost: "127.0.0.1", port: 5560 },
      }),
    },
    socketOptions: { sendHwm: 50, receiveHwm: 50, sendTimeoutMs: 2500, receiveTimeoutMs: 2000, lingerMs: 25 },
  };
}

test("advertises and generates all 80 advanced PUB/SUB configurations", () => {
  const catalog = getCapabilities().pubSubExtensions;
  assert.deepEqual(catalog.languages, ["python", "cpp", "java", "node"]);
  assert.equal(catalog.configSchemaVersion, "1.1");
  assert.equal(catalog.irVersion, "1.1");
  const stream = ["black-box", "espresso", "last-value-caching", "suicidal-snail"];
  const expected = new Map([["clone", ["server"]], ["binary-star,clone", ["server"]]]);
  for (let mask = 1; mask < 16; mask++) {
    const extensions = stream.filter((_, index) => mask & (1 << index));
    expected.set(extensions.join(","), mask & 6 ? ["proxy"] : ["pub", "sub"]);
  }
  assert.deepEqual(new Map(catalog.combinations.map(({ extensions, bindRoles }) => [extensions.join(","), bindRoles])), expected);

  let checked = 0;
  for (const language of catalog.languages) {
    for (const { extensions, bindRoles } of catalog.combinations) {
      for (const bindRole of bindRoles) {
        const input = config(extensions, bindRole, language);
        const summary = inspectProject(input);
        const output = generateProject(input);
        assert.equal(summary.ok, true, JSON.stringify(summary.diagnostics));
        assert.equal(output.ok, true, JSON.stringify(output.diagnostics));
        assert.deepEqual(summary.value.extensions, extensions);
        assert.ok(summary.value.roles.every(({ socket, endpoint }) => socket && /^(tcp|inproc):\/\//.test(endpoint)));
        assert.deepEqual(output.value.manifest.extensions, extensions);
        assert.equal(output.value.manifest.configSchemaVersion, "1.1");
        assert.equal(output.value.manifest.irVersion, "1.1");
        assert.equal(output.value.manifest.templateVersion, "1.2.0");
        checked++;
      }
    }
  }
  assert.equal(checked, 80);
});

test("plans each TCP and inproc socket with its role and endpoint", () => {
  const input = config(["clone", "binary-star"], "server");
  const result = inspectProject(input);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.roles.filter(({ role }) => role === "backup")
      .map(({ socket, socketType, mode, endpoint }) => [socket, socketType, mode, endpoint]),
    [
      ["snapshot", "ROUTER", "bind", "tcp://127.0.0.1:5560"],
      ["updates", "PUB", "bind", "tcp://127.0.0.1:5561"],
      ["collector", "SUB", "bind", "tcp://127.0.0.1:5562"],
      ["peerIn", "ROUTER", "bind", "tcp://127.0.0.1:5563"],
      ["peerOut", "DEALER", "connect", "tcp://localhost:5558"],
    ],
  );
  const stream = inspectProject(config(["espresso", "black-box"])).value;
  assert.deepEqual(stream.roles.filter(({ endpoint }) => endpoint.startsWith("inproc")).map(({ socketType }) => socketType),
    ["PAIR", "PAIR", "PUSH", "PULL", "PULL"]);
  const plan = structuredClone(planProject(input).value);
  plan.applications[0].sockets.pop();
  assert.equal(validatePubSubPlan(plan)[0].code, "IR_INVALID_TOPOLOGY");
  const invalidState = structuredClone(planProject(input).value);
  invalidState.behavior.binaryStarTransitions.passive.vote = "passive";
  assert.equal(validatePubSubPlan(invalidState)[0].code, "IR_INVALID_TOPOLOGY");
});

test("normalizes advanced options and generates identical output for equivalent input", () => {
  const timed = config(["suicidal-snail", "black-box"], "sub");
  assert.equal(validateConfig(timed).value.messaging.maxAgeMs, 1000);
  assert.equal(validateConfig(config(["clone"], "server")).value.messaging.subtree, "");

  const input = config(["clone", "binary-star"], "server", "node");
  const alternate = structuredClone(input);
  alternate.messaging.extensions.reverse();
  alternate.messaging.backup = Object.fromEntries(Object.entries(alternate.messaging.backup).reverse());
  alternate.socketOptions = Object.fromEntries(Object.entries(alternate.socketOptions).reverse());
  assert.deepEqual(generateProject(alternate), generateProject(input));
  const output = validateConfig(input).value;
  input.messaging.backup.port++;
  input.messaging.extensions.pop();
  assert.equal(output.messaging.backup.port, 5560);
  assert.deepEqual(output.messaging.extensions, ["binary-star", "clone"]);
});

test("rejects invalid extensions, settings, and TCP port ranges", () => {
  const clone = config(["clone"], "server");
  const star = config(["clone", "binary-star"], "server");
  const cases = [
    [config([]), "MISSING_EXTENSION", "/messaging/extensions"],
    [config(["bogus"]), "UNSUPPORTED_EXTENSION", "/messaging/extensions/0"],
    [config(["espresso", "espresso"]), "DUPLICATE_EXTENSION", "/messaging/extensions"],
    [config(["binary-star"]), "INCOMPATIBLE_EXTENSIONS", "/messaging/extensions"],
    [config(["clone", "espresso"], "server"), "INCOMPATIBLE_EXTENSIONS", "/messaging/extensions"],
    [config(["espresso"], "pub"), "INVALID_BIND_ROLE", "/messaging/bindRole"],
    [{ ...clone, messaging: { ...clone.messaging, subtree: "/wrong" } }, "INVALID_SUBTREE", "/messaging/subtree"],
    [{ ...clone, messaging: { ...clone.messaging, maxAgeMs: 1 } }, "INACTIVE_EXTENSION_OPTION", "/messaging/maxAgeMs"],
    [{ ...clone, messaging: { ...clone.messaging, port: 65534 } }, "PORT_RANGE_OVERFLOW", "/messaging/port"],
    [{ ...star, messaging: { ...star.messaging, backup: undefined } }, "MISSING_FIELD", "/messaging/backup"],
    [{ ...star, messaging: { ...star.messaging, backup: { ...star.messaging.backup, port: 65533 } } },
      "PORT_RANGE_OVERFLOW", "/messaging/backup/port"],
    [{ ...star, messaging: { ...star.messaging, backup: { ...star.messaging.backup, port: 5556 } } },
      "OVERLAPPING_PORT_RANGES", "/messaging/backup/port"],
    [{ ...star, messaging: { ...star.messaging, backup: { ...star.messaging.backup, connectHost: "*" } } },
      "UNSPECIFIED_CONNECT_HOST", "/messaging/backup/connectHost"],
    [{ ...clone, schemaVersion: "1.0" }, "UNKNOWN_FIELD", "/messaging/extensions"],
  ];
  for (const [input, code, path] of cases) {
    const result = validateConfig(input);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code && diagnostic.path === path),
      JSON.stringify(result.diagnostics));
    assert.deepEqual(inspectProject(input), result);
    assert.deepEqual(generateProject(input), result);
  }
  const multiHost = config(["clone", "binary-star"], "server");
  multiHost.messaging.bindHost = "*";
  multiHost.messaging.connectHost = "primary.example";
  multiHost.messaging.backup = { bindHost: "*", connectHost: "backup.example", port: 5555 };
  assert.equal(validateConfig(multiHost).ok, true);
});

test("does not call accessors in extension arrays or backup endpoints", () => {
  const input = config(["espresso"]);
  const backup = config(["clone", "binary-star"], "server");
  for (const [settings, key] of [[input.messaging.extensions, "0"], [backup.messaging.backup, "port"]]) {
    Object.defineProperty(settings, key, { enumerable: true, get() { assert.fail("Accessor was called"); } });
  }
  for (const value of [input, backup]) assert.equal(validateConfig(value).diagnostics[0].code, "INVALID_JSON_INPUT");
});
