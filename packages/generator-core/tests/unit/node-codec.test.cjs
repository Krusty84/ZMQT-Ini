/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { nodeCodec } = require("../../dist/templates/node/codec.js");

test("Node codec distinguishes nested object keys from escaped string content", async () => {
  const { decode, encode, INVALID, validateMessage } = await import(
    `data:text/javascript;base64,${Buffer.from(nodeCodec).toString("base64")}`
  );
  const source = String.raw`{"id":"wire","type":"request","payload":[{"a":"[{\"a\":1}]"},{"a":"🧪"},null]}`;
  const parsed = decode(Buffer.from(source));
  assert.equal(validateMessage(parsed, ["request"], "wire"), true);
  assert.deepEqual(decode(encode(parsed)), JSON.parse(source));

  const duplicate = String.raw`{"id":"wire","type":"request","payload":[{"a":{"x":1,"\u0078":2}}]}`;
  assert.equal(decode(Buffer.from(duplicate)), INVALID);
  assert.equal(
    decode(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)]),
    ),
    INVALID,
  );
  assert.equal(
    encode({ id: "wire", type: "request", payload: [Infinity] }),
    INVALID,
  );
});
