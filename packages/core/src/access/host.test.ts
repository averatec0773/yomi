import { describe, expect, it } from "vitest";
import { allowedHostsFromEnv, hostAllowed, hostRefusal } from "./host";

describe("hostAllowed", () => {
  it("accepts loopback names on the server's port (or none), and allowed names", () => {
    for (const h of ["localhost:7773", "LOCALHOST:7773", "127.0.0.1:7773", "[::1]:7773", "localhost"]) expect(hostAllowed(h, "7773", [])).toBe(true);
    for (const h of ["localhost:3000", "evil.example:7773", "localhost.evil.example:7773", "192.168.1.20:7773", "", "user@localhost:7773"]) {
      expect(hostAllowed(h, "7773", [])).toBe(false);
    }
    expect(hostAllowed("192.168.1.20:7773", "7773", ["192.168.1.20"])).toBe(true);
    expect(hostAllowed("my-laptop.tail1234.ts.net", "7773", ["my-laptop.tail1234.ts.net"])).toBe(true);
    // An entry with a port allows exactly that port (a Docker or SSH port mapping).
    expect(hostAllowed("localhost:8080", "7773", ["localhost:8080"])).toBe(true);
    expect(hostAllowed("192.168.1.20:7773", "7773", ["192.168.1.20:8080"])).toBe(false);
  });

  it("reads YOMI_ALLOWED_HOSTS as a comma-separated list", () => {
    expect(allowedHostsFromEnv({ YOMI_ALLOWED_HOSTS: " my-laptop, 192.168.1.20:7773 ,," })).toEqual(["my-laptop", "192.168.1.20:7773"]);
    expect(allowedHostsFromEnv({})).toEqual([]);
  });
});

describe("hostRefusal", () => {
  it("takes the server's port from the request URL and the Host header from the client", () => {
    const url = new URL("http://localhost:7773/transactions");
    expect(hostRefusal("localhost:7773", url, [])).toBeNull();
    expect(hostRefusal("rebind.example:7773", url, [])).toEqual({
      error: "This server does not answer to rebind.example:7773. Add it to YOMI_ALLOWED_HOSTS and restart yomi",
      code: "request_host_not_allowed",
      params: { host: "rebind.example:7773" },
    });
    expect(hostRefusal("rebind.example:7773", url, ["rebind.example"])).toBeNull();
    // No Host header (a Request built in a test): the URL's own host counts.
    expect(hostRefusal(undefined, url, [])).toBeNull();
    expect(hostRefusal(null, new URL("http://192.168.1.20:7773/"), [])).not.toBeNull();
  });
});
