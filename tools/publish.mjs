#!/usr/bin/env node
/**
 * 原子发布：真源 → DSH 安装副本。
 *
 * 为什么必须是「原子」的：DSH 的 client-hmr 每 500ms 给每个 client bundle 做一次
 * `stat`（mtime/ctime/size），一变就让浏览器重新拉这个文件重建模块。如果发布是
 * 「就地写」——`cp` 覆盖到一半正被读到——浏览器拿到的就是半截 JS（语法错误），
 * 这个入口立刻变成 failed；而**前端 boot 只要有一个入口非 active 就整体抛错**，
 * 界面直接停在「Failed to load plugins」。所以这里一律「写临时文件 → rename()」：
 * 同一目录内 rename 是原子的，读的人只会看到旧版或新版，永远看不到半截。
 *
 * 用法：
 *   node tools/publish.mjs                 # 跑测试 → 重建预览 → 原子覆盖 → 复核
 *   node tools/publish.mjs --skip-tests    # 急着发布时跳过测试（不推荐）
 *   DSH_THINKING_SLIDER_TARGET=/path node tools/publish.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET =
  process.env.DSH_THINKING_SLIDER_TARGET ??
  "/data/user/0/app.dsh.mobile/files/dsh-home/harness/plugins/dsh-thinking-slider";

const FILES = [
  "package.json",
  "cordis.patch.yml",
  "README.md",
  "lib/index.js",
  "lib/client.js",
  "test/helpers.mjs",
  "test/client.test.mjs",
  "test/host.test.mjs",
  "preview/build-preview.mjs",
  "preview/serve.mjs",
  "preview/index.html",
];

const skipTests = process.argv.includes("--skip-tests");

/** 跑一步子命令；失败就带着尾部输出退出（不要发布没通过测试的东西）。 */
function run(label, script) {
  process.stdout.write(`\n── ${label}\n`);
  try {
    const out = execFileSync(process.execPath, script, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const tail = out.trim().split("\n").slice(-3).join("\n");
    if (tail.length > 0) process.stdout.write(`${tail}\n`);
  } catch (error) {
    const details = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
    process.stderr.write(`发布中止：${label} 失败\n${details}\n`);
    process.exit(1);
  }
}

if (!skipTests) {
  run("跑单测（不通过就不发布）", ["--test", "test/helpers.mjs", "test/client.test.mjs", "test/host.test.mjs"]);
  run("重建静态预览（外观证据跟着版本走）", ["preview/build-preview.mjs"]);
}

/** 原子替换一个文件：同目录写临时文件 → rename。 */
async function atomicCopy(relativePath, nonce) {
  const from = join(ROOT, relativePath);
  const to = join(TARGET, relativePath);
  const temporary = `${to}.dsh-tmp-${nonce}`;
  await mkdir(dirname(to), { recursive: true });
  const source = await readFile(from);
  await writeFile(temporary, source);
  await rename(temporary, to);
  return source.length;
}

/** 复核：逐字节比对真源与安装副本。 */
async function verify(relativePath) {
  const [a, b] = await Promise.all([readFile(join(ROOT, relativePath)), readFile(join(TARGET, relativePath))]);
  return Buffer.compare(a, b) === 0;
}

const nonce = `${process.pid}-${Date.now().toString(36)}`;
process.stdout.write(`\n── 原子发布 ${ROOT} → ${TARGET}\n`);
const published = [];
for (const file of FILES) {
  const bytes = await atomicCopy(file, nonce);
  published.push({ file, bytes });
}

let failures = 0;
for (const { file } of published) {
  const same = await verify(file);
  if (!same) {
    failures += 1;
    process.stderr.write(`✖ 不一致：${file}\n`);
  }
}

process.stdout.write(`\n${failures === 0 ? "✔" : "✖"} 发布 ${published.length} 个文件，复核 ${failures === 0 ? "全部一致" : `${failures} 个不一致`}\n`);
for (const { file, bytes } of published) process.stdout.write(`  ${file}  ${bytes}B\n`);
process.exit(failures === 0 ? 0 : 1);
