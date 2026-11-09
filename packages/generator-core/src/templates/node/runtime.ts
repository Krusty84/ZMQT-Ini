/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const nodeRuntime = String.raw`import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { setImmediate, setTimeout } from "node:timers/promises";
import zmq from "zeromq";
import { decode } from "./message_codec.mjs";

const pollSliceMs = 50;
const constructors = {
  REQ: zmq.Request, REP: zmq.Reply, PUB: zmq.Publisher,
  SUB: zmq.Subscriber, PUSH: zmq.Push, PULL: zmq.Pull,
};
const options = {
  sendHwm: ["sendHighWaterMark", 1, 1000000],
  receiveHwm: ["receiveHighWaterMark", 1, 1000000],
  sendTimeoutMs: ["sendTimeout", 1, 600000],
  receiveTimeoutMs: ["receiveTimeout", 1, 600000],
  lingerMs: ["linger", 0, 60000],
};

function hasKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validateHost(host, connect) {
  if (typeof host !== "string" || host.includes("%")) throw new Error("Invalid host");
  const family = isIP(host);
  if (host === "*" || family) {
    const canonical = family === 6 ? new URL("http://[" + host + "]").hostname : host;
    if (connect && ["*", "0.0.0.0", "[::]", "[::ffff:0:0]"].includes(canonical)) {
      throw new Error("Connect requires a destination");
    }
    return;
  }
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  const labels = name.split(".");
  if (name.length > 253 || /^(?:[0-9]+|0x[0-9a-f]*)(?![\s\S])/i.test(labels.at(-1)) ||
      !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?![\s\S])/i.test(label))) {
    throw new Error("Invalid host");
  }
}

function boundedInt(value, minimum, maximum) {
  return Number.isInteger(value) && minimum <= value && value <= maximum;
}

async function loadConfig() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--config")) {
    throw new Error("Expected --config PATH");
  }
  const configPath = args[1] ?? new URL("./config/zmq.json", import.meta.url);
  const config = decode(await readFile(configPath));
  if (!hasKeys(config, ["bindHost", "connectHost", "port", "socketOptions"]) ||
      !boundedInt(config.port, 1, 65535) || !hasKeys(config.socketOptions, Object.keys(options))) {
    throw new Error("Invalid runtime configuration");
  }
  validateHost(config.bindHost, false);
  validateHost(config.connectHost, true);
  for (const [name, [, minimum, maximum]] of Object.entries(options)) {
    if (!boundedInt(config.socketOptions[name], minimum, maximum)) throw new Error("Invalid socket option");
  }
  return config;
}

async function addresses(host) {
  if (host === "*" || isIP(host)) return [host];
  const records = await lookup(host, { all: true, order: "ipv4first" });
  if (records.length === 0) throw new Error("No usable address");
  return [...new Set(records.map(({ address }) => address))];
}

function endpoint(socket, host, port) {
  const ipv6 = isIP(host) === 6;
  socket.ipv6 = ipv6;
  return "tcp://" + (ipv6 ? "[" + host + "]" : host) + ":" + port;
}

async function bind(socket, host, port) {
  for (const address of await addresses(host)) {
    try {
      await socket.bind(endpoint(socket, address, port));
      return;
    } catch {
      // Try the next DNS address if this address cannot be bound.
    }
  }
  throw new Error("Could not bind any address");
}

class Runtime {
  stopping = false;
  runId = process.env.ZMQT_TEST_RUN_ID || null;
  sequence = 0;
  socket;

  nextId() {
    return (this.runId ?? "msg") + "-" + String(++this.sequence).padStart(4, "0");
  }

  examplePayload(includeTestRunId) {
    const payload = { value: 42 };
    if (includeTestRunId && this.runId !== null) payload.runId = this.runId;
    return payload;
  }

  log(event, data) {
    const entry = { event, ...data };
    if (event === "MESSAGE_RECEIVED" && typeof data.payload?.runId === "string") {
      entry.runId = data.payload.runId;
    }
    console.log(JSON.stringify(entry));
  }

  async transfer(operation) {
    // Yield to signals even if each native operation resolves immediately.
    await setImmediate();
    if (this.stopping) return ["shutdown"];
    try {
      const value = await operation();
      return this.stopping ? ["shutdown"] : ["ok", value];
    } catch (error) {
      if (this.stopping) return ["shutdown"];
      return [error.code === "EAGAIN" ? "timeout" : "error"];
    }
  }

  async send(frame) {
    const [outcome] = await this.transfer(() => this.socket.send(frame));
    return outcome;
  }

  async receive() {
    const [outcome, frames] = await this.transfer(() => this.socket.receive());
    return [outcome, frames?.length === 1 ? frames[0] : undefined];
  }

  async wait(milliseconds) {
    const deadline = performance.now() + milliseconds;
    while (!this.stopping) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return "ok";
      await setTimeout(Math.min(pollSliceMs, Math.ceil(remaining)));
    }
    return "shutdown";
  }
}

export async function run(socketType, mode, activeOptions, subscription, behavior) {
  const runtime = new Runtime();
  const stop = () => { runtime.stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let socket;
  let watcher;
  let result = 1;
  let errorEvent = "CONFIG_ERROR";
  try {
    const config = await loadConfig();
    errorEvent = "TRANSPORT_ERROR";
    socket = new constructors[socketType]();
    runtime.socket = socket;
    for (const name of activeOptions) socket[options[name][0]] = config.socketOptions[name];
    if (subscription !== null) socket.subscribe(subscription);
    if (mode === "bind") {
      errorEvent = "BIND_ERROR";
      await bind(socket, config.bindHost, config.port);
    } else {
      const [host] = await addresses(config.connectHost);
      socket.connect(endpoint(socket, host, config.port));
    }
    errorEvent = "TRANSPORT_ERROR";
    runtime.log("READY");
    // Closing the socket cancels an outstanding native operation. Wait for its
    // promise to settle before leaving the behavior and removing the handlers.
    watcher = setInterval(() => {
      if (runtime.stopping) socket.close();
    }, pollSliceMs);
    result = runtime.stopping ? 0 : await behavior(runtime);
  } catch {
    if (runtime.stopping) result = 0;
    else runtime.log(errorEvent);
  } finally {
    clearInterval(watcher);
    socket?.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (runtime.stopping) runtime.log("SHUTDOWN");
  return result;
}
`;
