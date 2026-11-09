/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { RoleDefinition } from "../patterns/registry";
import type { NormalizedConfig } from "../public/types";

type StartupStep =
  | {
      readonly op:
        | "load-runtime-config"
        | "validate-runtime-config"
        | "create-context"
        | "create-socket"
        | "apply-options"
        | "bind-or-connect"
        | "emit-ready"
        | "execute-pattern";
    }
  | { readonly op: "apply-subscription"; readonly prefix: "" };

type CleanupStep =
  | {
      readonly op: "apply-linger" | "close-socket";
      readonly ifCreated: "socket";
    }
  | { readonly op: "close-context"; readonly ifCreated: "context" }
  | { readonly op: "stop" };

export interface LifecyclePlan {
  readonly startup: readonly StartupStep[];
  readonly cleanup: readonly CleanupStep[];
  readonly cleanupOn: "always";
  readonly continueCleanupOnError: true;
  readonly shutdown: {
    readonly signals: readonly ["SIGINT", "SIGTERM"];
    readonly handler: "set-flag";
    readonly waiting: "interruptible";
  };
}

export function buildLifecycle(
  language: NormalizedConfig["project"]["language"],
  role: RoleDefinition,
): LifecyclePlan {
  const hasContext = language !== "node";
  const startup: StartupStep[] = [
    { op: "load-runtime-config" },
    { op: "validate-runtime-config" },
  ];
  if (hasContext) startup.push({ op: "create-context" });
  startup.push({ op: "create-socket" }, { op: "apply-options" });
  if (role.requiresSubscription)
    startup.push({ op: "apply-subscription", prefix: "" });
  startup.push(
    { op: "bind-or-connect" },
    { op: "emit-ready" },
    { op: "execute-pattern" },
  );

  const cleanup: CleanupStep[] = [
    { op: "apply-linger", ifCreated: "socket" },
    { op: "close-socket", ifCreated: "socket" },
  ];
  if (hasContext) cleanup.push({ op: "close-context", ifCreated: "context" });
  cleanup.push({ op: "stop" });

  return {
    startup,
    cleanup,
    cleanupOn: "always",
    continueCleanupOnError: true,
    shutdown: {
      signals: ["SIGINT", "SIGTERM"],
      handler: "set-flag",
      waiting: "interruptible",
    },
  };
}
