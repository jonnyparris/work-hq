// Memory MCP over plain HTTP (any server exposing read/write/list/search tools, e.g. agent-memory-mcp; read must
// page like agent-memory-mcp: offset in, truncated + next_offset out, see read()). Stateless Streamable HTTP: POST JSON-RPC,
// get JSON back. R2 is the primary copy of memory and has NO versioning —
// every write here is read-before-write and append-only in spirit.

import { config } from "./config.ts";

let rpcId = 1;
/** A whole read (all pages) gives up after this; each page also has the 30 s call timeout. */
const READ_DEADLINE_MS = 120_000;
/** 200 pages = 10M chars: far past any memory file; a server that never stops paging hits this. */
const MAX_READ_PAGES = 200;

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

  /**
   * Returns the whole file, or undefined if it doesn't exist. agent-memory-mcp returns at most 50K chars a call
   * and sets truncated + next_offset; this follows them. Every call sends `offset`: without it the server appends
   * an in-band "[Content truncated...]" marker to the content and omits total_length. Callers read-modify-write,
   * so anything that could be a short or stitched read throws instead: truncated without a usable next_offset, a
   * gap or overlap between pages, a file that changes between pages (new updated_at or total_length; a same-length
   * edit in the same millisecond isn't caught), a length that doesn't add up, an unknown reply.
   * 11-10 and 11-11 the journal flush wrote back one page of the archive (marker included), deleting 11-05..11-09.
   */
  async read(path: string): Promise<string | undefined> {
    const deadline = Date.now() + READ_DEADLINE_MS;
    let content = "";
    let first: { updated_at?: unknown; total_length?: unknown } | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_READ_PAGES) throw new Error(`memory read ${path}: still truncated after ${page} pages`);
      if (page && Date.now() > deadline) throw new Error(`memory read ${path}: over ${READ_DEADLINE_MS / 1000}s`);
      const offset = content.length;
      let out: any;
      try {
        out = await this.call("read", { path, offset });
      } catch (e) {
        if (e instanceof NotFound && page === 0) return undefined;
        throw e;
      }
      if (page === 0 && typeof out === "string" && out.startsWith("File not found")) return undefined;
      if (Array.isArray(out?.files) && out.files[0] && typeof out.files[0] === "object") out = out.files[0];
      if (typeof out?.content !== "string") {
        throw new Error(`memory read ${path}: unrecognised reply at offset ${offset}: ${String(typeof out === "string" ? out : JSON.stringify(out)).slice(0, 120)}`);
      }
      if (!first) first = { updated_at: out.updated_at, total_length: out.total_length };
      else if (out.updated_at !== first.updated_at || out.total_length !== first.total_length) {
        throw new Error(`memory read ${path}: file changed between pages`);
      }
      if (typeof out.offset === "number" && out.offset !== offset) {
        throw new Error(`memory read ${path}: asked for offset ${offset}, got ${out.offset}`);
      }
      content += out.content;
      if (!out.truncated) {
        if (typeof first.total_length === "number" && first.total_length !== content.length) {
          throw new Error(`memory read ${path}: read ${content.length} of ${first.total_length} chars`);
        }
        return content;
      }
      if (!out.content.length || out.next_offset !== content.length) {
        throw new Error(`memory read ${path}: truncated at ${content.length} chars with no usable next_offset (${out.next_offset})`);
      }
    }
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
