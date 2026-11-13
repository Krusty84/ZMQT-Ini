/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import generator from "../../package.json";
import type { LanguageAdapter } from "../adapters/types";
import { generateAdvancedDocsAndTest, generateAdvancedSources } from "../adapters/advanced";
import { projectDependencies } from "../catalog/capabilities";
import { configSchemaVersion } from "../config/schema";
import { validatePubSubPlan, type ProjectPlan } from "../planning/pub-sub";
import { validatePlan } from "../planning/validate";
import type { CoreResult, Diagnostic, GeneratedProject } from "../public/types";
import { sortDiagnostics } from "../validation/diagnostics";
import { validateArtifacts } from "./validate";
import { runtimeConfigFile } from "./files";

export function assembleProject(
  plan: ProjectPlan,
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
  const diagnostics = plan.irVersion === "1.0"
    ? validatePlan(plan, adapter.capabilities()) : validatePubSubPlan(plan);
  if (diagnostics.length > 0) return fail(diagnostics);
  const expectedDependencies = projectDependencies(plan.project);
  if (
    plan.dependencies.length !== expectedDependencies.length ||
    !expectedDependencies.every(({ id, version }) =>
      plan.dependencies.some((dependency) => dependency.id === id && dependency.version === version)) ||
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

  const sources = plan.irVersion === "1.0"
    ? adapter.generate(plan) : generateAdvancedSources(plan, adapter.layout);
  const projectFiles = plan.irVersion === "1.0"
    ? [...adapter.generateRuntimeConfig(plan), ...adapter.generateTests(plan), adapter.generateReadme(plan)]
    : [runtimeConfigFile(plan), ...generateAdvancedDocsAndTest(plan)];
  const files = [...sources, ...adapter.generateBuildFiles(plan), ...projectFiles]
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

  const { serialization } = plan.project;
  return {
    ok: true,
    value: {
      manifest: {
        manifestVersion: 1,
        configSchemaVersion,
        ...(plan.irVersion === "1.0"
          ? { irVersion: "1.0" } as const
          : { irVersion: "1.1", extensions: plan.messaging.extensions } as const),
        generatorVersion: generator.version,
        language: plan.project.language,
        pattern: plan.project.pattern,
        ...(serialization && { serialization }),
        templateVersion: serialization === "cbor" ? "1.6.0" : adapter.templateVersion,
        dependencySetVersion: serialization === "cbor" ? "1.1.0" : adapter.dependencySetVersion,
      },
      files,
    },
    diagnostics: plan.diagnostics,
  };
}
