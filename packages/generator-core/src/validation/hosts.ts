/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 Alexey Sedoykin
 * SPDX-License-Identifier: MIT
 */

function parseIpv4(host: string): number[] | undefined {
  const octets = host.split(".");
  if (
    octets.length !== 4 ||
    !octets.every((octet) => /^(0|[1-9][0-9]{0,2})$/.test(octet))
  ) {
    return undefined;
  }

  const values = octets.map(Number);
  return values.every((value) => value <= 255) ? values : undefined;
}

function parseIpv6(host: string): number[] | undefined {
  if (host.includes(".")) {
    const suffix = host.lastIndexOf(":") + 1;
    const octets = parseIpv4(host.slice(suffix));
    if (!octets) return undefined;

    const [a, b, c, d] = octets;
    host = `${host.slice(0, suffix)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }

  const sections = host.split("::");
  if (sections.length > 2) return undefined;

  const [head, tail] = sections;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  const compressed = sections.length === 2;
  if (compressed ? missing <= 0 : missing !== 0) return undefined;
  if (![...left, ...right].every((group) => /^[0-9a-fA-F]{1,4}$/.test(group)))
    return undefined;

  return [
    ...left.map((group) => parseInt(group, 16)),
    ...Array<number>(missing).fill(0),
    ...right.map((group) => parseInt(group, 16)),
  ];
}

export function sameHost(first: string, second: string): boolean {
  if (first.toLowerCase().replace(/\.$/, "") === second.toLowerCase().replace(/\.$/, "")) return true;
  if (!first.includes(":") || !second.includes(":")) return false;
  const left = parseIpv6(first);
  const right = parseIpv6(second);
  return left !== undefined && right !== undefined && left.every((group, index) => group === right[index]);
}

function classifyIpv4(
  firstOctet: number,
  allZero: boolean,
): "loopback" | "unspecified" | "external" {
  if (allZero) return "unspecified";
  return firstOctet === 127 ? "loopback" : "external";
}

export function classifyHost(
  host: string,
): "loopback" | "unspecified" | "external" | undefined {
  if (host === "*") return "unspecified";

  if (host.includes(":")) {
    const groups = parseIpv6(host);
    if (!groups) return undefined;

    const [prefix, high, low] = groups.slice(5);
    if (prefix === 0xffff && groups.slice(0, 5).every((group) => group === 0)) {
      return classifyIpv4(high >>> 8, high === 0 && low === 0);
    }
    if (groups.slice(0, 7).every((group) => group === 0)) {
      if (low === 0) return "unspecified";
      if (low === 1) return "loopback";
    }
    return "external";
  }

  const octets = parseIpv4(host);
  if (octets)
    return classifyIpv4(
      octets[0],
      octets.every((octet) => octet === 0),
    );

  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  const labels = name.split(".");
  const lastLabel = labels[labels.length - 1];
  // Numeric suffixes can be interpreted as abbreviated or non-decimal IPv4 addresses.
  if (name.length > 253 || /^(\d+|0x[0-9a-f]*)$/i.test(lastLabel))
    return undefined;
  if (
    !labels.every((label) =>
      /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    )
  )
    return undefined;

  return name.toLowerCase() === "localhost" ? "loopback" : "external";
}
