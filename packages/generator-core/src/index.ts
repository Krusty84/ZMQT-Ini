/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export { getCapabilities } from "./catalog/capabilities";
export { generateProject } from "./public/generate";
export { inspectProject } from "./public/inspect";
export { validateConfig } from "./validation/config";
export type {
  CapabilityCatalog,
  AdvancedConfig,
  BasicConfig,
  CoreResult,
  Diagnostic,
  DiagnosticSeverity,
  GeneratedFile,
  GeneratedProject,
  GenerationManifest,
  NormalizedConfig,
  ProjectSummary,
  PubSubExtension,
  ValidationResult,
} from "./public/types";
