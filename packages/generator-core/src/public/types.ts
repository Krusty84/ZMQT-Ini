/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

type Language = "python" | "cpp" | "java" | "node";
type Pattern = "req-rep" | "pub-sub" | "push-pull";
type ConfigSchemaVersion = "2.0";

export type PubSubExtension =
  | "espresso"
  | "last-value-caching"
  | "suicidal-snail"
  | "black-box"
  | "clone"
  | "binary-star";

export interface CapabilityCatalog {
  catalogVersion: 1;
  configSchemaVersion: ConfigSchemaVersion;
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
  serializations: readonly ["json", "cbor"];
  socketOptionRanges: Readonly<Record<string, { min: number; max: number }>>;
  pubSubExtensions: {
    configSchemaVersion: ConfigSchemaVersion;
    irVersion: "1.1";
    languages: readonly Language[];
    combinations: readonly {
      extensions: readonly PubSubExtension[];
      bindRoles: readonly string[];
    }[];
  };
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

export interface BasicConfig {
  schemaVersion: ConfigSchemaVersion;
  project: {
    name: string;
    language: Language;
  };
  messaging: {
    pattern: Pattern;
    serialization?: "json" | "cbor";
    transport: "tcp";
    bindRole: string;
    bindHost: string;
    connectHost: string;
    port: number;
    extensions?: never;
  };
  socketOptions: {
    sendHwm: number;
    receiveHwm: number;
    sendTimeoutMs: number;
    receiveTimeoutMs: number;
    lingerMs: number;
    reconnectIntervalMs?: number;
    reconnectMaxIntervalMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    maxFrameBytes?: number;
    handshakeTimeoutMs?: number;
    immediate?: boolean;
  };
}

export interface AdvancedConfig extends Omit<BasicConfig, "messaging"> {
  messaging: Omit<BasicConfig["messaging"], "pattern" | "extensions"> & {
    pattern: "pub-sub";
    extensions: readonly PubSubExtension[];
    maxAgeMs?: number;
    subtree?: string;
    backup?: Pick<BasicConfig["messaging"], "bindHost" | "connectHost" | "port">;
  };
}

export type NormalizedConfig = BasicConfig | AdvancedConfig;

export interface GeneratedFile {
  path: string;
  encoding: "utf-8";
  content: string;
  executable: boolean;
}

interface ManifestFields {
  manifestVersion: 1;
  generatorVersion: string;
  configSchemaVersion: ConfigSchemaVersion;
  language: Language;
  pattern: Pattern;
  serialization?: "cbor";
  templateVersion: string;
  dependencySetVersion: string;
}

export type GenerationManifest = ManifestFields & (
  | { irVersion: "1.0" }
  | { irVersion: "1.1"; extensions: readonly PubSubExtension[] }
);

export interface GeneratedProject {
  manifest: GenerationManifest;
  files: readonly GeneratedFile[];
}

export interface ProjectSummary {
  projectName: string;
  language: Language;
  pattern: Pattern;
  serialization?: "cbor";
  extensions?: readonly PubSubExtension[];
  roles: readonly {
    role: string;
    socket?: string;
    socketType: string;
    mode: "bind" | "connect";
    endpoint: string;
  }[];
}
