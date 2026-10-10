#!/usr/bin/env node
/**
 * 极简静态服务器：把 preview/ 挂到 127.0.0.1:<port>，给手机浏览器看外观预览。
 *
 * 只服务 preview/ 目录下的文件，不做目录列举、不跟随到上级目录。
 * 用法：node preview/serve.mjs [port=3017]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 3017);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
  if (relative.includes("..")) {
    response.writeHead(403).end("forbidden");
    return;
  }
  const file = join(HERE, relative === "" ? "index.html" : relative);
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("404 只有 preview/ 目录下的文件：/、/index.html");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`dsh-thinking-slider preview → http://127.0.0.1:${port}/`);
});
