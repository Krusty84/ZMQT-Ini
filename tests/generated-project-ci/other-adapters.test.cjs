/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const { join } = require("node:path");
const { test } = require("node:test");
const { core, createProject, orientations } = require("./project.cjs");

const { python, run, toolchains } = require("./toolchains.cjs");
const catalog = core.getCapabilities();
const appCommands = {
  node: (role) => ["node", `app_${role}.mjs`],
  java: (role) => ["java", "-cp", "target/zmqt-apps-jar-with-dependencies.jar", `App${role.toUpperCase()}`],
  cpp: (role) => [`build/app_${role}`],
};

for (const [language, prepare] of Object.entries(toolchains)) {
  const { languageVersion } = catalog.languages.find(
    ({ id }) => id === language,
  );
  for (const [pattern, bindRole] of orientations) {
    test(`generated ${language} ${pattern}, ${bindRole} binds`, (t) => {
      const cwd = createProject(t, language, pattern, bindRole);
      const env = prepare(cwd, languageVersion);
      run(python, ["tests/integration_test.py"], cwd, env, 25_000);
      if (bindRole === "rep") {
        for (const [script, role] of [["strict_rep.py", "rep"], ["immediate.py", "req"]]) {
          run(python, [join(__dirname, script), ...appCommands[language](role)], cwd, env, 35_000);
        }
      }
    });
  }
}
