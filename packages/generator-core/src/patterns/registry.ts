/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { NormalizedConfig } from "../public/types";

type Pattern = NormalizedConfig["messaging"]["pattern"];
type SocketRole = "req" | "rep" | "pub" | "sub" | "push" | "pull";
export type SocketType = Uppercase<SocketRole>;
export type SocketOption = keyof NormalizedConfig["socketOptions"];

export interface RoleDefinition {
  readonly id: SocketRole;
  readonly socketType: SocketType;
  readonly canSend: boolean;
  readonly canReceive: boolean;
  readonly requiresSubscription: boolean;
  readonly behaviorId: SocketRole;
}

export interface PatternDefinition {
  readonly id: Pattern;
  readonly roles: readonly [RoleDefinition, RoleDefinition];
  readonly permittedBindRoles: readonly string[];
}

function definePattern(
  id: Pattern,
  first: RoleDefinition,
  second: RoleDefinition,
): PatternDefinition {
  return {
    id,
    roles: [first, second],
    permittedBindRoles: [first.id, second.id],
  };
}

export const patternRegistry: Readonly<Record<Pattern, PatternDefinition>> = {
  "req-rep": definePattern(
    "req-rep",
    {
      id: "req",
      socketType: "REQ",
      canSend: true,
      canReceive: true,
      requiresSubscription: false,
      behaviorId: "req",
    },
    {
      id: "rep",
      socketType: "REP",
      canSend: true,
      canReceive: true,
      requiresSubscription: false,
      behaviorId: "rep",
    },
  ),
  "pub-sub": definePattern(
    "pub-sub",
    {
      id: "pub",
      socketType: "PUB",
      canSend: true,
      canReceive: false,
      requiresSubscription: false,
      behaviorId: "pub",
    },
    {
      id: "sub",
      socketType: "SUB",
      canSend: false,
      canReceive: true,
      requiresSubscription: true,
      behaviorId: "sub",
    },
  ),
  "push-pull": definePattern(
    "push-pull",
    {
      id: "push",
      socketType: "PUSH",
      canSend: true,
      canReceive: false,
      requiresSubscription: false,
      behaviorId: "push",
    },
    {
      id: "pull",
      socketType: "PULL",
      canSend: false,
      canReceive: true,
      requiresSubscription: false,
      behaviorId: "pull",
    },
  ),
};

export function activeSocketOptions(
  role: RoleDefinition,
): readonly SocketOption[] {
  const options: SocketOption[] = ["lingerMs"];
  if (role.canSend) options.push("sendHwm", "sendTimeoutMs");
  if (role.canReceive) options.push("receiveHwm", "receiveTimeoutMs");
  return options;
}
