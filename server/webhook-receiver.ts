import { createServer } from "node:http";
import { verifyWebhook } from "./webhooks.ts";

/**
 * `npm run webhook:receiver`: a test endpoint that checks each delivery's
 * signature and prints it. Point OPENCHARTS_WEBHOOK_URLS at
 * http://127.0.0.1:8788/ and use the same OPENCHARTS_WEBHOOK_SECRET.
 */

const secret = process.env.OPENCHARTS_WEBHOOK_SECRET ?? "";
if (secret.length < 32) {
  console.error("Set OPENCHARTS_WEBHOOK_SECRET (32+ characters), the same one the server uses.");
  process.exit(1);
}
const port = Number(process.env.WEBHOOK_PORT ?? 8788);

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const header = (name: string) => req.headers[name] as string | undefined;
    const valid = verifyWebhook(
      secret,
      header("x-opencharts-timestamp"),
      header("x-opencharts-signature"),
      body,
    );
    const delivery = header("x-opencharts-delivery") ?? "?";
    console.log(`${new Date().toISOString()} ${valid ? "VALID" : "BAD SIGNATURE"} ${delivery}`);
    if (valid) console.log(`  ${body}`);
    res.writeHead(valid ? 200 : 401).end();
  });
}).listen(port, "127.0.0.1", () => console.log(`Listening on http://127.0.0.1:${port}/`));
