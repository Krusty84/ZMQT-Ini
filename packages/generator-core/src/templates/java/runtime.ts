/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const imports = String.raw`import java.io.IOException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.ToIntFunction;
import org.zeromq.SocketType;
import org.zeromq.ZContext;
import org.zeromq.ZMQ;
import org.zeromq.ZMQException;
import sun.misc.Signal;
import tools.jackson.databind.JsonNode;

final class ZmqtRuntime {
`;

const pollSlice = String.raw`    private static final long SLICE_NS = TimeUnit.MILLISECONDS.toNanos(50);
`;

const configFields = String.raw`    private static final Set<String> CONFIG_FIELDS = Set.of("bindHost", "connectHost", "port", "socketOptions");
    private static final Map<String, Integer> MAXIMUMS = Map.of(
        "sendHwm", 1_000_000, "receiveHwm", 1_000_000,
        "sendTimeoutMs", 600_000, "receiveTimeoutMs", 600_000, "lingerMs", 60_000
    );
    private static final String IPV4 = "(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}";

`;

const singleSocketState = String.raw`    record Received(String outcome, byte[] frame) {}
    private record Config(String bindHost, String connectHost, int port, JsonNode options) {}

    private final String runId = System.getenv("ZMQT_TEST_RUN_ID");
    private volatile boolean stopping;
    private long sequence;
`;

const socketField = String.raw`    private ZMQ.Socket socket;
`;

const singleSocketPoller = String.raw`    private ZMQ.Poller poller;
`;

const validation = String.raw`    private JsonNode options;

    private static boolean exactFields(JsonNode value, Set<String> fields) {
        return value != null && value.isObject() && value.size() == fields.size()
            && fields.stream().allMatch(value::has);
    }

    private static InetAddress numericAddress(String host) {
        if (!host.matches(IPV4) && !(host.contains(":") && host.matches("[0-9a-fA-F:.]+"))) return null;
        String dotted = host.substring(host.lastIndexOf(':') + 1);
        if (dotted.contains(".") && !dotted.matches(IPV4)) return null;
        try {
            return InetAddress.ofLiteral(host);
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }

    private static String checkHost(JsonNode value, boolean connect) {
        if (!value.isString()) throw new IllegalArgumentException("Invalid host");
        String host = value.asString();
        if (host.equals("*")) {
            if (connect) throw new IllegalArgumentException("Connect requires a destination");
            return host;
        }
        InetAddress address = numericAddress(host);
        if (address != null) {
            if (connect && address.isAnyLocalAddress()) throw new IllegalArgumentException("Connect requires a destination");
            return host;
        }
        String name = host.endsWith(".") ? host.substring(0, host.length() - 1) : host;
        String[] labels = name.split("\\.", -1);
        if (name.length() > 253 || labels[labels.length - 1].matches("(?i)[0-9]+|0x[0-9a-f]*")
            || !Arrays.stream(labels).allMatch(label -> label.matches("(?i)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"))) {
            throw new IllegalArgumentException("Invalid host");
        }
        return host;
    }

    private static int checkInteger(JsonNode value, int minimum, int maximum) {
        if (!value.isNumber()) throw new IllegalArgumentException("Invalid integer option");
        double number = value.doubleValue();
        if (number < minimum || number > maximum || number != Math.rint(number)) {
            throw new IllegalArgumentException("Invalid integer option");
        }
        return (int) number;
    }

`;

const singleSocketConfig = String.raw`    private static Config load(String[] args) throws IOException {
        Path path = Path.of("config", "zmq.json");
        if (args.length == 2 && args[0].equals("--config")) path = Path.of(args[1]);
        else if (args.length != 0) throw new IllegalArgumentException("Expected --config PATH");
        JsonNode config = MessageCodec.decode(Files.readAllBytes(path));
        if (!exactFields(config, CONFIG_FIELDS)) throw new IllegalArgumentException("Invalid configuration");
        JsonNode options = config.get("socketOptions");
        if (!exactFields(options, MAXIMUMS.keySet())) throw new IllegalArgumentException("Invalid socket options");
        for (var option : MAXIMUMS.entrySet()) {
            checkInteger(options.get(option.getKey()), option.getKey().equals("lingerMs") ? 0 : 1, option.getValue());
        }
        return new Config(checkHost(config.get("bindHost"), false), checkHost(config.get("connectHost"), true),
            checkInteger(config.get("port"), 1, 65535), options);
    }

`;

