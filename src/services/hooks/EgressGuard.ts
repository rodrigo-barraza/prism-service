import dns from "dns";
import net from "net";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * EgressGuard — SSRF containment for user-configured outbound requests.
 *
 * A configured `http` hook is a URL a *user* supplied that the *server*
 * fetches. That is the textbook server-side request forgery shape: the
 * attacker picks the destination, the server supplies the network position.
 * Inside this deployment that position reaches Mongo, MinIO, every sibling
 * service on the LAN, and — on any cloud host — the 169.254.169.254 instance
 * metadata endpoint that hands out credentials.
 *
 * The guard is deliberately generic (URL in, verdict out) rather than
 * hook-shaped, because `WebhookRoutes` has the identical hole standing open
 * as a TODO on its subscription-create path. Whatever adopts it next needs
 * the same three checks:
 *
 *   1. Protocol — `http:`/`https:` only. `file:`, `gopher:`, `ftp:` and the
 *      rest are alternate ways to reach a local resource.
 *   2. Name — `localhost`, `*.localhost`, `*.local` never leave the box, and
 *      an allowlist (when configured) is the only set of names permitted.
 *   3. Address — the hostname is resolved and EVERY returned address is
 *      tested against the private/loopback/link-local ranges. Checking the
 *      name alone is not enough: an attacker controls their own DNS and can
 *      point `evil.example.com` straight at `127.0.0.1`.
 *
 * Residual risk, stated plainly: between our `dns.lookup` and the socket the
 * fetch actually opens there is a second, independent resolution. An attacker
 * serving a 0-TTL record can flip the answer in that window (classic DNS
 * rebinding). Closing it completely requires pinning the connection to a
 * vetted address via a custom undici dispatcher; what this module does is
 * vet every address the name resolves to and hand those addresses back, so a
 * caller that wants to pin has what it needs.
 */

/** Env var holding a comma-separated hostname allowlist. Empty = any public host. */
export const EGRESS_ALLOWLIST_ENV_VAR = "HOOK_EGRESS_ALLOWED_HOSTS";

/** Hostname suffixes that never resolve off-box. */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

/** Exact hostnames that never resolve off-box. */
const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface EgressCheckResult {
  allowed: boolean;
  /** Stable machine-readable code, suitable for logs and metrics. */
  reason: string;
  hostname?: string;
  /** Every address the hostname resolved to, all of them vetted. */
  addresses?: string[];
}

export class EgressBlockedError extends Error {
  readonly reason: string;
  readonly url: string;

  constructor(url: string, reason: string, detail?: string) {
    super(
      `Egress to "${url}" blocked: ${reason}${detail ? ` (${detail})` : ""}`,
    );
    this.name = "EgressBlockedError";
    this.reason = reason;
    this.url = url;
  }
}

// ─── Address classification ───────────────────────────────────────────────────

function parseIpv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * IPv4 ranges that must never be reached from a user-supplied URL.
 * RFC1918 plus every other block that is either local to the host, local to
 * the network, or special-use — a hook has no legitimate reason to reach any
 * of them, so the list errs wide.
 */
function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) return false;
  const [first, second] = octets;

  if (first === 0) return true; // 0.0.0.0/8 "this network"
  if (first === 10) return true; // RFC1918
  if (first === 127) return true; // loopback
  if (first === 169 && second === 254) return true; // link-local + cloud metadata
  if (first === 172 && second >= 16 && second <= 31) return true; // RFC1918
  if (first === 192 && second === 168) return true; // RFC1918
  if (first === 100 && second >= 64 && second <= 127) return true; // CGNAT RFC6598
  if (first === 192 && second === 0) return true; // 192.0.0/24 + TEST-NET-1
  if (first === 198 && (second === 18 || second === 19)) return true; // benchmarking
  if (first === 198 && second === 51) return true; // TEST-NET-2
  if (first === 203 && second === 0) return true; // TEST-NET-3
  if (first >= 224) return true; // multicast, reserved, broadcast

  return false;
}

