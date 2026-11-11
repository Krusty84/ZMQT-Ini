/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { BasicConfig, NormalizedConfig } from "../public/types";
import validate, { type SchemaIssue } from "./compiled-schema.js";
import validateAdvanced from "./compiled-schema-1.1.js";

type SchemaResult =
  | { ok: true; value: NormalizedConfig }
  | { ok: false; errors: readonly SchemaIssue[] };

function commonFields(config: NormalizedConfig): Omit<BasicConfig, "schemaVersion"> {
  const { project, messaging, socketOptions } = config;
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
    socketOptions: {
      sendHwm: socketOptions.sendHwm,
      receiveHwm: socketOptions.receiveHwm,
      sendTimeoutMs: socketOptions.sendTimeoutMs,
      receiveTimeoutMs: socketOptions.receiveTimeoutMs,
      lingerMs: socketOptions.lingerMs,
    },
  };
}

export function parseConfig(input: unknown): SchemaResult {
  if (input && typeof input === "object" && !Array.isArray(input) &&
      (input as { schemaVersion?: unknown }).schemaVersion === "1.1") {
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
        schemaVersion: "1.1",
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
      schemaVersion: "1.0",
      ...commonFields(input),
    },
  };
}
