import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * A minimal MCP server over Streamable HTTP (stateless, JSON responses),
 * enough for tools: initialize, ping, tools/list and tools/call on POST /mcp.
 *
 * Every request needs `Authorization: Bearer <token>`. Each token has a role;
 * a tool with a `role` is listed and callable only with that role's token
 * (the Risk Officer's approval tools, later the Trader's order tools).
 */

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>;
  /** Only tokens with this role may see or call the tool. Unset: every token. */
  role?: string;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface McpToken {
  token: string;
  role: string;
}

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 1_000_000;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "cache-control": "no-store",
    ...(body !== undefined && { "content-type": "application/json" }),
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

function findRole(header: string | undefined, tokens: McpToken[]): string | null {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return null;
  const given = Buffer.from(match[1]!);
  for (const t of tokens) {
    const want = Buffer.from(t.token);
    if (want.length === given.length && timingSafeEqual(want, given)) return t.role;
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createMcpHandler(options: {
  tools: McpTool[];
  tokens: McpToken[];
  version: string;
}) {
  const { tools, tokens } = options;
  const visible = (role: string) => tools.filter((t) => !t.role || t.role === role);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Browsers always send Origin; bots don't. Refusing it blocks DNS-rebinding pages.
    if (req.headers.origin) return send(res, 403, { error: "Browser requests are not allowed" });
    if (req.method !== "POST") return send(res, 405, { error: "Use POST" }, { allow: "POST" });
    const role = findRole(req.headers.authorization, tokens);
    if (!role)
      return send(
        res,
        401,
        { error: "Missing or wrong bearer token" },
        { "www-authenticate": "Bearer" },
      );
    const version = req.headers["mcp-protocol-version"];
    if (typeof version === "string" && !PROTOCOL_VERSIONS.includes(version))
      return send(
        res,
        400,
        rpcError(null, -32600, `Unsupported MCP-Protocol-Version "${version}"`),
      );

    const raw = await readBody(req);
    if (raw === null) return send(res, 413, rpcError(null, -32600, "Body too large"));
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return send(res, 400, rpcError(null, -32700, "Parse error"));
    }
    const invalid = () => send(res, 400, rpcError(null, -32600, "Invalid request"));
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0")
      return invalid();
    const validId =
      typeof msg.id === "string" || (typeof msg.id === "number" && Number.isInteger(msg.id));
    if (msg.method === undefined) {
      // A response to a server request; this server sends none, so just acknowledge it.
      return validId && ("result" in msg || "error" in msg) ? send(res, 202) : invalid();
    }
    if (typeof msg.method !== "string") return invalid();
    if (msg.id === undefined) return send(res, 202); // a notification
    if (!validId) return invalid();
    const reply = (result: unknown) => send(res, 200, { jsonrpc: "2.0", id: msg.id, result });

    switch (msg.method) {
      case "initialize": {
        const asked = String(msg.params?.protocolVersion ?? "");
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "opencharts", version: options.version },
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: visible(role).map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const tool = visible(role).find((t) => t.name === name);
        if (!tool) return send(res, 200, rpcError(msg.id, -32602, `Unknown tool "${name}"`));
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const result = await tool.run(typeof args === "object" && args ? args : {});
          return reply({
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: { result },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return reply({ content: [{ type: "text", text: message }], isError: true });
        }
      }
      default:
        return send(res, 200, rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
    }
  };
}
