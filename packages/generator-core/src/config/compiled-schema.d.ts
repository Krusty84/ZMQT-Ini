/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { BasicConfig } from "../public/types";

export interface SchemaIssue {
  keyword: string;
  instancePath: string;
  params: Readonly<Record<string, unknown>>;
  message?: string;
}

declare const validate: {
  (input: unknown): input is BasicConfig;
  errors?: readonly SchemaIssue[] | null;
};

export default validate;
