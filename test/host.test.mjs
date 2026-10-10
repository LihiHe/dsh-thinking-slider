/**
 * 宿主半边单测：诊断路由的注册与落盘。
 *
 * 这里只覆盖 lib/index.js 那唯一一件事 —— 注册 `POST /dsh-thinking-slider/diag`
 * 并把收到的 JSON 行追加到 `$DSH_HOME/thinking-slider-diag.log`。控件本体在
 * client.test.mjs 里。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAG_PATH, MAX_BODY_BYTES, apply, diagFile, name, readBody } from "../lib/index.js";

/**
 * 轮询读诊断日志直到 predicate 满意。
 *
 * 宿主启动标记是 void appendFile(...)（fire-and-forget，apply() 不 await），
 * 和路由里那两条 await 过的日志写的是同一个文件 —— 读到「3 行」时**不保证**
 * 标记已经落盘，直接断言顺序会偶发失败（实测约 1/3 概率）。这里最多等 500ms，
 * 超时就把现状交回断言，照旧报错而不是把问题吞掉。
 */
async function waitForLog(file, predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await readFile(file, "utf8").catch(() => "");
    const lines = text.trim() === "" ? [] : text.trim().split("\n");
    if (predicate(lines) || Date.now() > deadline) return lines;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 造一个假的 webServer 服务，接住 register 的参数。 */
function fakeWebServer() {
  const routes = [];
  return {
    routes,
    register(options) {
      routes.push(options);
      return () => {};
    },
  };
}

/** 造一个假 ctx（cordis 风格：get / webServer / effect）。 */
function fakeContext(webServer) {
  const effects = [];
  return {
    effects,
    webServer,
    get(service) {
      return service === "webServer" ? webServer : undefined;
    },
    effect(fn, label) {
      effects.push({ label });
      return fn();
    },
  };
}

/** 造一个最小 node 请求对象（只用到 method、headers 与异步迭代）。 */
function fakeRequest(method, body, headers = {}) {
  const chunks = [Buffer.from(body ?? "")];
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** 造一个最小 node 应答对象，记录状态码 / 头 / 正文。 */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(text) {
      this.body = text ?? "";
    },
  };
}

test("宿主: 注册精确路由 DIAG_PATH，并要求 POST", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-ts-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    assert.equal(name, "dsh-thinking-slider");
    assert.equal(DIAG_PATH, "/dsh-thinking-slider/diag");

    const webServer = fakeWebServer();
    const ctx = fakeContext(webServer);
    apply(ctx);

    assert.equal(webServer.routes.length, 1, "应当注册且只注册一条路由");
    assert.deepEqual(
      { kind: webServer.routes[0].kind, path: webServer.routes[0].path },
      { kind: "exact", path: DIAG_PATH },
    );
    assert.equal(typeof webServer.routes[0].handler, "function");

    // 跨站 POST → 403，不写日志。
    const crossSite = fakeResponse();
    await webServer.routes[0].handler(
      fakeRequest("POST", JSON.stringify({ event: "evil" }), { "sec-fetch-site": "cross-site" }),
      crossSite,
    );
    assert.equal(crossSite.statusCode, 403);

    // GET → 405，不写日志。
    const rejected = fakeResponse();
    await webServer.routes[0].handler(fakeRequest("GET"), rejected);
    assert.equal(rejected.statusCode, 405);
    assert.equal(JSON.parse(rejected.body).ok, false);

    // POST → 200，并逐行追加。
    const first = fakeResponse();
    await webServer.routes[0].handler(
      fakeRequest("POST", JSON.stringify({ event: "apply", seq: 1 })),
      first,
    );
    assert.equal(first.statusCode, 200);
    assert.equal(JSON.parse(first.body).ok, true);

    const second = fakeResponse();
    await webServer.routes[0].handler(
      fakeRequest("POST", JSON.stringify({ event: "seat-render", seq: 2, sessionId: "s1" })),
      second,
    );

    const lines = await waitForLog(
      join(home, "thinking-slider-diag.log"),
      (rows) => rows.length === 3 && /"event":"host-apply"/.test(rows[0]),
    );
    assert.equal(lines.length, 3, "启动标记 + 两条诊断各占一行");
    assert.match(lines[0], /"event":"host-apply"/, "第一条是宿主启动标记");
    assert.match(lines[1], /"event":"apply"/);
    assert.match(lines[2], /"sessionId":"s1"/);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T/, "每行以 ISO 时间戳开头");

    assert.equal(diagFile(), join(home, "thinking-slider-diag.log"));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("宿主: 没有 webServer 服务时安静退出，不抛错", () => {
  const ctx = fakeContext(undefined);
  assert.doesNotThrow(() => apply(ctx));
  assert.equal(ctx.effects.length, 0);
});

test("宿主: readBody 超过上限就截断", async () => {
  const text = await readBody(fakeRequest("POST", "x".repeat(MAX_BODY_BYTES + 100)));
  assert.ok(text.length > 0);
  assert.ok(text.length <= MAX_BODY_BYTES + 1, `应截断到 ${String(MAX_BODY_BYTES)} 附近，实际 ${String(text.length)}`);
});
