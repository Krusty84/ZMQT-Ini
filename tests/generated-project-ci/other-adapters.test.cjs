/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { dirname, join, delimiter } = require("node:path");
const { test } = require("node:test");
const { core, createProject, orientations } = require("./project.cjs");

const python = process.env.ZMQT_PYTHON || "python3";
const catalog = core.getCapabilities();
const repCommands = {
  node: ["node", "app_rep.mjs"],
  java: ["java", "-cp", "target/zmqt-apps-jar-with-dependencies.jar", "AppREP"],
  cpp: ["build/app_rep"],
};

function run(command, args, cwd, env, timeout = 240_000) {
  return execFileSync(command, args, { cwd, env, timeout, encoding: "utf8" });
}

const toolchains = {
  node(cwd, version) {
    const node = process.env.ZMQT_NODE || "node";
    const env = { ...process.env };
    if (node !== "node") env.PATH = `${dirname(node)}${delimiter}${env.PATH}`;
    assert.equal(run(node, ["--version"], cwd, env).trim(), `v${version}`);
    run("npm", ["ci", "--no-audit", "--no-fund"], cwd, env);
    return env;
  },
  java(cwd, version) {
    const javaHome = process.env.ZMQT_JAVA_HOME || process.env.JAVA_HOME;
    const env = { ...process.env };
    if (javaHome) {
      env.JAVA_HOME = javaHome;
      env.PATH = `${join(javaHome, "bin")}${delimiter}${env.PATH}`;
    }
    assert.equal(
      run("javac", ["-version"], cwd, env).trim(),
      `javac ${version}`,
    );
    const cache = process.env.ZMQT_MAVEN_REPOSITORY;
    const args = ["-B", "-q", "package"];
    if (cache) args.push(`-Dmaven.repo.local=${cache}`);
    run("mvn", args, cwd, env);
    return env;
  },
  cpp(cwd) {
    const cmake = process.env.ZMQT_CMAKE || "cmake";
    const env = { ...process.env };
    run(
      cmake,
      ["-S", ".", "-B", "build", "-DCMAKE_BUILD_TYPE=Release"],
      cwd,
      env,
    );
    run(cmake, ["--build", "build", "--parallel", "4"], cwd, env);
    return env;
  },
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
        run(
          python,
          [join(__dirname, "strict_rep.py"), ...repCommands[language]],
          cwd,
          env,
          35_000,
        );
      }
    });
  }
}
