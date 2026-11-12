/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { AdvancedConfig, BasicConfig, NormalizedConfig } from "../public/types";
import validate, { type SchemaIssue } from "./compiled-schema.js";
import validateAdvanced from "./compiled-schema-advanced.js";
import { optionalTcpSocketOptions } from "./socket-options";

export const configSchemaVersion: BasicConfig["schemaVersion"] = "2.0";

export function hasExtensions(messaging: unknown): messaging is Record<string, unknown> {
  return messaging !== null && typeof messaging === "object" && !Array.isArray(messaging) &&
    Object.hasOwn(messaging, "extensions");
}

export function isAdvancedConfig(config: NormalizedConfig): config is AdvancedConfig {
  return config.messaging.extensions !== undefined;
}

type SchemaResult =
  | { ok: true; value: NormalizedConfig }
  | { ok: false; errors: readonly SchemaIssue[] };

function commonFields(config: NormalizedConfig): Omit<BasicConfig, "schemaVersion"> {
  const { project, messaging, socketOptions } = config;
  const options: BasicConfig["socketOptions"] = {
    sendHwm: socketOptions.sendHwm,
    receiveHwm: socketOptions.receiveHwm,
    sendTimeoutMs: socketOptions.sendTimeoutMs,
    receiveTimeoutMs: socketOptions.receiveTimeoutMs,
    lingerMs: socketOptions.lingerMs,
  };
  for (const option of optionalTcpSocketOptions("connect")) {
    const value = socketOptions[option];
    if (value !== undefined) Object.assign(options, { [option]: value });
  }
  return {
    project: { name: project.name, language: project.language },
    messaging: {
      pattern: messaging.pattern,
      transport: messaging.transport,
      bindRole: messaging.bindRole,
      bindHost: messaging.bindHost,
      connectHost: messaging.connectHost,
      port: messaging.port,
    },
    socketOptions: options,
  };
}

export function parseConfig(input: unknown): SchemaResult {
  if (input && typeof input === "object" && !Array.isArray(input) &&
      hasExtensions((input as { messaging?: unknown }).messaging)) {
    if (!validateAdvanced(input)) {
      const errors = validateAdvanced.errors!;
      validateAdvanced.errors = null;
      return { ok: false, errors };
    }
    const common = commonFields(input);
    const { extensions, backup, maxAgeMs, subtree } = input.messaging;
    return {
      ok: true,
      value: {
        schemaVersion: configSchemaVersion,
        ...common,
        messaging: {
          ...common.messaging,
          pattern: "pub-sub",
          extensions: [...extensions].sort(),
          ...(maxAgeMs !== undefined && { maxAgeMs }),
          ...(subtree !== undefined && { subtree }),
          ...(backup && { backup: { bindHost: backup.bindHost, connectHost: backup.connectHost, port: backup.port } }),
        },
      },
    };
  }
  if (!validate(input)) {
    const errors = validate.errors!;
    validate.errors = null;
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      schemaVersion: configSchemaVersion,
      ...commonFields(input),
    },
  };
}
