#!/usr/bin/env node
/**
 * dsh-thinking-slider 的静态外观预览生成器。
 *
 * 为什么需要它：本机的 DSH Web GUI 跑在手机 WebView 里，没有 devtools；插件的
 * 卡片是挂在 `document.body` 上的 portal，只能点开才出现，而全屏截图 / scr 都
 * 没法「点开再截」。所以这里把**组件真实渲染出的元素树**序列化成一份离线页面：
 *
 *   - DOM 标签、行内样式、class、aria 属性全部来自 `renderComponent` 的那棵树，
 *     不是照抄一遍的 HTML —— 组件改了，预览跟着改，不存在「预览和实际不一样」；
 *   - 滑轨 CSS 是插件注入页面的那个字符串（`RANGE_CSS`）逐字复制；
 *   - 星尘位置走 `starStyleFor`（确定性哈希），比例走 `ratioOf`，最高档判定走
 *     `railBoostOf` + `railVarsFor`，都是同一份函数。
 *
 * 唯一「模拟」的部分：官方 `MenuSurface` 提供的材质外壳（半透明底 + 模糊 +
 * 圆角）。测试替身把 MenuSurface 渲染成一个普通 div，所以这里用一条等价 CSS
 * 把材质补回去（`[data-primitive="MenuSurface"]`）。
 *
 * 用法：node preview/build-preview.mjs [输出路径]
 *       默认写 preview/index.html。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boot, renderComponent } from "../test/helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const outputPath = process.argv[2] === undefined ? join(HERE, "index.html") : process.argv[2];

/* ------------------------------------------------------------------ *
 * 1. 演示目录：六档，档位名照素材写（轻度 / 中 / 高 / 极高 / 最高 / Ultra）
 * ------------------------------------------------------------------ */

const DEMO_MODEL = "deepseek-flash";
const DEMO_MODEL_NAME = "DeepSeek-V4.1-Flash";
const EFFORTS = [
  { id: "low", name: "轻度" },
  { id: "medium", name: "中" },
  { id: "high", name: "高" },
  { id: "xhigh", name: "极高" },
  { id: "max", name: "最高" },
  { id: "ultra", name: "Ultra" },
];

/**
 * 演示目录：六档 + 一份**真实形状**的多 provider 模型表。
 *
 * 模型清单直接吃这份快照（与官方模型菜单同源），所以预览里展开的清单就是
 * 真机上的那一份：两个 provider（其中一个失败）+ 一个不支持推理等级的模型。
 * @param {string} effort - 当前档位 id。
 * @returns {object} 目录快照。
 */
function demoSnapshot(effort) {
  return {
    current: { provider: "deepseek-account", model: DEMO_MODEL, reasoningEffort: effort },
    retainedEffort: effort,
    routable: true,
    groups: [
      {
        id: "deepseek-account",
        name: "DeepSeek",
        models: [
          { id: DEMO_MODEL, name: DEMO_MODEL_NAME, reasoning: { defaultEffort: "medium", efforts: EFFORTS } },
          {
            id: "deepseek-v41-pro",
            name: "DeepSeek-V4.1-Pro",
            reasoning: {
              defaultEffort: "high",
              efforts: [
                { id: "high", name: "高" },
                { id: "xhigh", name: "极高" },
                { id: "max", name: "最高" },
                { id: "ultra", name: "Ultra" },
              ],
            },
          },
          { id: "deepseek-v41", name: "DeepSeek-V4.1（无推理档位）" },
        ],
      },
      {
        id: "anthropic",
        name: "Anthropic",
        models: [
          {
            id: "claude-opus-4",
            name: "Opus 4",
            reasoning: {
              defaultEffort: "medium",
              efforts: [{ id: "low", name: "轻度" }, { id: "medium", name: "中" }, { id: "high", name: "高" }],
            },
          },
        ],
      },
    ],
    failures: [
      { id: "openai", name: "OpenAI", message: "登录已过期，请重新授权" },
      { id: "google", name: "Google", message: "无法连接" },
    ],
    status: "ready",
    pending: null,
    error: null,
  };
}

/* ------------------------------------------------------------------ *
 * 2. 元素树 → HTML
 * ------------------------------------------------------------------ */

const UNITLESS = new Set([
  "fontWeight",
  "lineHeight",
  "zIndex",
  "opacity",
  "flexShrink",
  "flexGrow",
  "flex",
  "order",
  "aspectRatio",
]);

