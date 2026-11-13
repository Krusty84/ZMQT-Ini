/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const cborCodec = `    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

    static JsonNode decode(byte[] frame) {
        if (frame == null) return null;
        try {
            return unpack(CBORObject.DecodeFromBytes(frame, CBOREncodeOptions.Default));
        } catch (CBORException | IllegalArgumentException | ArithmeticException error) {
            return null;
        }
    }

    private static JsonNode unpack(CBORObject value) {
        if (value.isTagged()) throw new IllegalArgumentException("Unexpected CBOR tag");
        return switch (value.getType()) {
            case Boolean -> NODES.booleanNode(value.AsBoolean());
            case TextString -> NODES.stringNode(value.AsString());
            case ByteString -> NODES.binaryNode(value.GetByteString());
            case Integer -> {
                long number = value.AsInt64Value();
                if (number < -MAX_SAFE_INTEGER || number > MAX_SAFE_INTEGER) {
                    throw new IllegalArgumentException("Integer outside the safe range");
                }
                yield NODES.numberNode(number);
            }
            case FloatingPoint -> {
                double number = value.AsDoubleValue();
                if (!Double.isFinite(number)) throw new IllegalArgumentException("Non-finite CBOR number");
                yield NODES.numberNode(number);
            }
            case Array -> {
                var array = NODES.arrayNode();
                for (int index = 0; index < value.size(); index++) array.add(unpack(value.get(index)));
                yield array;
            }
            case Map -> {
                var object = NODES.objectNode();
                for (CBORObject key : value.getKeys()) {
                    if (key.isTagged() || key.getType() != CBORType.TextString) {
                        throw new IllegalArgumentException("Expected a CBOR text key");
                    }
                    object.set(key.AsString(), unpack(value.get(key)));
                }
                yield object;
            }
            case SimpleValue -> {
                if (!value.isNull()) throw new IllegalArgumentException("Unsupported CBOR value");
                yield NODES.nullNode();
            }
            case Number -> throw new IllegalArgumentException("Unsupported CBOR number");
        };
    }

    private static CBORObject pack(JsonNode value) {
        if (value.isNull()) return CBORObject.Null;
        if (value.isBoolean()) return CBORObject.FromObject(value.booleanValue());
        if (value.isBinary()) return CBORObject.FromObject(value.binaryValue());
        if (value.isString()) {
            checkText(value.asString());
            return CBORObject.FromObject(value.asString());
        }
        if (value.isNumber()) {
            double number = value.doubleValue();
            if (!Double.isFinite(number) || (value.isIntegralNumber() && Math.abs(number) > MAX_SAFE_INTEGER)) {
                throw new IllegalArgumentException("Invalid CBOR number");
            }
            return value.isIntegralNumber() ? CBORObject.FromObject(value.longValue()) : CBORObject.FromObject(number);
        }
        if (value.isArray()) {
            var array = CBORObject.NewArray();
            for (var item : value) array.Add(pack(item));
            return array;
        }
        if (value.isObject()) {
            var map = CBORObject.NewMap();
            for (var field : value.properties()) {
                checkText(field.getKey());
                map.set(field.getKey(), pack(field.getValue()));
            }
            return map;
        }
        throw new IllegalArgumentException("Unsupported CBOR value");
    }

    static byte[] encode(JsonNode message) {
        if (!validateMessage(message, MESSAGE_TYPES, null)) return null;
        try {
            return pack(message).EncodeToBytes();
        } catch (CBORException | IllegalArgumentException | ArithmeticException error) {
            return null;
        }
    }

    static ObjectNode telemetryPayload() {
        var payload = object().put("deviceId", "sensor-01");
        payload.set("samples", NODES.binaryNode(new byte[]{0, (byte) 255}));
        return payload;
    }

    private static JsonNode logValue(JsonNode value) {
        if (value.isBinary()) return NODES.stringNode(HexFormat.of().formatHex(value.binaryValue()));
        if (value.isObject()) {
            var object = NODES.objectNode();
            for (var field : value.properties()) object.set(field.getKey(), logValue(field.getValue()));
            return object;
        }
        if (value.isArray()) {
            var array = NODES.arrayNode();
            for (var item : value) array.add(logValue(item));
            return array;
        }
        return value;
    }`;

const jsonEncoder = `    static byte[] encode(JsonNode message) {
        if (!validateMessage(message, MESSAGE_TYPES, null)) return null;
        try {
            return JSON.writeValueAsBytes(check(message));
        } catch (JacksonException | IllegalArgumentException error) {
            return null;
        }
    }`;

export const javaCodec = (cbor: boolean) => `import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
${cbor ? "import java.util.HexFormat;\n" : ""}import java.util.Set;
${cbor ? `import com.upokecenter.cbor.CBOREncodeOptions;
import com.upokecenter.cbor.CBORException;
import com.upokecenter.cbor.CBORObject;
import com.upokecenter.cbor.CBORType;
` : ""}import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.DoubleNode;
${cbor ? "import tools.jackson.databind.node.JsonNodeFactory;\n" : ""}import tools.jackson.databind.node.ObjectNode;

final class MessageCodec {
    private static final JsonMapper JSON = JsonMapper.builder()
        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        .build();
    private static final Set<String> MESSAGE_TYPES = Set.of("request", "response", "error", "event", "task");

    static JsonNode ${cbor ? "decodeJson" : "decode"}(byte[] frame) {
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

${cbor ? cborCodec : jsonEncoder}

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
        return JSON.writeValueAsString(${cbor ? "logValue(value)" : "value"});
    }
}
`;
