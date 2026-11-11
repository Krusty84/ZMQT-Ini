/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const pythonClone = String.raw`
from uuid import uuid4


_HEARTBEAT = 1000
_PEER_TIMEOUT = 3 * _HEARTBEAT


def _chp(key, sequence, identity=b"", properties=b"", value=b""):
    return [key, _number(sequence), identity, properties, value]


def _key(frame):
    return bool(frame) and b"\0" not in frame and frame not in (b"HUGZ", b"KTHXBAI")


def _read_chp(frames, uuid_lengths):
    if len(frames) != 5 or not _key(frames[0]) or len(frames[2]) not in uuid_lengths:
        raise ValueError("Invalid CHP message")
    return frames[0], _from_number(frames[1]), frames[2], frames[3], frames[4]


def _expiry(properties):
    for prop in properties.splitlines():
        name, _, value = prop.partition(b"=")
        if name == b"ttl":
            if not re.fullmatch(rb"[0-9]{1,10}", value) or int(value) > 2147483647:
                raise ValueError("Invalid TTL")
            return _wall_ms() + int(value) * 1000 if int(value) else 0
    return 0


def _remember(mapping, key, value, limit):
    mapping[key] = value
    if len(mapping) > limit:
        mapping.pop(next(iter(mapping)))


class _CloneServer:
    def __init__(self, runtime):
        self.runtime = runtime
        self.transitions = runtime.spec.get("binaryStarTransitions")
        self.state = ("primary" if runtime.spec["role"] == "server" else "backup") if self.transitions else "active"
        self.peer_deadline = 0
        self.next_peer = 0
        self.next_sync = 0
        self.synced = False
        self.sequence = 0
        self.data = {}
        self.pending = {}
        self.seen = {}
        self.limit = runtime.options["receiveHwm"]
        self.next_heartbeat = 0

    def transition(self, event):
        state = self.transitions[self.state].get(event)
        if state == "conflict":
            self.runtime.fail("BINARY_STAR_CONFLICT")
        elif state == "active" and self.state == "passive" and not self.synced:
            return
        elif state is not None:
            self.state = state
            self.next_peer = 0
            self.synced = False
            self.runtime.log("BINARY_STAR_STATE", role=self.runtime.spec["role"], state=state)
            if state == "active":
                pending, self.pending = self.pending, {}
                for frames, expires in pending.values():
                    self.commit(frames, expires)
            elif state == "passive":
                self.next_sync = 0

    def apply(self, frames, expires):
        key, self.sequence, identity, _, value = _read_chp(frames, (0, 16))
        if value:
            self.data[key] = (value, expires)
        else:
            self.data.pop(key, None)
        if identity:
            _remember(self.seen, identity, None, self.limit)
            self.pending.pop(identity, None)

    def commit(self, frames, expires):
        key, _, identity, properties, value = _read_chp(frames, (0, 16))
        if identity and identity in self.seen:
            return
        publication = _chp(key, self.sequence + 1, identity, properties, value)
        self.apply(publication, expires)
        if self.transitions:
            self.runtime.send("peerOut", [b"COMMIT", *publication, _number(expires)])
        self.runtime.send("updates", publication)
        self.next_heartbeat = _clock_ms() + _HEARTBEAT

    def snapshot(self, frames):
        if len(frames) != 3 or frames[1] != b"ICANHAZ?" or not _subtree(frames[2].decode("utf-8")):
            raise ValueError("Invalid snapshot request")
        if self.state == "passive" and _clock_ms() >= self.peer_deadline:
            self.transition("vote")
        if self.state != "active":
            return
        identity, _, prefix = frames
        self.expire()
        watermark = self.sequence
        for key, (value, _) in self.data.items():
            if key.startswith(prefix) and not self.runtime.send(
                    "snapshot", [identity, *_chp(key, watermark, value=value)], wait=True):
                return
        self.runtime.send("snapshot", [identity, *_chp(b"KTHXBAI", watermark, value=prefix)], wait=True)

    def sync_peer(self):
        frames = [b"SNAPSHOT", _number(self.sequence), _number(len(self.data))]
        for key, (value, expires) in self.data.items():
            frames.extend((key, _number(expires), value))
        frames.extend(self.seen)
        self.runtime.send("peerOut", frames)

    def receive_peer(self, frames):
        if len(frames) < 2:
            raise ValueError("Invalid peer message")
        command = frames[1]
        if command == b"STATE" and len(frames) == 4:
            state = frames[2].decode("ascii")
            sequence = _from_number(frames[3])
            if state not in self.transitions:
                raise ValueError("Invalid peer state")
            self.peer_deadline = _clock_ms() + _PEER_TIMEOUT
            self.transition(state)
            if self.state == "passive" and sequence > self.sequence:
                self.synced = False
        elif command == b"SYNC" and len(frames) == 2 and self.state == "active":
            self.expire()
            self.sync_peer()
        elif command == b"SNAPSHOT" and len(frames) >= 4 and self.state == "passive":
            sequence, size = map(_from_number, frames[2:4])
            end = 4 + size * 3
            if end > len(frames) or any(len(uuid) != 16 for uuid in frames[end:]):
                raise ValueError("Invalid replica snapshot")
            data = {}
            for key, deadline, value in zip(frames[4:end:3], frames[5:end:3], frames[6:end:3]):
                if not _key(key) or not value:
                    raise ValueError("Invalid replica row")
                data[key] = (value, _from_number(deadline))
            self.data, self.sequence = data, sequence
            self.seen = dict.fromkeys(frames[max(end, len(frames) - self.limit):])
            for uuid in self.seen:
                self.pending.pop(uuid, None)
            self.synced = True
            self.runtime.log("REPLICA_SYNCED", role=self.runtime.spec["role"], sequence=str(sequence))
        elif command == b"COMMIT" and len(frames) == 8 and self.state == "passive":
            publication, expires = frames[2:7], _from_number(frames[7])
            _, sequence, _, _, _ = _read_chp(publication, (0, 16))
            if self.synced and sequence == self.sequence + 1:
                self.apply(publication, expires)
            elif sequence > self.sequence:
                self.synced = False

    def receive(self, name, frames):
        try:
            if name == "snapshot":
                self.snapshot(frames)
            elif name == "collector":
                _, _, identity, properties, _ = _read_chp(frames, (16,))
                expires = _expiry(properties)
                if self.state == "active":
                    self.commit(frames, expires)
                elif identity not in self.seen and identity not in self.pending:
                    _remember(self.pending, identity, (frames, expires), self.limit)
            else:
                self.receive_peer(frames)
        except (ValueError, UnicodeError):
            self.runtime.log("PROTOCOL_ERROR")

    def expire(self):
        now = _wall_ms()
        expired = [key for key, (_, expires) in self.data.items() if expires and expires <= now]
        for key in expired:
            self.commit(_chp(key, 0), 0)

    def tick(self):
        now = _clock_ms()
        if self.transitions and now >= self.next_peer:
            self.next_peer = now + _HEARTBEAT
            self.runtime.send("peerOut", [b"STATE", self.state.encode(), _number(self.sequence)])
        if self.state == "passive" and not self.synced and now >= self.next_sync:
            self.next_sync = now + _HEARTBEAT
            self.runtime.send("peerOut", [b"SYNC"])
        if self.state == "active":
            self.expire()
            if now >= self.next_heartbeat:
                self.next_heartbeat = now + _HEARTBEAT
                self.runtime.send("updates", _chp(b"HUGZ", 0))


class _CloneClient:
    def __init__(self, runtime):
        self.runtime = runtime
        self.prefix = runtime.config["subtree"].encode()
        self.servers = 2 if "binaryStarTransitions" in runtime.spec else 1
        self.server = 0
        self.sequence = 0
        self.deadline = 0
        self.data = {}
        self.staged = {}
        self.buffered = []
        self.watermark = 0
        self.stream_seen = False
        self.refresh = False
        self.demo = _chp(self.prefix + b"demo" if self.prefix else b"/demo/value", 0, uuid4().bytes, value=b"42")
        self.demo_sent = False
        self.next_write = 0

    def begin(self, server, refresh=False):
        self.server = server
        self.staged, self.buffered, self.watermark = {}, [], 0
        self.stream_seen = refresh
        self.refresh = not refresh
        self.deadline = _clock_ms() + _PEER_TIMEOUT
        if not refresh:
            self.runtime.open(f"updates{server}")
        self.runtime.open(f"snapshot{server}")
        self.runtime.send(f"snapshot{server}", [b"ICANHAZ?", self.prefix], wait=True)

    def update(self, frames):
        key, sequence, identity, _, value = _read_chp(frames, (0, 16))
        if sequence <= self.sequence or not key.startswith(self.prefix):
            return
        self.sequence = sequence
        if value:
            self.data[key] = value
        else:
            self.data.pop(key, None)
        if identity == self.demo[2]:
            self.demo_sent = True
        # Use the updated local copy here.
        self.runtime.log("CLONE_UPDATE", key=key.decode("utf-8", errors="replace"),
                         sequence=str(sequence), valueHex=value.hex())

    def receive_snapshot(self, frames):
        if self.staged is None or len(frames) != 5 or frames[2] or frames[3]:
            raise ValueError("Invalid snapshot frame")
        key, sequence, value = frames[0], _from_number(frames[1]), frames[4]
        if key == b"KTHXBAI":
            if value != self.prefix or sequence < self.watermark:
                raise ValueError("Invalid snapshot terminator")
            self.data, self.sequence = self.staged, sequence
            self.staged = None
            self.deadline = _clock_ms() + _PEER_TIMEOUT
            self.runtime.log("CLONE_SNAPSHOT", server=self.server, size=len(self.data), sequence=str(sequence))
            if not self.demo_sent and self.next_write and self.data.get(self.demo[0]) == self.demo[4]:
                self.demo_sent = True
                self.runtime.log("CLONE_WRITE_CONFIRMED")
            for update in self.buffered:
                self.update(update)
            self.buffered.clear()
            if self.stream_seen and self.refresh:
                self.begin(self.server, refresh=True)
        elif _key(key) and key.startswith(self.prefix):
            self.watermark = max(self.watermark, sequence)
            self.staged[key] = value
            self.deadline = _clock_ms() + _PEER_TIMEOUT
        else:
            raise ValueError("Invalid snapshot key")

    def receive(self, name, frames):
        try:
            if name == f"snapshot{self.server}":
                self.receive_snapshot(frames)
            elif name == f"updates{self.server}":
                heartbeat = frames == _chp(b"HUGZ", 0)
                if not heartbeat:
                    _read_chp(frames, (0, 16))
                self.stream_seen = True
                if self.staged is None:
                    self.deadline = _clock_ms() + _PEER_TIMEOUT
                    if not heartbeat:
                        self.update(frames)
                    if self.refresh:
                        self.begin(self.server, refresh=True)
                elif not heartbeat:
                    if len(self.buffered) >= self.runtime.options["receiveHwm"]:
                        self.begin(self.server, refresh=True)
                    else:
                        self.buffered.append(frames)
        except ValueError:
            self.runtime.log("PROTOCOL_ERROR")

    def tick(self):
        now = _clock_ms()
        if now >= self.deadline:
            self.begin((self.server + 1) % self.servers)
        if self.staged is None and not self.demo_sent and now >= self.next_write:
            self.next_write = now + 250
            # Publish the same UUID on each connection and keep it for retries.
            for server in range(self.servers):
                self.runtime.send(f"writer{server}", self.demo)


def clone_program(runtime):
    runtime.log("READY")
    if runtime.spec["program"] == "clone-server":
        server = _CloneServer(runtime)
        runtime.loop(server.receive, server.tick)
    else:
        client = _CloneClient(runtime)
        client.begin(0)
        runtime.loop(client.receive, client.tick)
`;
