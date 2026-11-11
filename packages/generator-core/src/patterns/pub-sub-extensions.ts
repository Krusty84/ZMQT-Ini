/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { PubSubExtension } from "../public/types";

const streamExtensions = [
  "black-box", "espresso", "last-value-caching", "suicidal-snail",
] as const;

export function extensionTopology(extensions: readonly PubSubExtension[]) {
  const clone = extensions.includes("clone");
  const binaryStar = extensions.includes("binary-star");
  const proxy = extensions.includes("espresso") || extensions.includes("last-value-caching");
  const bindRoles = clone ? ["server"] : proxy ? ["proxy"] : ["pub", "sub"];
  return { clone, binaryStar, proxy, bindRoles, portCount: binaryStar ? 4 : clone ? 3 : proxy ? 2 : 1 };
}

export function extensionCombinations() {
  const combinations: PubSubExtension[][] = [
    ["clone"], ["binary-star", "clone"],
  ];
  for (let mask = 1; mask < 1 << streamExtensions.length; mask++) {
    combinations.push(streamExtensions.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return combinations.map((extensions) => ({
    extensions,
    bindRoles: extensionTopology(extensions).bindRoles,
  }));
}
