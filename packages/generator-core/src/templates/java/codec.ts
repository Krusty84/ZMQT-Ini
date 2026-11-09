/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const javaCodec = `import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
import java.util.Set;
import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.DoubleNode;
import tools.jackson.databind.node.ObjectNode;

final class MessageCodec {
    private static final JsonMapper JSON = JsonMapper.builder()
        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        .build();
    private static final Set<String> MESSAGE_TYPES = Set.of("request", "response", "error", "event", "task");

    static JsonNode decode(byte[] frame) {
        if (frame == null) return null;
        try {
            String text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(frame)).toString();
            return decodeText(text);
        } catch (CharacterCodingException error) {
            return null;
        }
    }

    static JsonNode decodeText(String text) {
        if (!text.isEmpty() && text.charAt(0) == 0xfeff) return null;
        try {
            JsonNode node = JSON.readTree(text);
            return node == null || node.isMissingNode() ? null : check(node);
        } catch (JacksonException | IllegalArgumentException error) {
            return null;
        }
    }

    private static void checkText(String text) {
        if (!StandardCharsets.UTF_8.newEncoder().canEncode(text)) {
            throw new IllegalArgumentException("Unpaired surrogate");
        }
    }

    private static JsonNode check(JsonNode node) {
        if (node.isString()) {
            checkText(node.asString());
        } else if (node.isNumber()) {
            double number = node.doubleValue();
            if (!Double.isFinite(number)) throw new IllegalArgumentException("Non-finite JSON number");
            if (!node.isIntegralNumber() || Math.abs(number) > 9_007_199_254_740_991.0) {
                return DoubleNode.valueOf(number);
            }
        } else if (node instanceof ObjectNode object) {
            for (var field : object.properties()) {
                checkText(field.getKey());
                object.set(field.getKey(), check(field.getValue()));
            }
        } else if (node instanceof ArrayNode array) {
            for (int index = 0; index < array.size(); index++) array.set(index, check(array.get(index)));
        }
        return node;
    }

    static String extractId(JsonNode value) {
        if (value == null || !value.isObject()) return null;
        JsonNode id = value.get("id");
        if (id == null || !id.isString() || id.asString().isEmpty()) return null;
        return id.asString();
    }

    static boolean validateMessage(JsonNode value, Collection<String> messageTypes, String matchesId) {
        String id = extractId(value);
        if (id == null || value.size() != 3 || !value.has("payload")) return false;
        JsonNode type = value.get("type");
        return type != null && type.isString() && messageTypes.contains(type.asString())
            && (matchesId == null || matchesId.equals(id));
    }

    static byte[] encode(JsonNode message) {
        if (!validateMessage(message, MESSAGE_TYPES, null)) return null;
        try {
            return JSON.writeValueAsBytes(check(message));
        } catch (JacksonException | IllegalArgumentException error) {
            return null;
        }
    }

    static ObjectNode object() {
        return JSON.createObjectNode();
    }

    static JsonNode message(String id, String type, JsonNode payload) {
        ObjectNode message = object().put("id", id).put("type", type);
        message.set("payload", payload);
        return message;
    }

    static JsonNode processTask(JsonNode message) {
        ObjectNode copy = (ObjectNode) message.deepCopy();
        return copy.put("result", "processed");
    }

    static String toJson(JsonNode value) {
        return JSON.writeValueAsString(value);
    }
}
`;
