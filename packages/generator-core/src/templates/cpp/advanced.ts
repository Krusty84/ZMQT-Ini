/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const cppAdvancedHeader = `#pragma once

#include "message_codec.hpp"
#include <zmq.hpp>

namespace zmqt {
int run_advanced(int argc, char* argv[], std::string_view spec);
}
`;

export const cppAdvanced = String.raw`
#include <atomic>
#include <future>
#include <map>
#include <mutex>
#include <zmq_addon.hpp>

namespace zmqt {
namespace {

using Multipart = std::vector<std::string>;

bool valid_subtree(const std::string& value) {
    static const std::regex pattern(R"(/(?:[^/\x00]+/)+)");
    return value.empty() || std::regex_match(value, pattern);
}

bool valid_utf8(const std::string& value) {
    try {
        (void)Json(value).dump();
        return true;
    } catch (const Json::type_error&) {
        return false;
    }
}

Config advanced_endpoint(const Json& group, int port_limit, const Json& options) {
    Config result{group.at("bindHost").get<std::string>(), group.at("connectHost").get<std::string>(),
        bounded_int(group.at("port"), 1, port_limit), options};
    check_host(result.bind_host, false);
    check_host(result.connect_host, true);
    return result;
}

Json load_advanced(int argc, char* argv[], const Json& spec) {
    const char* path = "config/zmq.json";
    if (argc == 3 && std::string_view{argv[1]} == "--config") path = argv[2];
    else if (argc != 1) throw std::invalid_argument("Expected --config PATH");
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot read runtime configuration");
    auto parsed = decode(std::string{std::istreambuf_iterator<char>(input), {}});
    std::vector<std::string> fields{"bindHost", "connectHost", "port", "socketOptions"};
    if (spec.at("timed").get<bool>()) fields.push_back("maxAgeMs");
    if (spec.at("program").get<std::string>().starts_with("clone")) fields.push_back("subtree");
    if (spec.contains("binaryStarTransitions")) fields.push_back("backup");
    if (!parsed || !parsed->is_object() || parsed->size() != fields.size() ||
        !std::all_of(fields.begin(), fields.end(), [&](const auto& field) { return parsed->contains(field); })) {
        throw std::invalid_argument("Invalid runtime configuration");
    }
    auto& data = *parsed;
    auto& options = data.at("socketOptions");
    validate_socket_options(options);
    const int max_port = 65536 - spec.at("portCount").get<int>();
    data["port"] = advanced_endpoint(data, max_port, options).port;
    if (data.contains("backup")) {
        auto& backup = data.at("backup");
        if (!backup.is_object() || backup.size() != 3) throw std::invalid_argument("Invalid backup");
        backup["port"] = advanced_endpoint(backup, max_port, options).port;
    }
    if (data.contains("maxAgeMs")) data["maxAgeMs"] = bounded_int(data.at("maxAgeMs"), 1, 600000);
    if (data.contains("subtree") && !valid_subtree(data.at("subtree").get<std::string>()))
        throw std::invalid_argument("Invalid subtree");
    return data;
}

std::int64_t clock_ms() {
    static const auto start = Clock::now();
    return std::chrono::duration_cast<Milliseconds>(Clock::now() - start).count();
}

std::uint64_t wall_ms() {
    return std::chrono::duration_cast<Milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string number_frame(std::uint64_t value) {
    std::string frame(8, '\0');
    for (auto byte = frame.rbegin(); byte != frame.rend(); ++byte) {
        *byte = static_cast<char>(value & 255);
        value >>= 8;
    }
    return frame;
}

std::uint64_t read_number(std::string_view frame) {
    if (frame.size() != 8) throw std::invalid_argument("Expected an eight-byte number");
    std::uint64_t value = 0;
    for (unsigned char byte : frame) value = (value << 8) | byte;
    return value;
}

std::string hex(std::string_view bytes) {
    constexpr std::string_view digits = "0123456789abcdef";
    std::string result;
    result.reserve(bytes.size() * 2);
    for (unsigned char byte : bytes) {
        result += digits[byte >> 4];
        result += digits[byte & 15];
    }
    return result;
}

Multipart receive_frames(zmq::socket_t& socket) {
    std::vector<zmq::message_t> parts;
    if (!zmq::recv_multipart(socket, std::back_inserter(parts), zmq::recv_flags::dontwait)) return {};
    Multipart frames;
    frames.reserve(parts.size());
    for (const auto& part : parts) frames.push_back(part.to_string());
    return frames;
}

class Advanced {
public:
    Advanced(const Json& spec, const Json& config)
        : spec(spec), config(config), options(config.at("socketOptions")) {
        for (const auto& definition : spec.at("sockets"))
            definitions.emplace(definition.at("name").get<std::string>(), definition);
    }

    ~Advanced() {
        halted = true;
        workers.clear();
        for (auto name = opened.rbegin(); name != opened.rend(); ++name) sockets.erase(*name);
    }

    bool finished() const { return stopping || halted; }

    void log(std::string_view event, Json data = Json::object()) {
        const std::scoped_lock lock(log_mutex);
        data["event"] = event;
        std::cout << data.dump(-1, ' ', true, Json::error_handler_t::replace) << std::endl;
    }

    void fail(std::string_view event) {
        if (!failed.exchange(true)) log(event);
        halted = true;
    }

    zmq::socket_t open_socket(const Json& definition) {
        static const std::map<std::string, zmq::socket_type> types{
            {"PUB", zmq::socket_type::pub}, {"SUB", zmq::socket_type::sub},
            {"XSUB", zmq::socket_type::xsub}, {"XPUB", zmq::socket_type::xpub},
            {"PUSH", zmq::socket_type::push}, {"PULL", zmq::socket_type::pull},
            {"PAIR", zmq::socket_type::pair}, {"ROUTER", zmq::socket_type::router},
            {"DEALER", zmq::socket_type::dealer},
        };
        zmq::socket_t socket(context, types.at(definition.at("type").get<std::string>()));
        const auto tcp_options = definition.at("tcpOptions").get<std::vector<std::string>>();
        for (const auto& option : socket_options) {
            const auto value = options.find(option.name);
            if (value == options.end()) continue;
            const std::string_view name = option.name;
            if (name == "lingerMs" || (name.starts_with("send") && definition.at("send").get<bool>()) ||
                (name.starts_with("receive") && definition.at("receive").get<bool>()) ||
                std::find(tcp_options.begin(), tcp_options.end(), option.name) != tcp_options.end()) {
                apply_socket_option(socket, option, *value);
            }
        }
        if (definition.value("verbose", false)) socket.set(zmq::sockopt::xpub_verbose, 1);
        if (definition.at("type") == "ROUTER") socket.set(zmq::sockopt::router_mandatory, 1);
        if (definition.at("name") == "peerOut" && !options.contains("immediate"))
            socket.set(zmq::sockopt::immediate, 1);
        const auto subscription = definition.value("subscriptions", "");
        if (subscription == "all") socket.set(zmq::sockopt::subscribe, "");
        if (subscription == "subtree") {
            const auto& prefix = config.at("subtree").get_ref<const std::string&>();
            socket.set(zmq::sockopt::subscribe, prefix);
            if (!prefix.empty()) socket.set(zmq::sockopt::subscribe, "HUGZ");
        }
        const bool binds = definition.at("mode") == "bind";
        if (definition.at("target") == "inproc") {
            const auto& address = definition.at("endpoint").get_ref<const std::string&>();
            if (binds) socket.bind(address);
            else socket.connect(address);
        } else {
            const auto& group = definition.at("target") == "backup" ? config.at("backup") : config;
            Config entry = advanced_endpoint(group, 65535, options);
            entry.port += definition.at("offset").get<int>();
            if (binds) bind(socket, entry);
            else socket.connect(endpoint(socket, addresses(entry.connect_host, true).front(), entry.port));
        }
        return socket;
    }

    void open(const std::string& name) {
        if (auto previous = sockets.find(name); previous != sockets.end()) {
            previous->second.set(zmq::sockopt::linger, 0);
            sockets.erase(previous);
        } else opened.push_back(name);
        sockets.emplace(name, open_socket(definitions.at(name)));
    }

    bool send(const std::string& name, const Multipart& frames, bool wait = false) {
        auto& socket = sockets.at(name);
        std::vector<zmq::const_buffer> buffers;
        buffers.reserve(frames.size());
        for (const auto& frame : frames) buffers.push_back(zmq::buffer(frame));
        const auto deadline = clock_ms() + options.at("sendTimeoutMs").get<int>();
        while (!finished()) {
            try {
                if (zmq::send_multipart(socket, buffers, zmq::send_flags::dontwait)) return true;
            } catch (const zmq::error_t& error) {
                if (error.num() == EHOSTUNREACH) return false;
                throw;
            }
            const auto remaining = deadline - clock_ms();
            if (!wait || remaining <= 0) return false;
            std::array<zmq::pollitem_t, 1> poll{{{socket.handle(), 0, ZMQ_POLLOUT, 0}}};
            zmq::poll(poll, Milliseconds{std::min<std::int64_t>(20, remaining)});
        }
        return false;
    }

    template<class Receive, class Tick>
    void loop(Receive receive, Tick tick) {
        while (!finished()) {
            tick();
            std::vector<std::string> names;
            std::vector<zmq::pollitem_t> poll;
            for (const auto& [name, socket] : sockets) {
                if (definitions.at(name).at("receive").get<bool>()) {
                    names.push_back(name);
                    poll.push_back({const_cast<void*>(socket.handle()), 0, ZMQ_POLLIN, 0});
                }
            }
            if (poll.empty()) {
                std::this_thread::sleep_for(Milliseconds{20});
                continue;
            }
            zmq::poll(poll, Milliseconds{20});
            for (std::size_t index = 0; index < names.size() && !finished(); index++) {
                auto& socket = sockets.at(names[index]);
                if ((poll[index].revents & ZMQ_POLLIN) && socket.handle() == poll[index].socket) {
                    auto frames = receive_frames(socket);
                    if (!frames.empty()) receive(names[index], frames);
                }
            }
        }
    }

    const Json& spec;
    const Json& config;
    const Json& options;
    std::map<std::string, Json> definitions;
    std::map<std::string, zmq::socket_t> sockets;
    std::atomic_bool halted = false;
    std::atomic_bool failed = false;
    std::vector<std::jthread> workers;

private:
    zmq::context_t context{1};
    std::mutex log_mutex;
    std::vector<std::string> opened;
};

} // namespace
} // namespace zmqt
`;

