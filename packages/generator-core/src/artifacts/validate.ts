/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { ArtifactLayout } from "../adapters/types";
import { getCapabilities } from "../catalog/capabilities";
import type { ApplicationPlan, GenerationPlan } from "../planning/ir";
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

type Language = GenerationPlan["project"]["language"];

const sourceMarkers: Record<Language, Record<string, string>> = {
  python: {
    "message_codec.py": "def decode(frame):",
    "zmqt_runtime.py": "import zmq",
  },
  node: {
    "message_codec.mjs": "export function decode(frame) {",
    "zmqt_runtime.mjs": 'import zmq from "zeromq";',
  },
  java: {
    "src/main/java/MessageCodec.java": "final class MessageCodec {",
    "src/main/java/ZmqtRuntime.java": "final class ZmqtRuntime {",
  },
  cpp: {
    "message_codec.cpp": '#include "message_codec.hpp"',
    "message_codec.hpp": "#include <nlohmann/json.hpp>",
    "zmqt_runtime.cpp": '#include "zmqt_runtime.hpp"',
    "zmqt_runtime.hpp": "#include <zmq.hpp>",
  },
};

function matchesApplication(
  content: string,
  language: Language,
  application: ApplicationPlan,
): boolean {
  const { socketType, endpoint: { mode }, behavior } = application;
  const socket = JSON.stringify(socketType);
  const endpoint = JSON.stringify(mode);
  const signatures = {
    python: [
      "from zmqt_runtime import run",
      `raise SystemExit(run(\n        ${socket},\n        ${endpoint},`,
      "case ", ":",
    ],
    node: [
      'import { run } from "./zmqt_runtime.mjs";',
      `process.exitCode = await run(\n  ${socket},\n  ${endpoint},`,
      "case ", ": {",
    ],
    java: [
      `public final class App${socketType} {`,
      `System.exit(ZmqtRuntime.run(args, SocketType.${socketType}, ${endpoint},`,
      "case ", " -> {",
    ],
    cpp: [
      '#include "zmqt_runtime.hpp"',
      `return run(argc, argv, zmq::socket_type::${socketType.toLowerCase()}, ${mode === "bind"},`,
      "if (state == ", ") {",
    ],
  };
  const [marker, startup, casePrefix, caseSuffix] = signatures[language];
  const lines = new Set(content.split("\n").map((line) => line.trim()));
  return lines.has(marker) && content.includes(startup) &&
    behavior.nodes.every(({ id }) => lines.has(`${casePrefix}${JSON.stringify(id)}${caseSuffix}`));
}

function matchesSource(
  path: string,
  content: string,
  plan: GenerationPlan,
  layout: ArtifactLayout,
): boolean {
  const { language, pattern } = plan.project;
  const application = plan.applications.find(
    ({ role }) => layout.entryPoint(role) === path,
  );
  if (application) return matchesApplication(content, language, application);

  const marker = sourceMarkers[language][path];
  if (marker) return content.split("\n").includes(marker);
  if (path === "README.md") {
    return content.includes(`\nThis project runs the ${pattern} pattern over TCP`);
  }
  if (path === "tests/integration_test.py") {
    const bind = plan.applications.find(({ endpoint }) => endpoint.mode === "bind")!;
    const lines = content.split("\n");
    return lines.includes(`PATTERN = ${JSON.stringify(pattern)}`) &&
      lines.includes(`BIND_ROLE = ${JSON.stringify(bind.role)}`);
  }
  return true;
}

function matchesNpmDependencies(
  path: string,
  content: string,
  plan: GenerationPlan,
  languageVersion: string,
): boolean {
  try {
    const manifest = JSON.parse(content);
    const root = path === "package.json" ? manifest : manifest?.packages?.[""];
    return root?.engines?.node === languageVersion &&
      Object.keys(root.dependencies ?? {}).length === plan.dependencies.length &&
      plan.dependencies.every(({ id, version }) => {
        if (root.dependencies[id] !== version) return false;
        if (path === "package.json") return true;
        const locked = manifest.packages[`node_modules/${id}`];
        return locked?.version === version &&
          locked.resolved === `https://registry.npmjs.org/${id}/-/${id}-${version}.tgz`;
      });
  } catch {
    return false;
  }
}

function matchesDependencies(
  path: string,
  content: string,
  plan: GenerationPlan,
  languageVersion: string,
): boolean {
  switch (path) {
    case "requirements.txt":
      return content.trim() === plan.dependencies.map(({ id, version }) => `${id}==${version}`).join("\n");
    case "package.json":
    case "package-lock.json":
      return matchesNpmDependencies(path, content, plan, languageVersion);
    case "pom.xml": {
      const pom = content.replace(/<!--[\s\S]*?-->/g, "");
      const declarations = [...pom.matchAll(/<dependency>\s*<groupId>org\.zeromq<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>\s*<version>([^<]+)<\/version>\s*<\/dependency>/g)];
      return pom.includes(`<maven.compiler.release>${languageVersion.split(".")[0]}</maven.compiler.release>`) &&
        declarations.length === plan.dependencies.length && plan.dependencies.every(({ id, version }) =>
          declarations.some(([, artifact, declaredVersion]) => artifact === id && declaredVersion === version),
        );
    }
    case "CMakeLists.txt": {
      const declarations = [...content.matchAll(/^FetchContent_Declare\((\w+)\n([\s\S]*?)^\)$/gm)];
      return content.split("\n").includes(`  CXX_STANDARD ${languageVersion.slice(3)}`) &&
        plan.dependencies.every(({ id, version }) => {
          const matching = declarations.filter(([, name]) => name === id);
          if (matching.length !== 1) return false;
          const lines = matching[0][2].split("\n");
          return lines.includes(`  URL https://codeload.github.com/zeromq/${id}/tar.gz/refs/tags/v${version}`) &&
            lines.includes(`  FIND_PACKAGE_ARGS ${version} EXACT CONFIG`);
        });
    }
    default:
      return true;
  }
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

  const { languageVersion } = getCapabilities().languages.find(
    ({ id }) => id === plan.project.language,
  )!;
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
    if (expected.has(path) && !matchesSource(path, content, plan, layout)) {
      report(
        "INVALID_ARTIFACT_SOURCE",
        `${location}/content`,
        "Artifact content does not match the planned language, pattern, or role.",
      );
    }
    if (expected.has(path) && !matchesDependencies(path, content, plan, languageVersion)) {
      report(
        "INVALID_ARTIFACT_DEPENDENCIES",
        `${location}/content`,
        "Artifact dependency declarations do not match the generation plan.",
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
