/**
 * Which Host names this server answers to: localhost, 127.0.0.1 and [::1] on its own port, plus YOMI_ALLOWED_HOSTS.
 * A page on another name that resolves to this computer (DNS rebinding) sends its own name as Host and is refused.
 * Framework-free: apps/web/proxy.ts checks every request with it, packages/api every /api request (and Origins).
 */

/** Host names every install answers to, on the port it runs on. */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** "localhost:7773" → { name: "localhost", port: "7773" }, "[::1]" → { name: "[::1]", port: "" }; null when malformed. */
function parseHost(value: string): { name: string; port: string } | null {
  const m = /^(\[[0-9a-f:.]+\]|[^\s:/[\]@]+)(?::(\d+))?$/i.exec(value.trim());
  return m ? { name: m[1]!.toLowerCase(), port: m[2] ?? "" } : null;
}

/** YOMI_ALLOWED_HOSTS: comma-separated names this server also answers to, each with an optional port ("my-laptop,192.168.1.20:7773"). */
export function allowedHostsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env.YOMI_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/**
 * Whether `value` (a Host header, or the host of an Origin) names this server: a loopback name or an allowed one, on
 * the entry's port when it names one, else on the server's own port (or none, behind a proxy on 80/443).
 */
export function hostAllowed(value: string, serverPort: string, allowed: readonly string[]): boolean {
  const h = parseHost(value);
  if (!h) return false;
  return [...LOOPBACK, ...allowed].some((entry) => {
    const e = parseHost(entry);
    return e !== null && e.name === h.name && (e.port ? h.port === e.port : h.port === "" || h.port === serverPort);
  });
}

export interface HostRefusal {
  error: string;
  code: "request_host_not_allowed";
  params: { host: string };
}

/**
 * The 403 body for a request whose Host this server does not answer to, or null when it does. `url` is the request URL,
 * which Next.js builds from its own listening origin, so its port is the server's; without a Host header its host counts.
 */
export function hostRefusal(hostHeader: string | null | undefined, url: URL, allowed: readonly string[]): HostRefusal | null {
  const host = hostHeader ?? url.host;
  if (hostAllowed(host, url.port, allowed)) return null;
  return {
    error: `This server does not answer to ${host}. Add it to YOMI_ALLOWED_HOSTS and restart yomi`,
    code: "request_host_not_allowed",
    params: { host },
  };
}
