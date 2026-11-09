/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const { copyFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const standaloneCode = require("ajv/dist/standalone");
const schema = require("../resources/config.schema.json");

const ajv = new Ajv2020({
  allErrors: true,
  ownProperties: true,
  code: { source: true, lines: true },
});

// JSON Schema counts Unicode code points for string length limits.
const validator = standaloneCode(ajv, ajv.compile(schema)).replace(
  'require("ajv/dist/runtime/ucs2length").default',
  "(value) => [...value].length",
);

if (/\brequire\s*\(/.test(validator)) {
  throw new Error("The compiled schema must be self-contained.");
}

writeFileSync(join(__dirname, "../dist/config/compiled-schema.js"), validator);
copyFileSync(
  join(__dirname, "../src/config/compiled-schema.d.ts"),
  join(__dirname, "../dist/config/compiled-schema.d.ts"),
);
