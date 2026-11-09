/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyHost } = require("../../dist/validation/hosts.js");

test("classifies raw IPv4, IPv6, and DNS hosts without resolving names", () => {
  const valid = {
    unspecified: ["*", "0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0"],
    loopback: [
      "127.255.0.9",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::FFFF:127.0.0.2",
      "::ffff:7f00:1",
      "LOCALHOST.",
    ],
    external: [
      "192.0.2.1",
      "2001:db8::5",
      "::ffff:192.0.2.1",
      "Example.COM.",
      "zeromq-service",
      "1.example",
    ],
  };

  for (const [kind, hosts] of Object.entries(valid)) {
    for (const host of hosts) assert.equal(classifyHost(host), kind, host);
  }
});

test("rejects ambiguous numeric hosts, endpoint syntax, and malformed addresses", () => {
  const invalid = [
    "",
    " host",
    "host\n",
    "bad_name",
    "-example.test",
    "host..test",
    "a".repeat(64),
    "127.1",
    "127.0.0.01",
    "127.0.0.256",
    "127.0.0.1.",
    "0x7f000001",
    "0177.0.0.1",
    "[::1]",
    "fe80::1%en0",
    "tcp://localhost:5000",
    "localhost:5000",
    ":::",
    "::1::",
    "1:2:3:4:5:6::7:8",
    "1:2:3:4:5:6:7",
    "::ffff:127.0.0.256",
    "::ffff:127.0.0.1:1",
  ];

  for (const host of invalid) assert.equal(classifyHost(host), undefined, host);
});
