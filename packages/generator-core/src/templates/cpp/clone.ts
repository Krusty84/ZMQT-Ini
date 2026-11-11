/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const cppClone = String.raw`
#include <charconv>
#include <list>
#include <random>

namespace zmqt {
namespace {

constexpr std::int64_t heartbeat_ms = 1000;
constexpr std::int64_t peer_timeout_ms = 3 * heartbeat_ms;

Multipart chp(const std::string& key, std::uint64_t sequence, const std::string& uuid = {},
              const std::string& properties = {}, const std::string& value = {}) {
    return {key, number_frame(sequence), uuid, properties, value};
}

bool valid_key(const std::string& key) {
    return !key.empty() && key != "HUGZ" && key != "KTHXBAI" && key.find('\0') == std::string::npos;
}

std::uint64_t read_chp(const Multipart& frames, bool uuid_required = false) {
    if (frames.size() != 5 || !valid_key(frames[0]) ||
        (frames[2].size() != 16 && (uuid_required || !frames[2].empty()))) {
        throw std::invalid_argument("Invalid CHP message");
    }
    return read_number(frames[1]);
}

std::uint64_t expiry(std::string_view properties) {
    while (!properties.empty()) {
        const auto newline = properties.find('\n');
        const auto property = properties.substr(0, newline);
        if (property.starts_with("ttl=")) {
            const auto text = property.substr(4);
            unsigned int seconds = 0;
            const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), seconds);
            if (error != std::errc{} || end != text.data() + text.size() || seconds > 2147483647)
                throw std::invalid_argument("Invalid TTL");
            return seconds == 0 ? 0 : wall_ms() + std::uint64_t{seconds} * 1000;
        }
        if (newline == std::string_view::npos) break;
        properties.remove_prefix(newline + 1);
    }
    return 0;
}

template<class Value>
class Recent {
public:
    explicit Recent(std::size_t limit) : limit(limit) {}

    bool contains(const std::string& key) const { return index.contains(key); }

    void erase(const std::string& key) {
        const auto found = index.find(key);
        if (found == index.end()) return;
        values.erase(found->second);
        index.erase(found);
    }

    void add(const std::string& key, Value value) {
        if (contains(key)) return;
        values.emplace_back(key, std::move(value));
        index.emplace(key, std::prev(values.end()));
        if (values.size() > limit) erase(values.front().first);
    }

    auto take() {
        index.clear();
        return std::exchange(values, {});
    }

    std::list<std::pair<std::string, Value>> values;

private:
    std::size_t limit;
    std::map<std::string, typename std::list<std::pair<std::string, Value>>::iterator> index;
};

class CloneServer {
public:
    explicit CloneServer(Advanced& runtime)
        : runtime(runtime), binary(runtime.spec.contains("binaryStarTransitions")),
          state(!binary ? "active" : runtime.spec.at("role") == "server" ? "primary" : "backup"),
          pending(runtime.options.at("receiveHwm").get<std::size_t>()),
          seen(runtime.options.at("receiveHwm").get<std::size_t>()) {}

    void receive(const std::string& name, const Multipart& frames) {
        try {
            if (name == "snapshot") snapshot(frames);
            else if (name == "collector") {
                read_chp(frames, true);
                const auto expires = expiry(frames[3]);
                if (state == "active") commit(frames, expires);
                else if (!seen.contains(frames[2])) pending.add(frames[2], {frames, expires});
            } else receive_peer(frames);
        } catch (const std::invalid_argument&) {
            runtime.log("PROTOCOL_ERROR");
        }
    }

    void tick() {
        const auto now = clock_ms();
        if (binary && now >= next_peer) {
            next_peer = now + heartbeat_ms;
            runtime.send("peerOut", {"STATE", state, number_frame(sequence)});
        }
        if (state == "passive" && !synced && now >= next_sync) {
            next_sync = now + heartbeat_ms;
            runtime.send("peerOut", {"SYNC"});
        }
        if (state == "active") {
            expire();
            if (now >= next_heartbeat) {
                next_heartbeat = now + heartbeat_ms;
                runtime.send("updates", chp("HUGZ", 0));
            }
        }
    }

private:
    struct Entry {
        std::string value;
        std::uint64_t expires;
    };

    void transition(const std::string& event) {
        const auto& choices = runtime.spec.at("binaryStarTransitions").at(state);
        if (!choices.contains(event)) return;
        auto next = choices.at(event).get<std::string>();
        if (next == "conflict") {
            runtime.fail("BINARY_STAR_CONFLICT");
            return;
        }
        if (next == "active" && state == "passive" && !synced) return;
        state = std::move(next);
        next_peer = 0;
        synced = false;
        runtime.log("BINARY_STAR_STATE", {{"role", runtime.spec.at("role")}, {"state", state}});
        if (state == "active") {
            for (const auto& [uuid, write] : pending.take()) commit(write.first, write.second);
        } else if (state == "passive") next_sync = 0;
    }

    void apply(const Multipart& frames, std::uint64_t expires) {
        sequence = read_chp(frames);
        if (frames[4].empty()) data.erase(frames[0]);
        else data[frames[0]] = {frames[4], expires};
        if (!frames[2].empty()) {
            seen.add(frames[2], true);
            pending.erase(frames[2]);
        }
    }

    void commit(const Multipart& frames, std::uint64_t expires) {
        read_chp(frames);
        if (seen.contains(frames[2])) return;
        const auto publication = chp(frames[0], sequence + 1, frames[2], frames[3], frames[4]);
        apply(publication, expires);
        if (binary) {
            Multipart replica{"COMMIT"};
            replica.insert(replica.end(), publication.begin(), publication.end());
            replica.push_back(number_frame(expires));
            runtime.send("peerOut", replica);
        }
        runtime.send("updates", publication);
        next_heartbeat = clock_ms() + heartbeat_ms;
    }

    void expire() {
        const auto now = wall_ms();
        for (auto it = data.begin(); it != data.end();) {
            const auto current = it++;
            if (current->second.expires && current->second.expires <= now) {
                commit(chp(current->first, 0), 0);
            }
        }
    }

    void snapshot(const Multipart& frames) {
        if (frames.size() != 3 || frames[1] != "ICANHAZ?" || !valid_utf8(frames[2]) || !valid_subtree(frames[2]))
            throw std::invalid_argument("Invalid snapshot request");
        if (state == "passive" && clock_ms() >= peer_deadline) transition("vote");
        if (state != "active") return;
        expire();
        const auto watermark = sequence;
        const auto reply = [&](const auto& key, const auto& value) {
            auto row = chp(key, watermark, {}, {}, value);
            row.insert(row.begin(), frames[0]);
            return runtime.send("snapshot", row, true);
        };
        for (const auto& [key, entry] : data) {
            if (key.starts_with(frames[2]) && !reply(key, entry.value)) return;
        }
        reply("KTHXBAI", frames[2]);
    }

    void send_replica() {
        expire();
        Multipart snapshot{"SNAPSHOT", number_frame(sequence), number_frame(data.size())};
        for (const auto& [key, entry] : data) {
            snapshot.push_back(key);
            snapshot.push_back(number_frame(entry.expires));
            snapshot.push_back(entry.value);
        }
        for (const auto& [uuid, _] : seen.values) snapshot.push_back(uuid);
        runtime.send("peerOut", snapshot);
    }

    void receive_replica(const Multipart& frames) {
        const auto watermark = read_number(frames[2]);
        const auto count = read_number(frames[3]);
        if (count > (frames.size() - 4) / 3) throw std::invalid_argument("Invalid replica snapshot");
        const auto end = 4 + count * 3;
        std::map<std::string, Entry> snapshot;
        for (std::size_t index = 4; index < end; index += 3) {
            if (!valid_key(frames[index]) || frames[index + 2].empty())
                throw std::invalid_argument("Invalid replica row");
            snapshot[frames[index]] = {frames[index + 2], read_number(frames[index + 1])};
        }
        for (std::size_t index = end; index < frames.size(); index++) {
            if (frames[index].size() != 16) throw std::invalid_argument("Invalid UUID");
        }
        data = std::move(snapshot);
        sequence = watermark;
        seen.take();
        for (std::size_t index = end; index < frames.size(); index++) {
            seen.add(frames[index], true);
            pending.erase(frames[index]);
        }
        synced = true;
        runtime.log("REPLICA_SYNCED", {{"role", runtime.spec.at("role")}, {"sequence", std::to_string(sequence)}});
    }

    void receive_peer(const Multipart& frames) {
        if (frames.size() < 2) throw std::invalid_argument("Invalid peer message");
        const auto& command = frames[1];
        if (command == "STATE" && frames.size() == 4) {
            if (!runtime.spec.at("binaryStarTransitions").contains(frames[2]))
                throw std::invalid_argument("Invalid peer state");
            const auto peer_sequence = read_number(frames[3]);
            peer_deadline = clock_ms() + peer_timeout_ms;
            transition(frames[2]);
            if (state == "passive" && peer_sequence > sequence) synced = false;
        } else if (command == "SYNC" && frames.size() == 2 && state == "active") {
            send_replica();
        } else if (command == "SNAPSHOT" && frames.size() >= 4 && state == "passive") {
            receive_replica(frames);
        } else if (command == "COMMIT" && frames.size() == 8 && state == "passive") {
            const auto expires = read_number(frames[7]);
            const Multipart publication(frames.begin() + 2, frames.begin() + 7);
            const auto revision = read_chp(publication);
            if (synced && revision == sequence + 1) apply(publication, expires);
            else if (revision > sequence) synced = false;
        }
    }

    Advanced& runtime;
    bool binary;
    std::string state;
    bool synced = false;
    std::uint64_t sequence = 0;
    std::int64_t peer_deadline = 0;
    std::int64_t next_peer = 0;
    std::int64_t next_sync = 0;
    std::int64_t next_heartbeat = 0;
    std::map<std::string, Entry> data;
    Recent<std::pair<Multipart, std::uint64_t>> pending;
    Recent<bool> seen;
};

std::string uuid_v4() {
    std::random_device random;
    std::string uuid(16, '\0');
    for (auto& byte : uuid) byte = static_cast<char>(random() & 255);
    uuid[6] = static_cast<char>((uuid[6] & 15) | 64);
    uuid[8] = static_cast<char>((uuid[8] & 63) | 128);
    return uuid;
}

class CloneClient {
public:
    explicit CloneClient(Advanced& runtime)
        : runtime(runtime), prefix(runtime.config.at("subtree").get<std::string>()),
          servers(runtime.spec.contains("binaryStarTransitions") ? 2 : 1),
          demo(chp(prefix.empty() ? "/demo/value" : prefix + "demo", 0, uuid_v4(), {}, "42")) {}

    void begin(int index, bool refresh = false) {
        server = index;
        staged.emplace();
        buffered.clear();
        watermark = 0;
        stream_seen = refresh;
        needs_refresh = !refresh;
        deadline = clock_ms() + peer_timeout_ms;
        const auto suffix = std::to_string(server);
        if (!refresh) runtime.open("updates" + suffix);
        runtime.open("snapshot" + suffix);
        runtime.send("snapshot" + suffix, {"ICANHAZ?", prefix}, true);
    }

    void receive(const std::string& name, const Multipart& frames) {
        try {
            const auto suffix = std::to_string(server);
            if (name == "snapshot" + suffix) receive_snapshot(frames);
            else if (name == "updates" + suffix) {
                const bool heartbeat = frames == chp("HUGZ", 0);
                if (!heartbeat) read_chp(frames);
                stream_seen = true;
                if (!staged) {
                    deadline = clock_ms() + peer_timeout_ms;
                    if (!heartbeat) update(frames);
                    if (needs_refresh) begin(server, true);
                } else if (!heartbeat) {
                    if (buffered.size() >= runtime.options.at("receiveHwm").get<std::size_t>()) begin(server, true);
                    else buffered.push_back(frames);
                }
            }
        } catch (const std::invalid_argument&) {
            runtime.log("PROTOCOL_ERROR");
        }
    }

    void tick() {
        const auto now = clock_ms();
        if (now >= deadline) begin((server + 1) % servers);
        if (!staged && !demo_sent && now >= next_write) {
            next_write = now + 250;
            // Publish the same UUID on each connection and keep it for retries.
            for (int index = 0; index < servers; index++) runtime.send("writer" + std::to_string(index), demo);
        }
    }

private:
    void update(const Multipart& frames) {
        const auto revision = read_chp(frames);
        if (revision <= sequence || !frames[0].starts_with(prefix)) return;
        sequence = revision;
        if (frames[4].empty()) data.erase(frames[0]);
        else data[frames[0]] = frames[4];
        if (frames[2] == demo[2]) demo_sent = true;
        // Use the updated local copy here.
        runtime.log("CLONE_UPDATE", {{"key", frames[0]}, {"sequence", std::to_string(sequence)}, {"valueHex", hex(frames[4])}});
    }

    void receive_snapshot(const Multipart& frames) {
        if (!staged || frames.size() != 5 || !frames[2].empty() || !frames[3].empty())
            throw std::invalid_argument("Invalid snapshot frame");
        const auto revision = read_number(frames[1]);
        if (frames[0] == "KTHXBAI") {
            if (frames[4] != prefix || revision < watermark) throw std::invalid_argument("Invalid snapshot terminator");
            data = std::move(*staged);
            staged.reset();
            sequence = revision;
            deadline = clock_ms() + peer_timeout_ms;
            runtime.log("CLONE_SNAPSHOT", {{"server", server}, {"size", data.size()}, {"sequence", std::to_string(sequence)}});
            if (auto found = data.find(demo[0]); !demo_sent && next_write &&
                found != data.end() && found->second == demo[4]) {
                demo_sent = true;
                runtime.log("CLONE_WRITE_CONFIRMED");
            }
            for (const auto& publication : buffered) update(publication);
            buffered.clear();
            if (stream_seen && needs_refresh) begin(server, true);
        } else if (valid_key(frames[0]) && frames[0].starts_with(prefix)) {
            watermark = std::max(watermark, revision);
            (*staged)[frames[0]] = frames[4];
            deadline = clock_ms() + peer_timeout_ms;
        } else throw std::invalid_argument("Invalid snapshot key");
    }

    Advanced& runtime;
    std::string prefix;
    int servers;
    Multipart demo;
    int server = 0;
    std::uint64_t sequence = 0;
    std::uint64_t watermark = 0;
    std::int64_t deadline = 0;
    std::int64_t next_write = 0;
    bool demo_sent = false;
    bool stream_seen = false;
    bool needs_refresh = false;
    std::map<std::string, std::string> data;
    std::optional<std::map<std::string, std::string>> staged;
    std::vector<Multipart> buffered;
};

void advanced_program(Advanced& runtime) {
    runtime.log("READY");
    if (runtime.spec.at("program") == "clone-server") {
        CloneServer server(runtime);
        runtime.loop([&](const auto& name, const auto& frames) { server.receive(name, frames); },
                     [&] { server.tick(); });
    } else {
        CloneClient client(runtime);
        client.begin(0);
        runtime.loop([&](const auto& name, const auto& frames) { client.receive(name, frames); },
                     [&] { client.tick(); });
    }
}

} // namespace
} // namespace zmqt
`;