/** 需要自闭合的标签（没有结束标签）。 */
const VOID_TAGS = new Set(["input", "br", "hr", "img", "path", "circle", "rect", "line", "polyline", "polygon", "use"]);

/** 已经是短横线写法的属性直接透传；这些是 React 里的例外（DOM 也这么拼）。 */
const KEEP_CASE = new Set(["viewBox", "preserveAspectRatio", "gradientTransform"]);

/** `{ "--x": "1px", fontSize: "13px", minWidth: 0 }` → `--x:1px;font-size:13px;min-width:0` */
function css(style) {
  return Object.entries(style ?? {})
    .map(([key, raw]) => {
      const name = key.startsWith("--") ? key : key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
      let value;
      if (typeof raw === "number") value = raw === 0 || UNITLESS.has(key) ? String(raw) : `${raw}px`;
      else value = String(raw);
      return `${name}:${value}`;
    })
    .join(";");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 官方图标包的替身（测试替身把 primitives 渲染成空 div，直接序列化会丢图标）。
 * 这里用包里的原始 SVG path 补回来（viewBox 0 0 16 16、stroke-width 1）。
 */
const PRIMITIVE_SVG = {
  IconThinkOutlineRegular: (size, styleAttr) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke-width="1"${styleAttr}>
  <path d="M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z" stroke="currentColor"/>
  <path d="M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z" stroke="currentColor"/>
  <path d="M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z" fill="currentColor"/>
</svg>`,
  IconChevronDownOutlineRegular: (size, styleAttr) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true"${styleAttr}><path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  IconChevronUpOutlineRegular: (size, styleAttr) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true"${styleAttr}><path d="M4 10L7.29289 6.70711C7.68342 6.31658 8.31658 6.31658 8.70711 6.70711L12 10" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  IconLoadingOutlineRegular: (size, styleAttr) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true"${styleAttr}><path d="M8 1.5V4M8 12V14.5M1.5 8H4M12 8H14.5M3.4 3.4L5.2 5.2M10.8 10.8L12.6 12.6M12.6 3.4L10.8 5.2M5.2 10.8L3.4 12.6" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>`,
};

/** React props → HTML 属性串（丢掉事件处理函数与 ref / key）。 */
function attrsOf(props) {
  const out = [];
  for (const [key, raw] of Object.entries(props ?? {})) {
    if (key === "children" || key === "ref" || key === "key" || typeof raw === "function") continue;
    const name = key === "className" ? "class" : KEEP_CASE.has(key) || key.includes("-") ? key : key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    // aria-* 在真 DOM 里是**字符串**：React 会把 true/false 写成 aria-selected="true"/"false"。
    // 这里不能按布尔属性处理（写成 aria-selected=""），否则预览里「选中项」
    // 「清单已展开」这些状态样式（CSS 全靠 [aria-*="true"] 选）一个都看不出差别。
    if (key.startsWith("aria-")) {
      if (raw === undefined || raw === null) continue;
      out.push(` ${name}="${escapeHtml(String(raw))}"`);
      continue;
    }
    if (raw === undefined || raw === null || raw === false) continue;
    if (key === "style") {
      const text = css(raw);
      if (text !== "") out.push(` style="${text}"`);
      continue;
    }
    if (raw === true) {
      out.push(` ${name}=""`);
      continue;
    }
    out.push(` ${name}="${escapeHtml(String(raw))}"`);
  }
  return out.join("");
}

function childrenHtml(node) {
  return node.children.map((child) => toHtml(child)).join("");
}

/** 元素树 → HTML。Fragment 与 portal 都是透明容器，函数组件已被 replace 掉。 */
function toHtml(node) {
  if (node === null || node === undefined || node === false) return "";
  if (Array.isArray(node)) return node.map((child) => toHtml(child)).join("");
  if (typeof node === "string") return escapeHtml(node);
  if (typeof node === "number") return String(node);
  if (typeof node !== "object" || node.$$dshElement !== true) return "";
  const type = node.type;
  if (typeof type !== "string") return childrenHtml(node); // Fragment / portal / 未展开的组件
  const primitive = node.props?.["data-primitive"];
  if (typeof primitive === "string" && Object.hasOwn(PRIMITIVE_SVG, primitive)) {
    const size = typeof node.props.size === "number" ? node.props.size : 16;
    const style = typeof node.props.style === "object" && node.props.style !== null ? css(node.props.style) : "";
    return PRIMITIVE_SVG[primitive](size, style === "" ? "" : ` style="${style}"`);
  }
  const attrs = attrsOf(node.props);
  if (VOID_TAGS.has(type)) return `<${type}${attrs}>`;
  return `<${type}${attrs}>${childrenHtml(node)}</${type}>`;
}

/** 在树里找第一个满足条件的元素，取不到就抛（预览缺一块时应该立刻失败，别静默出半张图）。 */
function mustFind(frame, predicate, what) {
  const found = frame.find(predicate);
  if (found === null || found === undefined) throw new Error(`preview: 没找到${what}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * 3. 每个档位渲染一个场景：真实组件树 → HTML
 * ------------------------------------------------------------------ */

/** 点开卡片：先渲染一帧拿触发按钮，触发 onClick，再渲染「已展开」的那一帧。 */
function openFrame(snapshot) {
  const runtime = boot({ snapshot });
  let frame = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  const trigger = mustFind(frame, (element) => element.props["aria-haspopup"] === "dialog", "触发按钮");
  frame.fire(trigger, "onClick");
  frame = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  return { runtime, frame };
}

function sceneOf(effort) {
  const snapshot = demoSnapshot(effort);
  const { runtime, frame } = openFrame(snapshot);
  const I = runtime.internals;
  const view = I.resolveLevels(snapshot);
  const stops = I.buildStops(view);
  const card = mustFind(
    frame,
    (element) => element.props.role === "group" && element.props["data-primitive"] === "MenuSurface",
    "卡片（MenuSurface）",
  );
  const trigger = mustFind(frame, (element) => element.props["aria-haspopup"] === "dialog", "触发按钮");
  return {
    effort,
    runtime,
    internals: I,
    stops,
    current: stops.find((stop) => I.effortOf(stop) === effort) ?? stops[0],
    cardHtml: toHtml(card),
    triggerHtml: toHtml(trigger),
    names: stops.map((stop) => stop.name),
    efforts: stops.map((stop) => I.effortOf(stop) ?? ""),
  };
}

const SCENES = EFFORTS.map((effort) => sceneOf(effort.id));
const I = SCENES[0].internals;

/** 每个场景的标题与说明。 */
const NOTES = [
  { title: "① 轻度（最低档）", note: "圆钮在最左，六颗刻度点全是灰的；填充起点就是 0 —— 圆钮靠 CSS 的 `calc` 端点内缩压在轨道上。" },
  { title: "② 中", note: "已填充段是素材那颗饱和蓝，被填充盖住的那颗刻度点自动变浅蓝（`clip-path` 裁一层亮点）。" },
  { title: "③ 高", note: "档位由四舍五入决定：连续位置落在这一格就是「高」。" },
  { title: "④ 极高", note: "最高三档之一，但只有 Ultra 走「更快」的流动。" },
  { title: "⑤ 最高", note: "整条轨道换成蓝→靛→洋紫渐变并在 6s 内往复流动，轨道上漂白色星尘（12 颗）。" },
  { title: "⑥ Ultra", note: "渐变相位不同（素材里两行 Ultra 就是这条动画的两帧），星尘 22 颗、横穿更快；闪电与等级名一起转紫。" },
];

/** 星尘样式表：两种档位各一份，页面脚本换档时按这份重建星图。 */
const STAR_STYLES = {
  true: Array.from({ length: I.STAR_COUNT.true }, (_unused, at) => I.starStyleFor(at, "true")),
  fast: Array.from({ length: I.STAR_COUNT.fast }, (_unused, at) => I.starStyleFor(at, "fast")),
};

/** 场景元数据：给页面脚本用（档位名、effort、最高档集合、步进）。 */
const SCENE_DATA = SCENES.map((scene) => ({
  names: scene.names,
  efforts: scene.efforts,
  boostEfforts: I.BOOST_EFFORTS,
  step: I.DRAG_STEP,
}));

const scenesHtml = SCENES.map(
  (scene, at) => `<section class="pv-scene">
  <h3 class="pv-scene-title">${escapeHtml(NOTES[at].title)}</h3>
  <p class="pv-scene-note">${NOTES[at].note}</p>
  <div class="pv-composer" data-scene="${String(at)}">
    <div class="pv-cardwrap">${scene.cardHtml}</div>
    <div class="pv-input">
      <span class="pv-input-placeholder">给智能体发消息</span>
      ${scene.triggerHtml}
    </div>
  </div>
</section>`,
).join("\n");

/* ------------------------------------------------------------------ *
 * 3b. 额外一张：模型清单展开（选模型并进滑条之后的交互）
 * ------------------------------------------------------------------ */

/**
 * 第 ③ 档（高）+ 展开模型清单的那一帧。
 *
 * 页面脚本按 `data-scene` 取档位数据，所以这一张沿用第 ③ 档的下标，
 * 拖动演示照样能跑（清单只是叠在滑条上方的一层）。
 * @returns {{cardHtml:string, triggerHtml:string, choices:number}} 片段与行数。
 */
function modelSceneOf() {
  const { runtime, frame } = openFrame(demoSnapshot("high"));
  const row = mustFind(frame, (element) => element.props.className === "dsh-thinking-slider-model-row", "模型行");
  frame.fire(row, "onClick");
  const opened = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  return {
    cardHtml: toHtml(mustFind(
      opened,
      (element) => element.props.role === "group" && element.props["data-primitive"] === "MenuSurface",
      "卡片（MenuSurface）",
    )),
    triggerHtml: toHtml(mustFind(opened, (element) => element.props["aria-haspopup"] === "dialog", "触发按钮")),
    choices: runtime.internals.modelChoicesOf(demoSnapshot("high")).length,
  };
}

const MODEL_SCENE = modelSceneOf();
const modelSceneHtml = `<section class="pv-scene">
  <h3 class="pv-scene-title">⑦ 选模型（清单展开）</h3>
  <p class="pv-scene-note">卡头里那行模型名本身就是按钮：点开就是官方模型菜单的同一份数据（${String(MODEL_SCENE.choices)} 行 —— 两个 provider + 两个加载失败）。多项时插分组标题，当前项打勾，失败行不可选、hover 显示原因。<strong>点这一张里的模型行</strong>就能看到「图二（收起）⇄ 图一（展开）」的高度过渡。真机上卡片被锚在输入框上方（官方 <code>useAnchoredPosition</code> 对面板挂了 ResizeObserver，高度一变就重算 <code>top</code>），所以过渡时是<strong>底边不动、顶边往上长</strong>；预览页里卡片在普通文档流里，是顶边不动、往下长 —— 高度过渡本身完全一样。</p>
  <div class="pv-composer" data-scene="2">
    <div class="pv-cardwrap">${MODEL_SCENE.cardHtml}</div>
    <div class="pv-input">
      <span class="pv-input-placeholder">给智能体发消息</span>
      ${MODEL_SCENE.triggerHtml}
    </div>
  </div>
</section>`;

/* ------------------------------------------------------------------ *
 * 4. 事实表
 * ------------------------------------------------------------------ */

const facts = [
  ["轨道", `高 ${I.RAIL_HEIGHT}px 满圆角；圆钮 ${I.KNOB_SIZE}px > 轨道，所以上下各溢出 —— 素材就是这么画的（49 > 38）`],
  ["端点内缩", `${I.RAIL_EDGE}px = 圆钮半径，刻度点因此正好压在原生 range 的圆钮行程上`],
  ["已填充段", `\`${I.TRACK_FILL}\`（素材实测 rgb(48,120,240)）`],
  ["未填充段", `\`${I.TRACK_REST}\``],
  ["刻度点", `每档一颗、直径 ${I.DOT_SIZE}px；未到达是中性灰，被填充盖住那颗是「品牌蓝 + 白」——两层叠着用 \`clip-path\` 裁`],
  ["圆钮", `${I.KNOB_SIZE}px 白色实心 + 双层投影，hover 放大 1.06、按住 1.16 并带 7px 光晕`],
  ["步进", `\`step: ${I.DRAG_STEP}\` —— **连续**跟手，档位由四舍五入决定（不是一格格跳）`],
  ["拖动中", `只写 \`--dsh-ts-ratio\` 这一个 CSS 变量到滑轨外层，不进 React state；一次拖动只在跨档时重渲染`],
  ["比例过渡", "`transition: --dsh-ts-ratio 320ms cubic-bezier(0.34,1.28,0.64,1)`；拖动中临时 `transition: none`"],
  ["松手", "**吸附到最近的档位**（`Math.round`，正好在中点时朝强度更高一侧）：草稿值从连续落点换成档位下标，由上面那条 320ms 回弹过渡滑到档位中心 —— 拖动中不吸附（否则一格格跳），只在松手这一刻吸"],
  ["清单开合", "卡头模型行点开 ⇄ 收起：外层 reveal 走 grid-template-rows 的 0fr ↔ 1fr（300ms），卡片高度跟着一起长/缩；内层 clip 裁切，清单本体 opacity + translateY(-6px) 淡入下移。清单常驻 DOM —— 收起时若节点直接消失，内容会先在 1 帧内没了、空出来的高度再慢慢收，像被「抽走」；收起态靠 aria-hidden + 每行 tabIndex -1 挡住读屏与 Tab"],
  ["换档动效", "档位名重挂 → `dsh-ts-level-in` 200ms 淡入 + 上浮 3px；卡片进场 `dsh-ts-card-in` 180ms"],
  ["渐变进出", "非最高档 `opacity: 0` → 最高档 `opacity: 1`，280ms 淡入淡出（不是硬闪）"],
  ["最高档判定", `effort ∈ ${JSON.stringify(I.BOOST_EFFORTS)}（Ultra 额外拿 \`data-boost="fast"\`）`],
  ["最高档渐变", `\`${I.BOOST_GRADIENT}\` + \`background-size: 220% 100%\` + \`dsh-ts-effort-flow\` 6s（Ultra 4s）往复`],
  ["星尘", `确定性哈希布点（\`starStyleFor\`，不用 Math.random），两份星图整体左移 50% 无缝循环；最高档 ${I.STAR_COUNT.true} 颗、Ultra ${I.STAR_COUNT.fast} 颗`],
  ["降级", "`@media (prefers-reduced-motion: reduce)` 关掉流动、星尘闪烁与所有过渡"],
  ["禁用态", "`.dsh-thinking-slider-rail:has(range:disabled) { opacity: .55 }`"],
  ["接管官方座位", `官方 \`conversation.input.model\` 是 **single** 插槽（\`dsh-client-ui-slots/lib/index.js:172\` 直接抛「already has a registration」）—— 抢不过来，只能在运行时给它的 DOM 打 \`${I.NATIVE_SEAT_ATTR}="hidden"\` + CSS \`display:none\`。判据是「这一排里最后一个带 \`aria-haspopup="menu"\` 的兄弟节点」，切会话重挂 DOM 时由 \`MutationObserver\` 重打标记，官方把它锁住（\`disabled\`）时不接管。`],
  ["模型清单", "卡头里那行模型名就是按钮：`modelChoicesOf(snapshot)` 把官方 `groups` / `failures` 铺平（与官方 `optionsOf` 同源、顺序一致），点击即 `directory.select({provider, model, reasoningEffort?})`"],
  ["换模型带档位", "`transferEffort`：目标模型声明了同 id 档位就保留（官方 `selectionOf` 是一律回新模型的 `defaultEffort`，这里**有意不同** —— 换 provider 时「高」还是「高」）；没声明就省略该字段，等于用目标模型的默认档"],
  ["触发 chip", "`模型名 · 档位`；模型不支持推理等级时只剩模型名 —— 这时它就是一个**纯模型选择器**（所以它不能再像以前那样整段不渲染）"],
];

/* ------------------------------------------------------------------ *
 * 5. 页面
 * ------------------------------------------------------------------ */

const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>dsh-thinking-slider · 素材化预览</title>
<style>
/* ---- DSH 主题令牌：取自 @deepseek-ai/dsh-client-ui-theme 的真实取值 ---- */
:root, [data-theme="light"] {
  --dsw-alias-bg-base: #fff;
  --dsw-alias-bg-layer-1: #fff;
  --dsw-alias-bg-layer-2: #fff;
  --dsw-alias-label-primary: #0f1115;
  --dsw-alias-label-secondary: #cfd3d6;
  --dsw-alias-label-tertiary: #adb2b8;
  --dsw-alias-label-caption: #adb2b8;
  --dsw-alias-label-dimmed: #e1e5ee;
  --dsw-alias-border-l2: #0000001a;
  --dsw-alias-interactive-bg-hover: #2631480f;
  --dsw-alias-interactive-bg-active: #2631481a;
  --dsw-alias-state-business-primary: #3078f0;
  --dsw-alias-state-error-primary: #ec1313;
  --dsw-menu-surface-fill: #f8f9fa94;
  --dsw-menu-backdrop-filter: blur(40px) saturate(150%);
  --dsw-radius-lg: 16px;
  --dsw-radius-md: 12px;
  --pv-page-bg: #f2f4f7;
  --pv-card-bg: #fff;
  --pv-composer-bg: #fff;
  --pv-composer-border: #00000014;
  --pv-note: #666a70;
}
[data-theme="dark"] {
  --dsw-alias-bg-base: #151517;
  --dsw-alias-bg-layer-1: #232324;
  --dsw-alias-bg-layer-2: #2c2c2e;
  --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-secondary: #61666b;
  --dsw-alias-label-tertiary: #81858c;
  --dsw-alias-label-caption: #81858c;
  --dsw-alias-label-dimmed: #43454a;
  --dsw-alias-border-l2: #ffffff1f;
  --dsw-alias-interactive-bg-hover: #ffffff14;
  --dsw-alias-interactive-bg-active: #ffffff24;
  --dsw-alias-state-business-primary: #3b82f6;
  --dsw-alias-state-error-primary: #f25a5a;
  --dsw-menu-surface-fill: #43454a73;
  --pv-page-bg: #000;
  --pv-card-bg: #222;
  --pv-composer-bg: #16171a;
  --pv-composer-border: #ffffff1f;
  --pv-note: #9aa0a6;
}

/* ---- 插件真实注入的 CSS，逐字复制（RANGE_CSS） ---- */
${I.RANGE_CSS.trim()}

/* ---- 预览页自己的排版糖，不属于插件 ---- */
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 16px 14px 40px;
  background: var(--pv-page-bg);
  color: var(--dsw-alias-label-primary);
  font: 15px/1.5 -apple-system, "PingFang SC", "Source Han Sans SC", system-ui, sans-serif;
}
.pv-head { max-width: 1180px; margin: 0 auto 18px; }
.pv-head h1 { margin: 0 0 6px; font-size: 20px; }
.pv-head p { margin: 0 0 6px; font-size: 13px; color: var(--pv-note); }
.pv-head code { font-size: 12px; }
.pv-switch { display: flex; gap: 8px; margin: 12px 0 4px; }
.pv-switch button {
  padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--pv-composer-bg);
  border: 1px solid var(--pv-composer-border); border-radius: 8px;
}
.pv-switch button[aria-pressed="true"] { border-color: var(--dsw-alias-state-business-primary); }
.pv-grid { max-width: 1180px; margin: 0 auto; display: grid; gap: 22px; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
.pv-scene-title { margin: 0 0 2px; font-size: 14px; }
.pv-scene-note { margin: 0 0 10px; font-size: 12px; line-height: 1.45; color: var(--pv-note); min-height: 34px; }
.pv-composer { position: relative; }
.pv-input {
  display: flex; align-items: center; gap: 8px; justify-content: flex-end;
  min-height: 46px; padding: 6px 8px 6px 14px;
  background: var(--pv-composer-bg);
  border: 1px solid var(--pv-composer-border);
  border-radius: var(--dsw-radius-lg);
}
.pv-input-placeholder { margin-right: auto; font-size: 14px; color: var(--dsw-alias-label-tertiary); }
.pv-cardwrap { margin-bottom: 8px; }
/* 官方 MenuSurface 的材质等价物（测试替身渲染成普通 div，这里把材质补回去）。 */
[data-primitive="MenuSurface"] {
  background: var(--dsw-menu-surface-fill);
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  border-radius: var(--dsw-radius-lg);
  overflow: hidden;
}
/* 素材里的卡片是纯深灰底；深色主题下用 --pv-card-bg 压掉材质半透明，方便对照素材。 */
[data-theme="dark"] [data-primitive="MenuSurface"] { background: var(--pv-card-bg); backdrop-filter: none; -webkit-backdrop-filter: none; }
.pv-facts { max-width: 1180px; margin: 26px auto 0; font-size: 13px; }
.pv-facts table { width: 100%; border-collapse: collapse; }
.pv-facts th, .pv-facts td { padding: 5px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--pv-composer-border); }
.pv-facts th { width: 116px; font-weight: 500; color: var(--pv-note); }
details { max-width: 1180px; margin: 18px auto 0; font-size: 12px; }
pre { overflow: auto; padding: 10px; background: var(--pv-composer-bg); border-radius: 12px; border: 1px solid var(--pv-composer-border); }
</style>
</head>
<body>
<header class="pv-head">
  <h1>dsh-thinking-slider · 素材化预览</h1>
  <p>每一处外观都来自插件**真实渲染出的元素树**（测试替身 React 渲染 → 序列化成 HTML），滑轨 CSS 是插件注入页面的那一份逐字复制；只有官方 <code>MenuSurface</code> 的材质外壳用了一条等价 CSS 还原。<strong>这不是运行时截图</strong>，是同一份代码的离线渲染，用来在没有 devtools 的 WebView 里核对视觉。</p>
  <p>真实位置：DSH Web GUI 输入框右侧 <code>conversation.input.right</code>（order 45）；官方那个 <code>DeepSeek-V4.1-Flash · High</code> 座位是 <strong>single</strong> 插槽抢不过来，所以插件在运行时给它打标记隐掉，把「选模型」并进这枚 chip 与它的卡片里 —— 下面是接管后的样子（官方座位已不在画面中）。</p>
  <p><strong>可以直接拖下面的滑轨</strong>：这一页内嵌了一段与被改组件 <code>onInput</code>/<code>onRelease</code> 等价的脚本 —— 拖动时蓝填充与圆钮跟手、跨档时档位名淡入、进最高档时渐变 280ms 淡入并流动、星尘按档位重建、松手吸附到最近的档位、点卡头那行模型名还能把模型清单展开 / 收起（高度 300ms 过渡）。</p>
  <div class="pv-switch" role="group" aria-label="主题">
    <button type="button" data-pv-theme="light" aria-pressed="false">浅色</button>
    <button type="button" data-pv-theme="dark" aria-pressed="true">深色（对照素材）</button>
  </div>
