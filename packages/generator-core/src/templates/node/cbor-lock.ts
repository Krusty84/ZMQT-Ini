/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

export const cborLockPackages = {
  "node_modules/@cto.af/wtf8": {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/@cto.af/wtf8/-/wtf8-1.0.0.tgz",
    integrity: "sha512-qI0XnZxcj/FmASB8XXWqG49bSIzu0I/02deAjhnTni9IZ7KMRVlh8EFLE+mmJlMA169lET6rTCFhEsZSjOwlhA==",
    license: "MIT",
    engines: { node: ">=22" },
  },
  "node_modules/cbor2": {
    version: "2.4.1",
    resolved: "https://registry.npmjs.org/cbor2/-/cbor2-2.4.1.tgz",
    integrity: "sha512-h4OqPnSvIEUNCxTNb9pwMZPKjhNKO9bkPwQJOR7d5oBIrZR/CO098atrLl4AkQmB1p3opCvo2UFt4fhRSWC/vQ==",
    license: "MIT",
    dependencies: { "@cto.af/wtf8": "1.0.0" },
    engines: { node: ">=22" },
  },
};