const endpoints = String.raw`    private static List<String> addresses(String host) throws UnknownHostException {
        if (host.equals("*") || numericAddress(host) != null) return List.of(host);
        return Arrays.stream(InetAddress.getAllByName(host))
            .sorted(Comparator.comparingInt(address -> address.getAddress().length))
            .map(InetAddress::getHostAddress).distinct().toList();
    }

    private String endpoint(String host, int port) {
        boolean ipv6 = host.contains(":");
        require(socket.setIPv6(ipv6));
        return "tcp://" + (ipv6 ? "[" + host + "]" : host) + ":" + port;
    }

    private boolean bind(String host, int port) throws UnknownHostException {
        for (String address : addresses(host)) {
            try {
                if (socket.bind(endpoint(address, port))) return true;
            } catch (ZMQException error) {
                // An unavailable candidate does not prevent trying the next address.
            }
        }
        return false;
    }

    private static void require(boolean ok) {
        if (!ok) throw new IllegalStateException("ZeroMQ operation failed");
    }

    private int option(String name) {
        return options.get(name).intValue();
    }

    private void applyOptions(List<String> active) {
        for (String name : active) {
            int value = option(name);
            require(switch (name) {
                case "sendHwm" -> socket.setSndHWM(value);
                case "receiveHwm" -> socket.setRcvHWM(value);
                case "sendTimeoutMs" -> socket.setSendTimeOut(value);
                case "receiveTimeoutMs" -> socket.setReceiveTimeOut(value);
                case "lingerMs" -> socket.setLinger(value);
                default -> throw new IllegalArgumentException("Unknown socket option");
            });
        }
    }

`;

const singleSocketMessages = String.raw`    String nextId() {
        String prefix = runId == null || runId.isEmpty() ? "msg" : runId;
        return prefix + "-" + String.format(Locale.ROOT, "%04d", ++sequence);
    }

    JsonNode examplePayload(boolean includeRunId) {
        var payload = MessageCodec.object().put("value", 42);
        if (includeRunId && runId != null && !runId.isEmpty()) payload.put("runId", runId);
        return payload;
    }

`;

const logging = String.raw`    void log(String event, JsonNode data) {
        var entry = MessageCodec.object().put("event", event);
        if (data != null) {
            for (var field : data.properties()) entry.set(field.getKey(), field.getValue());
            JsonNode payload = data.get("payload");
            if (event.equals("MESSAGE_RECEIVED") && payload != null && payload.has("runId")) {
                entry.set("runId", payload.get("runId"));
            }
        }
        byte[] line = (MessageCodec.toJson(entry) + "\n").getBytes(StandardCharsets.UTF_8);
        System.out.write(line, 0, line.length);
        System.out.flush();
    }

`;