</header>

<div class="pv-grid">
${scenesHtml}
${modelSceneHtml}
</div>

<section class="pv-facts">
  <h3>关键数值</h3>
  <table>
    <tbody>
      ${facts.map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${value}</td></tr>`).join("\n      ")}
    </tbody>
  </table>
</section>

<details>
  <summary>插件注入的 RANGE_CSS（逐字，${I.RANGE_CSS.trim().split("\n").length} 行）</summary>
  <pre>${escapeHtml(I.RANGE_CSS.trim())}</pre>
</details>

<script type="application/json" id="pv-scenes">${JSON.stringify(SCENE_DATA)}</script>
<script type="application/json" id="pv-stars">${JSON.stringify(STAR_STYLES)}</script>
<script>
  const root = document.documentElement;
  const themeButtons = Array.from(document.querySelectorAll("[data-pv-theme]"));
  function applyTheme(theme) {
    root.dataset.theme = theme;
    for (const button of themeButtons) button.setAttribute("aria-pressed", String(button.dataset.pvTheme === theme));
  }
  for (const button of themeButtons) button.addEventListener("click", () => applyTheme(button.dataset.pvTheme));
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  applyTheme(media !== null && media.matches ? "dark" : "dark");

  /* ---- 拖动演示：与组件 onInput / onRelease 的等价实现 ------------------
   * 唯一目的是让人能**用手**核对「跟手 / 淡入 / 流动 / 星尘 / 落点」这五件事。
   * 逻辑抄自 lib/client.js：比例 = position / (档位数 - 1)，档位由 Math.round 决定，
   * 拖动中把滑轨外层那条 320ms 过渡临时压成 none（否则填充会去追手指）。 */
  const SCENES = JSON.parse(document.getElementById("pv-scenes").textContent);
  const STAR_STYLES = JSON.parse(document.getElementById("pv-stars").textContent);
  const STAR_VARS = ["--dsh-ts-star-scale", "--dsh-ts-star-delay", "--dsh-ts-star-period"];

  function buildStars(kind) {
    const wrap = document.createElement("div");
    wrap.className = "dsh-thinking-slider-stars";
    wrap.setAttribute("aria-hidden", "true");
    const field = document.createElement("div");
    field.className = "dsh-thinking-slider-starfield";
    for (const half of [0, 1]) {
      const box = document.createElement("div");
      box.className = "dsh-thinking-slider-star-half";
      for (const spec of STAR_STYLES[kind]) {
        const star = document.createElement("i");
        star.className = "dsh-thinking-slider-star";
        star.style.left = spec.left;
        star.style.top = spec.top;
        for (const name of STAR_VARS) star.style.setProperty(name, spec[name]);
        box.appendChild(star);
      }
      field.appendChild(box);
    }
    wrap.appendChild(field);
    return wrap;
  }

  for (const composer of document.querySelectorAll(".pv-composer")) {
    const data = SCENES[Number(composer.dataset.scene)];
    const input = composer.querySelector(".dsh-thinking-slider-range");
    const rail = composer.querySelector(".dsh-thinking-slider-rail");
    const card = composer.querySelector(".dsh-thinking-slider-card-inner");
    const label = composer.querySelector(".dsh-thinking-slider-level");
    const trigger = composer.querySelector(".dsh-thinking-slider-trigger");
    if (data === undefined || input === null || rail === null) continue;
    const BOOST = new Set(data.boostEfforts);
    const last = data.names.length - 1;
    const levelOf = (position) => Math.min(Math.max(Math.round(position), 0), last);
    let shown = levelOf(Number(input.value));

    /** 档位名（卡片内 + 触发按钮）+ 最高档配色，一次改到位。 */
    const paintLevel = (index) => {
      if (label !== null) {
        label.textContent = data.names[index];
        // 重挂 class 让 dsh-ts-level-in 重播（React 那边靠 key 重挂节点）。
        label.classList.remove("dsh-thinking-slider-level");
        void label.offsetWidth;
        label.classList.add("dsh-thinking-slider-level");
      }
      input.setAttribute("aria-valuetext", data.names[index]);
      // 触发按钮里有两段文字：模型名 + 档位名。档位名必须**按 class** 找 ——
      // 按「所有非空 span」扫会把模型名也写成档位名（这枚 chip 现在是「谁 + 多强」）。
      if (trigger !== null) {
        const triggerLevel = trigger.querySelector(".dsh-thinking-slider-trigger-level");
        if (triggerLevel !== null) triggerLevel.textContent = data.names[index];
      }
    };
    const paintBoost = (index) => {
      const effort = data.efforts[index];
      const kind = BOOST.has(effort) ? (effort === "ultra" ? "fast" : "true") : null;
      if (kind === null) delete rail.dataset.boost;
      else rail.dataset.boost = kind;
      const old = rail.querySelector(".dsh-thinking-slider-stars");
      if (old !== null) old.remove();
      if (kind !== null) rail.insertBefore(buildStars(kind), rail.querySelector(".dsh-thinking-slider-knob"));
    };
    const paint = (index) => {
      if (index === shown) return;
      shown = index;
      paintLevel(index);
      paintBoost(index);
    };

    paintBoost(shown);
    input.addEventListener("input", () => {
      const position = Number(input.value);
      rail.style.setProperty("transition", "none");
      rail.style.setProperty("--dsh-ts-ratio", String(last <= 0 ? 0 : Math.min(Math.max(position, 0), last) / last));
      paint(levelOf(position));
    });
    // 松手 / 键盘改档：先恢复 CSS 里的 320ms 过渡，**再**把落点吸附到最近的档位中心。
    // 顺序不能反：transition 还写着 none 的时候改比例 = 这次吸附会瞬移（组件里 onRelease 同序）。
    for (const type of ["pointerup", "pointercancel", "change", "blur"]) {
      input.addEventListener(type, () => {
        const level = levelOf(Number(input.value));
        input.value = String(level);
        rail.style.removeProperty("transition");
        rail.style.setProperty("--dsh-ts-ratio", String(last <= 0 ? 0 : level / last));
        paint(level);
      });
    }

    // 模型清单的开合演示：翻 reveal 的 data-open（样式在插件注入的 CSS 里），
    // 与组件 setModelsOpen 等价 —— 收起时清单只是被裁掉，顺手把 Tab 停靠点去掉。
    const modelRow = composer.querySelector(".dsh-thinking-slider-model-row");
    const reveal = composer.querySelector(".dsh-thinking-slider-models-reveal");
    if (modelRow !== null && reveal !== null) {
      modelRow.addEventListener("click", () => {
        const open = reveal.dataset.open !== "true";
        reveal.dataset.open = String(open);
        modelRow.setAttribute("aria-expanded", String(open));
        if (open) reveal.removeAttribute("aria-hidden");
        else reveal.setAttribute("aria-hidden", "true");
        for (const item of reveal.querySelectorAll("[role=option]")) {
          if (open) item.removeAttribute("tabindex");
          else item.setAttribute("tabindex", "-1");
        }
      });
    }
  }
</script>
</body>
</html>
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, html, "utf8");
console.log(`preview written: ${outputPath} (${html.length} bytes)`);
console.log(`档位: ${SCENES[0].stops.map((stop) => `${stop.name}=${I.effortOf(stop)}`).join(", ")}`);
console.log(`最高档: ${JSON.stringify(I.BOOST_EFFORTS)} → railBoostOf → data-boost（渐变由 RANGE_CSS 的 ::after 画）`);
console.log(`星尘: 常档 ${I.STAR_COUNT.true} 颗 / Ultra ${I.STAR_COUNT.fast} 颗（starStyleFor 确定性布点）`);
