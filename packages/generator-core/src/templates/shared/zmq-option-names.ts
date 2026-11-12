/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const zmqOptionNames = {
  sendHwm: "SNDHWM",
  receiveHwm: "RCVHWM",
  sendTimeoutMs: "SNDTIMEO",
  receiveTimeoutMs: "RCVTIMEO",
  lingerMs: "LINGER",
  reconnectIntervalMs: "RECONNECT_IVL",
  reconnectMaxIntervalMs: "RECONNECT_IVL_MAX",
  heartbeatIntervalMs: "HEARTBEAT_IVL",
  heartbeatTimeoutMs: "HEARTBEAT_TIMEOUT",
  maxFrameBytes: "MAXMSGSIZE",
  handshakeTimeoutMs: "HANDSHAKE_IVL",
  immediate: "IMMEDIATE",
} as const;
