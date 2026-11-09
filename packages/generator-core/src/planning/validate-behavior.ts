/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { RoleDefinition } from "../patterns/registry";
import type { Diagnostic } from "../public/types";
import type {
  BehaviorOperation,
  BehaviorOutcome,
  BehaviorPlan,
  LanguageCapabilities,
  MessageType,
  ProjectSpec,
} from "./ir";

export type Report = (
  code: string,
  path: string,
  message: string,
  params?: Diagnostic["params"],
) => void;

type Edge = [outcome: BehaviorOutcome, target: string];

interface Node {
  path: string;
  operation: BehaviorOperation;
  edges: readonly Edge[];
}

const outcomes = {
  build: ["ok"],
  encode: ["ok"],
  decode: ["ok", "invalid"],
  validate: ["ok", "invalid"],
  send: ["ok", "timeout", "error", "shutdown"],
  receive: ["ok", "timeout", "error", "shutdown"],
  process: ["ok"],
  wait: ["ok", "shutdown"],
  log: ["ok"],
  stop: [],
} as const satisfies Record<
  BehaviorOperation["op"],
  readonly BehaviorOutcome[]
>;

const patternMessages: Record<ProjectSpec["pattern"], readonly MessageType[]> =
  {
    "req-rep": ["request", "response", "error"],
    "pub-sub": ["event"],
    "push-pull": ["task"],
  };

function checkGraph(
  plan: BehaviorPlan,
  path: string,
  capabilities: LanguageCapabilities,
  report: Report,
): Map<string, Node> | undefined {
  const graph = new Map<string, Node>();
  let valid = true;
  for (const [index, { id, operation, transitions }] of plan.nodes.entries()) {
    const nodePath = `${path}/nodes/${index}`;
    if (graph.has(id)) {
      report(
        "IR_DUPLICATE_NODE",
        `${nodePath}/id`,
        "Behavior node ID is duplicated.",
        { id },
      );
      valid = false;
    }
    const edges = Object.entries(transitions) as Edge[];
    graph.set(id, { path: nodePath, operation, edges });

    if (
      !Object.hasOwn(outcomes, operation.op) ||
      !capabilities.operations.includes(operation.op)
    ) {
      report(
        "IR_UNSUPPORTED_OPERATION",
        `${nodePath}/operation/op`,
        "The adapter does not support this operation.",
        { operation: operation.op },
      );
      valid = false;
      continue;
    }

    const required: readonly BehaviorOutcome[] = outcomes[operation.op];
    if (
      edges.length !== required.length ||
      edges.some(([outcome]) => !required.includes(outcome))
    ) {
      report(
        "IR_INVALID_OUTCOMES",
        `${nodePath}/transitions`,
        "Transitions do not match the operation outcomes.",
      );
      valid = false;
    }
  }

  if (!graph.has(plan.entry)) {
    report(
      "IR_MISSING_ENTRY",
      `${path}/entry`,
      "The entry node does not exist.",
    );
    valid = false;
  }
  for (const node of graph.values()) {
    for (const [outcome, target] of node.edges) {
      if (!graph.has(target)) {
        report(
          "IR_MISSING_TARGET",
          `${node.path}/transitions`,
          "A transition target does not exist.",
          { outcome, target: String(target) },
        );
        valid = false;
      }
    }
  }
  return valid ? graph : undefined;
}

function reachableFrom(
  entry: string,
  graph: ReadonlyMap<string, Node>,
): Set<string> {
  const reachable = new Set([entry]);
  for (const id of reachable) {
    for (const [, target] of graph.get(id)!.edges) reachable.add(target);
  }
  return reachable;
}

function stopPaths(graph: ReadonlyMap<string, Node>) {
  const canStop = new Set<string>();
  const mustStop = new Set<string>();
  for (const [id, node] of graph) {
    if (node.operation.op === "stop") {
      canStop.add(id);
      mustStop.add(id);
    }
  }

  let previousSize: number;
  do {
    previousSize = canStop.size + mustStop.size;
    for (const [id, { edges }] of graph) {
      if (edges.some(([, target]) => canStop.has(target))) canStop.add(id);
      if (
        edges.every(
          ([outcome, target]) => outcome !== "shutdown" && mustStop.has(target),
        )
      )
        mustStop.add(id);
    }
  } while (previousSize !== canStop.size + mustStop.size);

  return { canStop, mustStop };
}

