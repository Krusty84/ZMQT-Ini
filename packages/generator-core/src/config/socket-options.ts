/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import schema from "../../resources/config.schema.json";
import type { BasicConfig } from "../public/types";

const connectOptions = ["reconnectIntervalMs", "reconnectMaxIntervalMs", "immediate"] as const;
const tcpOptions = ["heartbeatIntervalMs", "heartbeatTimeoutMs", "maxFrameBytes", "handshakeTimeoutMs"] as const;

export const socketOptionSchema = schema.properties.socketOptions;
export const socketOptionDefinitions = (
  Object.keys(socketOptionSchema.properties) as (keyof typeof socketOptionSchema.properties)[]
).map((name) => {
  const option = socketOptionSchema.properties[name];
  return {
    name,
    bounds: "minimum" in option ? { minimum: option.minimum, maximum: option.maximum } : undefined,
    required: socketOptionSchema.required.includes(name),
  };
});
export const defaultReconnectIntervalMs = 100;

export function optionalTcpSocketOptions(mode: "bind" | "connect") {
  return mode === "connect" ? [...connectOptions, ...tcpOptions] : tcpOptions;
}

export function invalidSocketOptionCombinations(options: Partial<BasicConfig["socketOptions"]>) {
  const { reconnectIntervalMs, reconnectMaxIntervalMs, heartbeatIntervalMs, heartbeatTimeoutMs } = options;
  const invalid: { option: keyof BasicConfig["socketOptions"]; message: string }[] = [];
  const initial = reconnectIntervalMs ?? defaultReconnectIntervalMs;
  if (reconnectMaxIntervalMs !== undefined && reconnectMaxIntervalMs > 0 && reconnectMaxIntervalMs < initial) {
    invalid.push({
      option: "reconnectMaxIntervalMs",
      message: "The maximum reconnect interval must be zero or at least the initial interval.",
    });
  }
  if (heartbeatTimeoutMs !== undefined && (heartbeatIntervalMs ?? 0) === 0) {
    invalid.push({
      option: "heartbeatTimeoutMs",
      message: "The heartbeat timeout requires a positive heartbeat interval.",
    });
  }
  return invalid;
}
