/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const cborCodec = String.raw`const encodeTypes = new TypeEncoderMap();
encodeTypes.registerEncoder(Buffer, writeUint8Array);

const decodeOptions = {
  ignoreGlobalTags: true,
  preferBigInt: true,
  createObject(entries) {
    const fields = new Map();
    for (const [key, value] of entries) {
      if (typeof key !== "string" || fields.has(key)) throw new Error("Invalid CBOR map key");
      fields.set(key, value);
    }
    return Object.fromEntries(fields);
  },
};

function unpackValue(value) {
  if (typeof value === "bigint") {
    const integer = Number(value);
    if (!Number.isSafeInteger(integer)) throw new Error("Integer outside the safe range");
    return integer;
  }
  if (Array.isArray(value)) return value.map(unpackValue);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpackValue(item)]));
  }
  if (!isJson(value, true)) throw new Error("Unsupported CBOR value");
  return value;
}

export function decode(frame) {
  try {
    return unpackValue(decodeCbor(frame, decodeOptions));
  } catch {
    return INVALID;
  }
}

export function encode(message) {
  try {
    if (!validateMessage(message, messageTypes)) return INVALID;
    return Buffer.from(encodeCbor(message, { types: encodeTypes }));
  } catch {
    return INVALID;
  }
}

export function telemetryPayload() {
  return { deviceId: "sensor-01", samples: Uint8Array.of(0, 255) };
}

export function stringifyLog(value) {
  return JSON.stringify(value, function (key, item) {
    const original = this[key];
    return original instanceof Uint8Array ? Buffer.from(original).toString("hex") : item;
  });
}`;

const jsonEncoder = String.raw`export function encode(message) {
  try {
    if (!validateMessage(message, messageTypes)) return INVALID;
    return Buffer.from(JSON.stringify(message), "utf8");
  } catch {
    return INVALID;
  }
}`;

export function renderNodeCodec(cbor: boolean): string {
  return String.raw`${cbor ? `import { decode as decodeCbor, TypeEncoderMap } from "cbor2";
import { encode as encodeCbor, writeUint8Array } from "cbor2/encoder";

` : ""}const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const messageTypes = ["request", "response", "error", "event", "task"];

export const INVALID = Symbol("invalid message");

function hasUniqueKeys(source) {
  const containers = [];
  const tokens = /("(?:[^"\\]|\\[\s\S])*"|[{}\[\]])[ \t\r\n]*/g;
  for (const match of source.matchAll(tokens)) {
    const token = match[1];
    if (token === "{") {
      containers.push(new Set());
    } else if (token === "[") {
      containers.push(null);
    } else if (token === "}" || token === "]") {
      containers.pop();
    } else if (source[match.index + match[0].length] === ":") {
      const key = JSON.parse(token);
      const keys = containers.at(-1);
      if (keys.has(key)) return false;
      keys.add(key);
    }
  }
  return true;
}

function isJson(value${cbor ? ", binary = false" : ""}) {
${cbor ? "  if (binary && value instanceof Uint8Array) return true;\n" : ""}  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) {
    for (const item of value) if (!isJson(item${cbor ? ", binary" : ""})) return false;
    return true;
  }
  return typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
    Object.entries(value).every(([key, item]) => key.isWellFormed() && isJson(item${cbor ? ", binary" : ""}));
}

export function ${cbor ? "decodeJson" : "decode"}(frame) {
  try {
    const source = utf8.decode(frame);
    const value = JSON.parse(source);
    return hasUniqueKeys(source) && isJson(value) ? value : INVALID;
  } catch {
    return INVALID;
  }
}

export function extractId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "id")) return null;
  return typeof value.id === "string" && value.id.length > 0 && value.id.isWellFormed() ? value.id : null;
}

export function validateMessage(value, allowedTypes, matchesId = null) {
  const id = extractId(value);
  return id !== null && (matchesId === null || id === matchesId) &&
    Object.keys(value).length === 3 && Object.hasOwn(value, "type") && Object.hasOwn(value, "payload") &&
    allowedTypes.includes(value.type) && isJson(value${cbor ? ", true" : ""});
}

${cbor ? cborCodec : jsonEncoder}

export function processTask(message) {
  return { ...message, result: "processed" };
}
`;
}

export const nodeCodec = renderNodeCodec(false);
