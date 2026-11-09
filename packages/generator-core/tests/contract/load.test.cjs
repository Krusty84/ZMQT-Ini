/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("node:worker_threads");
const { generateProject } = require("../../dist/index.js");
const {
  projectCases,
  canonicalProject,
} = require("../golden/project-cases.cjs");

const workerCount = 10;

if (!isMainThread) {
  const { start, index } = workerData;
  parentPort.postMessage("ready");
  Atomics.wait(start, 0, 0);
  const observations = projectCases
    .filter((_, caseIndex) => caseIndex % workerCount === index)
    .map((config) => {
      const begin = process.hrtime.bigint();
      const result = generateProject(config);
      const milliseconds = Number(process.hrtime.bigint() - begin) / 1e6;
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      return {
        name: config.project.name,
        bytes: canonicalProject(result.value),
        milliseconds,
      };
    });
  parentPort.postMessage(observations);
} else {
  test(
    "ten concurrent workers generate the same bytes as the direct API",
    { timeout: 30_000 },
    async (t) => {
      const expected = new Map(
        projectCases.map((config) => {
          const result = generateProject(config);
          assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
          return [config.project.name, canonicalProject(result.value)];
        }),
      );
      const start = new Int32Array(
        new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      );
      let ready = 0;
      const batches = await Promise.all(
        Array.from(
          { length: workerCount },
          (_, index) =>
            new Promise((resolve, reject) => {
              const worker = new Worker(__filename, {
                workerData: { start, index },
              });
              t.after(() => worker.terminate());
              worker.on("message", (message) => {
                if (message !== "ready") {
                  resolve(message);
                } else if (++ready === workerCount) {
                  Atomics.store(start, 0, 1);
                  Atomics.notify(start, 0);
                }
              });
              worker.once("error", reject);
              worker.once("exit", (code) => {
                if (code !== 0)
                  reject(
                    new Error(`Generator worker exited with code ${code}.`),
                  );
              });
            }),
        ),
      );

      const observations = batches.flat();
      assert.equal(observations.length, expected.size);
      for (const { name, bytes } of observations) {
        assert.equal(bytes, expected.get(name), name);
        expected.delete(name);
      }
      assert.equal(expected.size, 0);

      const times = observations
        .map(({ milliseconds }) => milliseconds)
        .sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1];
      const macVersion =
        process.platform === "darwin"
          ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
              encoding: "utf8",
            }).trim()
          : "";
      t.diagnostic(
        `p95 ${p95.toFixed(2)} ms from ${times.length} calls on ${process.platform} ${macVersion} ${process.arch}, Node ${process.version}`,
      );
      if (
        macVersion === "27.0.1" &&
        process.arch === "arm64" &&
        process.version === "v26.13.0"
      ) {
        assert.ok(
          p95 <= 3000,
          `p95 ${p95} ms exceeds the 3000 ms reference budget.`,
        );
      }
    },
  );
}
