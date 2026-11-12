/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const nodeAdvanced = String.raw`
import { encode, validateMessage } from "./message_codec.mjs";

const advancedConstructors = {
  PUB: zmq.Publisher, SUB: zmq.Subscriber, XSUB: zmq.XSubscriber, XPUB: zmq.XPublisher,
  PUSH: zmq.Push, PULL: zmq.Pull, PAIR: zmq.Pair, ROUTER: zmq.Router, DEALER: zmq.Dealer,
};
const utf8Text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const validSubtree = value => typeof value === "string" &&
  (value === "" || /^\/(?:[^/\0]+\/)+(?![\s\S])/u.test(value));

async function loadAdvancedConfig(spec) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--config")) {
    throw new Error("Expected --config PATH");
  }
  const path = args[1] ?? new URL("./config/zmq.json", import.meta.url);
  const config = decode(await readFile(path));
  const fields = ["bindHost", "connectHost", "port", "socketOptions"];
  if (spec.timed) fields.push("maxAgeMs");
  if (spec.program.startsWith("clone")) fields.push("subtree");
  if (spec.binaryStarTransitions) fields.push("backup");
  if (!hasKeys(config, fields)) throw new Error("Invalid runtime configuration");
  validateSocketOptions(config.socketOptions);
  const groups = [config];
  if (spec.binaryStarTransitions) {
    if (!hasKeys(config.backup, ["bindHost", "connectHost", "port"])) throw new Error("Invalid backup");
    groups.push(config.backup);
  }
  for (const group of groups) {
    validateHost(group.bindHost, false);
    validateHost(group.connectHost, true);
    if (!boundedInt(group.port, 1, 65536 - spec.portCount)) throw new Error("Invalid port");
  }
  if (spec.timed && !boundedInt(config.maxAgeMs, 1, 600000)) throw new Error("Invalid maxAgeMs");
  if (Object.hasOwn(config, "subtree") && !validSubtree(config.subtree)) throw new Error("Invalid subtree");
  return config;
}

function numberFrame(value) {
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64BE(BigInt(value));
  return frame;
}

function readNumber(frame) {
  if (frame.length !== 8) throw new RangeError("Expected an eight-byte number");
  return frame.readBigUInt64BE();
}

class AdvancedRuntime {
  sockets = new Map();
  readers = new Map();
  workers = [];
  stopping = false;
  status = 0;

  constructor(spec, config) {
    this.spec = spec;
    this.config = config;
    this.options = config.socketOptions;
    this.definitions = new Map(spec.sockets.map(definition => [definition.name, definition]));
  }

  log(event, data) {
    console.log(JSON.stringify({ event, ...data }));
  }

  fail(event) {
    if (this.status === 0) this.log(event);
    this.status = 1;
    this.stopping = true;
  }

  async open(name) {
    const definition = this.definitions.get(name);
    const previous = this.sockets.get(name);
    if (previous) {
      previous.linger = 0;
      previous.close();
    }
    this.sockets.delete(name);
    this.readers.delete(name);
    const socket = new advancedConstructors[definition.type]();
    try {
      socket.linger = this.options.lingerMs;
      if (definition.send) {
        socket.sendHighWaterMark = this.options.sendHwm;
        socket.sendTimeout = 0;
      }
      if (definition.receive) {
        socket.receiveHighWaterMark = this.options.receiveHwm;
        socket.receiveTimeout = 0;
      }
      applySocketOptions(socket, this.options, definition.tcpOptions);
      if (definition.verbose) socket.verbosity = "allSubs";
      if (definition.type === "ROUTER") socket.mandatory = true;
      if (name === "peerOut" && !Object.hasOwn(this.options, "immediate")) socket.immediate = true;
      if (definition.subscriptions === "all") socket.subscribe();
      if (definition.subscriptions === "subtree") {
        socket.subscribe(this.config.subtree);
        if (this.config.subtree !== "") socket.subscribe("HUGZ");
      }
      if (definition.target === "inproc") {
        await socket[definition.mode](definition.endpoint);
      } else {
        const group = definition.target === "backup" ? this.config.backup : this.config;
        const port = group.port + definition.offset;
        if (definition.mode === "bind") await bind(socket, group.bindHost, port);
        else {
          const [host] = await addresses(group.connectHost);
          socket.connect(endpoint(socket, host, port));
        }
      }
      this.sockets.set(name, socket);
      if (definition.receive) this.readers.set(name, socket);
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  async send(name, frames, wait = false) {
    const socket = this.sockets.get(name);
    const deadline = performance.now() + this.options.sendTimeoutMs;
    while (!this.stopping) {
      try {
        await socket.send(frames);
        return true;
      } catch (error) {
        if (error.code === "EHOSTUNREACH") return false;
        if (error.code !== "EAGAIN") throw error;
        if (!wait || performance.now() >= deadline) return false;
        await setTimeout(5);
      }
    }
    return false;
  }

  async loop(receive, tick = () => {}) {
    while (!this.stopping) {
      await tick();
      let activity = false;
      for (const [name, socket] of [...this.readers]) {
        if (this.stopping || this.readers.get(name) !== socket) continue;
        let frames;
        try {
          frames = await socket.receive();
        } catch (error) {
          if (error.code !== "EAGAIN") throw error;
          continue;
        }
        activity = true;
        await receive(name, frames);
      }
      if (activity) await setImmediate();
      else await setTimeout(10);
    }
  }
}

export async function runAdvanced(spec, program) {
  let config;
  try {
    config = await loadAdvancedConfig(spec);
  } catch {
    console.log('{"event":"CONFIG_ERROR"}');
    return 1;
  }
  const runtime = new AdvancedRuntime(spec, config);
  const stop = () => { runtime.stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let event = "TRANSPORT_ERROR";
  try {
    for (const definition of spec.sockets) {
      event = definition.mode === "bind" ? "BIND_ERROR" : "TRANSPORT_ERROR";
      await runtime.open(definition.name);
    }
    event = "TRANSPORT_ERROR";
    await program(runtime);
  } catch {
    if (!runtime.stopping) runtime.fail(event);
  } finally {
    runtime.stopping = true;
    for (const { port } of runtime.workers) port.close();
    await Promise.all(runtime.workers.map(({ worker }) => worker.terminate()));
    for (const socket of [...runtime.sockets.values()].reverse()) socket.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (runtime.status === 0) runtime.log("SHUTDOWN");
  return runtime.status;
}
`;

