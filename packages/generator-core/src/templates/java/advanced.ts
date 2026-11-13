/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const javaAdvancedImports = `import java.nio.ByteBuffer;
import java.nio.channels.Selector;
import java.nio.charset.CharacterCodingException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiConsumer;
import tools.jackson.databind.node.ObjectNode;
`;

export const javaAdvanced = (cbor: boolean) => String.raw`
    private static boolean validSubtree(String value) {
        return value.isEmpty() || value.matches("/(?:[^/\\x00]+/)+");
    }

    private static JsonNode loadAdvanced(String[] args, JsonNode spec) throws IOException {
        Path path = Path.of("config", "zmq.json");
        if (args.length == 2 && args[0].equals("--config")) path = Path.of(args[1]);
        else if (args.length != 0) throw new IllegalArgumentException("Expected --config PATH");
        JsonNode config = MessageCodec.${cbor ? "decodeJson" : "decode"}(Files.readAllBytes(path));
        var fields = new java.util.HashSet<>(CONFIG_FIELDS);
        if (spec.get("timed").booleanValue()) fields.add("maxAgeMs");
        if (spec.get("program").asString().startsWith("clone")) fields.add("subtree");
        if (spec.has("binaryStarTransitions")) fields.add("backup");
        if (!exactFields(config, fields)) throw new IllegalArgumentException("Invalid configuration");
        validateSocketOptions(config.get("socketOptions"));
        var groups = new ArrayList<>(List.of(config));
        if (config.has("backup")) {
            if (!exactFields(config.get("backup"), Set.of("bindHost", "connectHost", "port")))
                throw new IllegalArgumentException("Invalid backup");
            groups.add(config.get("backup"));
        }
        for (var group : groups) {
            checkHost(group.get("bindHost"), false);
            checkHost(group.get("connectHost"), true);
            checkInteger(group.get("port"), 1, 65536 - spec.get("portCount").intValue());
        }
        if (config.has("maxAgeMs")) checkInteger(config.get("maxAgeMs"), 1, 600000);
        if (config.has("subtree") && (!config.get("subtree").isString() || !validSubtree(config.get("subtree").asString())))
            throw new IllegalArgumentException("Invalid subtree");
        return config;
    }

    private static final long ADVANCED_START = System.nanoTime();

    private static long clockMs() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - ADVANCED_START); }

    private static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }

    private static String text(byte[] bytes) { return new String(bytes, StandardCharsets.UTF_8); }

    private static String strictText(byte[] bytes) {
        try {
            return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException error) {
            throw new IllegalArgumentException("Invalid UTF-8", error);
        }
    }

    private static String hex(byte[] bytes) { return HexFormat.of().formatHex(bytes); }

    private static byte[] numberFrame(long value) { return ByteBuffer.allocate(8).putLong(value).array(); }

    private static long readNumber(byte[] frame) {
        if (frame.length != 8) throw new IllegalArgumentException("Expected an eight-byte number");
        return ByteBuffer.wrap(frame).getLong();
    }

    private static boolean prefixMatches(byte[] value, byte[] prefix) {
        return value.length >= prefix.length &&
            Arrays.equals(value, 0, prefix.length, prefix, 0, prefix.length);
    }

    private static List<byte[]> receiveFrames(ZMQ.Socket socket) {
        byte[] frame = socket.recv(ZMQ.DONTWAIT);
        if (frame == null) return List.of();
        var frames = new ArrayList<byte[]>();
        frames.add(frame);
        while (socket.hasReceiveMore()) {
            frame = socket.recv(ZMQ.DONTWAIT);
            if (frame == null) throw new IllegalStateException("Incomplete multipart receive");
            frames.add(frame);
        }
        return frames;
    }

    private static final class Advanced implements AutoCloseable {
        private final JsonNode spec;
        private final JsonNode config;
        private final ZContext context = new ZContext();
        private final Selector selector = context.createSelector();
        private final Map<String, JsonNode> definitions = new LinkedHashMap<>();
        private final Map<String, ZMQ.Socket> sockets = new LinkedHashMap<>();
        private final List<Thread> workers = new ArrayList<>();
        private final AtomicBoolean failed = new AtomicBoolean();
        private final ZmqtRuntime logger = new ZmqtRuntime();
        private volatile boolean halted;

        Advanced(JsonNode spec, JsonNode config) {
            this.spec = spec;
            this.config = config;
            for (var definition : spec.get("sockets")) definitions.put(definition.get("name").asString(), definition);
        }

        int option(String name) { return config.get("socketOptions").get(name).intValue(); }

        synchronized void log(String event, JsonNode data) { logger.log(event, data); }
        void log(String event) { log(event, null); }

        void fail(String event) {
            if (failed.compareAndSet(false, true)) log(event);
            halted = true;
        }

        ZMQ.Socket openSocket(JsonNode definition) throws IOException {
            var type = SocketType.valueOf(definition.get("type").asString());
            var socket = context.createSocket(type);
            try {
                var transport = new ZmqtRuntime();
                transport.socket = socket;
                transport.options = config.get("socketOptions");
                var options = new ArrayList<>(List.of("lingerMs"));
                if (definition.get("send").booleanValue()) options.addAll(List.of("sendHwm", "sendTimeoutMs"));
                if (definition.get("receive").booleanValue()) options.addAll(List.of("receiveHwm", "receiveTimeoutMs"));
                for (var option : definition.get("tcpOptions")) options.add(option.asString());
                transport.applyOptions(options);
                if (definition.has("verbose")) require(socket.setXpubVerbose(definition.get("verbose").booleanValue()));
                if (type == SocketType.ROUTER) require(socket.setRouterMandatory(true));
                var subscription = definition.has("subscriptions") ? definition.get("subscriptions").asString() : "";
                if (subscription.equals("all")) require(socket.subscribe(""));
                if (subscription.equals("subtree")) {
                    var prefix = config.get("subtree").asString();
                    require(socket.subscribe(prefix));
                    if (!prefix.isEmpty()) require(socket.subscribe("HUGZ"));
                }

                var target = definition.get("target").asString();
                boolean binds = definition.get("mode").asString().equals("bind");
                if (target.equals("inproc")) {
                    var address = definition.get("endpoint").asString();
                    require(binds ? socket.bind(address) : socket.connect(address));
                } else {
                    var group = target.equals("backup") ? config.get("backup") : config;
                    int port = group.get("port").intValue() + definition.get("offset").intValue();
                    if (binds) require(transport.bind(group.get("bindHost").asString(), port));
                    else {
                        var address = addresses(group.get("connectHost").asString()).getFirst();
                        require(socket.connect(transport.endpoint(address, port)));
                    }
                }
                return socket;
            } catch (IOException | RuntimeException error) {
                socket.setLinger(0);
                context.destroySocket(socket);
                throw error;
            }
        }

        void open(String name) throws IOException {
            var old = sockets.remove(name);
            if (old != null) {
                old.setLinger(0);
                context.destroySocket(old);
            }
            sockets.put(name, openSocket(definitions.get(name)));
        }

        void reopen(String name) {
            try {
                open(name);
            } catch (IOException error) {
                throw new IllegalStateException("Cannot open socket", error);
            }
        }

        boolean send(String name, List<byte[]> frames) { return send(name, frames, false); }

        boolean send(String name, List<byte[]> frames, boolean wait) {
            var socket = sockets.get(name);
            long deadline = clockMs() + option("sendTimeoutMs");
            while (!halted) {
                int index = 0;
                int error;
                try {
                    for (; index < frames.size(); index++) {
                        int flags = ZMQ.DONTWAIT | (index + 1 < frames.size() ? ZMQ.SNDMORE : 0);
                        if (!socket.send(frames.get(index), flags)) break;
                    }
                    if (index == frames.size()) return true;
                    error = socket.errno();
                } catch (ZMQException failure) {
                    error = failure.getErrorCode();
                }
                if (index != 0) throw new IllegalStateException("Incomplete multipart send");
                if (error == ZMQ.Error.EHOSTUNREACH.getCode()) return false;
                if (error != ZMQ.Error.EAGAIN.getCode()) throw new ZMQException(error);
                long remaining = deadline - clockMs();
                if (!wait || remaining <= 0) return false;
                ZMQ.poll(selector, new ZMQ.PollItem[]{new ZMQ.PollItem(socket, ZMQ.Poller.POLLOUT)}, Math.min(20, remaining));
            }
            return false;
        }

        void loop(BiConsumer<String, List<byte[]>> receive, Runnable tick) {
            while (!halted) {
                tick.run();
                var names = new ArrayList<String>();
                var items = new ArrayList<ZMQ.PollItem>();
                for (var entry : sockets.entrySet()) {
                    if (definitions.get(entry.getKey()).get("receive").booleanValue()) {
                        names.add(entry.getKey());
                        items.add(new ZMQ.PollItem(entry.getValue(), ZMQ.Poller.POLLIN));
                    }
                }
                if (items.isEmpty()) {
                    try { Thread.sleep(20); }
                    catch (InterruptedException error) { Thread.currentThread().interrupt(); halted = true; }
                    continue;
                }
                ZMQ.poll(selector, items.toArray(ZMQ.PollItem[]::new), 20);
                for (int index = 0; index < names.size() && !halted; index++) {
                    var item = items.get(index);
                    if (item.isReadable() && item.getSocket() == sockets.get(names.get(index))) {
                        var frames = receiveFrames(item.getSocket());
                        if (!frames.isEmpty()) receive.accept(names.get(index), frames);
                    }
                }
            }
        }

        @Override public void close() {
            halted = true;
            boolean interrupted = false;
            for (var worker : workers) {
                while (worker.isAlive()) {
                    try { worker.join(); }
                    catch (InterruptedException error) { interrupted = true; }
                }
            }
            var opened = new ArrayList<>(sockets.values());
            Collections.reverse(opened);
            for (var socket : opened) context.destroySocket(socket);
            context.closeSelector(selector);
            context.close();
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    static int runAdvanced(String[] args, String descriptor) {
        var spec = MessageCodec.decodeText(descriptor);
        JsonNode config;
        try {
            config = loadAdvanced(args, spec);
        } catch (IOException | RuntimeException error) {
            new ZmqtRuntime().log("CONFIG_ERROR", null);
            return 1;
        }
        try (var runtime = new Advanced(spec, config)) {
            Signal.handle(new Signal("INT"), signal -> runtime.halted = true);
            Signal.handle(new Signal("TERM"), signal -> runtime.halted = true);
            String event = "TRANSPORT_ERROR";
            try {
                for (var definition : runtime.definitions.values()) {
                    if (definition.has("worker")) continue;
                    event = definition.get("mode").asString().equals("bind") ? "BIND_ERROR" : "TRANSPORT_ERROR";
                    runtime.open(definition.get("name").asString());
                }
                event = "TRANSPORT_ERROR";
                if (!runtime.halted) advancedProgram(runtime);
            } catch (IOException | RuntimeException error) {
                if (!runtime.halted) runtime.fail(event);
            }
            if (!runtime.failed.get()) runtime.log("SHUTDOWN");
            return runtime.failed.get() ? 1 : 0;
        }
    }
`;

