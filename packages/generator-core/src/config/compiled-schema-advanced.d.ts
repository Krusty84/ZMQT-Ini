/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

import type { AdvancedConfig } from "../public/types";
import type { SchemaIssue } from "./compiled-schema.js";

declare const validateAdvanced: {
  (input: unknown): input is AdvancedConfig;
  errors?: readonly SchemaIssue[] | null;
};

export default validateAdvanced;
