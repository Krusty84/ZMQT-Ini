/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const cborReadme = `Both peers must use CBOR for the message frame. The codec packs a map with \`id\`, \`type\`, and \`payload\` and unpacks it before the app handles the message.

To send your data, edit the telemetry payload function in the message codec. For example, set \`deviceId\` to \`sensor-02\` and set \`samples\` to the two bytes \`10 2a\`. The handler gets bytes, and the JSON log displays them as \`"102a"\`.

Payloads accept untagged JSON values and byte strings. Maps use unique text keys. Use finite numbers and keep CBOR integers in the range −9007199254740991 to 9007199254740991.`;

export const cborLogPayload = '{"deviceId": "sensor-01", "samples": "00ff"}';
