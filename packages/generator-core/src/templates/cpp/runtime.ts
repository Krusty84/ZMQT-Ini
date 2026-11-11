/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const cppRuntimeHeader = `#pragma once

#include "message_codec.hpp"

#include <cstdint>
#include <utility>

#include <zmq.hpp>

namespace zmqt {

enum class Outcome { ok, timeout, error, shutdown };

class Runtime {
public:
    // Pass a configured socket from your application.
    // Keep the socket and options alive for the lifetime of Runtime.
    Runtime(zmq::socket_t& socket, const Json& options);
    std::string next_id();
    Json example_payload(bool include_run_id) const;
    void log(std::string_view event, const Json& data = Json::object()) const;
    Outcome send(const Frame& frame);
    std::pair<Outcome, Frame> receive();
    Outcome wait(int milliseconds) const;

private:
    template <typename Transfer>
    Outcome transfer(Transfer operation, short events, int timeout_ms);

    zmq::socket_t& socket_;
    const Json& options_;
    std::string run_id_;
    std::uint64_t sequence_ = 0;
};

int run(int argc, char* argv[], zmq::socket_type socket_type, bool binds,
        std::initializer_list<std::string_view> active_options, std::optional<std::string_view> subscription,
        int (*behavior)(Runtime&));

} // namespace zmqt
`;

