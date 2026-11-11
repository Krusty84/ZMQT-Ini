/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const javaClone = String.raw`
    private static final int HEARTBEAT_MS = 1000;
    private static final int PEER_TIMEOUT_MS = 3 * HEARTBEAT_MS;
    private static final byte[] EMPTY = new byte[0];
    private static final byte[] HUGZ = bytes("HUGZ");
    private static final byte[] KTHXBAI = bytes("KTHXBAI");

    private static List<byte[]> chp(byte[] key, long sequence, byte[] uuid, byte[] properties, byte[] value) {
        return List.of(key, numberFrame(sequence), uuid, properties, value);
    }

    private static boolean validKey(byte[] key) {
        if (key.length == 0 || Arrays.equals(key, HUGZ) || Arrays.equals(key, KTHXBAI)) return false;
        for (byte value : key) if (value == 0) return false;
        return true;
    }

    private static long readChp(List<byte[]> frames, boolean uuidRequired) {
        if (frames.size() != 5 || !validKey(frames.getFirst()) ||
            (frames.get(2).length != 16 && (uuidRequired || frames.get(2).length != 0))) {
            throw new IllegalArgumentException("Invalid CHP message");
        }
        return readNumber(frames.get(1));
    }

    private static long expiry(byte[] properties) {
        for (String property : text(properties).split("\n")) {
            if (!property.startsWith("ttl=")) continue;
            String seconds = property.substring(4);
            if (!seconds.matches("[0-9]{1,10}")) throw new IllegalArgumentException("Invalid TTL");
            long ttl = Long.parseLong(seconds);
            if (ttl > Integer.MAX_VALUE) throw new IllegalArgumentException("Invalid TTL");
            return ttl == 0 ? 0 : System.currentTimeMillis() + ttl * 1000;
        }
        return 0;
    }

    private static <Value> void remember(LinkedHashMap<String, Value> map, String key, Value value, int limit) {
        map.putIfAbsent(key, value);
        if (map.size() > limit) map.pollFirstEntry();
    }

    private record Row(byte[] key, byte[] value, long expires) {}
    private record Write(List<byte[]> frames, long expires) {}

    private static final class CloneServer {
        private final Advanced runtime;
        private final JsonNode transitions;
        private final int limit;
        private String state;
        private long sequence;
        private long peerDeadline;
        private long nextPeer;
        private long nextSync;
        private long nextHeartbeat;
        private boolean synced;
        private Map<String, Row> data = new LinkedHashMap<>();
        private final LinkedHashMap<String, Write> pending = new LinkedHashMap<>();
        private final LinkedHashMap<String, byte[]> seen = new LinkedHashMap<>();

        CloneServer(Advanced runtime) {
            this.runtime = runtime;
            this.transitions = runtime.spec.get("binaryStarTransitions");
            this.state = transitions == null ? "active" :
                runtime.spec.get("role").asString().equals("server") ? "primary" : "backup";
            this.limit = runtime.option("receiveHwm");
        }

        private void transition(String event) {
            var target = transitions.get(state).get(event);
            if (target == null) return;
            String next = target.asString();
            if (next.equals("conflict")) {
                runtime.fail("BINARY_STAR_CONFLICT");
                return;
            }
            if (next.equals("active") && state.equals("passive") && !synced) return;
            state = next;
            nextPeer = 0;
            synced = false;
            runtime.log("BINARY_STAR_STATE", MessageCodec.object().put("role", runtime.spec.get("role").asString()).put("state", state));
            if (state.equals("active")) {
                var writes = new ArrayList<>(pending.values());
                pending.clear();
                for (var write : writes) commit(write.frames(), write.expires());
            } else if (state.equals("passive")) nextSync = 0;
        }

        private void apply(List<byte[]> frames, long expires) {
            sequence = readChp(frames, false);
            String key = hex(frames.getFirst());
            var value = frames.getLast();
            if (value.length != 0) data.put(key, new Row(frames.getFirst(), value, expires));
            else data.remove(key);
            var identity = frames.get(2);
            if (identity.length != 0) {
                String uuid = hex(identity);
                remember(seen, uuid, identity, limit);
                pending.remove(uuid);
            }
        }

        private void commit(List<byte[]> frames, long expires) {
            readChp(frames, false);
            if (seen.containsKey(hex(frames.get(2)))) return;
            var publication = chp(frames.getFirst(), sequence + 1, frames.get(2), frames.get(3), frames.getLast());
            apply(publication, expires);
            if (transitions != null) {
                var replica = new ArrayList<byte[]>();
                replica.add(bytes("COMMIT"));
                replica.addAll(publication);
                replica.add(numberFrame(expires));
                runtime.send("peerOut", replica);
            }
            runtime.send("updates", publication);
            nextHeartbeat = clockMs() + HEARTBEAT_MS;
        }

        private void expire() {
            long now = System.currentTimeMillis();
            var expired = data.values().stream().filter(row -> row.expires() != 0 && row.expires() <= now).toList();
            for (var row : expired) commit(chp(row.key(), 0, EMPTY, EMPTY, EMPTY), 0);
        }

        private boolean reply(byte[] identity, byte[] key, long watermark, byte[] value) {
            var frames = new ArrayList<byte[]>();
            frames.add(identity);
            frames.addAll(chp(key, watermark, EMPTY, EMPTY, value));
            return runtime.send("snapshot", frames, true);
        }

        private void snapshot(List<byte[]> frames) {
            if (frames.size() != 3 || !Arrays.equals(frames.get(1), bytes("ICANHAZ?")) ||
                !validSubtree(strictText(frames.get(2)))) throw new IllegalArgumentException("Invalid snapshot request");
            if (state.equals("passive") && clockMs() >= peerDeadline) transition("vote");
            if (!state.equals("active")) return;
            expire();
            long watermark = sequence;
            byte[] identity = frames.getFirst(), prefix = frames.getLast();
            for (var row : data.values()) {
                if (prefixMatches(row.key(), prefix) && !reply(identity, row.key(), watermark, row.value())) return;
            }
            reply(identity, KTHXBAI, watermark, prefix);
        }

        private void sendReplica() {
            expire();
            var frames = new ArrayList<>(List.of(bytes("SNAPSHOT"), numberFrame(sequence), numberFrame(data.size())));
            for (var row : data.values()) {
                frames.add(row.key());
                frames.add(numberFrame(row.expires()));
                frames.add(row.value());
            }
            frames.addAll(seen.values());
            runtime.send("peerOut", frames);
        }

        private void receiveReplica(List<byte[]> frames) {
            long watermark = readNumber(frames.get(2));
            long count = readNumber(frames.get(3));
            if (Long.compareUnsigned(count, (frames.size() - 4) / 3) > 0)
                throw new IllegalArgumentException("Invalid replica snapshot");
            int end = 4 + (int) count * 3;
            var snapshot = new LinkedHashMap<String, Row>();
            for (int index = 4; index < end; index += 3) {
                byte[] key = frames.get(index), value = frames.get(index + 2);
                if (!validKey(key) || value.length == 0) throw new IllegalArgumentException("Invalid replica row");
                snapshot.put(hex(key), new Row(key, value, readNumber(frames.get(index + 1))));
            }
            for (int index = end; index < frames.size(); index++) {
                if (frames.get(index).length != 16) throw new IllegalArgumentException("Invalid UUID");
            }
            data = snapshot;
            sequence = watermark;
            seen.clear();
            for (int index = end; index < frames.size(); index++) {
                var identity = frames.get(index);
                String uuid = hex(identity);
                remember(seen, uuid, identity, limit);
                pending.remove(uuid);
            }
            synced = true;
            runtime.log("REPLICA_SYNCED", MessageCodec.object().put("role", runtime.spec.get("role").asString())
                .put("sequence", Long.toUnsignedString(sequence)));
        }

        private void receivePeer(List<byte[]> frames) {
            if (frames.size() < 2) throw new IllegalArgumentException("Invalid peer message");
            String command = text(frames.get(1));
            if (command.equals("STATE") && frames.size() == 4) {
                String peer = text(frames.get(2));
                long revision = readNumber(frames.get(3));
                if (!transitions.has(peer)) throw new IllegalArgumentException("Invalid peer state");
                peerDeadline = clockMs() + PEER_TIMEOUT_MS;
                transition(peer);
                if (state.equals("passive") && Long.compareUnsigned(revision, sequence) > 0) synced = false;
            } else if (command.equals("SYNC") && frames.size() == 2 && state.equals("active")) {
                sendReplica();
            } else if (command.equals("SNAPSHOT") && frames.size() >= 4 && state.equals("passive")) {
                receiveReplica(frames);
            } else if (command.equals("COMMIT") && frames.size() == 8 && state.equals("passive")) {
                var publication = frames.subList(2, 7);
                long revision = readChp(publication, false);
                long expires = readNumber(frames.getLast());
                if (synced && revision == sequence + 1) apply(publication, expires);
                else if (Long.compareUnsigned(revision, sequence) > 0) synced = false;
            }
        }

        void receive(String name, List<byte[]> frames) {
            try {
                if (name.equals("snapshot")) snapshot(frames);
                else if (name.equals("collector")) {
                    readChp(frames, true);
                    String uuid = hex(frames.get(2));
                    long expires = expiry(frames.get(3));
                    if (state.equals("active")) commit(frames, expires);
                    else if (!seen.containsKey(uuid)) remember(pending, uuid, new Write(frames, expires), limit);
                } else receivePeer(frames);
            } catch (IllegalArgumentException error) {
                runtime.log("PROTOCOL_ERROR");
            }
        }

        void tick() {
            long now = clockMs();
            if (transitions != null && now >= nextPeer) {
                nextPeer = now + HEARTBEAT_MS;
                runtime.send("peerOut", List.of(bytes("STATE"), bytes(state), numberFrame(sequence)));
            }
            if (state.equals("passive") && !synced && now >= nextSync) {
                nextSync = now + HEARTBEAT_MS;
                runtime.send("peerOut", List.of(bytes("SYNC")));
            }
            if (state.equals("active")) {
                expire();
                if (now >= nextHeartbeat) {
                    nextHeartbeat = now + HEARTBEAT_MS;
                    runtime.send("updates", chp(HUGZ, 0, EMPTY, EMPTY, EMPTY));
                }
            }
        }
    }

    private static final class CloneClient {
        private final Advanced runtime;
        private final byte[] prefix;
        private final int servers;
        private final List<byte[]> demo;
        private int server;
        private long sequence;
        private long watermark;
        private long deadline;
        private long nextWrite;
        private boolean demoSent;
        private boolean streamSeen;
        private boolean needsRefresh;
        private Map<String, byte[]> data = new LinkedHashMap<>();
        private Map<String, byte[]> staged;
        private final List<List<byte[]>> buffered = new ArrayList<>();

        CloneClient(Advanced runtime) {
            this.runtime = runtime;
            String subtree = runtime.config.get("subtree").asString();
            this.prefix = bytes(subtree);
            this.servers = runtime.spec.has("binaryStarTransitions") ? 2 : 1;
            UUID uuid = UUID.randomUUID();
            byte[] identity = ByteBuffer.allocate(16).putLong(uuid.getMostSignificantBits())
                .putLong(uuid.getLeastSignificantBits()).array();
            this.demo = chp(bytes(subtree.isEmpty() ? "/demo/value" : subtree + "demo"), 0, identity, EMPTY, bytes("42"));
        }

        void begin(int index, boolean refresh) {
            server = index;
            staged = new LinkedHashMap<>();
            buffered.clear();
            watermark = 0;
            streamSeen = refresh;
            needsRefresh = !refresh;
            deadline = clockMs() + PEER_TIMEOUT_MS;
            if (!refresh) runtime.reopen("updates" + server);
            runtime.reopen("snapshot" + server);
            runtime.send("snapshot" + server, List.of(bytes("ICANHAZ?"), prefix), true);
        }

        private void update(List<byte[]> frames) {
            long revision = readChp(frames, false);
            byte[] key = frames.getFirst(), value = frames.getLast();
            if (Long.compareUnsigned(revision, sequence) <= 0 || !prefixMatches(key, prefix)) return;
            sequence = revision;
            if (value.length != 0) data.put(hex(key), value);
            else data.remove(hex(key));
            if (Arrays.equals(frames.get(2), demo.get(2))) demoSent = true;
            // Use the updated local copy here.
            runtime.log("CLONE_UPDATE", MessageCodec.object().put("key", text(key))
                .put("sequence", Long.toUnsignedString(sequence)).put("valueHex", hex(value)));
        }

        private void receiveSnapshot(List<byte[]> frames) {
            if (staged == null || frames.size() != 5 || frames.get(2).length != 0 || frames.get(3).length != 0)
                throw new IllegalArgumentException("Invalid snapshot frame");
            byte[] key = frames.getFirst(), value = frames.getLast();
            long revision = readNumber(frames.get(1));
            if (Arrays.equals(key, KTHXBAI)) {
                if (!Arrays.equals(value, prefix) || Long.compareUnsigned(revision, watermark) < 0)
                    throw new IllegalArgumentException("Invalid snapshot terminator");
                data = staged;
                staged = null;
                sequence = revision;
                deadline = clockMs() + PEER_TIMEOUT_MS;
                runtime.log("CLONE_SNAPSHOT", MessageCodec.object().put("server", server)
                    .put("size", data.size()).put("sequence", Long.toUnsignedString(sequence)));
                if (!demoSent && nextWrite != 0 && Arrays.equals(data.get(hex(demo.getFirst())), demo.getLast())) {
                    demoSent = true;
                    runtime.log("CLONE_WRITE_CONFIRMED");
                }
                for (var publication : buffered) update(publication);
                buffered.clear();
                if (streamSeen && needsRefresh) begin(server, true);
            } else if (validKey(key) && prefixMatches(key, prefix)) {
                if (Long.compareUnsigned(revision, watermark) > 0) watermark = revision;
                staged.put(hex(key), value);
                deadline = clockMs() + PEER_TIMEOUT_MS;
            } else throw new IllegalArgumentException("Invalid snapshot key");
        }

        void receive(String name, List<byte[]> frames) {
            try {
                if (name.equals("snapshot" + server)) receiveSnapshot(frames);
                else if (name.equals("updates" + server)) {
                    boolean heartbeat = frames.size() == 5 && Arrays.equals(frames.getFirst(), HUGZ) &&
                        readNumber(frames.get(1)) == 0 && frames.subList(2, 5).stream().allMatch(frame -> frame.length == 0);
                    if (!heartbeat) readChp(frames, false);
                    streamSeen = true;
                    if (staged == null) {
                        deadline = clockMs() + PEER_TIMEOUT_MS;
                        if (!heartbeat) update(frames);
                        if (needsRefresh) begin(server, true);
                    } else if (!heartbeat) {
                        if (buffered.size() >= runtime.option("receiveHwm")) begin(server, true);
                        else buffered.add(frames);
                    }
                }
            } catch (IllegalArgumentException error) {
                runtime.log("PROTOCOL_ERROR");
            }
        }

        void tick() {
            long now = clockMs();
            if (now >= deadline) begin((server + 1) % servers, false);
            if (staged == null && !demoSent && now >= nextWrite) {
                nextWrite = now + 250;
                // Publish the same UUID on each connection and keep it for retries.
                for (int index = 0; index < servers; index++) runtime.send("writer" + index, demo);
            }
        }
    }

    private static void advancedProgram(Advanced runtime) {
        runtime.log("READY");
        if (runtime.spec.get("program").asString().equals("clone-server")) {
            var server = new CloneServer(runtime);
            runtime.loop(server::receive, server::tick);
        } else {
            var client = new CloneClient(runtime);
            client.begin(0, false);
            runtime.loop(client::receive, client::tick);
        }
    }
`;
