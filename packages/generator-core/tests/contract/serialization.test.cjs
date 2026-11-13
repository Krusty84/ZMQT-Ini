/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { generateProject, getCapabilities, inspectProject, validateConfig } = require("@zmqt-ini/generator-core");
const { projectCases } = require("../golden/project-cases.cjs");

function withSerialization(config, serialization) {
  return { ...config, messaging: { ...config.messaging, serialization } };
}

test("generates JSON by default and records the opt-in CBOR format", () => {
  assert.deepEqual(getCapabilities().serializations, ["json", "cbor"]);
  for (const config of projectCases) {
    assert.deepEqual(generateProject(withSerialization(config, "json")), generateProject(config));
    const binary = withSerialization(config, "cbor");
    const result = generateProject(binary);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const { manifest } = result.value;
    assert.equal(manifest.serialization, "cbor");
    assert.equal(manifest.templateVersion, "1.6.0");
    assert.equal(manifest.dependencySetVersion, "1.1.0");
    assert.equal(inspectProject(binary).value.serialization, "cbor");
    assert.equal(validateConfig(binary).value.messaging.serialization, "cbor");
  }
});

test("generates CBOR for each stream extension combination and bind role", () => {
  const { languages, combinations } = getCapabilities().pubSubExtensions;
  for (const language of languages) {
    const base = projectCases.find(({ project }) => project.language === language);
    for (const { extensions, bindRoles } of combinations) {
      if (extensions.includes("clone")) continue;
      for (const bindRole of bindRoles) {
        const config = {
          ...base,
          messaging: { ...base.messaging, pattern: "pub-sub", bindRole, extensions, serialization: "cbor" },
        };
        const result = generateProject(config);
        assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
        assert.deepEqual(result.value.manifest.extensions, extensions);
        assert.equal(result.value.manifest.serialization, "cbor");
      }
    }
  }
});

test("rejects unknown formats and serialization for Clone and Binary Star", () => {
  const base = projectCases[0];
  const rejected = (config, expected) => {
    const result = validateConfig(config);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(({ code, path }) => code === expected && path === "/messaging/serialization"));
  };
  rejected(withSerialization(base, "msgpack"), "UNSUPPORTED_SERIALIZATION");
  for (const extensions of [["clone"], ["clone", "binary-star"]]) {
    for (const serialization of ["json", "cbor"]) {
      rejected({
        ...base,
        messaging: {
          ...base.messaging, pattern: "pub-sub", bindRole: "server", extensions, serialization,
          ...(extensions.length === 2 && { backup: { bindHost: "127.0.0.1", connectHost: "localhost", port: 5600 } }),
        },
      }, "INACTIVE_EXTENSION_OPTION");
    }
  }
});
