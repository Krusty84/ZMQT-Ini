/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import {
  projectDependencies,
  p0LanguageCapabilities,
} from "../catalog/capabilities";
import { buildBehavior } from "../patterns/behavior";
import { isAdvancedConfig } from "../config/schema";
import { patternRegistry, type RoleDefinition } from "../patterns/registry";
import type { BasicConfig, CoreResult, Diagnostic } from "../public/types";
import { compileTopology, type RolePlan } from "../topology/compiler";
import { buildLifecycle } from "../topology/lifecycle";
import { validateConfig } from "../validation/config";
import type { ApplicationPlan, GenerationPlan, ProjectSpec } from "./ir";
import { validatePlan } from "./validate";
import { compilePubSub, validatePubSubPlan, type ProjectPlan } from "./pub-sub";

const p0Capabilities = p0LanguageCapabilities();

function buildPlan(
  config: BasicConfig,
  diagnostics: readonly Diagnostic[],
): GenerationPlan {
  const { name, language } = config.project;
  const { pattern, serialization } = config.messaging;
  const project: ProjectSpec = { name, language, pattern, ...(serialization === "cbor" && { serialization }) };
  const topology = compileTopology(config);
  const definition = patternRegistry[pattern];

  const application = (
    role: RolePlan,
    roleDefinition: RoleDefinition,
  ): ApplicationPlan => ({
    ...role,
    lifecycle: buildLifecycle(language, roleDefinition),
    behavior: buildBehavior(role.socketType),
  });

  return {
    irVersion: "1.0",
    project,
    topology,
    dependencies: projectDependencies(project),
    applications: [
      application(topology.roles[0], definition.roles[0]),
      application(topology.roles[1], definition.roles[1]),
    ],
    files: [
      { kind: "application", role: topology.roles[0].role },
      { kind: "application", role: topology.roles[1].role },
      { kind: "runtime-config" },
      { kind: "codec" },
      { kind: "build" },
      { kind: "test" },
      { kind: "readme" },
    ],
    diagnostics,
  };
}

export function planProject(input: unknown): CoreResult<ProjectPlan> {
  const validation = validateConfig(input);
  if (!validation.ok) return validation;

  const plan = isAdvancedConfig(validation.value)
    ? compilePubSub(validation.value, validation.diagnostics)
    : buildPlan(validation.value, validation.diagnostics);
  const diagnostics = plan.irVersion === "1.0" ? validatePlan(plan, p0Capabilities) : validatePubSubPlan(plan);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return { ok: true, value: plan, diagnostics: validation.diagnostics };
}
