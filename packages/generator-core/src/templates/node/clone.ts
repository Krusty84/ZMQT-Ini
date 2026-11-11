/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const nodeClone = String.raw`
import { randomUUID } from "node:crypto";

const heartbeatMs = 1000;
const peerTimeoutMs = 3 * heartbeatMs;
const empty = Buffer.alloc(0);
const hugz = Buffer.from("HUGZ");
const kthxbai = Buffer.from("KTHXBAI");

function chp(key, sequence, uuid = empty, properties = empty, value = empty) {
  return [key, numberFrame(sequence), uuid, properties, value];
}

const validKey = key => key.length !== 0 && !key.includes(0) && !key.equals(hugz) && !key.equals(kthxbai);
const matchesPrefix = (key, prefix) => key.subarray(0, prefix.length).equals(prefix);

function readChp(frames, uuidRequired = false) {
  if (frames.length !== 5 || !validKey(frames[0]) ||
      (frames[2].length !== 16 && (uuidRequired || frames[2].length !== 0))) {
    throw new RangeError("Invalid CHP message");
  }
  return { key: frames[0], sequence: readNumber(frames[1]), uuid: frames[2].toString("hex"),
    properties: frames[3], value: frames[4] };
}

function expiry(properties) {
  for (const prop of properties.toString().split("\n")) {
    if (!prop.startsWith("ttl=")) continue;
    const seconds = prop.slice(4);
    if (!/^[0-9]{1,10}(?![\s\S])/.test(seconds) || Number(seconds) > 2147483647) {
      throw new RangeError("Invalid TTL");
    }
    return Number(seconds) === 0 ? 0 : Date.now() + Number(seconds) * 1000;
  }
  return 0;
}

function remember(map, key, value, limit) {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
}

class CloneServer {
  sequence = 0n;
  data = new Map();
  pending = new Map();
  seen = new Map();
  peerDeadline = 0;
  nextPeer = 0;
  nextSync = 0;
  nextHeartbeat = 0;
  synced = false;

  constructor(runtime) {
    this.runtime = runtime;
    this.transitions = runtime.spec.binaryStarTransitions;
    this.state = !this.transitions ? "active" : runtime.spec.role === "server" ? "primary" : "backup";
    this.limit = runtime.options.receiveHwm;
  }

  async transition(event) {
    const next = this.transitions[this.state][event];
    if (next === "conflict") this.runtime.fail("BINARY_STAR_CONFLICT");
    else if (next !== undefined && (next !== "active" || this.state !== "passive" || this.synced)) {
      this.state = next;
      this.nextPeer = 0;
      this.synced = false;
      this.runtime.log("BINARY_STAR_STATE", { role: this.runtime.spec.role, state: next });
      if (next === "active") {
        const pending = this.pending;
        this.pending = new Map();
        for (const [frames, expires] of pending.values()) await this.commit(frames, expires);
      } else if (next === "passive") this.nextSync = 0;
    }
  }

  apply(frames, expires) {
    const { key, sequence, uuid, value } = readChp(frames);
    this.sequence = sequence;
    if (value.length) this.data.set(key.toString("hex"), { key, value, expires });
    else this.data.delete(key.toString("hex"));
    if (uuid) {
      remember(this.seen, uuid, null, this.limit);
      this.pending.delete(uuid);
    }
  }

  async commit(frames, expires) {
    const { key, uuid, properties, value } = readChp(frames);
    if (uuid && this.seen.has(uuid)) return;
    const publication = chp(key, this.sequence + 1n, frames[2], properties, value);
    this.apply(publication, expires);
    if (this.transitions) await this.runtime.send("peerOut", ["COMMIT", ...publication, numberFrame(expires)]);
    await this.runtime.send("updates", publication);
    this.nextHeartbeat = performance.now() + heartbeatMs;
  }

  async snapshot(frames) {
    if (frames.length !== 3 || frames[1].toString() !== "ICANHAZ?" ||
        !validSubtree(utf8Text.decode(frames[2]))) throw new RangeError("Invalid snapshot request");
    if (this.state === "passive" && performance.now() >= this.peerDeadline) await this.transition("vote");
    if (this.state !== "active") return;
    const [identity, , prefix] = frames;
    await this.expire();
    const watermark = this.sequence;
    for (const { key, value } of this.data.values()) {
      if (matchesPrefix(key, prefix) && !await this.runtime.send(
        "snapshot", [identity, ...chp(key, watermark, empty, empty, value)], true)) return;
    }
    await this.runtime.send("snapshot", [identity, ...chp(kthxbai, watermark, empty, empty, prefix)], true);
  }

  async receivePeer(frames) {
    const command = frames[1]?.toString();
    if (command === "STATE" && frames.length === 4) {
      const state = frames[2].toString();
      const sequence = readNumber(frames[3]);
      if (!Object.hasOwn(this.transitions, state)) throw new RangeError("Invalid peer state");
      this.peerDeadline = performance.now() + peerTimeoutMs;
      await this.transition(state);
      if (this.state === "passive" && sequence > this.sequence) this.synced = false;
    } else if (command === "SYNC" && frames.length === 2 && this.state === "active") {
      await this.expire();
      const snapshot = ["SNAPSHOT", numberFrame(this.sequence), numberFrame(this.data.size)];
      for (const { key, value, expires } of this.data.values()) snapshot.push(key, numberFrame(expires), value);
      for (const uuid of this.seen.keys()) snapshot.push(Buffer.from(uuid, "hex"));
      await this.runtime.send("peerOut", snapshot);
    } else if (command === "SNAPSHOT" && frames.length >= 4 && this.state === "passive") {
      const sequence = readNumber(frames[2]);
      const end = 4 + Number(readNumber(frames[3])) * 3;
      if (end > frames.length || frames.slice(end).some(uuid => uuid.length !== 16)) {
        throw new RangeError("Invalid replica snapshot");
      }
      const data = new Map();
      for (let index = 4; index < end; index += 3) {
        const [key, deadline, value] = frames.slice(index, index + 3);
        if (!validKey(key) || value.length === 0) throw new RangeError("Invalid replica row");
        data.set(key.toString("hex"), { key, expires: Number(readNumber(deadline)), value });
      }
      this.data = data;
      this.sequence = sequence;
      this.seen = new Map(frames.slice(Math.max(end, frames.length - this.limit))
        .map(uuid => [uuid.toString("hex"), null]));
      for (const uuid of this.seen.keys()) this.pending.delete(uuid);
      this.synced = true;
      this.runtime.log("REPLICA_SYNCED", { role: this.runtime.spec.role, sequence: String(sequence) });
    } else if (command === "COMMIT" && frames.length === 8 && this.state === "passive") {
      const publication = frames.slice(2, 7);
      const expires = Number(readNumber(frames[7]));
      const { sequence } = readChp(publication);
      if (this.synced && sequence === this.sequence + 1n) this.apply(publication, expires);
      else if (sequence > this.sequence) this.synced = false;
    }
  }

  async receive(name, frames) {
    try {
      if (name === "snapshot") await this.snapshot(frames);
      else if (name === "collector") {
        const { uuid, properties } = readChp(frames, true);
        const expires = expiry(properties);
        if (this.state === "active") await this.commit(frames, expires);
        else if (!this.seen.has(uuid) && !this.pending.has(uuid)) remember(this.pending, uuid, [frames, expires], this.limit);
      } else await this.receivePeer(frames);
    } catch (error) {
      if (!(error instanceof RangeError || error instanceof TypeError) || error.code) throw error;
      this.runtime.log("PROTOCOL_ERROR");
    }
  }

  async expire() {
    const now = Date.now();
    for (const { key, expires } of this.data.values()) {
      if (expires && expires <= now) await this.commit(chp(key, 0), 0);
    }
  }

  async tick() {
    const now = performance.now();
    if (this.transitions && now >= this.nextPeer) {
      this.nextPeer = now + heartbeatMs;
      await this.runtime.send("peerOut", ["STATE", this.state, numberFrame(this.sequence)]);
    }
    if (this.state === "passive" && !this.synced && now >= this.nextSync) {
      this.nextSync = now + heartbeatMs;
      await this.runtime.send("peerOut", ["SYNC"]);
    }
    if (this.state === "active") {
      await this.expire();
      if (now >= this.nextHeartbeat) {
        this.nextHeartbeat = now + heartbeatMs;
        await this.runtime.send("updates", chp(hugz, 0));
      }
    }
  }
}

class CloneClient {
  sequence = 0n;
  data = new Map();
  demoSent = false;
  nextWrite = 0;

  constructor(runtime) {
    this.runtime = runtime;
    this.prefix = Buffer.from(runtime.config.subtree);
    this.servers = runtime.spec.binaryStarTransitions ? 2 : 1;
    this.demo = chp(Buffer.from(runtime.config.subtree ? runtime.config.subtree + "demo" : "/demo/value"),
      0, Buffer.from(randomUUID().replaceAll("-", ""), "hex"), empty, Buffer.from("42"));
  }

  async begin(server, refresh = false) {
    this.server = server;
    this.staged = new Map();
    this.buffered = [];
    this.watermark = 0n;
    this.streamSeen = refresh;
    this.refresh = !refresh;
    this.deadline = performance.now() + peerTimeoutMs;
    if (!refresh) await this.runtime.open("updates" + server);
    await this.runtime.open("snapshot" + server);
    await this.runtime.send("snapshot" + server, ["ICANHAZ?", this.prefix], true);
  }

  update(frames) {
    const { key, sequence, value } = readChp(frames);
    if (sequence <= this.sequence || !matchesPrefix(key, this.prefix)) return;
    this.sequence = sequence;
    if (value.length) this.data.set(key.toString("hex"), value);
    else this.data.delete(key.toString("hex"));
    if (frames[2].equals(this.demo[2])) this.demoSent = true;
    // Use the updated local copy here.
    this.runtime.log("CLONE_UPDATE", { key: key.toString(), sequence: String(sequence), valueHex: value.toString("hex") });
  }

  async receiveSnapshot(frames) {
    if (!this.staged || frames.length !== 5 || frames[2].length || frames[3].length) {
      throw new RangeError("Invalid snapshot frame");
    }
    const [key, encoded, , , value] = frames;
    const sequence = readNumber(encoded);
    if (key.equals(kthxbai)) {
      if (!value.equals(this.prefix) || sequence < this.watermark) throw new RangeError("Invalid snapshot terminator");
      this.data = this.staged;
      this.sequence = sequence;
      this.staged = null;
      this.deadline = performance.now() + peerTimeoutMs;
      this.runtime.log("CLONE_SNAPSHOT", { server: this.server, size: this.data.size, sequence: String(sequence) });
      if (!this.demoSent && this.nextWrite && this.data.get(this.demo[0].toString("hex"))?.equals(this.demo[4])) {
        this.demoSent = true;
        this.runtime.log("CLONE_WRITE_CONFIRMED");
      }
      for (const frames of this.buffered) this.update(frames);
      this.buffered = [];
      if (this.streamSeen && this.refresh) await this.begin(this.server, true);
    } else if (validKey(key) && matchesPrefix(key, this.prefix)) {
      if (sequence > this.watermark) this.watermark = sequence;
      this.staged.set(key.toString("hex"), value);
      this.deadline = performance.now() + peerTimeoutMs;
    } else throw new RangeError("Invalid snapshot key");
  }

  async receive(name, frames) {
    try {
      if (name === "snapshot" + this.server) await this.receiveSnapshot(frames);
      else if (name === "updates" + this.server) {
        const heartbeat = frames.length === 5 && frames[0].equals(hugz) &&
          readNumber(frames[1]) === 0n && frames.slice(2).every(frame => frame.length === 0);
        if (!heartbeat) readChp(frames);
        this.streamSeen = true;
        if (this.staged === null) {
          this.deadline = performance.now() + peerTimeoutMs;
          if (!heartbeat) this.update(frames);
          if (this.refresh) await this.begin(this.server, true);
        } else if (!heartbeat) {
          if (this.buffered.length >= this.runtime.options.receiveHwm) await this.begin(this.server, true);
          else this.buffered.push(frames);
        }
      }
    } catch (error) {
      if (!(error instanceof RangeError) || error.code) throw error;
      this.runtime.log("PROTOCOL_ERROR");
    }
  }

  async tick() {
    const now = performance.now();
    if (now >= this.deadline) await this.begin((this.server + 1) % this.servers);
    if (this.staged === null && !this.demoSent && now >= this.nextWrite) {
      this.nextWrite = now + 250;
      // Publish the same UUID on each connection and keep it for retries.
      for (let server = 0; server < this.servers; server++) await this.runtime.send("writer" + server, this.demo);
    }
  }
}

export async function cloneProgram(runtime) {
  runtime.log("READY");
  const server = runtime.spec.program === "clone-server";
  const app = server ? new CloneServer(runtime) : new CloneClient(runtime);
  if (!server) await app.begin(0);
  await runtime.loop((name, frames) => app.receive(name, frames), () => app.tick());
}
`;
