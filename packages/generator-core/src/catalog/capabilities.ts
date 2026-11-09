/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import schema from "../../resources/config.schema.json";
import { patternRegistry } from "../patterns/registry";
import type { LanguageCapabilities } from "../planning/ir";
import type { CapabilityCatalog } from "../public/types";

const patterns = Object.values(patternRegistry);

// Latest stable releases available on 2026-11-09.
const languages = [
  {
    id: "python",
    libraryId: "pyzmq",
    libraryVersion: "27.3.0",
    languageVersion: "3.15.2",
  },
  {
    id: "cpp",
    libraryId: "cppzmq",
    libraryVersion: "4.11.0",
    languageVersion: "C++23",
  },
  {
    id: "java",
    libraryId: "jeromq",
    libraryVersion: "0.6.0",
    languageVersion: "27.0.1",
  },
  {
    id: "node",
    libraryId: "zeromq",
    libraryVersion: "6.5.0",
    languageVersion: "26.13.0",
  },
] as const satisfies readonly Omit<
  CapabilityCatalog["languages"][number],
  "patterns"
>[];

export function p0LanguageCapabilities(): LanguageCapabilities {
  return {
    irVersions: ["1.0"],
    operations: [
      "build",
      "encode",
      "decode",
      "validate",
      "send",
      "receive",
      "process",
      "wait",
      "log",
      "stop",
    ],
    socketTypes: patterns.flatMap(({ roles }) =>
      roles.map(({ socketType }) => socketType),
    ),
    socketOptions: Object.keys(schema.properties.socketOptions.properties),
  };
}

export function getCapabilities(): CapabilityCatalog {
  return {
    catalogVersion: 1,
    configSchemaVersion: "1.0",
    irVersion: "1.0",
    languages: languages.map((language) => ({
      ...language,
      patterns: patterns.map(({ id }) => id),
    })),
    patterns: patterns.map(({ id, permittedBindRoles }) => ({
      id,
      bindRoles: [...permittedBindRoles],
    })),
    transports: ["tcp"],
    socketOptionRanges: Object.fromEntries(
      Object.entries(schema.properties.socketOptions.properties).map(
        ([option, { minimum, maximum }]) => [
          option,
          { min: minimum, max: maximum },
        ],
      ),
    ),
  };
}
