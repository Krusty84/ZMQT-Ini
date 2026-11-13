/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { configSchemaVersion } from "../config/schema";
import { socketOptionDefinitions, socketOptionSchema } from "../config/socket-options";
import { patternRegistry } from "../patterns/registry";
import { extensionCombinations } from "../patterns/pub-sub-extensions";
import type { DependencySpec, LanguageCapabilities, ProjectSpec } from "../planning/ir";
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

const cborDependencies: Record<ProjectSpec["language"], DependencySpec> = {
  python: { id: "cbor2", version: "6.2.1" },
  cpp: { id: "libcbor", version: "0.14.0" },
  java: { id: "com.upokecenter:cbor", version: "4.5.6" },
  node: { id: "cbor2", version: "2.4.1" },
};

export function projectDependencies(project: ProjectSpec): readonly DependencySpec[] {
  const { libraryId, libraryVersion } = languages.find(({ id }) => id === project.language)!;
  const dependencies: DependencySpec[] = [{ id: libraryId, version: libraryVersion }];
  if (project.serialization === "cbor") dependencies.push({ ...cborDependencies[project.language] });
  return dependencies;
}

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
    socketOptions: Object.keys(socketOptionSchema.properties),
  };
}

export function getCapabilities(): CapabilityCatalog {
  return {
    catalogVersion: 1,
    configSchemaVersion,
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
    serializations: ["json", "cbor"],
    pubSubExtensions: {
      configSchemaVersion,
      irVersion: "1.1",
      languages: languages.map(({ id }) => id),
      combinations: extensionCombinations(),
    },
    socketOptionRanges: Object.fromEntries(
      socketOptionDefinitions.flatMap(({ name, bounds }) =>
        bounds ? [[name, { min: bounds.minimum, max: bounds.maximum }]] : [],
      ),
    ),
  };
}
