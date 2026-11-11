/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { getCapabilities } from "../catalog/capabilities";
import { extensionTopology } from "../patterns/pub-sub-extensions";
import type { AdvancedConfig, Diagnostic } from "../public/types";
import { formatEndpointUri } from "../topology/compiler";
import { validateConfig } from "../validation/config";
import type { DependencySpec, GenerationPlan } from "./ir";

const directions = {
  PUB: [true, false], SUB: [false, true], XSUB: [true, true], XPUB: [true, true],
  PUSH: [true, false], PULL: [false, true], PAIR: [true, true],
  ROUTER: [true, true], DEALER: [true, true],
} as const;

const binaryStarTransitions = Object.freeze({
  primary: Object.freeze({ backup: "active", active: "passive" }),
  backup: Object.freeze({ active: "passive" }),
  active: Object.freeze({ active: "conflict" }),
  passive: Object.freeze({ primary: "active", backup: "active", passive: "conflict", vote: "active" }),
});

type SocketType = keyof typeof directions;
type Mode = "bind" | "connect";
type Program = "publish" | "subscribe" | "proxy" | "clone-server" | "clone-client";

interface SocketPlan {
  name: string;
  type: SocketType;
  mode: Mode;
  target: "primary" | "backup" | "inproc";
  offset: number;
  endpoint: string;
  send: boolean;
  receive: boolean;
  subscriptions?: "all" | "subtree";
  verbose?: true;
  worker?: number;
}

interface ApplicationPlan {
  role: string;
  program: Program;
  sockets: SocketPlan[];
}

export interface PubSubPlan {
  irVersion: "1.1";
  project: GenerationPlan["project"];
  messaging: AdvancedConfig["messaging"];
  socketOptions: AdvancedConfig["socketOptions"];
  behavior: {
    portCount: number;
    cache: boolean;
    timed: boolean;
    workerCount: number;
    binaryStarTransitions?: typeof binaryStarTransitions;
  };
  applications: ApplicationPlan[];
  dependencies: readonly DependencySpec[];
  diagnostics: readonly Diagnostic[];
}

export type ProjectPlan = GenerationPlan | PubSubPlan;

