/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { parseConfig } from "../config/schema";
import type { SchemaIssue } from "../config/compiled-schema.js";
import { activeSocketOptions, patternRegistry } from "../patterns/registry";
import type { SocketOption } from "../patterns/registry";
import { extensionCombinations, extensionTopology } from "../patterns/pub-sub-extensions";
import type {
  AdvancedConfig,
  Diagnostic,
  NormalizedConfig,
  ValidationResult,
} from "../public/types";
import { sortDiagnostics } from "./diagnostics";
import { classifyHost, sameHost } from "./hosts";
import { utf8ByteLength } from "./utf8";

const maxBytes = 32_768;
const configSections = ["project", "messaging", "socketOptions"] as const;

function copyRecord(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const data: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !("value" in property)) {
      throw new TypeError("Expected a JSON data property.");
    }
    data[key] = property.value;
  }
  return data;
}

function snapshot(input: unknown): unknown {
  const data = copyRecord(input);
  if (!data) return input;

  for (const section of configSections) {
    const sectionData = copyRecord(data[section]);
    if (sectionData) data[section] = sectionData;
  }
  const messaging = data.messaging as Record<string, unknown> | undefined;
  if (data.schemaVersion === "1.1" && messaging && typeof messaging === "object" &&
      !Array.isArray(messaging)) {
    const backup = copyRecord(messaging.backup);
    if (backup) messaging.backup = backup;
    const extensions = messaging.extensions;
    if (Array.isArray(extensions)) {
      // Seven entries are enough for the schema to report its six-item limit.
      messaging.extensions = Array.from({ length: Math.min(extensions.length, 7) }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(extensions, String(index));
        if (property && !("value" in property)) throw new TypeError("Expected a JSON data property.");
        return property?.value;
      });
    }
  }
  return data;
}