export const cppRuntime = String.raw`#include "zmqt_runtime.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <regex>
#include <stdexcept>
#include <thread>
#include <vector>

#include <arpa/inet.h>
#include <netdb.h>

namespace zmqt {
namespace {

using Clock = std::chrono::steady_clock;
using Milliseconds = std::chrono::milliseconds;
constexpr Milliseconds poll_slice{50};
volatile std::sig_atomic_t stopping = 0;

void stop(int) { stopping = 1; }

struct Option {
    const char* name;
    int zmq_option;
    int minimum;
    int maximum;
};

constexpr Option socket_options[] = {
    {"sendHwm", ZMQ_SNDHWM, 1, 1000000},
    {"receiveHwm", ZMQ_RCVHWM, 1, 1000000},
    {"sendTimeoutMs", ZMQ_SNDTIMEO, 1, 600000},
    {"receiveTimeoutMs", ZMQ_RCVTIMEO, 1, 600000},
    {"lingerMs", ZMQ_LINGER, 0, 60000},
};

struct Config {
    std::string bind_host;
    std::string connect_host;
    int port;
    Json options;
};

enum class Host { ipv4, ipv6, dns, wildcard };

Host check_host(const std::string& host, bool connects) {
    if (host.find('\0') != std::string::npos) throw std::invalid_argument("Invalid host");
    if (host == "*") {
        if (connects) throw std::invalid_argument("Connect requires a destination");
        return Host::wildcard;
    }

    in_addr address4{};
    if (inet_pton(AF_INET, host.c_str(), &address4) == 1) {
        if (connects && address4.s_addr == 0) throw std::invalid_argument("Connect requires a destination");
        return Host::ipv4;
    }
    in6_addr address6{};
    if (inet_pton(AF_INET6, host.c_str(), &address6) == 1) {
        const auto* bytes = address6.s6_addr;
        const bool mapped_zero = IN6_IS_ADDR_V4MAPPED(&address6) &&
            std::all_of(bytes + 12, bytes + 16, [](unsigned char byte) { return byte == 0; });
        if (connects && (IN6_IS_ADDR_UNSPECIFIED(&address6) || mapped_zero)) {
            throw std::invalid_argument("Connect requires a destination");
        }
        return Host::ipv6;
    }

    static const std::regex label_pattern("[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?");
    static const std::regex numeric_pattern("([0-9]+|0[xX][0-9a-fA-F]*)");
    std::string_view name = host;
    if (name.ends_with('.')) name.remove_suffix(1);
    if (name.size() > 253) throw std::invalid_argument("Invalid host");
    for (;;) {
        const auto dot = name.find('.');
        const auto label = name.substr(0, dot);
        if (!std::regex_match(label.begin(), label.end(), label_pattern)) throw std::invalid_argument("Invalid host");
        if (dot == std::string_view::npos) {
            if (std::regex_match(label.begin(), label.end(), numeric_pattern)) throw std::invalid_argument("Invalid host");
            return Host::dns;
        }
        name.remove_prefix(dot + 1);
    }
}

int bounded_int(const Json& value, int minimum, int maximum) {
    if (!value.is_number()) throw std::invalid_argument("Invalid integer option");
    const auto number = value.get<double>();
    if (!std::isfinite(number) || number < minimum || number > maximum || std::trunc(number) != number) {
        throw std::invalid_argument("Invalid integer option");
    }
    return static_cast<int>(number);
}

Config load_config(int argc, char* argv[]) {
    const char* path = "config/zmq.json";
    if (argc == 3 && std::string_view{argv[1]} == "--config") path = argv[2];
    else if (argc != 1) throw std::invalid_argument("Expected --config PATH");

    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot read runtime configuration");
    const auto data = decode(std::string{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()});
    if (!data || !data->is_object() || data->size() != 4) throw std::invalid_argument("Invalid runtime configuration");
    Config config{data->at("bindHost").get<std::string>(), data->at("connectHost").get<std::string>(),
                  bounded_int(data->at("port"), 1, 65535), data->at("socketOptions")};
    check_host(config.bind_host, false);
    check_host(config.connect_host, true);
    if (!config.options.is_object() || config.options.size() != std::size(socket_options)) {
        throw std::invalid_argument("Invalid socket options");
    }
    for (const auto& option : socket_options) {
        config.options.at(option.name) = bounded_int(config.options.at(option.name), option.minimum, option.maximum);
    }
    return config;
}

std::vector<std::string> addresses(const std::string& host, bool connects) {
    if (check_host(host, connects) != Host::dns) return {host};
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* resolved = nullptr;
    if (getaddrinfo(host.c_str(), nullptr, &hints, &resolved) != 0) throw std::runtime_error("Cannot resolve host");
    const std::unique_ptr<addrinfo, decltype(&freeaddrinfo)> entries(resolved, &freeaddrinfo);
    std::vector<std::string> result;
    for (const int family : {AF_INET, AF_INET6}) {
        for (auto* entry = entries.get(); entry; entry = entry->ai_next) {
            if (entry->ai_family != family) continue;
            char address[INET6_ADDRSTRLEN]{};
            const void* bytes = family == AF_INET
                ? static_cast<const void*>(&reinterpret_cast<sockaddr_in*>(entry->ai_addr)->sin_addr)
                : static_cast<const void*>(&reinterpret_cast<sockaddr_in6*>(entry->ai_addr)->sin6_addr);
            if (inet_ntop(family, bytes, address, sizeof(address)) &&
                std::find(result.begin(), result.end(), address) == result.end()) result.emplace_back(address);
        }
    }
    if (result.empty()) throw std::runtime_error("No usable address");
    if (connects) check_host(result.front(), true);
    return result;
}

std::string endpoint(zmq::socket_t& socket, const std::string& host, int port) {
    const bool ipv6 = host.find(':') != std::string::npos;
    socket.set(zmq::sockopt::ipv6, ipv6 ? 1 : 0);
    return "tcp://" + (ipv6 ? "[" + host + "]" : host) + ":" + std::to_string(port);
}

void bind(zmq::socket_t& socket, const Config& config) {
    for (const auto& host : addresses(config.bind_host, false)) {
        try {
            socket.bind(endpoint(socket, host, config.port));
            return;
        } catch (const zmq::error_t&) {
            if (stopping) return;
        }
    }
    throw std::runtime_error("Could not bind any address");
}

void log_event(std::string_view event, Json data = Json::object()) {
    data["event"] = std::string(event);
    if (event == "MESSAGE_RECEIVED" && data["payload"].is_object() && data["payload"].contains("runId")) {
        const Json run_id = data["payload"]["runId"];
        data["runId"] = run_id;
    }
    std::cout << data.dump(-1, ' ', true) << std::endl;
}

struct LingerOnClose {
    zmq::socket_t& socket;
    int linger_ms;
    bool& failed;

    ~LingerOnClose() {
        // lingerMs limits how long pending sends can stay queued after socket close.
        try { socket.set(zmq::sockopt::linger, linger_ms); }
        catch (const zmq::error_t&) { failed = true; }
    }
};

} // namespace

Runtime::Runtime(zmq::socket_t& socket, const Json& options) : socket_(socket), options_(options) {
    if (const char* run_id = std::getenv("ZMQT_TEST_RUN_ID")) run_id_ = run_id;
}

std::string Runtime::next_id() {
    const auto number = std::to_string(++sequence_);
    return (run_id_.empty() ? "msg" : run_id_) + "-" + std::string(number.size() < 4 ? 4 - number.size() : 0, '0') + number;
}

Json Runtime::example_payload(bool include_run_id) const {
    Json payload{{"value", 42}};
    if (include_run_id && !run_id_.empty()) payload["runId"] = run_id_;
    return payload;
}

void Runtime::log(std::string_view event, const Json& data) const { log_event(event, data); }

template <typename Transfer>
Outcome Runtime::transfer(Transfer operation, short events, int timeout_ms) {
    // sendTimeoutMs or receiveTimeoutMs limits the wait for one operation.
    // Poll in short intervals to check for shutdown.
    const auto deadline = Clock::now() + Milliseconds{timeout_ms};
    std::array<zmq::pollitem_t, 1> sockets{{{socket_.handle(), 0, events, 0}}};
    try {
        while (!stopping) {
            if (operation()) return Outcome::ok;
            if (stopping) return Outcome::shutdown;
            const auto remaining = deadline - Clock::now();
            if (remaining <= Clock::duration::zero()) return Outcome::timeout;
            zmq::poll(sockets, std::min(poll_slice, std::chrono::ceil<Milliseconds>(remaining)));
            if (!stopping && Clock::now() >= deadline) return Outcome::timeout;
        }
    } catch (const zmq::error_t&) {
        if (!stopping) return Outcome::error;
    }
    return Outcome::shutdown;
}

Outcome Runtime::send(const Frame& frame) {
    if (!frame) return Outcome::error;
    return transfer([&] { return socket_.send(zmq::buffer(*frame), zmq::send_flags::dontwait).has_value(); },
                    ZMQ_POLLOUT, options_.at("sendTimeoutMs").get<int>());
}

std::pair<Outcome, Frame> Runtime::receive() {
    Frame frame;
    const auto outcome = transfer([&] {
        zmq::message_t part;
        if (!socket_.recv(part, zmq::recv_flags::dontwait)) return false;
        if (!socket_.get(zmq::sockopt::rcvmore)) {
            frame = part.to_string();
        } else {
            do {
                if (stopping) return false;
                if (!socket_.recv(part, zmq::recv_flags::dontwait)) throw zmq::error_t();
            } while (socket_.get(zmq::sockopt::rcvmore));
        }
        return true;
    }, ZMQ_POLLIN, options_.at("receiveTimeoutMs").get<int>());
    return {outcome, std::move(frame)};
}

Outcome Runtime::wait(int milliseconds) const {
    const auto deadline = Clock::now() + Milliseconds{milliseconds};
    while (!stopping) {
        const auto remaining = deadline - Clock::now();
        if (remaining <= Clock::duration::zero()) return Outcome::ok;
        std::this_thread::sleep_for(std::min(poll_slice, std::chrono::ceil<Milliseconds>(remaining)));
    }
    return Outcome::shutdown;
}

int run(int argc, char* argv[], zmq::socket_type socket_type, bool binds,
        std::initializer_list<std::string_view> active_options, std::optional<std::string_view> subscription,
        int (*behavior)(Runtime&)) {
    // Use your application's configuration, logger, and shutdown hook here.
    std::signal(SIGINT, stop);
    std::signal(SIGTERM, stop);

    Config config;
    try {
        config = load_config(argc, argv);
    } catch (const std::exception&) {
        // Use CONFIG_ERROR when startup settings cannot be read or validated.
        log_event("CONFIG_ERROR");
        return 1;
    }

    // Socket setup, connect, and I/O failures use TRANSPORT_ERROR.
    std::string_view error_event = "TRANSPORT_ERROR";
    bool cleanup_failed = false;
    int result = 1;
    try {
        zmq::context_t context(1);
        zmq::socket_t socket(context, socket_type);
        const LingerOnClose cleanup{socket, config.options.at("lingerMs").get<int>(), cleanup_failed};
        // Apply the role's options before bind or connect.
        // sendHwm and receiveHwm limit the number of queued messages.
        for (const auto& option : socket_options) {
            if (std::find(active_options.begin(), active_options.end(), option.name) == active_options.end()) continue;
            const int value = config.options.at(option.name).get<int>();
            if (zmq_setsockopt(socket.handle(), option.zmq_option, &value, sizeof(value)) != 0) throw zmq::error_t();
        }
        // An empty SUB prefix matches every message.
        if (subscription) socket.set(zmq::sockopt::subscribe, std::string(*subscription));
        if (binds) {
            // Report a failure to open the local endpoint as BIND_ERROR.
            error_event = "BIND_ERROR";
            bind(socket, config);
        } else {
            const auto host = addresses(config.connect_host, true).front();
            socket.connect(endpoint(socket, host, config.port));
        }
        error_event = "TRANSPORT_ERROR";
        if (!stopping) log_event("READY");
        Runtime runtime(socket, config.options);
        result = stopping ? 0 : behavior(runtime);
    } catch (const std::exception&) {
        if (stopping) result = 0;
        else log_event(error_event);
    }
    if (cleanup_failed) {
        log_event("TRANSPORT_ERROR");
        result = 1;
    }
    if (stopping) log_event("SHUTDOWN");
    return result;
}

} // namespace zmqt
`;