export function compilePubSub(config: AdvancedConfig, diagnostics: readonly Diagnostic[]): PubSubPlan {
  const { messaging, socketOptions } = config;
  const { clone, binaryStar, proxy, portCount } = extensionTopology(messaging.extensions);
  const { language, name } = config.project;
  const { libraryId, libraryVersion } = getCapabilities().languages.find(({ id }) => id === language)!;
  const { extensions } = messaging;
  const workerCount = extensions.includes("black-box") ? 2 : 0;
  const tcp = (
    name: string, type: SocketType, mode: Mode, offset: number,
    target: "primary" | "backup" = "primary",
    settings: Pick<SocketPlan, "subscriptions" | "verbose"> = {},
  ): SocketPlan => {
    const group = target === "backup" ? messaging.backup! : messaging;
    const [send, receive] = directions[type];
    const host = mode === "bind" ? group.bindHost : group.connectHost;
    return { name, type, mode, offset, target, send, receive, ...settings,
      endpoint: formatEndpointUri(host, group.port + offset) };
  };
  const local = (name: string, type: SocketType, mode: Mode, channel: string): SocketPlan => ({
    name, type, mode, offset: 0, target: "inproc", endpoint: `inproc://${channel}`,
    send: type === "PAIR" ? mode === "bind" : directions[type][0],
    receive: type === "PAIR" ? mode === "connect" : directions[type][1],
  });

  let applications: ApplicationPlan[];
  if (clone) {
    const server = (target: "primary" | "backup"): ApplicationPlan => {
      const sockets = [
        tcp("snapshot", "ROUTER", "bind", 0, target),
        tcp("updates", "PUB", "bind", 1, target),
        tcp("collector", "SUB", "bind", 2, target, { subscriptions: "all" }),
      ];
      if (binaryStar) {
        sockets.push(tcp("peerIn", "ROUTER", "bind", 3, target));
        const peer = target === "primary" ? "backup" : "primary";
        sockets.push({ ...tcp("peerOut", "DEALER", "connect", 3, peer), receive: false });
      }
      return { role: target === "primary" ? "server" : "backup", program: "clone-server", sockets };
    };
    const client: ApplicationPlan = { role: "client", program: "clone-client", sockets: [] };
    const targets = binaryStar ? ["primary", "backup"] as const : ["primary"] as const;
    for (const [index, target] of targets.entries()) {
      client.sockets.push(
        tcp(`updates${index}`, "SUB", "connect", 1, target, { subscriptions: "subtree" }),
        tcp(`snapshot${index}`, "DEALER", "connect", 0, target),
        tcp(`writer${index}`, "PUB", "connect", 2, target),
      );
    }
    applications = [server("primary"), ...(binaryStar ? [server("backup")] : []), client];
  } else {
    const pub: ApplicationPlan = { role: "pub", program: "publish", sockets: [
      tcp("stream", "PUB", messaging.bindRole === "pub" ? "bind" : "connect", 0),
    ] };
    const sub: ApplicationPlan = { role: "sub", program: "subscribe", sockets: [
      tcp("stream", "SUB", messaging.bindRole === "sub" ? "bind" : "connect", proxy ? 1 : 0,
        "primary", { subscriptions: "all" }),
    ] };
    if (workerCount && language !== "node") {
      sub.sockets.push(local("dispatch", "PUSH", "bind", "zmqt-workers"));
      for (let worker = 1; worker <= workerCount; worker++) {
        sub.sockets.push({ ...local(`worker${worker}`, "PULL", "connect", "zmqt-workers"), worker });
      }
    }
    if (proxy) {
      const sockets = [
        tcp("upstream", "XSUB", "bind", 0),
        tcp("downstream", "XPUB", "bind", 1, "primary",
          extensions.includes("last-value-caching") ? { verbose: true } : {}),
      ];
      if (extensions.includes("espresso")) {
        sockets.push(local("captureOut", "PAIR", "bind", "zmqt-capture"));
        sockets.push(local("captureIn", "PAIR", "connect", "zmqt-capture"));
      }
      applications = [{ role: "proxy", program: "proxy", sockets }, sub, pub];
    } else {
      applications = messaging.bindRole === "pub" ? [pub, sub] : [sub, pub];
    }
  }
  return {
    irVersion: "1.1", project: { name, language, pattern: "pub-sub" }, messaging, socketOptions,
    behavior: {
      portCount,
      cache: extensions.includes("last-value-caching"),
      timed: extensions.includes("suicidal-snail"),
      workerCount,
      ...(binaryStar && { binaryStarTransitions }),
    },
    applications, dependencies: [{ id: libraryId, version: libraryVersion }], diagnostics,
  };
}

export function validatePubSubPlan(plan: PubSubPlan): Diagnostic[] {
  const { name, language, pattern } = plan.project;
  const validation = validateConfig({
    schemaVersion: "1.1", project: { name, language }, messaging: plan.messaging, socketOptions: plan.socketOptions,
  });
  if (validation.ok && validation.value.schemaVersion === "1.1" && pattern === "pub-sub") {
    const expected = compilePubSub(validation.value, []);
    if (JSON.stringify(plan.applications) === JSON.stringify(expected.applications) &&
        JSON.stringify(plan.behavior) === JSON.stringify(expected.behavior) &&
        plan.messaging.maxAgeMs === expected.messaging.maxAgeMs &&
        plan.messaging.subtree === expected.messaging.subtree) return [];
  }
  return [{
    severity: "error", code: "IR_INVALID_TOPOLOGY", path: "/applications",
    message: "Applications and sockets must match the selected PUB/SUB extensions.",
  }];
}

export function executionSpec(plan: PubSubPlan, role: string): string {
  const { program, sockets } = plan.applications.find((app) => app.role === role)!;
  const { workerCount, ...behavior } = plan.behavior;
  return JSON.stringify({
    role, program, ...behavior,
    workers: program === "subscribe" ? workerCount : 0,
    sockets: sockets.map(({ endpoint, ...socket }) => ({
      ...socket, ...(socket.target === "inproc" && { endpoint }),
    })),
  });
}
