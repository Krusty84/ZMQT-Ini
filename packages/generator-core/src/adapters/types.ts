/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { GeneratedFile, NormalizedConfig } from "../public/types";
import type { GenerationPlan, LanguageCapabilities } from "../planning/ir";
import type { ProjectPlan } from "../planning/pub-sub";

export interface ArtifactLayout {
  entryPoint(role: string): string;
  readonly executableEntries: boolean;
  readonly supportFiles: readonly string[];
}

export interface LanguageAdapter {
  readonly id: NormalizedConfig["project"]["language"];
  readonly templateVersion: string;
  readonly dependencySetVersion: string;
  readonly layout: ArtifactLayout;
  capabilities(): LanguageCapabilities;
  generate(plan: GenerationPlan): readonly GeneratedFile[];
  generateBuildFiles(plan: ProjectPlan): readonly GeneratedFile[];
  generateRuntimeConfig(plan: GenerationPlan): readonly GeneratedFile[];
  generateTests(plan: GenerationPlan): readonly GeneratedFile[];
  generateReadme(plan: GenerationPlan): GeneratedFile;
}
