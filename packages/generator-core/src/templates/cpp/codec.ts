/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const cppCodecHeader = (cbor: boolean) => `#pragma once

#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace zmqt {

using Json = nlohmann::json;
using Frame = std::optional<std::string>;

std::optional<Json> decode(const Frame& frame);
${cbor ? `std::optional<Json> decode_json(const Frame& frame);
Json telemetry_payload();
Json log_value(Json value);
` : ""}std::optional<std::string> extract_id(const Json& value);
bool validate_message(const Json& value, std::initializer_list<std::string_view> types,
                      const std::optional<std::string>& matches_id = std::nullopt);
Frame encode(const Json& message);
Json process_task(const Json& message);

} // namespace zmqt
`;

const cborDecoder = String.raw`namespace {

constexpr std::int64_t max_safe_integer = 9007199254740991;
using CborItem = std::unique_ptr<cbor_item_t, decltype(&cbor_intermediate_decref)>;

std::string cbor_text(cbor_item_t* item) {
    if (!cbor_isa_string(item)) throw std::invalid_argument("Expected a CBOR text string");
    if (!cbor_string_is_definite(item)) {
        std::string text;
        for (std::size_t index = 0; index < cbor_string_chunk_count(item); ++index) {
            text += cbor_text(cbor_string_chunks_handle(item)[index]);
        }
        return text;
    }
    const auto length = cbor_string_length(item);
    if (length == 0) return {};
    std::string text(reinterpret_cast<const char*>(cbor_string_handle(item)), length);
    (void)Json(text).dump(); // CBOR text strings must contain valid UTF-8.
    return text;
}

Json cbor_value(cbor_item_t* item) {
    switch (cbor_typeof(item)) {
    case CBOR_TYPE_UINT:
    case CBOR_TYPE_NEGINT: {
        const auto value = cbor_get_int(item);
        const bool negative = cbor_isa_negint(item);
        if (value > static_cast<std::uint64_t>(max_safe_integer) || (negative && value == max_safe_integer)) {
            throw std::invalid_argument("Integer outside the safe range");
        }
        const auto integer = static_cast<std::int64_t>(value);
        return negative ? -1 - integer : integer;
    }
    case CBOR_TYPE_BYTESTRING: {
        if (!cbor_bytestring_is_definite(item)) {
            CborItem joined(cbor_copy_definite(item), cbor_intermediate_decref);
            if (!joined) throw std::invalid_argument("Invalid CBOR byte string");
            return cbor_value(joined.get());
        }
        const auto length = cbor_bytestring_length(item);
        if (length == 0) return Json::binary({});
        const auto* data = cbor_bytestring_handle(item);
        return Json::binary(std::vector<std::uint8_t>(data, data + length));
    }
    case CBOR_TYPE_STRING:
        return cbor_text(item);
    case CBOR_TYPE_ARRAY: {
        Json result = Json::array();
        for (std::size_t index = 0; index < cbor_array_size(item); ++index) {
            result.push_back(cbor_value(cbor_array_handle(item)[index]));
        }
        return result;
    }
    case CBOR_TYPE_MAP: {
        Json result = Json::object();
        for (std::size_t index = 0; index < cbor_map_size(item); ++index) {
            const auto& entry = cbor_map_handle(item)[index];
            auto key = cbor_text(entry.key);
            if (result.contains(key)) throw std::invalid_argument("Duplicate CBOR map key");
            result[std::move(key)] = cbor_value(entry.value);
        }
        return result;
    }
    case CBOR_TYPE_FLOAT_CTRL:
        if (cbor_is_null(item)) return nullptr;
        if (cbor_is_bool(item)) return cbor_get_bool(item);
        if (cbor_is_float(item) && std::isfinite(cbor_float_get_float(item))) return cbor_float_get_float(item);
        break;
    case CBOR_TYPE_TAG:
        break;
    }
    throw std::invalid_argument("Unsupported CBOR value");
}

void check_cbor_value(const Json& value) {
    if (value.is_discarded() || (value.is_binary() && value.get_binary().has_subtype())) {
        throw std::invalid_argument("Unsupported CBOR value");
    }
    if (value.is_number()) {
        const auto number = value.get<double>();
        if (!std::isfinite(number) || (value.is_number_integer() && std::abs(number) > max_safe_integer)) {
            throw std::invalid_argument("Invalid CBOR number");
        }
    } else if (value.is_string()) {
        (void)value.dump(); // Validate UTF-8 before writing a CBOR text string.
    } else if (value.is_structured()) {
        for (auto child = value.begin(); child != value.end(); ++child) {
            if (value.is_object()) (void)Json(child.key()).dump();
            check_cbor_value(*child);
        }
    }
}

} // namespace

std::optional<Json> decode(const Frame& frame) {
    if (!frame || frame->empty()) return std::nullopt;
    cbor_load_result result{};
    CborItem item(cbor_load(reinterpret_cast<const unsigned char*>(frame->data()), frame->size(), &result),
                  cbor_intermediate_decref);
    if (!item || result.read != frame->size()) return std::nullopt;
    try {
        return cbor_value(item.get());
    } catch (const Json::exception&) {
        return std::nullopt;
    } catch (const std::invalid_argument&) {
        return std::nullopt;
    }
}

Json telemetry_payload() {
    return {{"deviceId", "sensor-01"}, {"samples", Json::binary({0, 255})}};
}

Json log_value(Json value) {
    if (value.is_binary()) {
        constexpr std::string_view digits = "0123456789abcdef";
        std::string text;
        const auto& bytes = value.get_binary();
        text.reserve(2 * bytes.size());
        for (const auto byte : bytes) {
            text.push_back(digits[byte >> 4]);
            text.push_back(digits[byte & 15]);
        }
        return text;
    }
    if (value.is_structured()) {
        for (auto& child : value) child = log_value(std::move(child));
    }
    return value;
}

`;

const cborEncoder = String.raw`Frame encode(const Json& message) {
    if (!validate_message(message, {"request", "response", "error", "event", "task"})) return std::nullopt;
    try {
        check_cbor_value(message);
        const auto bytes = Json::to_cbor(message);
        return std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    } catch (const Json::exception&) {
        return std::nullopt;
    } catch (const std::invalid_argument&) {
        return std::nullopt;
    }
}`;

const jsonEncoder = String.raw`Frame encode(const Json& message) {
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
}`;

export const cppCodec = (cbor: boolean) => String.raw`#include "message_codec.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <unordered_set>
#include <vector>${cbor ? "\n\n#include <cbor.h>\n#include <memory>\n#include <utility>" : ""}

namespace zmqt {

std::optional<Json> ${cbor ? "decode_json" : "decode"}(const Frame& frame) {
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

${cbor ? cborDecoder : ""}std::optional<std::string> extract_id(const Json& value) {
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

${cbor ? cborEncoder : jsonEncoder}

Json process_task(const Json& message) {
    Json result = message;
    result["result"] = "processed";
    return result;
}

} // namespace zmqt
`;
