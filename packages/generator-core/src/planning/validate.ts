/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { getCapabilities } from "../catalog/capabilities";
import {
  activeSocketOptions,
  patternRegistry,
  type RoleDefinition,
  type SocketOption,
} from "../patterns/registry";
import type { Diagnostic } from "../public/types";
import { sortDiagnostics } from "../validation/diagnostics";
import { formatEndpointUri, type RolePlan } from "../topology/compiler";
import { buildLifecycle, type LifecyclePlan } from "../topology/lifecycle";
import { classifyHost } from "../validation/hosts";
import type { GenerationPlan, LanguageCapabilities } from "./ir";
import { validateBehavior, type Report } from "./validate-behavior";

function equalRecords<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as (keyof T)[];
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}

function equalSteps<T extends object>(
  actual: readonly T[],
  expected: readonly T[],
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((step, index) => equalRecords(actual[index], step))
  );
}

function checkLifecycle(
  actual: LifecyclePlan,
  expected: LifecyclePlan,
  path: string,
  report: Report,
): void {
  if (!equalSteps(actual.startup, expected.startup)) {
    report(
      "IR_INVALID_STARTUP",
      `${path}/startup`,
      "Startup must initialize the resources in order before exchange.",
    );
  }
  if (
    !equalSteps(actual.cleanup, expected.cleanup) ||
    actual.cleanupOn !== "always" ||
    actual.continueCleanupOnError !== true
  ) {
    report(
      "IR_INVALID_CLEANUP",
      `${path}/cleanup`,
      "Cleanup must always release created resources in reverse order, even after errors.",
    );
  }
  const { signals, handler, waiting } = actual.shutdown;
  if (
    handler !== expected.shutdown.handler ||
    waiting !== expected.shutdown.waiting ||
    signals.length !== expected.shutdown.signals.length ||
    !expected.shutdown.signals.every(
      (signal, index) => signals[index] === signal,
    )
  ) {
    report(
      "IR_INVALID_SHUTDOWN",
      `${path}/shutdown`,
      "Shutdown must set a flag and interrupt the wait on SIGINT and SIGTERM.",
    );
  }
}

function checkOptions(
  application: RolePlan,
  role: RoleDefinition,
  path: string,
  capabilities: LanguageCapabilities,
  report: Report,
): void {
  const active = activeSocketOptions(role);
  const ranges = getCapabilities().socketOptionRanges;
  const options = Object.entries(application.options);
  for (const option of active) {
    if (!Object.hasOwn(application.options, option)) {
      report(
        "IR_MISSING_SOCKET_OPTION",
        `${path}/${option}`,
        "An active socket option is missing.",
      );
    }
  }
  for (const [option, value] of options) {
    const optionPath = `${path}/${option.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (!capabilities.socketOptions.includes(option)) {
      report(
        "IR_UNSUPPORTED_SOCKET_OPTION",
        optionPath,
        "The adapter does not support this socket option.",
      );
    }
    if (!active.includes(option as SocketOption)) {
      report(
        "IR_INACTIVE_SOCKET_OPTION",
        optionPath,
        "The socket does not use this option.",
      );
      continue;
    }
    const { min, max } = ranges[option];
    if (!Number.isInteger(value) || value < min || value > max) {
      report(
        "IR_INVALID_SOCKET_OPTION",
        optionPath,
        "The socket option is outside its range.",
        { min, max },
      );
    }
  }
}

export function validatePlan(
  plan: GenerationPlan,
  capabilities: LanguageCapabilities,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report: Report = (code, path, message, params) => {
    diagnostics.push({
      code,
      path,
      message,
      severity: "error",
      ...(params === undefined ? {} : { params }),
    });
  };
  if (
    plan.irVersion !== "1.0" ||
    !capabilities.irVersions.includes(plan.irVersion)
  ) {
    report("IR_UNSUPPORTED_VERSION", "/irVersion", "Unsupported IR version.", {
      version: plan.irVersion,
    });
    return diagnostics;
  }

  const { pattern, language } = plan.project;
  if (!Object.hasOwn(patternRegistry, pattern)) {
    report(
      "IR_UNSUPPORTED_PATTERN",
      "/project/pattern",
      "Unsupported messaging pattern.",
    );
    return diagnostics;
  }
  const definition = patternRegistry[pattern];
  const { roles, transport } = plan.topology;
  if (
    transport !== "tcp" ||
    roles.length !== 2 ||
    !definition.roles.every(({ id, socketType }) =>
      roles.some((role) => role.role === id && role.socketType === socketType),
    ) ||
    !roles.some(({ endpoint }) => endpoint.mode === "bind") ||
    !roles.some(({ endpoint }) => endpoint.mode === "connect") ||
    roles[0].endpoint.port !== roles[1].endpoint.port
  ) {
    report(
      "IR_INVALID_TOPOLOGY",
      "/topology",
      "The topology must contain both roles, with one TCP bind and one connect on the same port.",
    );
  }
  for (const [index, { endpoint }] of roles.entries()) {
    const { mode, host, port, uri } = endpoint;
    const address = classifyHost(host);
    if (
      address === undefined ||
      (mode === "connect" && address === "unspecified") ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      uri !== formatEndpointUri(host, port)
    ) {
      report(
        "IR_INVALID_ENDPOINT",
        `/topology/roles/${index}/endpoint`,
        "The endpoint must use a valid host, port and TCP URI for its mode.",
      );
    }
  }

  if (
    plan.applications.length !== 2 ||
    new Set(plan.applications.map(({ role }) => role)).size !== 2
  ) {
    report(
      "IR_INVALID_APPLICATIONS",
      "/applications",
      "The plan must have one application for each role.",
    );
  }
  for (const [index, application] of plan.applications.entries()) {
    const path = `/applications/${index}`;
    const topologyRole = roles.find(({ role }) => role === application.role);
    const definitionRole = definition.roles.find(
      ({ id }) => id === application.role,
    );
    if (
      !definitionRole ||
      !topologyRole ||
      application.socketType !== topologyRole.socketType ||
      !equalRecords(application.endpoint, topologyRole.endpoint) ||
      !equalRecords(application.options, topologyRole.options)
    ) {
      report(
        "IR_APPLICATION_TOPOLOGY_MISMATCH",
        path,
        "Application does not match its role in the topology.",
      );
    }
    if (!capabilities.socketTypes.includes(application.socketType)) {
      report(
        "IR_UNSUPPORTED_SOCKET",
        `${path}/socketType`,
        "The adapter does not support this socket type.",
        { socketType: application.socketType },
      );
    }
    if (!definitionRole) continue;

    checkOptions(
      application,
      definitionRole,
      `${path}/options`,
      capabilities,
      report,
    );
    checkLifecycle(
      application.lifecycle,
      buildLifecycle(language, definitionRole),
      `${path}/lifecycle`,
      report,
    );
    validateBehavior(
      application.behavior,
      `${path}/behavior`,
      definitionRole,
      pattern,
      capabilities,
      report,
    );
  }
  return sortDiagnostics(diagnostics);
}
