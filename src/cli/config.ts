// Print the resolved config (secrets masked), or one key: `bun src/cli/config.ts caFile`.
import { config } from "../server/config.ts";

const key = process.argv[2];
const masked = { ...config, memory: { ...config.memory, token: config.memory.token ? "••••" : undefined } };
if (key) {
  const v = key.split(".").reduce<any>((o, k) => o?.[k], masked);
  if (v !== undefined && v !== null) console.log(typeof v === "object" ? JSON.stringify(v) : String(v));
} else {
  console.log(JSON.stringify(masked, null, 2));
}
