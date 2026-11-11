/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { ProjectPlan } from "../planning/pub-sub";
import type { GeneratedFile } from "../public/types";

export function textFile(
  path: string,
  content: string,
  executable = false,
): GeneratedFile {
  return { path, encoding: "utf-8", content, executable };
}

export function runtimeConfigFile(plan: ProjectPlan): GeneratedFile {
  if (plan.irVersion === "1.1") {
    const { bindHost, connectHost, port, backup, maxAgeMs, subtree } = plan.messaging;
    const config = { bindHost, connectHost, port, socketOptions: plan.socketOptions, backup, maxAgeMs, subtree };
    return textFile("config/zmq.json", `${JSON.stringify(config, null, 2)}\n`);
  }
  const [first, second] = plan.topology.roles;
  const [bind, connect] =
    first.endpoint.mode === "bind" ? [first, second] : [second, first];
  const config = {
    bindHost: bind.endpoint.host,
    connectHost: connect.endpoint.host,
    port: bind.endpoint.port,
    socketOptions: { ...first.options, ...second.options },
  };
  return textFile("config/zmq.json", `${JSON.stringify(config, null, 2)}\n`);
}