function fieldPath(path: string, field: string): string {
  return `${path}/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

const unsupportedValues: Readonly<Record<string, readonly [string, string]>> = {
  "/schemaVersion": [
    "UNSUPPORTED_SCHEMA_VERSION",
    "Unsupported configuration schema version.",
  ],
  "/project/language": ["UNSUPPORTED_LANGUAGE", "Unsupported language."],
  "/messaging/pattern": [
    "UNSUPPORTED_PATTERN",
    "Unsupported messaging pattern.",
  ],
  "/messaging/transport": ["UNSUPPORTED_TRANSPORT", "Unsupported transport."],
};

function schemaDiagnostic({
  keyword,
  instancePath: path,
  params,
}: SchemaIssue): Diagnostic {
  const severity = "error";
  switch (keyword) {
    case "required":
      return {
        severity,
        code: "MISSING_FIELD",
        path: fieldPath(path, String(params.missingProperty)),
        message: "Required field is missing.",
      };
    case "additionalProperties":
      return {
        severity,
        code: "UNKNOWN_FIELD",
        path: fieldPath(path, String(params.additionalProperty)),
        message: "Unknown field.",
      };
    case "const":
    case "enum": {
      const [code, message] = unsupportedValues[path] ?? [
        "UNSUPPORTED_EXTENSION", "Unsupported PUB/SUB extension.",
      ];
      return { severity, code, path, message };
    }
    case "minItems":
      return { severity, code: "MISSING_EXTENSION", path, message: "Select a PUB/SUB extension." };
    case "maxItems":
      return { severity, code: "TOO_MANY_EXTENSIONS", path, message: "Too many PUB/SUB extensions." };
    case "uniqueItems":
      return { severity, code: "DUPLICATE_EXTENSION", path, message: "Select each extension once." };
    case "pattern":
      return {
        severity,
        code: "INVALID_PROJECT_NAME",
        path,
        message: "Invalid project name.",
      };
    case "maxLength":
      return {
        severity,
        code: "PROJECT_NAME_TOO_LONG",
        path,
        message: "Project name is too long.",
        params: { maxLength: Number(params.limit) },
      };
    case "minimum":
      return {
        severity,
        code: "VALUE_BELOW_MINIMUM",
        path,
        message: "Value is below the minimum.",
        params: { min: Number(params.limit) },
      };
    case "maximum":
      return {
        severity,
        code: "VALUE_ABOVE_MAXIMUM",
        path,
        message: "Value is above the maximum.",
        params: { max: Number(params.limit) },
      };
    case "type":
      return {
        severity,
        code: "INVALID_TYPE",
        path,
        message: "Invalid field type.",
        params: { expected: String(params.type) },
      };
    default:
      throw new Error(`Unexpected configuration schema keyword: ${keyword}`);
  }
}

function exceedsSize(config: NormalizedConfig): boolean {
  const { bindRole, bindHost, connectHost } = config.messaging;
  if (bindRole.length + bindHost.length + connectHost.length > maxBytes)
    return true;

  const json = JSON.stringify(config);
  return json.length > maxBytes || utf8ByteLength(json) > maxBytes;
}

function checkHosts(bindHost: string, connectHost: string, path: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const bind = classifyHost(bindHost);
  const connect = classifyHost(connectHost);
  if (!bind) {
    diagnostics.push({
      severity: "error",
      code: "INVALID_HOST",
      path: `${path}/bindHost`,
      message: "Invalid bind host.",
    });
  }
  if (!connect) {
    diagnostics.push({
      severity: "error",
      code: "INVALID_HOST",
      path: `${path}/connectHost`,
      message: "Invalid connect host.",
    });
  } else if (connect === "unspecified") {
    diagnostics.push({
      severity: "error",
      code: "UNSPECIFIED_CONNECT_HOST",
      path: `${path}/connectHost`,
      message: "Connect requires a destination address.",
    });
  }

  if (bind && bind !== "loopback") {
    diagnostics.push({
      severity: "warning",
      code: "UNENCRYPTED_EXTERNAL_BIND",
      path: `${path}/bindHost`,
      message: "Binding outside loopback exposes unencrypted traffic.",
    });
  }
  return diagnostics;
}

const combinations = extensionCombinations().map(({ extensions }) => extensions.join(","));

function checkAdvanced(config: AdvancedConfig, diagnostics: Diagnostic[]): void {
  const { extensions, maxAgeMs, subtree, backup, port, bindHost, connectHost } = config.messaging;
  const { clone, binaryStar, portCount } = extensionTopology(extensions);
  const error = (code: string, field: string, message: string) => {
    diagnostics.push({ severity: "error", code, path: `/messaging/${field}`, message });
  };
  if (!combinations.includes(extensions.join(","))) {
    error("INCOMPATIBLE_EXTENSIONS", "extensions", "PUB/SUB extensions cannot be combined.");
  }
  for (const [field, value, active] of [
    ["maxAgeMs", maxAgeMs, extensions.includes("suicidal-snail")],
    ["subtree", subtree, clone],
    ["backup", backup, binaryStar],
  ] as const) {
    if (value !== undefined && !active)
      error("INACTIVE_EXTENSION_OPTION", field, "Option requires its PUB/SUB extension.");
  }
  if (binaryStar && !backup) error("MISSING_FIELD", "backup", "Binary Star requires a backup endpoint.");
  if (subtree !== undefined && subtree !== "" &&
      (!/^\/(?:[^/\u0000]+\/)+(?![\s\S])/u.test(subtree) || /[\uD800-\uDFFF]/u.test(subtree))) {
    error("INVALID_SUBTREE", "subtree", "Use an empty subtree or a path such as /example/.");
  }
  if (port + portCount - 1 > 65535)
    error("PORT_RANGE_OVERFLOW", "port", "The topology requires consecutive TCP ports.");
  if (!backup) return;
  diagnostics.push(...checkHosts(backup.bindHost, backup.connectHost, "/messaging/backup"));
  if (backup.port + portCount - 1 > 65535)
    error("PORT_RANGE_OVERFLOW", "backup/port", "The backup requires consecutive TCP ports.");
  const localHosts = classifyHost(connectHost) === "loopback" && classifyHost(backup.connectHost) === "loopback";
  const sameBind = classifyHost(bindHost) !== "unspecified" && sameHost(bindHost, backup.bindHost);
  if ((localHosts || sameBind || sameHost(connectHost, backup.connectHost)) &&
      Math.abs(port - backup.port) < portCount) {
    error("OVERLAPPING_PORT_RANGES", "backup/port", "Server port ranges overlap on the same host.");
  }
}

function checkSemantics(config: NormalizedConfig): ValidationResult {
  const { pattern, bindRole, bindHost, connectHost } = config.messaging;
  const { roles, permittedBindRoles } = patternRegistry[pattern];
  const bindRoles = config.schemaVersion === "1.1"
    ? extensionTopology(config.messaging.extensions).bindRoles : permittedBindRoles;
  const diagnostics = checkHosts(bindHost, connectHost, "/messaging");
  if (!bindRoles.includes(bindRole)) {
    diagnostics.push({
      severity: "error",
      code: "INVALID_BIND_ROLE",
      path: "/messaging/bindRole",
      message: "Bind role does not belong to the pattern.",
      params: { pattern },
    });
  }
  if (config.schemaVersion === "1.1") checkAdvanced(config, diagnostics);
  if (diagnostics.some(({ severity }) => severity === "error")) {
    return { ok: false, diagnostics: sortDiagnostics(diagnostics.filter(({ severity }) => severity === "error")) };
  }

  if (pattern === "pub-sub") {
    diagnostics.push({
      severity: "warning",
      code: "PUB_SUB_MESSAGE_LOSS",
      path: "/messaging/pattern",
      message: "PUB/SUB can lose messages.",
    });
  }
  if (config.socketOptions.lingerMs === 0) {
    diagnostics.push({
      severity: "warning",
      code: "ZERO_LINGER",
      path: "/socketOptions/lingerMs",
      message: "Close can discard unsent messages when linger is zero.",
    });
  }
  if (config.schemaVersion === "1.1") {
    const { messaging } = config;
    if (messaging.extensions.includes("suicidal-snail")) messaging.maxAgeMs ??= 1000;
    if (messaging.extensions.includes("clone")) messaging.subtree ??= "";
  }
  const configuredOptions = Object.keys(config.socketOptions) as SocketOption[];
  for (const role of config.schemaVersion === "1.0" ? roles : []) {
    const active = activeSocketOptions(role);
    for (const option of configuredOptions) {
      if (!active.includes(option)) {
        diagnostics.push({
          severity: "warning",
          code: "INACTIVE_SOCKET_OPTION",
          path: `/socketOptions/${option}`,
          message: "Socket option is inactive for this role.",
          params: { role: role.id },
        });
      }
    }
  }

  return { ok: true, value: config, diagnostics: sortDiagnostics(diagnostics) };
}

export function validateConfig(input: unknown): ValidationResult {
  let data: unknown;
  try {
    data = snapshot(input);
  } catch {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "INVALID_JSON_INPUT",
          path: "",
          message: "Expected JSON data properties.",
        },
      ],
    };
  }

  const parsed = parseConfig(data);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostics: sortDiagnostics(parsed.errors.map(schemaDiagnostic)),
    };
  }
  if (exceedsSize(parsed.value)) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "INPUT_TOO_LARGE",
          path: "",
          message: "Configuration exceeds the UTF-8 size limit.",
          params: { maxBytes },
        },
      ],
    };
  }
  return checkSemantics(parsed.value);
}
