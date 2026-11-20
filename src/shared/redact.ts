// Shared by the check runner (src/server/checks.ts) and the read-only usage digest (src/cli/usage.ts).

// A key that names a secret: GITLAB_TOKEN, access_token, AWS_SECRET_ACCESS_KEY, private_key, "api key", password.
const KEY = String.raw`[\w-]*(?:token|secret|password|passwd|private[ _-]?key|api[ _-]?key)[\w-]*`;
// A quoted value through its closing quote, or to the end of the line when it never closes. Group 2 is the quote.
const QUOTED = String.raw`(["'])(?:\\.|(?!\2)[^\n])*(?:\2|$)`;
const UNQUOTED = String.raw`(?![-"'\[])[^\s"',;&]+`;
const masked = (prefix: string) => [new RegExp(`${prefix}${QUOTED}`, "gim"), new RegExp(`${prefix}${UNQUOTED}`, "gi")] as const;
const RULES: [RegExp, string][] = [
  // JWTs
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted]"],
  // Bearer / Basic credentials: a value with a digit or base64 punctuation, so "Basic setup failed" stays
  [/\b(Bearer|Basic)\s+(?=[\w+/=.-]*[\d+/=])[\w+/=.-]{6,}/gi, "$1 [redacted]"],
];
// key=value / key: value / "key": "value", then --key value, then curl -u user:pass
for (const prefix of [String.raw`(${KEY}["']?\s*[=:]\s*)`, String.raw`(--${KEY}\s+)`, String.raw`(\bcurl\b[^\n]*?\s-u\s+)`]) {
  const [q, u] = masked(prefix);
  RULES.push([q, "$1$2[redacted]$2"]);
  if (!prefix.includes("curl")) RULES.push([u, "$1[redacted]"]);
}
RULES.push(
  [/(\bcurl\b[^\n]*?\s-u\s+[^\s:"']+:)[^\s"']+/g, "$1[redacted]"],
  // Known token prefixes
  [/\b(?:glpat-|gl(?:dt|rt|cbt)-|gh[pousr]_|github_pat_|xox[abposr]-|sk[_-](?:live|test)_|AKIA)[\w-]{8,}/g, "[redacted]"],
  // 32+ key-ish chars with a digit in them. No "/": file paths stay readable.
  [/(?<![\w/-])(?=[A-Za-z_+-]*\d)[A-Za-z0-9+_-]{32,}={0,2}/g, "[redacted]"],
);

/** Mask secret-shaped strings in check output: it's stored in sync state, logged, and printed by the usage
 *  digest, which a reflection reads into a model prompt. Best effort, not a guarantee. */
export function redact(text: string): string {
  return RULES.reduce((t, [re, to]) => t.replace(re, to), text);
}
