/**
 * dsh-thinking-slider —— 宿主半边。
 *
 * 功能本体是**纯客户端控件**：
 *
 *   - 推理等级目录来自官方服务 `modelDirectories`（`@deepseek-ai/dsh-client-ui-model-selection`
 *     注册的客户端服务），浏览器半边直接取用；
 *   - 提交改动走官方 `sessions.selectModel({ sessionId, provider, model, reasoningEffort })`，
 *     和官方模型菜单的「推理等级」是**同一条写入路径**（同一份 Host 投影、同一套
 *     pending / 竞态 / 错误语义），所以宿主侧不需要任何会话状态或持久化。
 *
 * 之所以仍然提供宿主半边：`dsh.client` 双面包里，浏览器半边必须属于一个已经被
 * Loader 装载的 profile 条目；插件在 `dsh.profile.bundles` 里有一行、这一行能
 * `import` 成功，`./client` 才会被 web app 组合进 `__DSH_BOOT__`。
 *
 * 宿主半边只做一件与功能无关的事：**诊断路由** `POST /dsh-thinking-slider/diag`。
 * 手机上的 WebView 没有 devtools，控件「什么都没渲染」时无法取证；浏览器半边把
 * apply / 注册 / 目录就绪 / 渲染异常等事件 POST 到这里，逐行追加到
 * `$DSH_HOME/thinking-slider-diag.log`，宿主侧就能读到浏览器的真实状态。
 * 这条通道只是排障用的旁路，删掉它不影响控件本身。
 *
 * @module dsh-thinking-slider
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

/** Cordis 插件名。 */
export const name = "dsh-thinking-slider";

/** 需要 webServer 服务（诊断路由）。 */
export const inject = ["webServer"];

/** 诊断路由路径（与浏览器半边 `DIAG_ROUTE` 一致）。 */
export const DIAG_PATH = "/dsh-thinking-slider/diag";

/** 请求体上限。 */
export const MAX_BODY_BYTES = 16 * 1024;

/** JSON 应答头。 */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/**
 * 诊断日志文件（`$DSH_HOME/thinking-slider-diag.log`）。
 * @returns {string} 绝对路径。
 */
export function diagFile() {
  const home = process.env.DSH_HOME ?? process.env.HOME ?? ".";
  return join(home, "thinking-slider-diag.log");
}

/**
 * 读出请求体（超限即截断，诊断用不在乎完整性）。
 * @param {object} req - node 请求对象。
 * @returns {Promise<string>} 文本。
 */
export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) break;
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, MAX_BODY_BYTES);
}

/**
 * 插件体：注册诊断路由。
 * @param {object} ctx - 宿主插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  const webServer = ctx.get("webServer") ?? ctx.webServer;
  if (webServer === undefined || webServer === null || typeof webServer.register !== "function") {
    // 没有 webServer（例如非 web 形态）：控件本身照常工作，只是没有诊断日志。
    return;
  }
  const file = diagFile();
  // 启动标记：宿主半边被激活就一定留下这一行，用来区分「宿主没起来」和
  // 「宿主起来了但浏览器半边没回报」。落盘失败无所谓。
  void appendFile(file, `${new Date().toISOString()} {"event":"host-apply","plugin":"dsh-thinking-slider"}\n`).catch(
    () => {},
  );
  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: DIAG_PATH,
        handler: async (req, res) => {
          const fail = (status, message) => {
            res.statusCode = status;
            res.setHeader("content-type", JSON_HEADERS["content-type"]);
            res.setHeader("cache-control", "no-store");
            res.end(JSON.stringify({ ok: false, message }));
          };
          if (req.method !== "POST") {
            fail(405, "POST only");
            return;
          }
          // 同源栅栏：跨站页面的 POST 不该往日志里塞东西。
          if (req.headers?.["sec-fetch-site"] === "cross-site") {
            fail(403, "forbidden");
            return;
          }
          const text = await readBody(req);
          try {
            await appendFile(file, `${new Date().toISOString()} ${text}\n`);
          } catch {
            /* 写不进去也要回 200：诊断失败不能反过来影响浏览器 */
          }
          res.statusCode = 200;
          res.setHeader("content-type", JSON_HEADERS["content-type"]);
          res.setHeader("cache-control", "no-store");
          res.end('{"ok":true}');
        },
      }),
    `dsh-thinking-slider: ${DIAG_PATH} route`,
  );
}
