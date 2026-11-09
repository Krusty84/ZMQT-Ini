/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import { cppAdapter } from "../adapters/cpp/adapter";
import { javaAdapter } from "../adapters/java/adapter";
import { nodeAdapter } from "../adapters/node/adapter";
import { pythonAdapter } from "../adapters/python/adapter";
import type { LanguageAdapter } from "../adapters/types";
import { assembleProject } from "../artifacts/assemble";
import { planProject } from "../planning/build";
import type { CoreResult, GeneratedProject, NormalizedConfig } from "./types";

const adapters: Record<
  NormalizedConfig["project"]["language"],
  LanguageAdapter
> = {
  cpp: cppAdapter,
  java: javaAdapter,
  node: nodeAdapter,
  python: pythonAdapter,
};

export function generateProject(input: unknown): CoreResult<GeneratedProject> {
  const result = planProject(input);
  if (!result.ok) return result;
  return assembleProject(result.value, adapters[result.value.project.language]);
}
