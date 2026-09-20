/**
 * Secrets are set with `wrangler secret put` and deliberately never appear in
 * wrangler.jsonc, so `wrangler types` cannot see them. Declaring them here
 * merges with the generated `Cloudflare.Env`, which is what the `env` import
 * from "cloudflare:workers" resolves to.
 */
declare namespace Cloudflare {
  interface Env {
    /** Seals and opens /u/<sealed>/mcp credential URLs. */
    LOSEIT_URL_SECRET: string;
    /** Required as x-enroll-secret on POST /enroll. */
    LOSEIT_ENROLL_SECRET: string;
  }
}