/** Expand an IPv6 literal into its eight 16-bit groups. `null` when malformed. */
function expandIpv6(address: string): number[] | null {
  // Strip a zone index (`fe80::1%eth0`) — it is routing scope, not address.
  const zoneless = address.split("%")[0].toLowerCase();

  // A trailing dotted quad (`::ffff:192.168.0.1`) becomes two hex groups.
  const dottedMatch = zoneless.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  let normalized = zoneless;
  if (dottedMatch) {
    const octets = parseIpv4Octets(dottedMatch[1]);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${zoneless.slice(0, dottedMatch.index)}${high}:${low}`;
  }

  const doubleColonCount = normalized.split("::").length - 1;
  if (doubleColonCount > 1) return null;

  let groupTokens: string[];
  if (doubleColonCount === 1) {
    const [head, tail] = normalized.split("::");
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    groupTokens = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  } else {
    groupTokens = normalized.split(":");
  }

  if (groupTokens.length !== 8) return null;

  const groups: number[] = [];
  for (const token of groupTokens) {
    if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
    groups.push(parseInt(token, 16));
  }
  return groups;
}

function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return false;

  const allZeroPrefix = groups.slice(0, 5).every((group) => group === 0);

  // `::` (unspecified) and `::1` (loopback).
  if (allZeroPrefix && groups[5] === 0 && groups[6] === 0) {
    return true; // covers :: and ::1 and the deprecated ::a.b.c.d compat form
  }

  // IPv4-mapped `::ffff:a.b.c.d` — carries a v4 address, so test it as v4.
  if (allZeroPrefix && groups[5] === 0xffff) {
    return isPrivateIpv4(embeddedIpv4(groups));
  }

  // NAT64 `64:ff9b::/96` likewise wraps a v4 destination.
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isPrivateIpv4(embeddedIpv4(groups));
  }

  const firstByte = groups[0] >> 8;
  if (firstByte === 0xfc || firstByte === 0xfd) return true; // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (firstByte === 0xff) return true; // ff00::/8 multicast

  return false;
}

function embeddedIpv4(groups: number[]): string {
  return [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ].join(".");
}

/**
 * Is this literal IP address one a server must never be steered toward?
 * Unparseable input returns `false` — callers treat a non-IP as a hostname
 * and route it through DNS resolution instead.
 */
export function isPrivateIp(ip: string): boolean {
  if (typeof ip !== "string" || ip.length === 0) return false;
  const trimmed = ip.trim().replace(/^\[|\]$/g, "");
  const family = net.isIP(trimmed);
  if (family === 4) return isPrivateIpv4(trimmed);
  if (family === 6) return isPrivateIpv6(trimmed);
  // Not a literal address at all.
  return false;
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

let cachedAllowlistSource: string | null = null;
let cachedAllowlist: string[] = [];

/**
 * Parsed `HOOK_EGRESS_ALLOWED_HOSTS`. Read from the environment on every call
 * (memoized on the raw string) so a deployment can change it without a
 * restart, and so tests can set it per-case.
 */
export function getEgressAllowlist(): string[] {
  const raw = process.env[EGRESS_ALLOWLIST_ENV_VAR] ?? "";
  if (raw !== cachedAllowlistSource) {
    cachedAllowlistSource = raw;
    cachedAllowlist = raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
  }
  return cachedAllowlist;
}

/**
 * Allowlist entries match a hostname exactly, or — when written as
 * `.example.com` / `*.example.com` — as a suffix covering subdomains.
 * The bare `example.com` form deliberately does NOT cover subdomains: a
 * wildcard has to be asked for.
 */
function matchesAllowlistEntry(hostname: string, entry: string): boolean {
  if (entry === "*") return true;
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1); // ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  if (entry.startsWith(".")) {
    return hostname.endsWith(entry) && hostname.length > entry.length;
  }
  return hostname === entry;
}

// ─── Checks ───────────────────────────────────────────────────────────────────

function checkHostname(hostname: string): EgressCheckResult | null {
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: "loopback_hostname", hostname };
  }
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { allowed: false, reason: "local_domain_suffix", hostname };
  }

  const allowlist = getEgressAllowlist();
  if (
    allowlist.length > 0 &&
    !allowlist.some((entry) => matchesAllowlistEntry(hostname, entry))
  ) {
    return { allowed: false, reason: "host_not_allowlisted", hostname };
  }

  return null;
}

/**
 * Everything that can be decided without touching the network: protocol,
 * hostname shape, allowlist membership, and a literal-IP destination.
 *
 * Exposed separately because the routes layer validates a URL at write time,
 * where a DNS round-trip inside a request handler is a cost (and a different
 * answer than the one that will apply at dispatch time anyway).
 */
export function checkUrlWithoutDns(url: string): EgressCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "malformed_url" };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { allowed: false, reason: "protocol_not_allowed" };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) return { allowed: false, reason: "missing_hostname" };

  const hostnameVerdict = checkHostname(hostname);
  if (hostnameVerdict) return hostnameVerdict;

  // A literal address skips DNS entirely — there is nothing to resolve.
  if (net.isIP(hostname) !== 0) {
    if (isPrivateIp(hostname)) {
      return { allowed: false, reason: "private_address", hostname, addresses: [hostname] };
    }
    return { allowed: true, reason: "public_literal_address", hostname, addresses: [hostname] };
  }

  return { allowed: true, reason: "pending_dns_check", hostname };
}

/**
 * Full check: structural rules, then DNS, then EVERY resolved address.
 *
 * All addresses are tested rather than just the first, because a hostile
 * nameserver can return a public address alongside a private one and let the
 * connect logic pick.
 */
export async function isUrlAllowed(url: string): Promise<EgressCheckResult> {
  const structural = checkUrlWithoutDns(url);
  if (!structural.allowed) return structural;
  if (structural.reason !== "pending_dns_check") return structural;

  const hostname = structural.hostname as string;

  let resolved: Array<{ address: string }>;
  try {
    resolved = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch (lookupError: unknown) {
    // The verdict carries a stable code so a resolver's wording never leaks
    // into an API response; the wording itself goes to the log, where an
    // operator debugging a hook that "just stopped firing" needs it.
    logger.debug(
      `[EgressGuard] DNS lookup failed for "${hostname}": ${errorMessage(lookupError)}`,
    );
    return {
      allowed: false,
      reason: "dns_lookup_failed",
      hostname,
      addresses: [],
    };
  }

  const addresses = resolved.map((entry) => entry.address);
  if (addresses.length === 0) {
    return { allowed: false, reason: "dns_no_addresses", hostname, addresses };
  }

  // The rebinding re-check: the name passed, now the answers have to.
  const privateAddress = addresses.find((address) => isPrivateIp(address));
  if (privateAddress) {
    return {
      allowed: false,
      reason: "private_address",
      hostname,
      addresses,
    };
  }

  return { allowed: true, reason: "allowed", hostname, addresses };
}

/**
 * Throwing form. Use this at the top of any outbound dispatch so the failure
 * path is a thrown `EgressBlockedError` the caller already has to handle,
 * rather than a boolean somebody forgets to read.
 */
export async function assertUrlAllowed(url: string): Promise<EgressCheckResult> {
  const verdict = await isUrlAllowed(url);
  if (!verdict.allowed) {
    logger.warn(
      `[EgressGuard] Blocked outbound request to "${url}": ${verdict.reason}`,
    );
    throw new EgressBlockedError(url, verdict.reason);
  }
  return verdict;
}

/** Reset the memoized allowlist. Test seam. */
export function clearEgressAllowlistCache(): void {
  cachedAllowlistSource = null;
  cachedAllowlist = [];
}

const EgressGuard = {
  assertUrlAllowed,
  isUrlAllowed,
  checkUrlWithoutDns,
  isPrivateIp,
  getEgressAllowlist,
  clearEgressAllowlistCache,
  EgressBlockedError,
};

export default EgressGuard;
