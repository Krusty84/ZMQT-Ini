/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { SocketType } from "../../patterns/registry";

type StateComments = Readonly<Partial<Record<string, readonly string[]>>>;

const integrationPoint = "INTEGRATION POINT - ";
const receiveFrame = "Expect one UTF-8 JSON frame with id, type, and payload.";
const sendFrame = "Send one UTF-8 JSON frame with id, type, and payload.";

export function formatRoleComment(comment: string, cbor: boolean): string {
  return cbor ? comment.replace("UTF-8 JSON", "CBOR") : comment;
}
const receiveTimeout = "Wait for another message after a receive timeout.";
const sendTimeout = "End the loop after a send timeout.";
const invalidMessage = "Log a protocol error and skip this message.";

export const roleComments: Readonly<Record<SocketType, StateComments>> = {
  REQ: {
    "build-request": [
      `${integrationPoint}Supply your application's request payload here.`,
    ],
    send: ["Send one request, then receive its reply before sending another."],
    "validate-response": [receiveFrame],
    "log-response": [
      `${integrationPoint}Pass the reply with the verified id to your caller.`,
    ],
    SEND_TIMEOUT: ["End the exchange after a send timeout."],
    RECEIVE_TIMEOUT: ["End the exchange after a receive timeout."],
  },
  REP: {
    receive: [
      "Send a reply before receiving the next request.",
      receiveTimeout,
    ],
    "validate-request": [receiveFrame],
    "build-response": [
      `${integrationPoint}Call your request handler here. Use the request id in the reply.`,
    ],
    "recover-id": [
      "Send an INVALID_MESSAGE error reply if the request id is usable.",
      "End the loop if the id is missing or invalid.",
    ],
    PROTOCOL_ERROR: ["End the loop if the frame cannot be decoded."],
    SEND_TIMEOUT: [sendTimeout],
  },
  PUB: {
    build: [`${integrationPoint}Use an event from your application as the payload.`],
    encode: [sendFrame],
    wait: ["This wait sets the interval between sample publications."],
    SEND_TIMEOUT: [sendTimeout],
  },
  SUB: {
    receive: [receiveTimeout],
    validate: [receiveFrame],
    log: [`${integrationPoint}Pass the validated event to your event handler.`],
    "log-invalid": [invalidMessage],
  },
  PUSH: {
    build: [`${integrationPoint}Use a task from your application as the payload.`],
    encode: [sendFrame],
    SEND_TIMEOUT: [sendTimeout],
  },
  PULL: {
    receive: [receiveTimeout],
    validate: [receiveFrame],
    process: [`${integrationPoint}Run your application's task handler here.`],
    "log-invalid": [invalidMessage],
  },
};
