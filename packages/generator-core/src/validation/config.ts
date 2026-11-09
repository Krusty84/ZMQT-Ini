/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { parseConfig } from "../config/schema";
import type { SchemaIssue } from "../config/compiled-schema.js";
import { activeSocketOptions, patternRegistry } from "../patterns/registry";
import type { SocketOption } from "../patterns/registry";
import type {
  Diagnostic,
  NormalizedConfig,
  ValidationResult,
} from "../public/types";
import { sortDiagnostics } from "./diagnostics";
import { classifyHost } from "./hosts";
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
      const [code, message] = unsupportedValues[path];
      return { severity, code, path, message };
    }
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

function checkSemantics(config: NormalizedConfig): ValidationResult {
  const { pattern, bindRole, bindHost, connectHost } = config.messaging;
  const { roles, permittedBindRoles } = patternRegistry[pattern];
  const diagnostics: Diagnostic[] = [];
  if (!permittedBindRoles.includes(bindRole)) {
    diagnostics.push({
      severity: "error",
      code: "INVALID_BIND_ROLE",
      path: "/messaging/bindRole",
      message: "Bind role does not belong to the pattern.",
      params: { pattern },
    });
  }

  const bind = classifyHost(bindHost);
  const connect = classifyHost(connectHost);
  if (!bind) {
    diagnostics.push({
      severity: "error",
      code: "INVALID_HOST",
      path: "/messaging/bindHost",
      message: "Invalid bind host.",
    });
  }
  if (!connect) {
    diagnostics.push({
      severity: "error",
      code: "INVALID_HOST",
      path: "/messaging/connectHost",
      message: "Invalid connect host.",
    });
  } else if (connect === "unspecified") {
    diagnostics.push({
      severity: "error",
      code: "UNSPECIFIED_CONNECT_HOST",
      path: "/messaging/connectHost",
      message: "Connect requires a destination address.",
    });
  }

  if (diagnostics.length > 0)
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };

  if (bind !== "loopback") {
    diagnostics.push({
      severity: "warning",
      code: "UNENCRYPTED_EXTERNAL_BIND",
      path: "/messaging/bindHost",
      message: "Binding outside loopback exposes unencrypted traffic.",
    });
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
  const configuredOptions = Object.keys(config.socketOptions) as SocketOption[];
  for (const role of roles) {
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
