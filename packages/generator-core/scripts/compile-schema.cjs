/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const { copyFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const standaloneCode = require("ajv/dist/standalone");
const schema = require("../resources/config.schema.json");
const advanced = require("../resources/config-advanced.schema.json");

const ajv = new Ajv2020({
  allErrors: true,
  ownProperties: true,
  code: { source: true, lines: true },
});

ajv.addSchema(schema, "config.schema.json");
for (const [name, validate] of [
  ["compiled-schema", ajv.getSchema("config.schema.json")],
  ["compiled-schema-advanced", ajv.compile(advanced)],
]) {
  // JSON Schema counts Unicode code points for string length limits.
  const validator = standaloneCode(ajv, validate).replaceAll(
    'require("ajv/dist/runtime/ucs2length").default',
    "(value) => [...value].length",
  );

  if (/\brequire\s*\(/.test(validator)) {
    throw new Error("The compiled schema must be self-contained.");
  }

  writeFileSync(join(__dirname, "../dist/config", name + ".js"), validator);
  copyFileSync(
    join(__dirname, "../src/config", name + ".d.ts"),
    join(__dirname, "../dist/config", name + ".d.ts"),
  );
}
