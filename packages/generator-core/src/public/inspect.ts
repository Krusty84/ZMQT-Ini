/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { planProject } from "../planning/build";
import type { CoreResult, ProjectSummary } from "./types";

export function inspectProject(input: unknown): CoreResult<ProjectSummary> {
  const result = planProject(input);
  if (!result.ok) return result;

  const plan = result.value;
  const { project } = plan;
  return {
    ok: true,
    value: {
      projectName: project.name,
      language: project.language,
      pattern: project.pattern,
      ...(plan.irVersion === "1.1" && { extensions: plan.messaging.extensions }),
      roles: plan.irVersion === "1.0"
        ? plan.topology.roles.map(({ role, socketType, endpoint }) => ({
            role, socketType, mode: endpoint.mode, endpoint: endpoint.uri,
          }))
        : plan.applications.flatMap(({ role, sockets }) => sockets.map(({ name, type, mode, endpoint }) => ({
            role, socket: name, socketType: type, mode, endpoint,
          }))),
    },
    diagnostics: result.diagnostics,
  };
}
