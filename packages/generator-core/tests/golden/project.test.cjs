/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { generateProject } = require("../../dist/index.js");
const { projectCases, canonicalProject } = require("./project-cases.cjs");
const hashes = require("./hashes.json");

test("golden fixtures cover all 24 P0 configurations", () => {
  assert.equal(projectCases.length, 24);
  assert.deepEqual(
    Object.keys(hashes).sort(),
    projectCases.map(({ project }) => project.name).sort(),
  );
});

for (const config of projectCases) {
  const { name } = config.project;
  test(`golden artifacts for ${name}`, () => {
    const first = generateProject(config);
    assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
    const second = generateProject(config);
    assert.deepEqual(second, first);
    const bytes = canonicalProject(first.value);
    const digest = createHash("sha256").update(bytes, "utf8").digest("hex");
    assert.equal(digest, hashes[name]);
  });
}
