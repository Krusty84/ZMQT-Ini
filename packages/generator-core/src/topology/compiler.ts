/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { optionalTcpSocketOptions, socketOptionSchema } from "../config/socket-options";
import { activeSocketOptions, patternRegistry } from "../patterns/registry";
import type { RoleDefinition, SocketType } from "../patterns/registry";
import type { NormalizedConfig } from "../public/types";

export interface EndpointPlan {
  readonly mode: "bind" | "connect";
  readonly host: string;
  readonly port: number;
  readonly uri: string;
}

type SocketOptions = NormalizedConfig["socketOptions"];
export type SocketOptionsPlan = Partial<SocketOptions> &
  Pick<SocketOptions, "lingerMs">;

export interface RolePlan {
  readonly role: string;
  readonly socketType: SocketType;
  readonly endpoint: EndpointPlan;
  readonly options: Readonly<SocketOptionsPlan>;
}

export interface TopologyPlan {
  readonly transport: "tcp";
  readonly roles: readonly [RolePlan, RolePlan];
}

export function formatEndpointUri(host: string, port: number): string {
  const uriHost = host.includes(":") ? `[${host}]` : host;
  return `tcp://${uriHost}:${port}`;
}

export function runtimeSocketOptionNames({ options, endpoint }: RolePlan): readonly string[] {
  const required = Object.keys(options).filter((option) => socketOptionSchema.required.includes(option));
  return [...required, ...optionalTcpSocketOptions(endpoint.mode)];
}

export function compileTopology(config: NormalizedConfig): TopologyPlan {
  const { pattern, transport, bindRole, bindHost, connectHost, port } =
    config.messaging;
  const [first, second] = patternRegistry[pattern].roles;

  function compileRole(role: RoleDefinition): RolePlan {
    const mode = role.id === bindRole ? "bind" : "connect";
    const host = mode === "bind" ? bindHost : connectHost;
    const endpoint: EndpointPlan = {
      mode,
      host,
      port,
      uri: formatEndpointUri(host, port),
    };

    const options: SocketOptionsPlan = {
      lingerMs: config.socketOptions.lingerMs,
    };
    for (const option of [...activeSocketOptions(role), ...optionalTcpSocketOptions(mode)]) {
      const value = config.socketOptions[option];
      if (value !== undefined) Object.assign(options, { [option]: value });
    }

    return { role: role.id, socketType: role.socketType, endpoint, options };
  }

  return { transport, roles: [compileRole(first), compileRole(second)] };
}
