/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import {
  getCapabilities,
  p0LanguageCapabilities,
} from "../catalog/capabilities";
import { buildBehavior } from "../patterns/behavior";
import { patternRegistry, type RoleDefinition } from "../patterns/registry";
import type { CoreResult, Diagnostic, NormalizedConfig } from "../public/types";
import { compileTopology, type RolePlan } from "../topology/compiler";
import { buildLifecycle } from "../topology/lifecycle";
import { validateConfig } from "../validation/config";
import type { ApplicationPlan, GenerationPlan } from "./ir";
import { validatePlan } from "./validate";

const p0Capabilities = p0LanguageCapabilities();

function buildPlan(
  config: NormalizedConfig,
  diagnostics: readonly Diagnostic[],
): GenerationPlan {
  const { name, language } = config.project;
  const { pattern } = config.messaging;
  const topology = compileTopology(config);
  const definition = patternRegistry[pattern];
  const { libraryId, libraryVersion } = getCapabilities().languages.find(
    ({ id }) => id === language,
  )!;

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
    project: { name, language, pattern },
    topology,
    dependencies: [{ id: libraryId, version: libraryVersion }],
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

export function planProject(input: unknown): CoreResult<GenerationPlan> {
  const validation = validateConfig(input);
  if (!validation.ok) return validation;

  const plan = buildPlan(validation.value, validation.diagnostics);
  const diagnostics = validatePlan(plan, p0Capabilities);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return { ok: true, value: plan, diagnostics: validation.diagnostics };
}
