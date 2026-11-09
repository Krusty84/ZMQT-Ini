/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import generator from "../../package.json";
import type { LanguageAdapter } from "../adapters/types";
import { getCapabilities } from "../catalog/capabilities";
import type { GenerationPlan } from "../planning/ir";
import { validatePlan } from "../planning/validate";
import type { CoreResult, Diagnostic, GeneratedProject } from "../public/types";
import { sortDiagnostics } from "../validation/diagnostics";
import { validateArtifacts } from "./validate";

export function assembleProject(
  plan: GenerationPlan,
  adapter: LanguageAdapter,
): CoreResult<GeneratedProject> {
  const fail = (
    diagnostics: readonly Diagnostic[],
  ): CoreResult<GeneratedProject> => ({
    ok: false,
    diagnostics: sortDiagnostics([...plan.diagnostics, ...diagnostics]),
  });
  if (adapter.id !== plan.project.language) {
    return fail([
      {
        code: "IR_ADAPTER_MISMATCH",
        severity: "error",
        path: "/project/language",
        message: "Adapter does not match the project language.",
      },
    ]);
  }
  const diagnostics = validatePlan(plan, adapter.capabilities());
  if (diagnostics.length > 0) return fail(diagnostics);
  const language = getCapabilities().languages.find(
    ({ id }) => id === adapter.id,
  )!;
  if (
    !plan.dependencies.some(
      ({ id, version }) =>
        id === language.libraryId && version === language.libraryVersion,
    ) ||
    !adapter.templateVersion ||
    !adapter.dependencySetVersion
  ) {
    return fail([
      {
        code: "IR_UNSUPPORTED_DEPENDENCY_SET",
        severity: "error",
        path: "/dependencies",
        message: "Adapter versions do not match the supported dependency set.",
      },
    ]);
  }

  const files = [
    ...adapter.generate(plan),
    ...adapter.generateBuildFiles(plan),
    ...adapter.generateRuntimeConfig(plan),
    ...adapter.generateTests(plan),
    adapter.generateReadme(plan),
  ]
    .map(({ path, encoding, executable, content }) => ({
      path,
      encoding,
      executable,
      content: content.replace(/\r\n?/g, "\n"),
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  const outputDiagnostics = validateArtifacts(files, plan, adapter.layout);
  if (outputDiagnostics.length > 0) return fail(outputDiagnostics);

  return {
    ok: true,
    value: {
      manifest: {
        manifestVersion: 1,
        configSchemaVersion: "1.0",
        irVersion: plan.irVersion,
        generatorVersion: generator.version,
        language: plan.project.language,
        pattern: plan.project.pattern,
        templateVersion: adapter.templateVersion,
        dependencySetVersion: adapter.dependencySetVersion,
      },
      files,
    },
    diagnostics: plan.diagnostics,
  };
}
