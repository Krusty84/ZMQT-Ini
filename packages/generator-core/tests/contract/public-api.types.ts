/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type {
  CapabilityCatalog,
  CoreResult,
  Diagnostic,
  DiagnosticSeverity,
  GeneratedFile,
  GeneratedProject,
  generateProject,
  GenerationManifest,
  getCapabilities,
  inspectProject,
  NormalizedConfig,
  ProjectSummary,
  validateConfig,
  ValidationResult,
} from "@zmqt-ini/generator-core";
import type { CoreOperations } from "../../dist/public/operations";

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right
    ? 1
    : 2
    ? true
    : false;

type Assert<Condition extends true> = Condition;

type PublicApiContract = [
  Assert<Equal<CoreOperations["getCapabilities"], () => CapabilityCatalog>>,
  Assert<
    Equal<
      CoreOperations["validateConfig"],
      (input: unknown) => ValidationResult
    >
  >,
  Assert<
    Equal<
      CoreOperations["inspectProject"],
      (input: unknown) => CoreResult<ProjectSummary>
    >
  >,
  Assert<
    Equal<
      CoreOperations["generateProject"],
      (input: unknown) => CoreResult<GeneratedProject>
    >
  >,
  Assert<Equal<typeof getCapabilities, CoreOperations["getCapabilities"]>>,
  Assert<Equal<typeof inspectProject, CoreOperations["inspectProject"]>>,
  Assert<Equal<typeof generateProject, CoreOperations["generateProject"]>>,
  Assert<Equal<typeof validateConfig, CoreOperations["validateConfig"]>>,
  Assert<Equal<ValidationResult, CoreResult<NormalizedConfig>>>,
  Assert<Equal<NormalizedConfig["schemaVersion"], "2.0">>,
  Assert<Equal<Pick<NormalizedConfig["socketOptions"], "handshakeTimeoutMs">, { handshakeTimeoutMs?: number }>>,
  Assert<Equal<Pick<NormalizedConfig["socketOptions"], "immediate">, { immediate?: boolean }>>,
  Assert<
    Equal<
      CoreResult<NormalizedConfig>,
      | {
          ok: true;
          value: NormalizedConfig;
          diagnostics: readonly Diagnostic[];
        }
      | { ok: false; diagnostics: readonly Diagnostic[] }
    >
  >,
  Assert<Equal<Diagnostic["severity"], DiagnosticSeverity>>,
  Assert<Equal<DiagnosticSeverity, "error" | "warning">>,
  Assert<Equal<GeneratedProject["manifest"], GenerationManifest>>,
  Assert<Equal<GeneratedProject["files"], readonly GeneratedFile[]>>,
];