function checkCycles(
  graph: ReadonlyMap<string, Node>,
  reachable: ReadonlySet<string>,
  report: Report,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reported = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) return;
    const node = graph.get(id)!;
    if (visiting.has(id)) {
      if (!reported.has(id)) {
        report(
          "IR_UNMANAGED_CYCLE",
          node.path,
          "A cycle can run without a shutdown checkpoint.",
        );
        reported.add(id);
      }
      return;
    }
    if (!node.edges.some(([outcome]) => outcome === "shutdown")) {
      visiting.add(id);
      for (const [, target] of node.edges) visit(target);
      visiting.delete(id);
    }
    visited.add(id);
  }

  for (const id of reachable) visit(id);
}

type VariableKind = "id" | "message" | "frame" | "json" | "taskResult";
type Assignment = readonly [name: string, kind: VariableKind];
type Variables = ReadonlyMap<string, VariableKind | "mixed">;

function operands(operation: BehaviorOperation): {
  reads: readonly Assignment[];
  write?: Assignment;
} {
  switch (operation.op) {
    case "build": {
      const reads: Assignment[] = [];
      if (operation.id.kind !== "sequence")
        reads.push([operation.id.from, operation.id.kind]);
      if (operation.payload.kind === "message")
        reads.push([operation.payload.from, "message"]);
      return { reads, write: [operation.to, "message"] };
    }
    case "encode":
      return {
        reads: [[operation.from, "message"]],
        write: [operation.to, "frame"],
      };
    case "decode":
      return {
        reads: [[operation.from, "frame"]],
        write: [operation.to, "json"],
      };
    case "validate": {
      const reads: Assignment[] = [[operation.from, "json"]];
      if (
        operation.check === "message" &&
        operation.matchesIdOf !== undefined
      ) {
        reads.push([operation.matchesIdOf, "message"]);
      }
      return { reads, write: [operation.to, operation.check] };
    }
    case "send":
      return { reads: [[operation.from, "frame"]] };
    case "receive":
      return { reads: [], write: [operation.to, "frame"] };
    case "process":
      return {
        reads: [[operation.from, "message"]],
        write: [operation.to, "taskResult"],
      };
    case "log":
      return {
        reads:
          "from" in operation
            ? [
                [
                  operation.from,
                  operation.event === "TASK_PROCESSED"
                    ? "taskResult"
                    : "message",
                ],
              ]
            : [],
      };
    default:
      return { reads: [] };
  }
}

function mergeVariables(previous: Variables, incoming: Variables): Variables {
  const merged = new Map(previous);
  let changed = false;
  for (const [name, kind] of previous) {
    const otherKind = incoming.get(name);
    if (otherKind === undefined) {
      merged.delete(name);
      changed = true;
    } else if (otherKind !== kind && kind !== "mixed") {
      merged.set(name, "mixed");
      changed = true;
    }
  }
  return changed ? merged : previous;
}

function checkVariables(
  entry: string,
  graph: ReadonlyMap<string, Node>,
  report: Report,
): void {
  const incoming = new Map<string, Variables>([[entry, new Map()]]);
  const pending = new Set([entry]);

  for (const id of pending) {
    pending.delete(id);
    const state = incoming.get(id)!;
    const { operation, edges } = graph.get(id)!;
    const { write } = operands(operation);
    for (const [outcome, target] of edges) {
      const next =
        write && outcome === "ok" ? new Map(state).set(...write) : state;
      const previous = incoming.get(target);
      const merged = previous ? mergeVariables(previous, next) : next;
      if (merged !== previous) {
        incoming.set(target, merged);
        pending.add(target);
      }
    }
  }

  for (const [id, state] of incoming) {
    const { operation, path } = graph.get(id)!;
    for (const [name, expected] of operands(operation).reads) {
      const actual = state.get(name);
      if (actual === undefined) {
        report(
          "IR_UNASSIGNED_VARIABLE",
          `${path}/operation`,
          "The variable must be assigned on every incoming path.",
          { name },
        );
      } else if (actual !== expected) {
        report(
          "IR_VARIABLE_TYPE",
          `${path}/operation`,
          "The variable type does not match the operand.",
          { name, expected, actual },
        );
      }
    }
  }
}

