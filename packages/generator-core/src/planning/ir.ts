/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { Diagnostic, NormalizedConfig } from "../public/types";
import type { LifecyclePlan } from "../topology/lifecycle";
import type { RolePlan, TopologyPlan } from "../topology/compiler";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type MessageType = "request" | "response" | "error" | "event" | "task";
export type BehaviorOutcome =
  | "ok"
  | "timeout"
  | "invalid"
  | "error"
  | "shutdown";

type MessageIdSource =
  // Sequence starts at 1. Use msg-0001, or use the test run ID as the prefix.
  | { kind: "sequence" }
  | { kind: "message"; from: string }
  | { kind: "id"; from: string };

type PayloadSource =
  | { kind: "literal"; value: JsonValue }
  // The example payload is { value: 42 }, with runId when enabled in a test run.
  | { kind: "example"; includeTestRunId: boolean }
  | { kind: "message"; from: string };

type ErrorEvent =
  | "SEND_TIMEOUT"
  | "RECEIVE_TIMEOUT"
  | "PROTOCOL_ERROR"
  | "TRANSPORT_ERROR";

export type BehaviorOperation =
  | {
      op: "build";
      messageType: MessageType;
      id: MessageIdSource;
      payload: PayloadSource;
      to: string;
    }
  | { op: "encode"; from: string; to: string }
  | { op: "decode"; from: string; to: string }
  | { op: "validate"; check: "id"; from: string; to: string }
  | {
      op: "validate";
      check: "message";
      from: string;
      to: string;
      messageTypes: readonly MessageType[];
      matchesIdOf?: string;
    }
  | { op: "send"; from: string }
  | { op: "receive"; to: string }
  | { op: "process"; from: string; to: string }
  | { op: "wait"; milliseconds: number }
  | { op: "log"; event: ErrorEvent }
  | {
      op: "log";
      event: "RESPONSE_RECEIVED" | "MESSAGE_RECEIVED" | "TASK_PROCESSED";
      from: string;
    }
  | { op: "stop"; exitCode: number };

export interface BehaviorNode {
  id: string;
  operation: BehaviorOperation;
  transitions: Partial<Record<BehaviorOutcome, string>>;
}

export interface BehaviorPlan {
  version: 1;
  entry: string;
  nodes: readonly BehaviorNode[];
}

export interface ProjectSpec {
  name: string;
  language: NormalizedConfig["project"]["language"];
  pattern: NormalizedConfig["messaging"]["pattern"];
}

export interface DependencySpec {
  id: string;
  version: string;
}

export type FilePlan =
  | { kind: "application"; role: string }
  | { kind: "runtime-config" | "codec" | "build" | "test" | "readme" };

export interface ApplicationPlan extends RolePlan {
  lifecycle: LifecyclePlan;
  behavior: BehaviorPlan;
}

export interface GenerationPlan {
  irVersion: "1.0";
  project: ProjectSpec;
  topology: TopologyPlan;
  dependencies: readonly DependencySpec[];
  applications: readonly [ApplicationPlan, ApplicationPlan];
  files: readonly FilePlan[];
  diagnostics: readonly Diagnostic[];
}

export interface LanguageCapabilities {
  irVersions: readonly string[];
  operations: readonly BehaviorOperation["op"][];
  socketTypes: readonly string[];
  socketOptions: readonly string[];
}
