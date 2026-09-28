// Memory MCP over plain HTTP (any server exposing read/write/list/search tools, e.g. agent-memory-mcp). Stateless Streamable HTTP: POST JSON-RPC,
// get JSON back. R2 is the primary copy of memory and has NO versioning —
// every write here is read-before-write and append-only in spirit.

import { config } from "./config.ts";

let rpcId = 1;

export class NotFound extends Error {}

export class MemoryClient {
  constructor(
    private url = config.memory.url ?? "",
    private token = config.memory.token,
  ) {}

  get available() {
    return Boolean(this.url && this.token);
  }

  private async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.url || !this.token) throw new Error("memory not configured (memory.url + token)");
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`memory ${name}: HTTP ${res.status}`);
    const body: any = await res.json();
    if (body.error) throw new Error(`memory ${name}: ${body.error.message}`);
    const parts: string[] = (body.result?.content ?? []).map((c: any) => c.text ?? "");
    const text = parts.join("");
    if (body.result?.isError) {
      if (/File not found/.test(text)) throw new NotFound(name);
      throw new Error(`memory ${name}: ${text.slice(0, 200)}`);
    }
    // Some tools return a human preamble part plus a JSON part. Prefer the JSON one.
    for (const part of [...parts].reverse()) {
      for (const candidate of [part, part.slice(Math.max(0, part.indexOf("\n{")))]) {
        try {
          return JSON.parse(candidate.trim()) as T;
        } catch {}
      }
    }
    return text as T;
  }

  /** Returns file content, or undefined if it doesn't exist. */
  async read(path: string): Promise<string | undefined> {
    let out: any;
    try {
      out = await this.call("read", { path });
    } catch (e) {
      if (e instanceof NotFound) return undefined;
      throw e;
    }
    if (typeof out === "string") return out.startsWith("File not found") ? undefined : out;
    if (typeof out?.content === "string") return out.content;
    if (Array.isArray(out?.files)) return out.files[0]?.content;
    return undefined;
  }

  async write(path: string, content: string) {
    return this.call("write", { path, content });
  }

  async list(path: string): Promise<Array<{ path: string; updated_at?: string; size?: number }>> {
    const out: any = await this.call("list", { path });
    const files = Array.isArray(out) ? out : out?.files ?? [];
    return files.map((f: any) => (typeof f === "string" ? { path: f } : f));
  }

  async search(query: string, limit = 5) {
    return this.call<any>("search", { query, limit });
  }
}
