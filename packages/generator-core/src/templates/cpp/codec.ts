/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const cppCodecHeader = `#pragma once

#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace zmqt {

using Json = nlohmann::json;
using Frame = std::optional<std::string>;

std::optional<Json> decode(const Frame& frame);
std::optional<std::string> extract_id(const Json& value);
bool validate_message(const Json& value, std::initializer_list<std::string_view> types,
                      const std::optional<std::string>& matches_id = std::nullopt);
Frame encode(const Json& message);
Json process_task(const Json& message);

} // namespace zmqt
`;

export const cppCodec = String.raw`#include "message_codec.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <unordered_set>
#include <vector>

namespace zmqt {

std::optional<Json> decode(const Frame& frame) {
    if (!frame || frame->starts_with("\xef\xbb\xbf") || frame->find('\0') != std::string::npos) return std::nullopt;

    std::vector<std::unordered_set<std::string>> keys;
    const auto check = [&keys](int, Json::parse_event_t event, Json& value) {
        constexpr std::int64_t exact_limit = 9007199254740992;
        switch (event) {
        case Json::parse_event_t::object_start:
            keys.emplace_back();
            break;
        case Json::parse_event_t::key:
            if (!keys.back().insert(value.get<std::string>()).second) {
                throw std::invalid_argument("Duplicate JSON key");
            }
            break;
        case Json::parse_event_t::object_end:
            keys.pop_back();
            break;
        case Json::parse_event_t::value:
            if (value.is_number_unsigned()) {
                if (value.get<std::uint64_t>() > exact_limit) value = value.get<double>();
            } else if (value.is_number_integer()) {
                const auto number = value.get<std::int64_t>();
                if (number < -exact_limit || number > exact_limit) value = value.get<double>();
            }
            break;
        default:
            break;
        }
        return true;
    };

    try {
        return Json::parse(*frame, check);
    } catch (const Json::exception&) {
        return std::nullopt;
    } catch (const std::invalid_argument&) {
        return std::nullopt;
    }
}

std::optional<std::string> extract_id(const Json& value) {
    if (!value.is_object() || !value.contains("id") || !value["id"].is_string()) return std::nullopt;
    const auto& id = value["id"].get_ref<const std::string&>();
    if (id.empty()) return std::nullopt;
    return id;
}

bool validate_message(const Json& value, std::initializer_list<std::string_view> types,
                      const std::optional<std::string>& matches_id) {
    const auto id = extract_id(value);
    if (!id || (matches_id && id != matches_id) || value.size() != 3 || !value.contains("payload") ||
        !value.contains("type") || !value["type"].is_string()) return false;
    const auto& type = value["type"].get_ref<const std::string&>();
    return std::find(types.begin(), types.end(), type) != types.end();
}

Frame encode(const Json& message) {
    if (!validate_message(message, {"request", "response", "error", "event", "task"})) return std::nullopt;
    std::vector<const Json*> pending{&message};
    while (!pending.empty()) {
        const auto* item = pending.back();
        pending.pop_back();
        if (item->is_discarded() || item->is_binary() ||
            (item->is_number_float() && !std::isfinite(item->get<double>()))) return std::nullopt;
        if (item->is_structured()) {
            for (const auto& child : *item) pending.push_back(&child);
        }
    }
    try {
        return message.dump();
    } catch (const Json::exception&) {
        return std::nullopt;
    }
}

Json process_task(const Json& message) {
    Json result = message;
    result["result"] = "processed";
    return result;
}

} // namespace zmqt
`;
