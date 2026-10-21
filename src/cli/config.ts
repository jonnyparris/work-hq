// Print the resolved config (secrets masked), or one key: `bun src/cli/config.ts caFile`.
import { config } from "../server/config.ts";

/** Any `token` value, at any depth, prints as •••• (memory.token, deadlines.clairic.token, …). */
export function maskSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskSecrets);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /token$/i.test(k) && typeof x === "string" ? (x ? "••••" : x) : maskSecrets(x)]));
}

if (import.meta.main) {
  const key = process.argv[2];
  const masked = maskSecrets(config) as any;
  if (key) {
    const v = key.split(".").reduce<any>((o, k) => o?.[k], masked);
    if (v !== undefined && v !== null) console.log(typeof v === "object" ? JSON.stringify(v) : String(v));
  } else {
    console.log(JSON.stringify(masked, null, 2));
  }
}