export const javaStream = (cbor: boolean) => String.raw`
    private static void handleEvent(Advanced runtime, List<byte[]> frames, int worker) {
        boolean timed = runtime.spec.get("timed").booleanValue();
        if (frames.size() != (timed ? 3 : 2)) {
            runtime.log("PROTOCOL_ERROR");
            return;
        }
        String topic;
        long sentAt;
        try {
            topic = strictText(frames.getFirst());
            sentAt = timed ? readNumber(frames.get(1)) : 0;
        } catch (IllegalArgumentException error) {
            runtime.log("PROTOCOL_ERROR");
            return;
        }
        var message = MessageCodec.decode(frames.getLast());
        if (!MessageCodec.validateMessage(message, Set.of("event"), null)) {
            runtime.log("PROTOCOL_ERROR");
            return;
        }
        long now = System.currentTimeMillis();
        if (timed && Long.compareUnsigned(now, sentAt) >= 0 &&
            now - sentAt > runtime.config.get("maxAgeMs").intValue()) {
            runtime.fail("SUBSCRIBER_TOO_SLOW");
            return;
        }
        // Process a validated application event here. Workers can run this concurrently.
        var data = MessageCodec.object().put("topic", topic).put("id", MessageCodec.extractId(message));
        data.set("payload", message.get("payload"));
        if (worker != 0) data.put("worker", worker);
        runtime.log("MESSAGE_RECEIVED", data);
    }

    private static void streamWorker(Advanced runtime, JsonNode definition, CountDownLatch started) {
        ZMQ.Socket socket = null;
        try (var poller = runtime.context.createPoller(1)) {
            socket = runtime.openSocket(definition);
            int index = poller.register(socket, ZMQ.Poller.POLLIN);
            started.countDown();
            while (!runtime.halted) {
                if (poller.poll(20) > 0 && poller.pollin(index)) {
                    var frames = receiveFrames(socket);
                    if (!frames.isEmpty()) handleEvent(runtime, frames, definition.get("worker").intValue());
                }
            }
        } catch (IOException | RuntimeException error) {
            if (!runtime.halted) runtime.fail("TRANSPORT_ERROR");
        } finally {
            if (socket != null) runtime.context.destroySocket(socket);
            started.countDown();
        }
    }

    private static void streamProxy(Advanced runtime) {
        boolean cache = runtime.spec.get("cache").booleanValue();
        boolean timed = runtime.spec.get("timed").booleanValue();
        boolean capture = runtime.sockets.containsKey("captureOut");
        var saved = new LinkedHashMap<String, List<byte[]>>();
        BiConsumer<String, List<byte[]>> trace = (direction, frames) -> {
            if (capture) {
                var copy = new ArrayList<byte[]>();
                copy.add(bytes(direction));
                copy.addAll(frames);
                runtime.send("captureOut", copy);
            }
        };
        if (cache) runtime.send("upstream", List.of(new byte[]{1}), true);
        runtime.log("READY");
        runtime.loop((name, frames) -> {
            if (name.equals("captureIn")) {
                var data = MessageCodec.object().put("direction", text(frames.getFirst()));
                var copies = data.putArray("frames");
                for (int index = 1; index < frames.size(); index++) copies.add(hex(frames.get(index)));
                runtime.log("CAPTURE", data);
            } else if (name.equals("upstream")) {
                trace.accept("publication", frames);
                if (cache && frames.size() == (timed ? 3 : 2)) saved.put(hex(frames.getFirst()), frames);
                runtime.send("downstream", frames);
            } else if (frames.size() == 1 && frames.getFirst().length > 0) {
                var control = frames.getFirst();
                if (control[0] != 0 && control[0] != 1) return;
                trace.accept("subscription", frames);
                if (!cache) runtime.send("upstream", frames);
                else if (control[0] == 1) {
                    var prefix = Arrays.copyOfRange(control, 1, control.length);
                    for (var last : saved.values()) {
                        var topic = last.getFirst();
                        if (!prefixMatches(topic, prefix)) continue;
                        var replay = timed ? List.of(topic, numberFrame(System.currentTimeMillis()), last.getLast()) : last;
                        trace.accept("replay", replay);
                        runtime.send("downstream", replay);
                    }
                }
            }
        }, () -> {});
    }

    private static void advancedProgram(Advanced runtime) {
        switch (runtime.spec.get("program").asString()) {
            case "proxy" -> streamProxy(runtime);
            case "subscribe" -> {
                var ready = new CountDownLatch(runtime.spec.get("workers").intValue());
                for (var definition : runtime.definitions.values()) {
                    if (definition.has("worker")) {
                        runtime.workers.add(Thread.ofPlatform().start(() -> streamWorker(runtime, definition, ready)));
                    }
                }
                try { ready.await(); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); runtime.halted = true; }
                if (runtime.halted) return;
                runtime.log("READY");
                runtime.loop((name, frames) -> {
                    if (runtime.workers.isEmpty()) handleEvent(runtime, frames, 0);
                    else if (!runtime.send("dispatch", frames, true) && !runtime.halted) runtime.log("SEND_TIMEOUT");
                }, () -> {});
            }
            default -> {
                runtime.log("READY");
                runtime.loop((name, frames) -> {}, new Runnable() {
                    private long sequence;
                    private long nextSend = clockMs();

                    @Override public void run() {
                        long now = clockMs();
                        if (now < nextSend) return;
                        nextSend = now + 100;
                        // Replace the example topic and payload with your application data.
                        var frames = new ArrayList<byte[]>();
                        frames.add(bytes(++sequence % 2 == 1 ? "demo/a" : "demo/b"));
                        if (runtime.spec.get("timed").booleanValue()) frames.add(numberFrame(System.currentTimeMillis()));
${cbor ? `                        var event = MessageCodec.encode(MessageCodec.message("event-" + sequence, "event",
                            MessageCodec.telemetryPayload()));
                        if (event == null) {
                            runtime.fail("PROTOCOL_ERROR");
                            return;
                        }
                        frames.add(event);` : `                        frames.add(MessageCodec.encode(MessageCodec.message("event-" + sequence, "event",
                            MessageCodec.object().put("value", 42))));`}
                        runtime.send("stream", frames);
                    }
                });
            }
        }
    }
`;
