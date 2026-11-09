/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { Diagnostic } from "../public/types";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.sort(
    (left, right) =>
      compare(left.path, right.path) || compare(left.code, right.code),
  );
}
