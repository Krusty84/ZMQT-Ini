/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { planProject } from "../planning/build";
import type { CoreResult, ProjectSummary } from "./types";

export function inspectProject(input: unknown): CoreResult<ProjectSummary> {
  const result = planProject(input);
  if (!result.ok) return result;

  const { project, topology } = result.value;
  return {
    ok: true,
    value: {
      projectName: project.name,
      language: project.language,
      pattern: project.pattern,
      roles: topology.roles.map(({ role, socketType, endpoint }) => ({
        role,
        socketType,
        mode: endpoint.mode,
        endpoint: endpoint.uri,
      })),
    },
    diagnostics: result.diagnostics,
  };
}
