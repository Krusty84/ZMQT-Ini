/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type {
  CapabilityCatalog,
  CoreResult,
  GeneratedProject,
  ProjectSummary,
  ValidationResult,
} from "./types";

export interface CoreOperations {
  getCapabilities(): CapabilityCatalog;
  validateConfig(input: unknown): ValidationResult;
  inspectProject(input: unknown): CoreResult<ProjectSummary>;
  generateProject(input: unknown): CoreResult<GeneratedProject>;
}
