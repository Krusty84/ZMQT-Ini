/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { ArtifactLayout } from "../adapters/types";
import type { GenerationPlan } from "../planning/ir";
import type { Diagnostic, GeneratedFile } from "../public/types";
import { utf8ByteLength } from "../validation/utf8";
import { runtimeConfigFile } from "./files";

const maxBytes = 2_097_152;
const unresolvedPlaceholder = /\{\{\s*[A-Z][A-Z0-9_]*\s*\}\}/;
const loneSurrogate = /[\uD800-\uDFFF]/u;

function canonicalPath(path: string): string {
  return path.toLowerCase().normalize("NFC");
}

function safePath(path: string): boolean {
  return (
    !path.includes("\0") &&
    !path.includes("\\") &&
    !/^[a-z]:/i.test(path) &&
    !loneSurrogate.test(path) &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function hasFileAncestor(
  path: string,
  filePaths: ReadonlySet<string>,
): boolean {
  let slash = path.lastIndexOf("/");
  while (slash > 0) {
    if (filePaths.has(path.slice(0, slash))) return true;
    slash = path.lastIndexOf("/", slash - 1);
  }
  return false;
}

export function validateArtifacts(
  files: readonly GeneratedFile[],
  plan: GenerationPlan,
  layout: ArtifactLayout,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (
    code: string,
    path: string,
    message: string,
    params?: Diagnostic["params"],
  ) => {
    diagnostics.push({
      severity: "error",
      code,
      path,
      message,
      ...(params ? { params } : {}),
    });
  };
  const runtime = runtimeConfigFile(plan);
  const expected = new Map<string, boolean>(
    [
      "README.md",
      runtime.path,
      "tests/integration_test.py",
      ...layout.supportFiles,
    ].map((path) => [path, false]),
  );
  for (const { role } of plan.applications)
    expected.set(layout.entryPoint(role), layout.executableEntries);

  const present = new Set<string>();
  const filePaths = new Set(files.map(({ path }) => canonicalPath(path)));
  const seen = new Set<string>();
  let bytes = 0;
  for (const [
    index,
    { path, content, encoding, executable },
  ] of files.entries()) {
    const location = `/files/${index}`;
    const canonical = canonicalPath(path);
    if (!safePath(path)) {
      report(
        "INVALID_ARTIFACT_PATH",
        `${location}/path`,
        "Artifact path is unsafe.",
      );
    } else if (seen.has(canonical)) {
      report(
        "DUPLICATE_ARTIFACT_PATH",
        `${location}/path`,
        "Artifact path conflicts with another file.",
      );
    } else if (hasFileAncestor(canonical, filePaths)) {
      report(
        "ARTIFACT_PATH_CONFLICT",
        `${location}/path`,
        "An artifact path uses a file as a directory.",
      );
    } else if (!expected.has(path)) {
      report(
        "UNEXPECTED_ARTIFACT_PATH",
        `${location}/path`,
        "The adapter layout does not declare this artifact.",
      );
    }
    present.add(path);
    seen.add(canonical);

    if (expected.has(path) && expected.get(path) !== executable) {
      report(
        "INVALID_ARTIFACT_MODE",
        `${location}/executable`,
        "Artifact executable metadata does not match its role.",
      );
    }
    if (encoding !== "utf-8" || loneSurrogate.test(content)) {
      report(
        "INVALID_ARTIFACT_ENCODING",
        `${location}/content`,
        "Artifact must contain valid UTF-8 text.",
      );
    }
    if (content.trim() === "") {
      report(
        "EMPTY_ARTIFACT",
        `${location}/content`,
        "Artifact content is empty.",
      );
    }
    if (unresolvedPlaceholder.test(content)) {
      report(
        "UNRESOLVED_ARTIFACT_PLACEHOLDER",
        `${location}/content`,
        "Artifact contains an unresolved template placeholder.",
      );
    }
    if (path === runtime.path && content !== runtime.content) {
      report(
        "INVALID_RUNTIME_ARTIFACT",
        `${location}/content`,
        "Runtime configuration does not match the generation plan.",
      );
    }
    if (bytes <= maxBytes) bytes += utf8ByteLength(content);
  }

  for (const path of expected.keys()) {
    if (!present.has(path))
      report("MISSING_ARTIFACT", "/files", "Required artifact is missing.", {
        path,
      });
  }
  if (bytes > maxBytes) {
    report(
      "ARTIFACT_SIZE_LIMIT",
      "/files",
      "Artifacts exceed the aggregate UTF-8 size limit.",
      { maxBytes },
    );
  }
  return diagnostics;
}
