/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const cborCodec = `def _reject_tag(_value, _immutable):
    raise ValueError("Unexpected CBOR tag")


class _RejectTags(dict):
    def __missing__(self, _tag):
        return _reject_tag


# Override built-in tag conversions as well as unknown tags.
_TAG_DECODERS = _RejectTags()


def decode(frame):
    if frame is None:
        return INVALID
    try:
        stream = io.BytesIO(frame)
        value = cbor2.load(stream, read_size=1, allow_duplicate_keys=False, strict_hashable_types=True,
                           semantic_decoders=_TAG_DECODERS)
        if stream.read(1):
            return INVALID
        _check_value(value, binary=True)
        return value
    except (cbor2.CBORError, ValueError, OverflowError, RecursionError):
        return INVALID


def encode(message):
    if not validate_message(message, _MESSAGE_TYPES):
        return INVALID
    try:
        return cbor2.dumps(message)
    except (cbor2.CBORError, ValueError, OverflowError, RecursionError):
        return INVALID


def telemetry_payload():
    return {"deviceId": "sensor-01", "samples": bytes((0, 255))}


def log_bytes(value):
    if type(value) is bytes:
        return value.hex()
    raise TypeError("Unsupported log value")`;

const jsonEncoder = `def encode(message):
    if not validate_message(message, _MESSAGE_TYPES):
        return INVALID
    try:
        return json.dumps(message, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")
    except (ValueError, OverflowError, RecursionError):
        return INVALID`;

export function renderPythonCodec(cbor: boolean): string {
  const checkValue = cbor ? "_check_value" : "_check_json";
  return `${cbor ? "import io\n" : ""}import json
import math${cbor ? "\n\nimport cbor2" : ""}


INVALID = object()
_MESSAGE_TYPES = ("request", "response", "error", "event", "task")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON key")
        value[key] = item
    return value


def _binary64_integer(text):
    value = float(text)
    return int(value) if abs(value) <= 2 ** 53 else value


def ${checkValue}(value${cbor ? ", binary=False" : ""}):
    kind = type(value)
${cbor ? `    if binary and kind is bytes:
        return
    if binary and kind is int and abs(value) > 9007199254740991:
        raise ValueError("Integer outside the safe range")
` : ""}    if kind is str:
        value.encode("utf-8", errors="strict")
    elif kind in (int, float):
        if not math.isfinite(value):
            raise ValueError("Non-finite JSON number")
    elif kind is list:
        for item in value:
            ${checkValue}(item${cbor ? ", binary" : ""})
    elif kind is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError("JSON object keys must be strings")
            key.encode("utf-8", errors="strict")
            ${checkValue}(item${cbor ? ", binary" : ""})
    elif value is not None and kind is not bool:
        raise ValueError("Invalid JSON value")


def ${cbor ? "decode_json" : "decode"}(frame):
    if frame is None:
        return INVALID
    try:
        value = json.loads(frame.decode("utf-8", errors="strict"),
                           object_pairs_hook=_unique_object, parse_int=_binary64_integer)
        ${checkValue}(value)
        return value
    except (ValueError, OverflowError, RecursionError):
        return INVALID


def extract_id(value):
    if type(value) is not dict:
        return None
    message_id = value.get("id")
    if type(message_id) is not str or not message_id:
        return None
    try:
        message_id.encode("utf-8", errors="strict")
    except UnicodeError:
        return None
    return message_id


def validate_message(value, message_types, matches_id=None):
    message_id = extract_id(value)
    if (message_id is None or value.keys() != {"id", "type", "payload"}
            or value["type"] not in message_types
            or (matches_id is not None and message_id != matches_id)):
        return False
    try:
        ${checkValue}(value${cbor ? ", binary=True" : ""})
    except (ValueError, OverflowError, RecursionError):
        return False
    return True


${cbor ? cborCodec : jsonEncoder}


def process_task(message):
    return {**message, "result": "processed"}
`;
}
