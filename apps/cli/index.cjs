/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { createRequire } = require("node:module");
const { join, resolve } = require("node:path");

const requireCore = createRequire(
  join(__dirname, "../../packages/generator-core/package.json"),
);

function reject(diagnostics) {
  process.stderr.write(`${JSON.stringify({ diagnostics })}\n`);
  process.exitCode = 1;
}

function fail(code, message) {
  reject([{ code, severity: "error", path: "", message }]);
}

function removeCreated(paths, remove) {
  let complete = true;
  for (const path of paths.reverse()) {
    try {
      remove(path);
    } catch (error) {
      if (error.code !== "ENOENT") complete = false;
    }
  }
  return complete;
}

function main(args) {
  if (args.length !== 2) {
    return fail(
      "CLI_USAGE",
      "Usage: node apps/cli/index.cjs CONFIG_JSON NEW_OUTPUT_DIR",
    );
  }
  const [configPath, outputPath] = args;
  const output = resolve(outputPath);

  let bytes;
  try {
    bytes = readFileSync(configPath);
  } catch {
    return fail(
      "CLI_CONFIG_READ_FAILED",
      "Could not read the configuration file.",
    );
  }

  let config;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    config = JSON.parse(text);
  } catch {
    return fail(
      "CLI_INVALID_JSON",
      "The configuration must be valid UTF-8 JSON.",
    );
  }

  let result;
  try {
    const { generateProject } = requireCore("@zmqt-ini/generator-core");
    result = generateProject(config);
  } catch {
    return fail(
      "CLI_CORE_FAILED",
      "Generator Core could not complete the request.",
    );
  }
  if (!result.ok) return reject(result.diagnostics);

  try {
    mkdirSync(output);
  } catch (error) {
    if (error.code === "EEXIST")
      return fail("CLI_OUTPUT_EXISTS", "The output path already exists.");
    return fail(
      "CLI_OUTPUT_CREATE_FAILED",
      "Could not create the output directory.",
    );
  }

  const { manifest, files } = result.value;
  const createdDirectories = new Set([output]);
  const createdFiles = [];
  try {
    for (const file of files) {
      const segments = file.path.split("/");
      const name = segments.pop();
      let directory = output;
      for (const segment of segments) {
        directory = join(directory, segment);
        if (!createdDirectories.has(directory)) {
          mkdirSync(directory);
          createdDirectories.add(directory);
        }
      }
      const destination = join(directory, name);
      const descriptor = openSync(
        destination,
        "wx",
        file.executable ? 0o755 : 0o644,
      );
      createdFiles.push(destination);
      try {
        writeFileSync(descriptor, file.content, "utf8");
      } finally {
        closeSync(descriptor);
      }
    }
  } catch {
    const filesRemoved = removeCreated(createdFiles, unlinkSync);
    const directoriesRemoved = removeCreated(
      [...createdDirectories],
      rmdirSync,
    );
    return fail(
      "CLI_OUTPUT_WRITE_FAILED",
      filesRemoved && directoriesRemoved
        ? "Could not write the complete project."
        : "Could not write the complete project or remove every artifact created by this command.",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ manifest, diagnostics: result.diagnostics })}\n`,
  );
}

main(process.argv.slice(2));
