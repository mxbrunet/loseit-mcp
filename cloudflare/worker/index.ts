/**
 * Cloudflare Worker fronting the loseit-mcp container.
 *
 * The container runs the unmodified production image: uvicorn serving the
 * multi-tenant streamable-HTTP app on port 8000. This Worker's only jobs are
 * to start that container, rewrite the three headers the app expects from a
 * reverse proxy, and pass everything else through untouched.
 */
import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

export class LoseItContainer extends Container<Env> {
  // Matches PORT in the Dockerfile, which the CMD passes to `serve --port`.
  defaultPort = 8000;
  requiredPorts = [8000];

  // Long enough that a conversation's worth of tool calls stays warm, short
  // enough that an idle instance stops billing. A cold start is 2-3s.
  sleepAfter = "10m";

  // The whole point of the service is reaching loseit.com.
  enableInternet = true;

  envVars = {
    // Credentials arrive per-request, so the process itself holds none.
    LOSEIT_MULTI_TENANT: "1",

    // Enables credential URLs and POST /enroll.
    LOSEIT_ENROLLMENT: "1",

    // Seals and opens /u/<sealed>/mcp URLs. Rotating it invalidates every URL
    // ever issued, which is the only revocation mechanism there is.
    LOSEIT_URL_SECRET: env.LOSEIT_URL_SECRET,

    // Restricts enrollment to holders of this value, sent as x-enroll-secret.
    // Without it, anyone who finds the hostname can mint a URL on this
    // container's billed compute.
    LOSEIT_ENROLL_SECRET: env.LOSEIT_ENROLL_SECRET,

    // Required. The MCP transport's DNS-rebinding protection matches the Host
    // header against this list and answers 421 to anything else; the default
    // is localhost-only, which would reject every proxied request.
    LOSEIT_ALLOWED_HOSTS: env.LOSEIT_HOSTNAME,

    // Only names a place to re-enroll in the "URL no longer valid" message.
    LOSEIT_PUBLIC_URL: `https://${env.LOSEIT_HOSTNAME}`,

    // We write exactly one X-Forwarded-For hop below, so the throttle should
    // trust exactly one.
    LOSEIT_TRUSTED_PROXIES: "1",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);

    // The throttle reads X-Forwarded-For and nothing else — CF-Connecting-IP
    // is invisible to it. Overwrite rather than append: an appended value
    // would let a caller prepend hops and pick their own rate-limit bucket.
    // With no CF-Connecting-IP (wrangler dev), drop the header entirely so the
    // throttle falls back to the peer address instead of trusting the caller.
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) {
      headers.set("X-Forwarded-For", clientIp);
    } else {
      headers.delete("X-Forwarded-For");
    }

    // Enrollment builds the URL it hands back from these, and the hop to the
    // container is plain HTTP — without them it would mint http:// URLs.
    headers.set("X-Forwarded-Proto", url.protocol === "http:" ? "http" : "https");
    headers.set("X-Forwarded-Host", url.host);

    // One instance: the session-token cache, the throttle buckets, and the
    // per-credential limits all live in that process's memory, so spreading
    // requests across instances would fragment all three.
    const container = env.LOSEIT.getByName("singleton");
    await container.startAndWaitForPorts();

    // Constructing from `request` carries the method, body, and everything
    // else over, replacing only the headers. Spreading it would not: method
    // and body are prototype getters, not own enumerable properties.
    return container.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
