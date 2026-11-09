/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

type Language = "python" | "cpp" | "java" | "node";
type Pattern = "req-rep" | "pub-sub" | "push-pull";

export interface CapabilityCatalog {
  catalogVersion: 1;
  configSchemaVersion: "1.0";
  irVersion: "1.0";
  languages: readonly {
    id: Language;
    libraryId: string;
    libraryVersion: string;
    languageVersion: string;
    patterns: readonly Pattern[];
  }[];
  patterns: readonly {
    id: Pattern;
    bindRoles: readonly string[];
  }[];
  transports: readonly ["tcp"];
  socketOptionRanges: Readonly<Record<string, { min: number; max: number }>>;
}

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  path: string;
  message: string;
  params?: Readonly<Record<string, string | number | boolean>>;
}

export type CoreResult<T> =
  | { ok: true; value: T; diagnostics: readonly Diagnostic[] }
  | { ok: false; diagnostics: readonly Diagnostic[] };

export type ValidationResult = CoreResult<NormalizedConfig>;

export interface NormalizedConfig {
  schemaVersion: "1.0";
  project: {
    name: string;
    language: Language;
  };
  messaging: {
    pattern: Pattern;
    transport: "tcp";
    bindRole: string;
    bindHost: string;
    connectHost: string;
    port: number;
  };
  socketOptions: {
    sendHwm: number;
    receiveHwm: number;
    sendTimeoutMs: number;
    receiveTimeoutMs: number;
    lingerMs: number;
  };
}

export interface GeneratedFile {
  path: string;
  encoding: "utf-8";
  content: string;
  executable: boolean;
}

export interface GenerationManifest {
  manifestVersion: 1;
  configSchemaVersion: "1.0";
  irVersion: "1.0";
  generatorVersion: string;
  language: Language;
  pattern: Pattern;
  templateVersion: string;
  dependencySetVersion: string;
}

export interface GeneratedProject {
  manifest: GenerationManifest;
  files: readonly GeneratedFile[];
}

export interface ProjectSummary {
  projectName: string;
  language: Language;
  pattern: Pattern;
  roles: readonly {
    role: string;
    socketType: string;
    mode: "bind" | "connect";
    endpoint: string;
  }[];
}
