/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { join } = require("node:path");
const { before, test } = require("node:test");
const { core, projectConfig, writeProject } = require("../generated-project-ci/project.cjs");
const { python, run, toolchains } = require("../generated-project-ci/toolchains.cjs");

const variants = [
  ["espresso", "proxy", ["espresso"]],
  ["last-value-caching", "proxy", ["last-value-caching"]],
  ["suicidal-snail", "pub", ["suicidal-snail"]],
  ["black-box", "sub", ["black-box"]],
  ["espresso-cache", "proxy", ["espresso", "last-value-caching"]],
  ["snail-black-box", "sub", ["suicidal-snail", "black-box"]],
  ["all-stream", "proxy", ["espresso", "last-value-caching", "suicidal-snail", "black-box"]],
  ["clone", "server", ["clone"]],
  ["binary-star", "server", ["clone", "binary-star"]],
];

const { languages } = core.getCapabilities();

before(() => {
  const { languageVersion, libraryVersion } = languages.find(({ id }) => id === "python");
  const actual = run(python, ["-c", "import platform, zmq; print(platform.python_version(), zmq.__version__)"])
    .trim();
  assert.equal(actual, languageVersion + " " + libraryVersion);
});

for (const { id: language, languageVersion } of languages) {
  for (const [label, bindRole, extensions] of variants) {
    test("generated " + language + " advanced " + label, (t) => {
      const config = projectConfig(language, "pub-sub", bindRole);
      config.schemaVersion = "1.1";
      config.messaging.extensions = extensions;
      if (extensions.includes("clone")) config.messaging.subtree = "/stocks/";
      if (extensions.includes("binary-star")) {
        config.messaging.backup = { bindHost: "127.0.0.1", connectHost: "127.0.0.1", port: 5560 };
      }
      const cwd = writeProject(t, config);
      const env = toolchains[language]?.(cwd, languageVersion) ?? process.env;
      run(python, ["tests/integration_test.py"], cwd, env, 50_000);
      run(python, [join(__dirname, "wire.py"), label], cwd, env, 35_000);
    });
  }
}
