/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const nodeCodec = String.raw`const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
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

function isJson(value) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) {
    for (const item of value) if (!isJson(item)) return false;
    return true;
  }
  return typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
    Object.entries(value).every(([key, item]) => key.isWellFormed() && isJson(item));
}

export function decode(frame) {
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
    allowedTypes.includes(value.type) && isJson(value);
}

export function encode(message) {
  try {
    if (!validateMessage(message, messageTypes)) return INVALID;
    return Buffer.from(JSON.stringify(message), "utf8");
  } catch {
    return INVALID;
  }
}

export function processTask(message) {
  return { ...message, result: "processed" };
}
`;
