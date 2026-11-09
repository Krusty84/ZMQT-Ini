/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const pythonCodec = `import json
import math


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


def _check_json(value):
    kind = type(value)
    if kind is str:
        value.encode("utf-8", errors="strict")
    elif kind in (int, float):
        if not math.isfinite(value):
            raise ValueError("Non-finite JSON number")
    elif kind is list:
        for item in value:
            _check_json(item)
    elif kind is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError("JSON object keys must be strings")
            key.encode("utf-8", errors="strict")
            _check_json(item)
    elif value is not None and kind is not bool:
        raise ValueError("Invalid JSON value")


def decode(frame):
    if frame is None:
        return INVALID
    try:
        value = json.loads(frame.decode("utf-8", errors="strict"),
                           object_pairs_hook=_unique_object, parse_int=_binary64_integer)
        _check_json(value)
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
        _check_json(value)
    except (ValueError, OverflowError, RecursionError):
        return False
    return True


def encode(message):
    if not validate_message(message, _MESSAGE_TYPES):
        return INVALID
    try:
        return json.dumps(message, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")
    except (ValueError, OverflowError, RecursionError):
        return INVALID


def process_task(message):
    return {**message, "result": "processed"}
`;
