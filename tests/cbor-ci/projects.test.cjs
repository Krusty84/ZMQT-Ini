/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { join } = require("node:path");
const { before, test } = require("node:test");
const { core, projectConfig, writeProject } = require("../generated-project-ci/project.cjs");
const { python, run, toolchains } = require("../generated-project-ci/toolchains.cjs");

const { languages } = core.getCapabilities();
const variants = [
  ["req-rep", "req-rep", "rep"],
  ["pub-sub", "pub-sub", "pub"],
  ["push-pull", "push-pull", "push"],
  ["suicidal-snail", "pub-sub", "pub", ["suicidal-snail"]],
  ["all-stream", "pub-sub", "proxy", ["espresso", "last-value-caching", "suicidal-snail", "black-box"]],
];

before(() => {
  const { languageVersion, libraryVersion } = languages.find(({ id }) => id === "python");
  const actual = run(python, ["-c", [
    "import platform, zmq",
    "from importlib.metadata import version",
    "print(platform.python_version(), zmq.__version__, version('cbor2'))",
  ].join("\n")]).trim();
  assert.equal(actual, `${languageVersion} ${libraryVersion} 6.2.1`);
});

for (const { id: language, languageVersion } of languages) {
  for (const [label, pattern, bindRole, extensions] of variants) {
    test(`generated ${language} CBOR ${label}`, (t) => {
      const config = projectConfig(language, pattern, bindRole);
      config.messaging.serialization = "cbor";
      if (extensions) config.messaging.extensions = extensions;
      const cwd = writeProject(t, config);
      const env = toolchains[language]?.(cwd, languageVersion) ?? process.env;
      run(python, ["tests/integration_test.py"], cwd, env, 50_000);
      run(python, [join(__dirname, "wire.py"), label], cwd, env, 40_000);
    });
  }
}