const singleSocketRuntime = String.raw`    String send(byte[] frame) {
        // sendTimeoutMs limits the wait for one send.
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(option("sendTimeoutMs"));
        try {
            while (!stopping) {
                if (socket.send(frame, ZMQ.DONTWAIT)) return "ok";
                if (socket.errno() != ZMQ.Error.EAGAIN.getCode()) return "error";
                String status = poll(deadline, ZMQ.Poller.POLLOUT);
                if (!status.equals("ok")) return status;
            }
        } catch (ZMQException error) {
            if (!stopping) return "error";
        }
        return "shutdown";
    }

    Received receive() {
        // receiveTimeoutMs limits the wait for one receive.
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(option("receiveTimeoutMs"));
        try {
            while (!stopping) {
                byte[] frame = socket.recv(ZMQ.DONTWAIT);
                if (frame != null) {
                    boolean multipart = socket.hasReceiveMore();
                    while (socket.hasReceiveMore()) socket.recv(ZMQ.DONTWAIT);
                    return new Received("ok", multipart ? null : frame);
                }
                if (socket.errno() != ZMQ.Error.EAGAIN.getCode()) return new Received("error", null);
                String status = poll(deadline, ZMQ.Poller.POLLIN);
                if (!status.equals("ok")) return new Received(status, null);
            }
        } catch (ZMQException error) {
            if (!stopping) return new Received("error", null);
        }
        return new Received("shutdown", null);
    }

    private String poll(long deadline, int events) {
        // Poll in short intervals to check for shutdown.
        if (stopping) return "shutdown";
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) return "timeout";
        poller.register(socket, events);
        try {
            long delay = Math.max(1, TimeUnit.NANOSECONDS.toMillis(Math.min(remaining, SLICE_NS)));
            if (poller.poll(delay) < 0) return stopping ? "shutdown" : "error";
        } finally {
            poller.unregister(socket);
        }
        if (stopping) return "shutdown";
        return System.nanoTime() >= deadline ? "timeout" : "ok";
    }

    String waitFor(int milliseconds) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(milliseconds);
        while (!stopping) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) return "ok";
            try {
                TimeUnit.NANOSECONDS.sleep(Math.min(remaining, SLICE_NS));
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return "shutdown";
            }
        }
        return "shutdown";
    }

    static int run(String[] args, SocketType type, String mode, List<String> activeOptions,
                   String subscription, ToIntFunction<ZmqtRuntime> behavior) {
        // Use your application's configuration, logger, and shutdown hook here.
        var runtime = new ZmqtRuntime();
        // Keep signal callbacks separate from socket operations on the main thread.
        Signal.handle(new Signal("INT"), signal -> runtime.stopping = true);
        Signal.handle(new Signal("TERM"), signal -> runtime.stopping = true);
        Config config;
        try {
            config = load(args);
        } catch (IOException | IllegalArgumentException error) {
            // Use CONFIG_ERROR when startup settings cannot be read or validated.
            runtime.log("CONFIG_ERROR", null);
            return 1;
        }
        runtime.options = config.options();

        int result;
        // Socket setup, connect, and I/O failures use TRANSPORT_ERROR.
        String errorEvent = "TRANSPORT_ERROR";
        try (ZContext context = new ZContext(); ZMQ.Socket socket = context.createSocket(type)) {
            runtime.socket = socket;
            try {
                // Apply the role's options before bind or connect.
                // sendHwm and receiveHwm limit the number of queued messages.
                runtime.applyOptions(activeOptions);
                // An empty SUB prefix matches every message.
                if (subscription != null) require(socket.subscribe(subscription));
                if (mode.equals("bind")) {
                    // Report a failure to open the local endpoint as BIND_ERROR.
                    errorEvent = "BIND_ERROR";
                    require(runtime.bind(config.bindHost(), config.port()));
                } else {
                    String address = addresses(config.connectHost()).getFirst();
                    require(socket.connect(runtime.endpoint(address, config.port())));
                }
                errorEvent = "TRANSPORT_ERROR";
                runtime.log("READY", null);
                try (ZMQ.Poller poller = context.createPoller(1)) {
                    runtime.poller = poller;
                    result = runtime.stopping ? 0 : behavior.applyAsInt(runtime);
                }
            } finally {
                // lingerMs limits how long pending sends can stay queued after socket close.
                require(socket.setLinger(runtime.option("lingerMs")));
            }
        } catch (IOException | RuntimeException error) {
            if (!runtime.stopping) runtime.log(errorEvent, null);
            result = runtime.stopping ? 0 : 1;
        }
        if (runtime.stopping) runtime.log("SHUTDOWN", null);
        return result;
    }
}
`;

export const javaRuntime =
  imports +
  pollSlice +
  configFields +
  singleSocketState +
  socketField +
  singleSocketPoller +
  validation +
  singleSocketConfig +
  endpoints +
  singleSocketMessages +
  logging +
  singleSocketRuntime;

export const javaAdvancedBase =
  imports +
  configFields +
  socketField +
  validation +
  endpoints +
  logging;