export const nodeStream = String.raw`
import { Worker, MessageChannel, isMainThread, workerData } from "node:worker_threads";

function eventResult(frames, maxAgeMs) {
  const timed = maxAgeMs !== undefined;
  try {
    if (frames.length !== (timed ? 3 : 2)) throw new Error("Wrong event frame count");
    const topic = utf8Text.decode(frames[0]);
    const message = decode(frames.at(-1));
    if (!validateMessage(message, ["event"])) throw new Error("Invalid event JSON");
    if (timed && BigInt(Date.now()) - readNumber(frames[1]) > BigInt(maxAgeMs)) {
      return { event: "SUBSCRIBER_TOO_SLOW" };
    }
    // Process a validated application event here. Workers can run this concurrently.
    return { event: "MESSAGE_RECEIVED", data: { topic, id: message.id, payload: message.payload } };
  } catch {
    return { event: "PROTOCOL_ERROR" };
  }
}

if (!isMainThread && workerData?.streamPort) {
  const { streamPort, maxAgeMs } = workerData;
  streamPort.on("message", frames => {
    streamPort.postMessage(eventResult(frames.map(frame => Buffer.from(frame)), maxAgeMs));
  });
  streamPort.postMessage({ event: "WORKER_READY" });
}

function handleEvent(runtime, result, worker) {
  if (runtime.stopping) return;
  if (result.event === "SUBSCRIBER_TOO_SLOW") runtime.fail(result.event);
  else runtime.log(result.event, worker === undefined ? result.data : { ...result.data, worker });
}

async function startWorker(runtime, index) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { streamPort: port2, maxAgeMs: runtime.config.maxAgeMs },
    transferList: [port2],
  });
  const entry = { worker, port: port1, pending: 0 };
  runtime.workers.push(entry);
  await new Promise((resolve, reject) => {
    worker.on("error", error => {
      if (!runtime.stopping) runtime.fail("TRANSPORT_ERROR");
      reject(error);
    });
    worker.on("exit", () => {
      if (!runtime.stopping) runtime.fail("TRANSPORT_ERROR");
      resolve();
    });
    port1.on("message", result => {
      if (result.event === "WORKER_READY") resolve();
      else {
        entry.pending--;
        handleEvent(runtime, result, index);
      }
    });
  });
}

async function streamProxy(runtime) {
  const cache = runtime.spec.cache ? new Map() : null;
  const capture = runtime.sockets.has("captureOut");
  const trace = (direction, frames) => capture && runtime.send("captureOut", [direction, ...frames]);

  if (cache) await runtime.send("upstream", [Buffer.from([1])], true);
  runtime.log("READY");
  await runtime.loop(async (name, frames) => {
    if (name === "captureIn") {
      runtime.log("CAPTURE", { direction: frames[0].toString(),
        frames: frames.slice(1).map(frame => frame.toString("hex")) });
    } else if (name === "upstream") {
      await trace("publication", frames);
      if (cache && frames.length === (runtime.spec.timed ? 3 : 2)) {
        cache.set(frames[0].toString("hex"), frames);
      }
      await runtime.send("downstream", frames);
    } else if (frames.length === 1 && [0, 1].includes(frames[0][0])) {
      await trace("subscription", frames);
      if (!cache) await runtime.send("upstream", frames);
      else if (frames[0][0] === 1) {
        const prefix = frames[0].subarray(1);
        for (const saved of cache.values()) {
          if (!saved[0].subarray(0, prefix.length).equals(prefix)) continue;
          const replay = runtime.spec.timed ? [saved[0], numberFrame(Date.now()), saved[2]] : saved;
          await trace("replay", replay);
          await runtime.send("downstream", replay);
        }
      }
    }
  });
}

export async function streamProgram(runtime) {
  if (runtime.spec.program === "proxy") {
    await streamProxy(runtime);
  } else if (runtime.spec.program === "subscribe") {
    for (let index = 1; index <= runtime.spec.workers; index++) await startWorker(runtime, index);
    if (runtime.stopping) return;
    runtime.log("READY");
    const capacity = Math.max(1, Math.ceil(runtime.options.receiveHwm / runtime.spec.workers));
    let next = 0;
    await runtime.loop(async (_name, frames) => {
      if (runtime.workers.length === 0) {
        handleEvent(runtime, eventResult(frames, runtime.config.maxAgeMs));
        return;
      }
      const deadline = performance.now() + runtime.options.sendTimeoutMs;
      while (!runtime.stopping) {
        const length = runtime.workers.length;
        for (let offset = 0; offset < length; offset++) {
          const index = (next + offset) % length;
          const entry = runtime.workers[index];
          if (entry.pending < capacity) {
            entry.pending++;
            next = (index + 1) % length;
            entry.port.postMessage(frames);
            return;
          }
        }
        if (performance.now() >= deadline) {
          runtime.log("SEND_TIMEOUT");
          return;
        }
        await setTimeout(5);
      }
    });
  } else {
    runtime.log("READY");
    let sequence = 0;
    let nextSend = 0;
    await runtime.loop(() => {}, async () => {
      const now = performance.now();
      if (now < nextSend) return;
      nextSend = now + 100;
      // Replace the example topic and payload with your application data.
      const frames = [++sequence % 2 ? "demo/a" : "demo/b"];
      if (runtime.spec.timed) frames.push(numberFrame(Date.now()));
      frames.push(encode({ id: "event-" + sequence, type: "event", payload: { value: 42 } }));
      await runtime.send("stream", frames);
    });
  }
}
`;