export const cppStream = String.raw`
namespace zmqt {
namespace {

void handle_event(Advanced& runtime, const Multipart& frames, int worker = 0) {
    const bool timed = runtime.spec.at("timed").get<bool>();
    if (frames.size() != (timed ? 3 : 2) || !valid_utf8(frames.front()) ||
        (timed && frames[1].size() != 8)) {
        runtime.log("PROTOCOL_ERROR");
        return;
    }
    const auto message = decode(frames.back());
    if (!message || !validate_message(*message, {"event"})) {
        runtime.log("PROTOCOL_ERROR");
        return;
    }
    if (timed && wall_ms() > read_number(frames[1]) &&
        wall_ms() - read_number(frames[1]) > runtime.config.at("maxAgeMs").get<std::uint64_t>()) {
        runtime.fail("SUBSCRIBER_TOO_SLOW");
        return;
    }
    // Process a validated application event here. Workers can run this concurrently.
    Json data{{"topic", frames.front()}, {"id", message->at("id")}, {"payload", message->at("payload")}};
    if (worker) data["worker"] = worker;
    runtime.log("MESSAGE_RECEIVED", data);
}

void stream_worker(Advanced& runtime, const Json& definition, std::promise<void> started) {
    try {
        auto socket = runtime.open_socket(definition);
        started.set_value();
        std::array<zmq::pollitem_t, 1> poll{{{socket.handle(), 0, ZMQ_POLLIN, 0}}};
        while (!runtime.halted) {
            zmq::poll(poll, Milliseconds{20});
            if (poll[0].revents & ZMQ_POLLIN) {
                const auto frames = receive_frames(socket);
                if (!frames.empty()) handle_event(runtime, frames, definition.at("worker").get<int>());
            }
        }
    } catch (const std::exception&) {
        if (!runtime.halted) runtime.fail("TRANSPORT_ERROR");
    }
}

void stream_proxy(Advanced& runtime) {
    const bool cache = runtime.spec.at("cache").get<bool>();
    const bool timed = runtime.spec.at("timed").get<bool>();
    const bool capture = runtime.sockets.contains("captureOut");
    std::map<std::string, Multipart> saved;
    const auto trace = [&](const std::string& direction, const Multipart& frames) {
        if (!capture) return;
        Multipart copy{direction};
        copy.insert(copy.end(), frames.begin(), frames.end());
        runtime.send("captureOut", copy);
    };
    if (cache) runtime.send("upstream", {std::string(1, '\1')}, true);
    runtime.log("READY");
    runtime.loop([&](const std::string& name, const Multipart& frames) {
        if (name == "captureIn") {
            Json copies = Json::array();
            for (auto it = frames.begin() + 1; it != frames.end(); ++it) copies.push_back(hex(*it));
            runtime.log("CAPTURE", {{"direction", frames.front()}, {"frames", copies}});
        } else if (name == "upstream") {
            trace("publication", frames);
            if (cache && frames.size() == (timed ? 3 : 2)) saved[frames.front()] = frames;
            runtime.send("downstream", frames);
        } else if (frames.size() == 1 && !frames[0].empty() && (frames[0][0] == '\0' || frames[0][0] == '\1')) {
            trace("subscription", frames);
            if (!cache) runtime.send("upstream", frames);
            else if (frames[0][0] == '\1') {
                const auto prefix = std::string_view(frames[0]).substr(1);
                for (const auto& [topic, last] : saved) {
                    if (!topic.starts_with(prefix)) continue;
                    const auto replay = timed ? Multipart{topic, number_frame(wall_ms()), last.back()} : last;
                    trace("replay", replay);
                    runtime.send("downstream", replay);
                }
            }
        }
    }, [] {});
}

void advanced_program(Advanced& runtime) {
    const auto& program = runtime.spec.at("program");
    if (program == "proxy") {
        stream_proxy(runtime);
    } else if (program == "subscribe") {
        for (const auto& [name, definition] : runtime.definitions) {
            if (!definition.contains("worker")) continue;
            std::promise<void> started;
            auto ready = started.get_future();
            runtime.workers.emplace_back(stream_worker, std::ref(runtime), std::cref(definition), std::move(started));
            ready.wait();
        }
        if (runtime.finished()) return;
        runtime.log("READY");
        runtime.loop([&](const std::string&, const Multipart& frames) {
            if (runtime.workers.empty()) handle_event(runtime, frames);
            else if (!runtime.send("dispatch", frames, true) && !runtime.finished()) runtime.log("SEND_TIMEOUT");
        }, [] {});
    } else {
        runtime.log("READY");
        std::uint64_t sequence = 0;
        std::int64_t next_send = 0;
        runtime.loop([](const std::string&, const Multipart&) {}, [&] {
            const auto now = clock_ms();
            if (now < next_send) return;
            next_send = now + 100;
            // Replace the example topic and payload with your application data.
            Multipart frames{++sequence % 2 ? "demo/a" : "demo/b"};
            if (runtime.spec.at("timed").get<bool>()) frames.push_back(number_frame(wall_ms()));
            frames.push_back(*encode({{"id", "event-" + std::to_string(sequence)}, {"type", "event"},
                                      {"payload", {{"value", 42}}}}));
            runtime.send("stream", frames);
        });
    }
}

} // namespace
} // namespace zmqt
`;

export const cppAdvancedEntry = String.raw`
namespace zmqt {

int run_advanced(int argc, char* argv[], std::string_view source) {
    std::signal(SIGINT, stop);
    std::signal(SIGTERM, stop);
    const auto spec = Json::parse(source);
    Json config;
    try {
        config = load_advanced(argc, argv, spec);
    } catch (const std::exception&) {
        log_event("CONFIG_ERROR");
        return 1;
    }
    std::string_view event = "TRANSPORT_ERROR";
    int status = 0;
    try {
        Advanced runtime(spec, config);
        for (const auto& definition : spec.at("sockets")) {
            if (definition.contains("worker")) continue;
            event = definition.at("mode") == "bind" ? "BIND_ERROR" : "TRANSPORT_ERROR";
            runtime.open(definition.at("name").get<std::string>());
        }
        event = "TRANSPORT_ERROR";
        if (!runtime.finished()) advanced_program(runtime);
        status = runtime.failed ? 1 : 0;
    } catch (const std::exception&) {
        if (!stopping) {
            log_event(event);
            status = 1;
        }
    }
    if (status == 0) log_event("SHUTDOWN");
    return status;
}

} // namespace zmqt
`;