function checkExchangeOrder(
  entry: string,
  graph: ReadonlyMap<string, Node>,
  socketType: "REQ" | "REP",
  report: Report,
): void {
  type Phase = "send" | "receive" | "finished";
  const visited = new Map<string, Set<Phase>>();
  const reported = new Set<string>();
  const pending: [string, Phase][] = [
    [entry, socketType === "REQ" ? "send" : "receive"],
  ];

  for (const [id, phase] of pending) {
    const phases = visited.get(id) ?? new Set<Phase>();
    if (phases.has(phase)) continue;
    phases.add(phase);
    visited.set(id, phases);

    const {
      operation: { op },
      edges,
      path,
    } = graph.get(id)!;
    const exchanges = op === "send" || op === "receive";
    if (exchanges && op !== phase) {
      if (!reported.has(id)) {
        report(
          "IR_INVALID_EXCHANGE_ORDER",
          `${path}/operation/op`,
          "Socket state does not permit this operation.",
          { socketType },
        );
        reported.add(id);
      }
      continue;
    }
    for (const [outcome, target] of edges) {
      let next = phase;
      if (exchanges) {
        next = "finished";
        if (outcome === "ok") {
          next =
            op === "send"
              ? "receive"
              : socketType === "REP"
                ? "send"
                : "finished";
        } else if (
          op === "receive" &&
          outcome === "timeout" &&
          socketType === "REP"
        ) {
          next = "receive";
        }
      }
      pending.push([target, next]);
    }
  }
}

export function validateBehavior(
  plan: BehaviorPlan,
  path: string,
  role: RoleDefinition,
  pattern: ProjectSpec["pattern"],
  capabilities: LanguageCapabilities,
  report: Report,
): void {
  if (plan.version !== 1) {
    report(
      "IR_UNSUPPORTED_BEHAVIOR_VERSION",
      `${path}/version`,
      "Unsupported behavior plan version.",
    );
    return;
  }
  const graph = checkGraph(plan, path, capabilities, report);
  if (!graph) return;

  const reachable = reachableFrom(plan.entry, graph);
  const { canStop, mustStop } = stopPaths(graph);
  const { socketType, canSend, canReceive } = role;
  for (const [id, { operation, edges, path: nodePath }] of graph) {
    if (!reachable.has(id)) {
      report("IR_UNREACHABLE_NODE", nodePath, "Behavior node is unreachable.");
      continue;
    }
    if (!canStop.has(id))
      report(
        "IR_NO_STOP_PATH",
        nodePath,
        "No stop is reachable from this node.",
      );

    const { op } = operation;
    for (const [outcome, target] of edges) {
      const finishRequest =
        socketType === "REQ" &&
        (outcome === "timeout" || (op === "receive" && outcome === "ok"));
      const failedReply =
        socketType === "REP" && op === "send" && outcome === "timeout";
      if (
        (outcome === "shutdown" ||
          outcome === "error" ||
          finishRequest ||
          failedReply) &&
        !mustStop.has(target)
      ) {
        report(
          "IR_INVALID_STOP_PATH",
          `${nodePath}/transitions/${outcome}`,
          "The transition must lead to stop without another interruptible operation.",
        );
      }
    }

    if (
      (op === "send" && !canSend) ||
      (op === "receive" && !canReceive) ||
      (op === "process" && socketType !== "PULL")
    ) {
      report(
        "IR_SOCKET_OPERATION",
        `${nodePath}/operation/op`,
        "Socket type does not permit this operation.",
        { socketType },
      );
    }
    if (
      op === "wait" &&
      (!Number.isInteger(operation.milliseconds) || operation.milliseconds <= 0)
    ) {
      report(
        "IR_INVALID_OPERAND",
        `${nodePath}/operation/milliseconds`,
        "Wait duration must be a positive integer.",
      );
    }
    if (op === "stop" && operation.exitCode !== 0 && operation.exitCode !== 1) {
      report(
        "IR_INVALID_OPERAND",
        `${nodePath}/operation/exitCode`,
        "Exit code must be 0 or 1.",
      );
    }

    const messageTypes = patternMessages[pattern];
    if (op === "build" && !messageTypes.includes(operation.messageType)) {
      report(
        "IR_MESSAGE_TYPE",
        `${nodePath}/operation/messageType`,
        "The pattern does not permit this message type.",
      );
    } else if (
      op === "validate" &&
      operation.check === "message" &&
      (operation.messageTypes.length === 0 ||
        operation.messageTypes.some((type) => !messageTypes.includes(type)))
    ) {
      report(
        "IR_MESSAGE_TYPE",
        `${nodePath}/operation/messageTypes`,
        "The message check requires types supported by the pattern.",
      );
    }
  }

  checkCycles(graph, reachable, report);
  checkVariables(plan.entry, graph, report);
  if (socketType === "REQ" || socketType === "REP")
    checkExchangeOrder(plan.entry, graph, socketType, report);
}
