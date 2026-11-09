/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { NormalizedConfig } from "../public/types";
import validate, { type SchemaIssue } from "./compiled-schema.js";

type SchemaResult =
  | { ok: true; value: NormalizedConfig }
  | { ok: false; errors: readonly SchemaIssue[] };

export function parseConfig(input: unknown): SchemaResult {
  if (!validate(input)) {
    const errors = validate.errors!;
    validate.errors = null;
    return { ok: false, errors };
  }

  const { schemaVersion, project, messaging, socketOptions } = input;
  return {
    ok: true,
    value: {
      schemaVersion,
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
    },
  };
}
