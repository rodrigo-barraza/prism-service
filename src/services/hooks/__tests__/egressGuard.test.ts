import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock("dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

import {
  isPrivateIp,
  isUrlAllowed,
  assertUrlAllowed,
  checkUrlWithoutDns,
  clearEgressAllowlistCache,
  EgressBlockedError,
  EGRESS_ALLOWLIST_ENV_VAR,
} from "#src/services/hooks/EgressGuard";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// SSRF containment. Each private range gets its own case
// because "we block private IPs" is exactly the claim that is
// true for 10/8 and quietly false for 100.64/10 or ::ffff:.
// ────────────────────────────────────────────────────────────

function resolvesTo(...addresses: string[]) {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    })),
  );
}

describe("EgressGuard", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    delete process.env[EGRESS_ALLOWLIST_ENV_VAR];
    clearEgressAllowlistCache();
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env[EGRESS_ALLOWLIST_ENV_VAR];
    clearEgressAllowlistCache();
    vi.restoreAllMocks();
  });

  describe("isPrivateIp — IPv4", () => {
    it.each([
      ["loopback 127/8", "127.0.0.1"],
      ["loopback high", "127.255.255.254"],
      ["RFC1918 10/8", "10.1.2.3"],
      ["RFC1918 172.16/12 low", "172.16.0.1"],
      ["RFC1918 172.16/12 high", "172.31.255.255"],
      ["RFC1918 192.168/16", "192.168.1.1"],
      ["link-local 169.254/16", "169.254.0.1"],
      ["cloud metadata", "169.254.169.254"],
      ["this-network 0/8", "0.0.0.0"],
      ["CGNAT 100.64/10", "100.64.0.1"],
      ["multicast", "224.0.0.1"],
      ["broadcast", "255.255.255.255"],
    ])("rejects %s", (_label, address) => {
      expect(isPrivateIp(address)).toBe(true);
    });

    it.each([
      ["public DNS", "8.8.8.8"],
      ["public DNS 2", "1.1.1.1"],
      ["just outside 172.16/12", "172.32.0.1"],
      ["just below 172.16/12", "172.15.255.255"],
      ["just outside CGNAT", "100.128.0.1"],
      ["ordinary host", "93.184.216.34"],
    ])("allows %s", (_label, address) => {
      expect(isPrivateIp(address)).toBe(false);
    });
  });

  describe("isPrivateIp — IPv6", () => {
    it.each([
      ["loopback", "::1"],
      ["unspecified", "::"],
      ["unique-local fc00::/7", "fc00::1"],
      ["unique-local fd", "fd12:3456::1"],
      ["link-local fe80::/10", "fe80::1"],
      ["link-local with zone", "fe80::1%eth0"],
      ["multicast", "ff02::1"],
      ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
      ["IPv4-mapped RFC1918", "::ffff:10.0.0.1"],
    ])("rejects %s", (_label, address) => {
      expect(isPrivateIp(address)).toBe(true);
    });

    it.each([
      ["public v6", "2001:4860:4860::8888"],
      ["IPv4-mapped public", "::ffff:8.8.8.8"],
    ])("allows %s", (_label, address) => {
      expect(isPrivateIp(address)).toBe(false);
    });

    it("returns false for values that are not addresses at all", () => {
      expect(isPrivateIp("example.com")).toBe(false);
      expect(isPrivateIp("")).toBe(false);
      expect(isPrivateIp("999.999.999.999")).toBe(false);
    });
  });

  describe("protocol", () => {
    it.each([
      ["file", "file:///etc/passwd"],
      ["ftp", "ftp://example.com/x"],
      ["gopher", "gopher://example.com/"],
      ["data", "data:text/plain,hello"],
    ])("rejects the %s scheme", async (_label, url) => {
      const verdict = await isUrlAllowed(url);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("protocol_not_allowed");
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it("rejects a malformed URL", async () => {
      const verdict = await isUrlAllowed("not a url");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("malformed_url");
    });
  });

  describe("hostnames that never leave the box", () => {
    it.each([
      ["localhost", "http://localhost:7777/hook", "loopback_hostname"],
      ["a .local name", "https://printer.local/hook", "local_domain_suffix"],
      ["a .localhost name", "http://api.localhost/hook", "local_domain_suffix"],
      ["a .internal name", "http://db.internal/hook", "local_domain_suffix"],
    ])("rejects %s", async (_label, url, reason) => {
      const verdict = await isUrlAllowed(url);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe(reason);
      expect(lookupMock).not.toHaveBeenCalled();
    });
  });

  describe("literal addresses skip DNS", () => {
    it("rejects a literal private IPv4 without resolving", async () => {
      const verdict = await isUrlAllowed("http://127.0.0.1:27017/");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("private_address");
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it("rejects a bracketed literal IPv6 loopback", async () => {
      const verdict = await isUrlAllowed("http://[::1]:9000/");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("private_address");
    });

    it("rejects the cloud metadata address", async () => {
      const verdict = await isUrlAllowed("http://169.254.169.254/latest/meta-data/");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("private_address");
    });

    it("allows a literal public address", async () => {
      const verdict = await isUrlAllowed("https://8.8.8.8/hook");
      expect(verdict.allowed).toBe(true);
      expect(verdict.addresses).toEqual(["8.8.8.8"]);
      expect(lookupMock).not.toHaveBeenCalled();
    });
  });

  describe("DNS resolution — the rebinding defense", () => {
    it("blocks a public-looking name that resolves to a private address", async () => {
      resolvesTo("10.0.0.5");
      const verdict = await isUrlAllowed("https://evil.example.com/hook");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("private_address");
      expect(verdict.addresses).toEqual(["10.0.0.5"]);
    });

    it("blocks a name that resolves to the metadata endpoint", async () => {
      resolvesTo("169.254.169.254");
      const verdict = await isUrlAllowed("https://metadata.example.com/");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("private_address");
    });

    it("blocks when ANY answer is private, not just the first", async () => {
      resolvesTo("93.184.216.34", "127.0.0.1");
      const verdict = await isUrlAllowed("https://mixed.example.com/hook");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("private_address");
    });

    it("blocks a name resolving to an IPv4-mapped loopback", async () => {
      resolvesTo("::ffff:127.0.0.1");
      const verdict = await isUrlAllowed("https://sneaky.example.com/hook");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("private_address");
    });

    it("allows a name resolving only to public addresses", async () => {
      resolvesTo("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946");
      const verdict = await isUrlAllowed("https://example.com/hook");
      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toBe("allowed");
      expect(verdict.addresses).toHaveLength(2);
    });

    it("blocks when DNS fails", async () => {
      lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
      const verdict = await isUrlAllowed("https://nowhere.example.com/hook");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("dns_lookup_failed");
    });

    it("blocks when DNS returns nothing", async () => {
      lookupMock.mockResolvedValue([]);
      const verdict = await isUrlAllowed("https://empty.example.com/hook");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("dns_no_addresses");
    });
  });

  describe("allowlist", () => {
    it("allows any public host when the allowlist is empty", async () => {
      resolvesTo("93.184.216.34");
      const verdict = await isUrlAllowed("https://anything.example.com/hook");
      expect(verdict.allowed).toBe(true);
    });

    it("rejects a host that is not on a configured allowlist", async () => {
      process.env[EGRESS_ALLOWLIST_ENV_VAR] = "hooks.example.com";
      clearEgressAllowlistCache();
      const verdict = await isUrlAllowed("https://other.example.com/hook");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("host_not_allowlisted");
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it("allows an exact allowlist match", async () => {
      process.env[EGRESS_ALLOWLIST_ENV_VAR] = " hooks.example.com , other.test ";
      clearEgressAllowlistCache();
      resolvesTo("93.184.216.34");
      const verdict = await isUrlAllowed("https://hooks.example.com/hook");
      expect(verdict.allowed).toBe(true);
    });

    it("does not let an exact entry cover subdomains", async () => {
      process.env[EGRESS_ALLOWLIST_ENV_VAR] = "example.com";
      clearEgressAllowlistCache();
      const verdict = await isUrlAllowed("https://evil.example.com/hook");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("host_not_allowlisted");
    });

    it("honours a wildcard entry for subdomains", async () => {
      process.env[EGRESS_ALLOWLIST_ENV_VAR] = "*.example.com";
      clearEgressAllowlistCache();
      resolvesTo("93.184.216.34");
      expect((await isUrlAllowed("https://hooks.example.com/x")).allowed).toBe(
        true,
      );
      expect((await isUrlAllowed("https://example.com/x")).allowed).toBe(false);
    });

    it("still blocks a private address for an allowlisted host", async () => {
      process.env[EGRESS_ALLOWLIST_ENV_VAR] = "hooks.example.com";
      clearEgressAllowlistCache();
      resolvesTo("192.168.1.10");
      const verdict = await isUrlAllowed("https://hooks.example.com/hook");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("private_address");
    });
  });

  describe("assertUrlAllowed", () => {
    it("throws EgressBlockedError carrying the reason", async () => {
      await expect(assertUrlAllowed("http://localhost/hook")).rejects.toThrow(
        EgressBlockedError,
      );
      await expect(
        assertUrlAllowed("http://localhost/hook"),
      ).rejects.toMatchObject({ reason: "loopback_hostname" });
    });

    it("resolves with the verdict when the URL is allowed", async () => {
      resolvesTo("93.184.216.34");
      await expect(
        assertUrlAllowed("https://example.com/hook"),
      ).resolves.toMatchObject({ allowed: true });
    });
  });

  describe("checkUrlWithoutDns", () => {
    it("defers a resolvable hostname to the DNS stage", () => {
      const verdict = checkUrlWithoutDns("https://example.com/hook");
      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toBe("pending_dns_check");
    });

    it("is enough to reject the write-time cases a routes layer cares about", () => {
      expect(checkUrlWithoutDns("file:///etc/passwd").allowed).toBe(false);
      expect(checkUrlWithoutDns("http://localhost/x").allowed).toBe(false);
      expect(checkUrlWithoutDns("http://10.0.0.1/x").allowed).toBe(false);
    });
  });
});
