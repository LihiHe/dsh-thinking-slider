/**
 * dsh-thinking-slider 浏览器半边单测。
 *
 * 覆盖三类东西：
 *   1. 纯函数（快照 → 档位、下标、填充百分比）—— 等级解析的所有分支；
 *   2. 插槽注册 —— 座位 id / order / 文案命名空间，以及注入的 CSS 只注入一次；
 *   3. 组件行为 —— 隐藏条件、拖动只提交一次、竞态丢弃、失败提示、滑轨两端标签、
 *      回到默认档时请求体里**不出现** reasoningEffort 字段。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  boot,
  fakeContext,
  fakeDirectory,
  findByLabel,
  fire,
  loadClient,
  modelMenuSnapshot,
  renderComponent,
  threeLevelSnapshot,
  walk,
} from "./helpers.mjs";

/* ------------------------------------------------------------------ *
 * 1. resolveLevels
 * ------------------------------------------------------------------ */

test("resolveLevels: 快照为空 → 不支持，控件应隐藏", () => {
  const { internals } = boot({ snapshot: null });
  for (const snapshot of [null, undefined, "nope", 42]) {
    const view = internals.resolveLevels(snapshot);
    assert.equal(view.supported, false);
    assert.deepEqual(view.levels, []);
    assert.equal(view.model, undefined);
  }
});

test("resolveLevels: 模型没有 reasoning 字段 → supported=false（官方菜单也没有 Effort 行）", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const view = internals.resolveLevels({
    current: { provider: "openai", model: "gpt-5" },
    groups: [{ id: "openai", models: [{ id: "gpt-5", name: "GPT-5" }] }],
    status: "ready",
  });
  assert.equal(view.supported, false);
  assert.deepEqual(view.levels, []);
});

test("resolveLevels: reasoning.efforts 为空数组 → supported=true 但零档（只显示默认档）", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const view = internals.resolveLevels({
    current: { provider: "openai", model: "gpt-5" },
    groups: [{ id: "openai", models: [{ id: "gpt-5", reasoning: { efforts: [] } }] }],
    status: "ready",
  });
  assert.equal(view.supported, true);
  assert.deepEqual(view.levels, []);
  assert.equal(view.defaultEffort, undefined);
});

test("resolveLevels: 抽等级 id/name，name 缺失时回退成 id，非法项被丢弃", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const view = internals.resolveLevels({
    current: { provider: "p", model: "m", reasoningEffort: "high" },
    groups: [
      {
        id: "p",
        name: "Provider",
        models: [
          {
            id: "m",
            reasoning: {
              defaultEffort: "low",
              efforts: [{ id: "low", name: "Low" }, { id: "high" }, { id: "" }, { name: "无 id" }, null],
            },
          },
        ],
      },
    ],
    status: "ready",
  });
  assert.equal(view.supported, true);
  assert.deepEqual(view.levels, [
    { id: "low", name: "Low" },
    { id: "high", name: "high" },
  ]);
  assert.equal(view.defaultEffort, "low");
  assert.equal(view.currentEffort, "high");
  assert.equal(view.provider.name, "Provider");
  assert.equal(view.model.id, "m");
});

test("resolveLevels: groups 里找不到当前模型 → 仍然报 provider/model id，supported=false", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const view = internals.resolveLevels({
    current: { provider: "ghost", model: "unknown" },
    groups: [{ id: "other", models: [] }],
    status: "loading",
  });
  assert.equal(view.supported, false);
  assert.deepEqual(view.provider, { id: "ghost" });
  assert.deepEqual(view.model, { id: "unknown" });
  assert.equal(view.status, "loading");
});

/* ------------------------------------------------------------------ *
 * 2. buildStops / stopIndexOf / fillPercent / effortOf
 * ------------------------------------------------------------------ */

test("buildStops: 声明了 defaultEffort → 位置与 efforts 一一对应，不额外多出「默认」档", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const view = internals.resolveLevels(threeLevelSnapshot());
  const stops = internals.buildStops(view);
  // 官方 Effort 菜单就是这么建的（model-selection/lib/client.js:557-563）：
  // 只有当模型没声明 defaultEffort 时才补 "provider-default" 项。
  assert.deepEqual(
    stops.map((stop) => [stop.key, stop.effort, stop.name]),
    [
      ["effort:low", "low", "Low"],
      ["effort:medium", "medium", "Medium"],
      ["effort:high", "high", "High"],
    ],
  );
});

test("buildStops: 没有声明 defaultEffort → 最左补一档「默认」(provider default)", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const view = internals.resolveLevels({
    current: { provider: "p", model: "m" },
    groups: [{ id: "p", models: [{ id: "m", reasoning: { efforts: [{ id: "low", name: "Low" }] } }] }],
  });
  assert.deepEqual(
    internals.buildStops(view).map((stop) => stop.effort),
    [undefined, "low"],
  );
});

test("buildStops: 支持推理但一个档位都没声明 → 没有可拖的位置", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const view = internals.resolveLevels({
    current: { provider: "p", model: "m" },
    groups: [{ id: "p", models: [{ id: "m", reasoning: { efforts: [] } }] }],
  });
  assert.deepEqual(internals.buildStops(view), [], "空 efforts 不造档：滑轨会被锁成单点");
});

test("stopIndexOf: 用 effectiveEffort（官方口径）定位当前档", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const stops = internals.buildStops(internals.resolveLevels(threeLevelSnapshot()));

  const explicitHigh = internals.resolveLevels(threeLevelSnapshot({ current: { reasoningEffort: "high" } }));
  assert.equal(internals.stopIndexOf(explicitHigh, stops), 2, "显式 high → 下标 2");

  // 快照里没有显式 effort，但目录声明 defaultEffort=medium：
  // 官方菜单此时显示的就是 Medium，滑条必须停在同一档。
  const implicit = internals.resolveLevels({
    current: { provider: "anthropic", model: "claude-opus-4" },
    groups: threeLevelSnapshot().groups,
  });
  assert.equal(implicit.effectiveEffort, "medium");
  assert.equal(internals.stopIndexOf(implicit, stops), 1, "无显式 effort → 落在声明的默认档上");

  // 没有声明 defaultEffort 时，无显式 effort 表示「不指定」，落在 provider-default 档。
  const noDefault = internals.resolveLevels({
    current: { provider: "p", model: "m" },
    groups: [
      {
        id: "p",
        models: [{ id: "m", reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] } }],
      },
    ],
  });
  const noDefaultStops = internals.buildStops(noDefault);
  assert.deepEqual(noDefaultStops.map((stop) => stop.effort), [undefined, "low", "high"]);
  assert.equal(internals.stopIndexOf(noDefault, noDefaultStops), 0, "不指定 → 最左的「默认」档");
});

test("stopIndexOf: 快照里的 effort 不在声明列表里 → 退回首档（不越界）", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const view = internals.resolveLevels(threeLevelSnapshot({ current: { reasoningEffort: "ultra" } }));
  const stops = internals.buildStops(view);
  assert.equal(stops.length, 3);
  assert.equal(internals.stopIndexOf(view, stops), 0, "未知档位不能让滑条跑到不存在的下标上");
  assert.equal(internals.stopIndexOf(view, []), 0, "空 stops 也返回 0");
});

test("resetIndexOf: 只在能回到「声明的默认档」且与当前档不同时给出目标", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });

  // defaultEffort=medium：high → 回到 medium（下标 1）；medium 本身不用给按钮。
  const high = internals.resolveLevels(threeLevelSnapshot({ current: { reasoningEffort: "high" } }));
  const highStops = internals.buildStops(high);
  assert.equal(internals.resetIndexOf(high, highStops, internals.stopIndexOf(high, highStops)), 1);
  const medium = internals.resolveLevels(threeLevelSnapshot({ current: { reasoningEffort: "medium" } }));
  assert.equal(internals.resetIndexOf(medium, highStops, 1), -1, "已经在默认档 → 不给按钮");

  // 没声明 defaultEffort：回到最左的 provider-default 档。
  const noDefault = internals.resolveLevels({
    current: { provider: "p", model: "m", reasoningEffort: "high" },
    groups: [
      {
        id: "p",
        models: [{ id: "m", reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] } }],
      },
    ],
  });
  const noDefaultStops = internals.buildStops(noDefault);
  assert.equal(internals.resetIndexOf(noDefault, noDefaultStops, 2), 0);

  // 只有一档 → 没什么可回。
  const single = internals.resolveLevels({
    current: { provider: "p", model: "m" },
    groups: [{ id: "p", models: [{ id: "m", reasoning: { efforts: [{ id: "low", name: "Low" }], defaultEffort: "low" } }] }],
  });
  assert.equal(internals.resetIndexOf(single, internals.buildStops(single), 0), -1);
});

test("ratioOf: 位置比例 0..1，单档恒为 0，越界被夹住", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  assert.equal(internals.ratioOf(0, 0), 0, "只有一档（lastIndex 0）时比例为 0，不除零");
  assert.equal(internals.ratioOf(0, 2), 0);
  assert.equal(internals.ratioOf(1, 2), 0.5);
  assert.equal(internals.ratioOf(2, 2), 1);
  assert.equal(internals.ratioOf(99, 2), 1, "越界位置被夹住");
  assert.equal(internals.ratioOf(-5, 2), 0);
  assert.equal(internals.ratioOf(0.5, 4), 0.125, "连续步进也要如实反映在比例里（跟手）");
});

/* ------------------------------------------------------------------ *
 * 3. apply / 插槽注册
 * ------------------------------------------------------------------ */

test("apply: 注册 conversation.input.right 座位，order=45 排在官方流控之后，CSS 只注入一次", () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const styleTags = runtime.loaded.document.head.children.filter((node) => node.dataset.plugin === "dsh-thinking-slider");
  assert.equal(styleTags.length, 1, "重复 apply 不应重复注入 <style>");
  assert.match(styleTags[0].textContent, /\.dsh-thinking-slider-range/);

  runtime.exports.apply(runtime.ctx);
  assert.equal(
    runtime.loaded.document.head.children.filter((node) => node.dataset.plugin === "dsh-thinking-slider").length,
    1,
  );

  // 与官方 flow-control 同款写法：一次 apply 里 inject 一次，回调里 register。
  assert.equal(runtime.ctx._injections.length, 2);
  assert.equal(runtime.ctx._injections[1].name, "conversation.input.right");
  const definition = runtime.registration.definition;
  assert.equal(definition.name, "conversation.input.right");
  assert.equal(definition.id, "thinking-slider");
  assert.equal(definition.order, 45);
  assert.ok(definition.order > 40, "必须排在官方 flow-control 的 39/40 之后");
  // 座位**不能**声明文案命名空间：官方渲染器在没有文案面时会抛
  // SlotAssemblyError，整个座位消失（这就是第一版「重启后什么都没有」的根因）。
  assert.equal("locale" in definition, false, "座位不得声明 locale");
  assert.equal(runtime.ctx._dictionaries[0].namespace, "thinking-slider");
  assert.equal(runtime.ctx._dictionaries[0].dict.zh["card.title"], "推理强度");

  // 只 inject slots：声明的服务不到会让插件永远 pending（界面全无）。
  assert.deepEqual(runtime.exports.inject, ["slots"]);
});

/* ------------------------------------------------------------------ *
 * 4. 组件
 * ------------------------------------------------------------------ */

/**
 * 关于「帧」：这个替身 React 不保存 hook 状态，每次调用 Component 都是全新一帧。
 * 真实的「点开卡片」= 一次事件回调触发 setState、React 立即重渲染，所以测试里
 * 拆成两步来模拟：先在 A 帧上触发点击，再重新渲染得到「已展开」的 B 帧，并对
 * 着 B 帧继续操作。凡是跨帧的动作，代码里都显式分成两行，避免误挂到旧帧上。
 *
 * @param {object} runtime - boot() 的结果。
 * @returns {object} 「卡片已展开」的那一帧。
 */
function renderCardOpen(runtime) {
  let frame = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  const trigger = frame.find((element) => element.props["aria-haspopup"] === "dialog");
  if (trigger !== null && trigger.props["aria-expanded"] === false) {
    frame.fire(trigger, "onClick");
    frame = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  }
  assert.ok(trigger !== null, "触发按钮应当存在");
  return frame;
}

/** 取滑轨元素，取不到就直接断言失败（比后面 undefined.props 报错更好读）。 */
function rangeOf(frame) {
  const range = frame.range();
  assert.ok(range !== null, "应当渲染出原生滑轨");
  return range;
}

/** 取滑轨**外层容器**（承载 `--dsh-ts-ratio`、`data-boost` 与五层自绘子元素）。 */
function railOf(frame) {
  const rail = walk(frame.tree).find((element) => element.props.className === "dsh-thinking-slider-rail") ?? null;
  assert.ok(rail !== null, "应当渲染出滑轨外层容器");
  return rail;
}

/** 取集合里某类元素的纯文本，用于断言卡片文案。 */
function textsOf(node, kinds = ["p", "button"]) {
  return walk(node)
    .filter((element) => kinds.includes(element.type))
    .map((element) => element.children.join(""));
}

/** 树里所有直接文本节点（不限元素类型）：素材样式的文字散在 span / button / svg 里。 */
function allTexts(node) {
  return walk(node).flatMap((element) => element.children.filter((child) => typeof child === "string"));
}

/** 只看某个元素内部（含自身）：卡片头的闪电和触发按钮的图标是同一个 primitive，得分开数。 */
function within(node) {
  return walk(node);
}

/** 模型清单里每一行的名字（按渲染顺序）。 */
function optionLabels(list) {
  return walk(list)
    .filter((element) => element.props.role === "option")
    .map((element) =>
      walk(element)
        .filter((child) => child.props?.className === "dsh-thinking-slider-model-name")
        .map((child) => child.children.join(""))
        .join(""));
}

/** 模型清单里每一行的选中态（`aria-selected`）。 */
function optionSelected(list) {
  return walk(list)
    .filter((element) => element.props.role === "option")
    .map((element) => element.props["aria-selected"]);
}

/**
 * 模型清单里的分组标题文案。
 *
 * 用样式对象**引用相等**来认标题：这些样式是模块级常量，`__internals` 给的就是
 * 同一个对象，所以不用把颜色字号抄进测试里（抄了就会随样式漂移）。
 * @param {object} list - `dsh-thinking-slider-models` 元素。
 * @param {object} internals - `__internals`。
 * @returns {string[]} 标题文案。
 */
function groupHeadings(list, internals) {
  return walk(list)
    .filter((element) => element.props.style === internals.MODEL_GROUP)
    .map((element) => element.children.join(""));
}

test("组件: 没有 sessionId → 返回 null；目录迟到 → 显示等待占位点；模型不支持推理等级 → 仍然渲染（它是唯一的切模型入口）", () => {
  const withLevels = boot({ snapshot: threeLevelSnapshot() });
  // 目录拿不到：directoryFor 抛错 → directoryOf 兜底 null。
  const broken = boot({ snapshot: threeLevelSnapshot(), directoryFor: () => { throw new Error("no directory"); } });
  const waiting = renderComponent(broken.Component, { sessionId: "s1" }).tree;
  assert.ok(waiting !== null, "目录不可用时应留一个占位点，而不是整段消失");
  const dot = walk(waiting).find((element) => String(element.props?.style?.border ?? "").includes("dashed"));
  assert.ok(dot !== undefined, "占位点画成虚线空心圆");
  assert.equal(dot.props["aria-hidden"], "true");

  const unsupported = boot({
    snapshot: {
      current: { provider: "p", model: "m" },
      groups: [{ id: "p", models: [{ id: "m" }] }],
      status: "ready",
    },
  });
  // 官方「选择模型」座位已经被我们接管（见接管官方座位一段），所以这里不能是 null：
  // 否则模型一旦没有推理等级，用户就再也没有入口切回别的模型了。
  const bare = renderComponent(unsupported.Component, { sessionId: "s1" }).tree;
  assert.ok(bare !== null, "模型不支持推理等级时仍要渲染 chip");
  const chip = walk(bare).find((element) => element.props["aria-haspopup"] === "dialog");
  assert.ok(chip !== null, "仍然是一枚触发按钮");
  assert.equal(chip.props["aria-label"], "m", "没有推理等级时无障碍名就是模型名（这是个纯模型选择器）");
  assert.equal(textsOf(bare, ["span"]).includes("默认"), false, "没有档位就不显示档位名");
  assert.equal(renderComponent(withLevels.Component, { sessionId: undefined }).tree, null);
});

test("组件: 渲染触发按钮，挂载时拉一次目录，订阅目录 store", () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const frame = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  frame.flushEffects();

  assert.equal(runtime.directory.loadCount, 1, "挂载应拉一次目录");
  assert.equal(runtime.directory.listenerCount(), 1, "应订阅目录 store");
  assert.ok(walk(frame.tree).length > 3, "应当渲染出触发按钮");

  const trigger = frame.find((element) => element.props["aria-haspopup"] === "dialog");
  assert.ok(trigger !== null, "触发按钮带 aria-haspopup=dialog");
  assert.equal(trigger.props["aria-expanded"], false);
  assert.equal(trigger.props["aria-busy"], false);
  assert.equal(trigger.props["aria-label"], runtime.t("trigger.ariaEffort", { model: "Opus 4", level: "Medium" }));
  assert.ok(textsOf(frame.tree, ["span"]).includes("Medium"), "触发按钮上显示当前等级");
});

test("组件: 卡片默认不渲染；点开是素材样式 —— 三列卡头 + 每档一颗刻度点，没有 ± 步进", () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const closed = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  closed.flushEffects();
  assert.equal(closed.range(), null, "未展开时不渲染滑轨（portal 内容不该提前挂出去）");

  const frame = renderCardOpen(runtime);
  const range = rangeOf(frame);
  assert.equal(range.props.max, 2, "三个具名档 → 三个位置（官方 Effort 菜单同构）");
  assert.equal(range.props.value, 1, "currentEffort=medium → 下标 1");
  assert.equal(range.props["aria-valuetext"], "Medium");
  assert.equal(range.props.disabled, false);
  // 丝滑的关键：**连续步进**。档位语义交给 Math.round，位置本身是浮点，
  // 所以圆钮能停在任意处、拖动跟手，而不是在 3 个档位中心之间跳。
  assert.equal(range.props.step, runtime.internals.DRAG_STEP, "连续步进（跟手），不按档吸附");
  assert.ok(range.props.step < 1 && Number.isFinite(range.props.step), "步进必须是小于 1 的有限数");
  assert.equal(range.props.max - range.props.min, 2, "可拖动范围仍是「档数 - 1」");
  assert.equal(
    "--dsh-ts-ratio" in (range.props.style ?? {}),
    false,
    "比例变量挂在滑轨外层（填充 / 圆钮 / 刻度点共享），不再挂在 input 上",
  );

  // 拖动位置直接进受控 value（连续值也能表示，不是「只有 3 个落点的整数」）。
  frame.fire(range, "onChange", { currentTarget: { value: "2" } });
  const dragged = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  assert.equal(rangeOf(dragged).props.value, 2, "位置跟手：拖动值原样进 value");
  frame.fire(range, "onChange", { currentTarget: { value: "1.37" } });
  const mid = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  assert.equal(rangeOf(mid).props.value, 1.37, "落在档位之间也不被吸附");

  // 素材样式之一：比例写进滑轨外层，而不是重渲染出来的百分比宽度。
  const rail = railOf(frame);
  assert.equal(rail.props.style["--dsh-ts-ratio"], "0.5", "medium 是 3 档里的第 2 档 → 比例 0.5");
  assert.equal("data-boost" in rail.props, false, "medium 不是最高档 → 不上流动渐变");

  // 素材样式之二：卡头是三列网格（左闪电 / 中「名 + › + 模型」/ 右 ↻），中间列才真居中。
  const header = walk(frame.tree).find((element) => element.props.style?.gridTemplateColumns !== undefined);
  assert.ok(header !== undefined, "卡头用 grid 三列");
  assert.equal(header.props.style.gridTemplateColumns, "28px 1fr 28px");

  // 素材样式之三：每档一颗刻度点，画两层 —— 常驻灰点 + 「已通过」高亮点（靠 clip-path 裁）。
  const dotRows = walk(frame.tree).filter((element) =>
    String(element.props.className ?? "").startsWith("dsh-thinking-slider-dots"),
  );
  assert.equal(dotRows.length, 2, "刻度点画两层");
  for (const row of dotRows) {
    assert.equal(row.children.length, 3, "三个具名档 → 三颗点");
  }
  assert.match(String(dotRows[1].props.className), /dots-passed$/, "第二层是「已通过」那层");

  const labels = walk(frame.tree).map((element) => element.props["aria-label"]).filter(Boolean);
  assert.equal(labels.includes("降低一级") || labels.includes("提高一级"), false, "不该再有 ± 步进按钮");

  const texts = allTexts(frame.tree);
  assert.equal(texts.includes("Low") || texts.includes("High"), false, `素材样式不在轨道下方写端点档位名：${JSON.stringify(texts)}`);
  assert.ok(texts.includes("Medium"), "卡片中间是当前等级名");
  assert.ok(texts.includes("Opus 4"), "等级名下面一行是模型名");
  assert.ok(texts.includes("›"), "等级名右侧是素材里那个 `›`");
});

test("组件: 拖动只发一次请求（onChange 不提交，onPointerUp 才提交）", async () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const frame = renderCardOpen(runtime);
  const range = rangeOf(frame);

  // 拖动过程：经过 high（下标 2），一个请求都不该发出去。
  frame.fire(range, "onChange", { target: { value: "2" } });
  frame.fire(range, "onChange", { target: { value: "2" } });
  assert.equal(runtime.directory.calls.length, 0, "拖动中不提交");

  frame.fire(range, "onPointerUp", { currentTarget: { value: "2" } });
  await Promise.resolve();
  assert.equal(runtime.directory.calls.length, 1, "松手只提交一次");
  assert.deepEqual(runtime.directory.calls[0], { provider: "anthropic", model: "claude-opus-4", reasoningEffort: "high" });
});

test("组件: 拖到「默认」(provider default) 档时请求体里没有 reasoningEffort 字段", async () => {
  // 只有模型**没有**声明 defaultEffort 时才有这一档（与官方 Effort 菜单一致）。
  const runtime = boot({
    snapshot: {
      current: { provider: "anthropic", model: "claude-opus-4", reasoningEffort: "high" },
      groups: [
        {
          id: "anthropic",
          models: [
            {
              id: "claude-opus-4",
              name: "Opus 4",
              reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] },
            },
          ],
        },
      ],
      status: "ready",
    },
  });
  const frame = renderCardOpen(runtime);
  const range = rangeOf(frame);
  assert.equal(range.props.max, 2, "默认 + 2 级 = 3 个位置");
  assert.equal(range.props.value, 2, "显式 high → 下标 2");
  frame.fire(range, "onPointerUp", { currentTarget: { value: "0" } });
  await Promise.resolve();
  assert.equal(runtime.directory.calls.length, 1);
  assert.deepEqual(runtime.directory.calls[0], { provider: "anthropic", model: "claude-opus-4" });
  assert.equal("reasoningEffort" in runtime.directory.calls[0], false, "provider default 必须整字段省略");
});

test("组件: 拖到当前档 + 重复提交同一档 → 不发请求", async () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const frame = renderCardOpen(runtime);
  frame.fire(rangeOf(frame), "onPointerUp", { currentTarget: { value: "1" } });
  await Promise.resolve();
  assert.equal(runtime.directory.calls.length, 0, "当前档 = medium（下标 1），重复提交应被短路");
});

test("组件: 键盘方向键按整档移动并提交；普通按键不提交", async () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const frame = renderCardOpen(runtime);
  const range = rangeOf(frame);

  frame.fire(range, "onKeyDown", { key: "Tab", currentTarget: { value: "1" } });
  await Promise.resolve();
  assert.equal(runtime.directory.calls.length, 0, "Tab 不提交");

  // 连续步进下浏览器只会先 +0.01（value 还是 1.01），但组件按**整档**跳 → high。
  // 键盘因此和拖动一样丝滑，不会为了走一格而在 0.01 的粒度上连按 100 次。
  frame.fire(range, "onKeyDown", { key: "ArrowRight", currentTarget: { value: "1.01" } });
  await Promise.resolve();
  assert.equal(runtime.directory.calls.length, 1, "方向键提交一次");
  assert.equal(runtime.directory.calls[0].reasoningEffort, "high", "箭头按整档移动，不受 0.01 步进影响");

  frame.fire(range, "onKeyDown", { key: "Home", currentTarget: { value: "1" } });
  await Promise.resolve();
  assert.equal(runtime.directory.calls.at(-1).reasoningEffort, "low", "Home/End/Page 也要提交");
});

test("组件: 拖到最高档后，滑轨停在最右（比例 1）且不再画两端档位名", async () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const frame = renderCardOpen(runtime);
  frame.fire(rangeOf(frame), "onPointerUp", { currentTarget: { value: "2" } });
  await Promise.resolve();
  assert.deepEqual(runtime.directory.calls.at(-1), { provider: "anthropic", model: "claude-opus-4", reasoningEffort: "high" });

  // 目录快照跟上（真实环境里由 sessions 推送）。
  runtime.directory.setSnapshot(threeLevelSnapshot({ current: { reasoningEffort: "high" } }));
  const top = renderCardOpen(runtime);
  assert.ok(top.range() !== null, "快照更新后卡片仍然展开");
  assert.equal(top.range().props.value, 2, "已到最高档 → 滑轨停在最右");
  assert.equal(top.range().props["aria-valuetext"], "High");
  assert.equal(railOf(top).props.style["--dsh-ts-ratio"], "1", "比例 1 → 填充画满、圆钮骑在最右");
  assert.equal(railOf(top).props["data-boost"], undefined, "high 不是品牌最高档（xhigh/max/ultra 才是）→ 不上流动渐变");
  const texts = allTexts(top.tree);
  assert.equal(texts.filter((text) => text === "High").length, 2, "当前档名（卡头）+ 触发按钮 = 2 处 High");
  assert.equal(texts.includes("Low"), false, "素材样式不在轨道两端写档位名");
  assert.equal(texts.includes("Medium"), false, "已切到 high → 不该再出现 Medium");
});

test("组件: 卡头右侧的 ↻ 提交目录声明的默认档（没声明则提交无 effort）", async () => {
  // 情形 A：声明了 defaultEffort=medium，当前是 high → 回到 medium。
  const declared = boot({ snapshot: threeLevelSnapshot({ current: { reasoningEffort: "high" } }) });
  const frameA = renderCardOpen(declared);
  const resetA = findByLabel(frameA.tree, "返回默认");
  assert.ok(resetA !== null, "偏离声明的默认档时应出现 ↻ 重置按钮");
  assert.equal(resetA.type, "button");
  frameA.fire(resetA, "onClick");
  await Promise.resolve();
  assert.deepEqual(declared.directory.calls.at(-1), {
    provider: "anthropic",
    model: "claude-opus-4",
    reasoningEffort: "medium",
  });

  // 情形 B：没声明 defaultEffort，当前是 high → 回到「不指定」(整字段省略)。
  const implicit = boot({
    snapshot: {
      current: { provider: "anthropic", model: "claude-opus-4", reasoningEffort: "high" },
      groups: [
        {
          id: "anthropic",
          models: [
            {
              id: "claude-opus-4",
              name: "Opus 4",
              reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] },
            },
          ],
        },
      ],
      status: "ready",
    },
  });
  const frameB = renderCardOpen(implicit);
  const resetB = findByLabel(frameB.tree, "返回默认");
  assert.ok(resetB !== null);
  frameB.fire(resetB, "onClick");
  await Promise.resolve();
  assert.deepEqual(implicit.directory.calls.at(-1), { provider: "anthropic", model: "claude-opus-4" });
});

test("组件: 已在默认档时不显示 ↻ 重置按钮", () => {
  const runtime = boot({ snapshot: threeLevelSnapshot({ current: { reasoningEffort: undefined } }) });
  const frame = renderCardOpen(runtime);
  assert.equal(findByLabel(frame.tree, "返回默认"), null, "默认档上不该出现 ↻");
});

test("组件: select 返回 {ok:false} → 卡片里显示错误文案且草稿回滚", async () => {
  const directory = fakeDirectory({
    snapshot: threeLevelSnapshot(),
    select: async () => ({ ok: false, error: { message: "reasoning effort not supported by this model" } }),
  });
  const runtime = boot({ directory });
  const frame = renderCardOpen(runtime);
  frame.fire(rangeOf(frame), "onPointerUp", { currentTarget: { value: "2" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.directory.calls.length, 1);

  const after = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  const texts = textsOf(after.tree, ["p"]);
  assert.ok(
    texts.includes("reasoning effort not supported by this model"),
    `应当把服务端错误原文显示出来，实际：${JSON.stringify(texts)}`,
  );
});

test("组件: select 抛异常 → 显示异常消息", async () => {
  const directory = fakeDirectory({
    snapshot: threeLevelSnapshot(),
    select: async () => {
      throw new Error("network down");
    },
  });
  const runtime = boot({ directory });
  const frame = renderCardOpen(runtime);
  frame.fire(rangeOf(frame), "onPointerUp", { currentTarget: { value: "2" } });
  await new Promise((resolve) => setImmediate(resolve));

  const after = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  assert.ok(textsOf(after.tree, ["p"]).includes("network down"), "异常消息要落进卡片");
});

test("组件: 竞态 —— 先发的响应迟到时被丢弃，不覆盖后发结果", async () => {
  const pending = [];
  const directory = fakeDirectory({
    snapshot: threeLevelSnapshot(),
    select: (selection) =>
      new Promise((resolve) => {
        pending.push({ selection, resolve });
      }),
  });
  const runtime = boot({ directory });
  const frame = renderCardOpen(runtime);
  frame.fire(rangeOf(frame), "onPointerUp", { currentTarget: { value: "2" } }); // 第一次：high
  const second = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  second.fire(rangeOf(second), "onPointerUp", { currentTarget: { value: "0" } }); // 第二次：low

  assert.equal(pending.length, 2);
  assert.equal(pending[0].selection.reasoningEffort, "high");
  assert.equal(pending[1].selection.reasoningEffort, "low");

  // 后发的先成功，先发的随后才失败 —— 迟到的那次不该把错误显示出来。
  pending[1].resolve({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  pending[0].resolve({ ok: false, error: { message: "stale failure" } });
  await new Promise((resolve) => setImmediate(resolve));

  const after = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  assert.equal(textsOf(after.tree, ["p"]).includes("stale failure"), false, "迟到的失败必须按序号丢弃");
});

test("组件: 目录尚在加载且没有任何档位时锁定滑轨", () => {
  const runtime = boot({
    snapshot: {
      current: { provider: "anthropic", model: "claude-opus-4", reasoningEffort: "medium" },
      groups: [
        {
          id: "anthropic",
          models: [{ id: "claude-opus-4", name: "Opus 4", reasoning: { efforts: [], defaultEffort: "medium" } }],
        },
      ],
      status: "loading",
    },
  });
  const frame = renderCardOpen(runtime);
  const range = rangeOf(frame);
  assert.equal(range.props.disabled, true, "loading + 无档位 → 禁用");
  assert.equal(range.props.max, 0, "只剩「默认」一档 → min=max=0，滑轨只有一个位置");
});

test("组件: 没有 t 函数时退回中文硬编码文案，不抛错", () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const frame = renderComponent(runtime.Component, { sessionId: "s1" });
  frame.flushEffects();
  const trigger = frame.find((element) => element.props["aria-haspopup"] === "dialog");
  assert.equal(trigger.props["aria-label"], "推理强度：Opus 4 · Medium");
});

/* ------------------------------------------------------------------ *
 * 5. 模块级通知（Toast）通道
 * ------------------------------------------------------------------ */

test("showNotice/publish: 写入模块级通知并通知订阅者；reset 清空", () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const internals = runtime.internals;
  const seen = [];
  assert.equal(internals.notice, null);

  // 走一次组件里的 useNoticeState 效果，把订阅者挂上。
  const rendered = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  rendered.flushEffects();
  assert.equal(typeof internals.showNotice, "function");

  internals.showNotice("测试通知", "error");
  assert.equal(internals.notice.text, "测试通知");
  assert.equal(internals.notice.tone, "error");
  assert.equal(typeof internals.notice.key, "number");
  seen.push(internals.notice.key);

  internals.showNotice("第二条");
  assert.equal(internals.notice.text, "第二条");
  assert.equal(internals.notice.tone, undefined);
  assert.ok(internals.notice.key > seen[0], "key 自增，React 才会重建 Toast");

  internals.reset();
  assert.equal(internals.notice, null);
});

/* ------------------------------------------------------------------ *
 * 6. GPT 视觉契约（单色胶囊 + 只有最高档上品牌渐变）
 * ------------------------------------------------------------------ */

/** 一份「最高档叫 xhigh」的目录快照 —— 用来验证最高档才上色。 */
function xhighSnapshot(effort = "xhigh") {
  return threeLevelSnapshot({
    current: { reasoningEffort: effort },
    groups: [
      {
        id: "anthropic",
        name: "Anthropic",
        models: [
          {
            id: "claude-opus-4",
            name: "Opus 4",
            reasoning: {
              defaultEffort: "low",
              efforts: [
                { id: "low", name: "Low" },
                { id: "high", name: "High" },
                { id: "xhigh", name: "xHigh" },
              ],
            },
          },
        ],
      },
    ],
  });
}

test("视觉契约: 素材配色 —— 蓝色填充 + 每档刻度点，只有最高档上流动渐变与星尘", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const {
    REF,
    COLOR,
    TRACK_FILL,
    TRACK_REST,
    TRACK_EDGE,
    DOT_REST,
    DOT_PASSED,
    BOOST_GRADIENT,
    BOOST_EFFORTS,
    RANGE_CSS,
    RAIL_HEIGHT,
    KNOB_SIZE,
    DOT_SIZE,
    RAIL_EDGE,
    STAR_COUNT,
  } = internals;

  // 素材实测色（720x1920 源图逐像素取）：填充 rgb(48,120,240)、空轨道 rgb(56,56,56)、
  // 刻度点 rgb(133,133,133)、被填充盖住的那颗是浅蓝 rgb(109,181,255)。
  assert.equal(REF.accent, "#3078f0", "填充蓝 = 素材实测 rgb(48,120,240)");
  assert.deepEqual(REF.ultra, ["#0818e0", "#4020e8", "#a828e8", "#c65cf5"], "Ultra 渐变四段色取自素材");
  assert.equal(COLOR.ultraInk, REF.ultraText, "Ultra 档的等级名 / 闪电用素材里那抹紫");

  // 填充走品牌色（素材是饱和蓝，不是旧版「文字色 18%」的灰调）；
  // 空轨道与描边仍是中性色 —— 深浅主题都自动成立。
  assert.equal(TRACK_FILL, COLOR.accent, "已填充段 = 品牌蓝");
  assert.match(TRACK_FILL, /business-primary/);
  assert.match(TRACK_FILL, /#3078f0/, "主题变量缺席时退回素材那个蓝");
  assert.match(TRACK_REST, /14%/, "空轨道 = 文字色 14%（深色主题下正好落在素材的 #383838 上）");
  assert.match(TRACK_REST, /label-primary/, "基准色是主题文字色");
  assert.equal(/business-primary|#3078f0/.test(TRACK_REST), false, `空轨道不该带品牌色：${TRACK_REST}`);
  assert.equal(/business-primary|#3078f0/.test(TRACK_EDGE), false, `轨道描边不该带品牌色：${TRACK_EDGE}`);
  assert.match(DOT_REST, /42%/, "常驻刻度点是中性灰");
  assert.match(DOT_PASSED, /55%/, "已通过的刻度点 = 品牌蓝混白（素材里那颗浅蓝点）");

  // 最高档的渐变：105deg + 素材四段色，靠 background-position 无限往复流动。
  assert.match(BOOST_GRADIENT, /^linear-gradient\(105deg/);
  for (const color of REF.ultra) {
    assert.ok(BOOST_GRADIENT.includes(color), `渐变里要有素材实测色 ${color}`);
  }
  assert.deepEqual(BOOST_EFFORTS, ["xhigh", "max", "ultra"], "只有最高那几档是彩色的");

  // 几何：圆钮比轨道高（素材 49 > 38），端点内缩 = 圆钮半径 —— 刻度点因此正好压在
  // 原生 range 圆钮的行程上。
  assert.ok(KNOB_SIZE > RAIL_HEIGHT, "圆钮要骑在轨道上（上下溢出），素材就是这么画的");
  assert.equal(RAIL_EDGE, KNOB_SIZE / 2, "端点内缩 = 圆钮半径");
  assert.equal(DOT_SIZE, 4);
  assert.deepEqual(STAR_COUNT, { fast: 22, true: 12 }, "星尘只出现在最高档：Ultra 22 颗、其余 12 颗");

  // CSS 形状契约：比例是可补间属性 + 五层自绘 + 星尘 + 降级。
  assert.match(RANGE_CSS, /@property --dsh-ts-ratio/);
  assert.match(RANGE_CSS, /transition: --dsh-ts-ratio 320ms/, "填充 / 圆钮 / 刻度点共享同一条比例过渡");
  for (const layer of ["track", "fill", "dots", "knob", "stars"]) {
    assert.ok(RANGE_CSS.includes(`.dsh-thinking-slider-${layer}`), `自绘层缺了：${layer}`);
  }
  assert.match(RANGE_CSS, /@keyframes dsh-ts-effort-flow/);
  assert.match(RANGE_CSS, /@keyframes dsh-ts-twinkle/);
  assert.match(RANGE_CSS, /@keyframes dsh-ts-starfield/);
  assert.match(RANGE_CSS, /prefers-reduced-motion: reduce/);
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-rail:has\(\.dsh-thinking-slider-range:disabled\)/);
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-trigger:hover/);
  // 原生滑轨必须完全透明（原生的轨道与圆钮都是），否则会和自绘的五层叠成双影。
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-range::-webkit-slider-runnable-track\s*\{[^}]*background: transparent/);
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-range::-webkit-slider-thumb\s*\{[^}]*background: transparent/);
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-range::-moz-range-thumb\s*\{[^}]*background: transparent/);
});

test("组件: xhigh 档才画出流动渐变与星尘，低档仍是蓝填充 + 灰点；触发按钮用思考图标", () => {
  const runtime = boot({ snapshot: xhighSnapshot("xhigh") });
  const { RANGE_CSS, STAR_COUNT, DOT_BOOST_REST, DOT_BOOST_PASSED, DOT_REST } = runtime.internals;
  const frame = renderCardOpen(runtime);
  const rail = railOf(frame);
  const range = rangeOf(frame);

  assert.equal(range.props.value, 2, "currentEffort=xhigh → 下标 2（最高档）");
  // 渐变不写成 inline style（那样进出最高档就是硬闪）。容器只挂 `data-boost`，
  // 渐变由 CSS 画在填充层的 `::after` 上，进/出最高档是一次 280ms 淡入淡出。
  assert.equal(rail.props["data-boost"], "true", "最高档：容器打上 data-boost 标记");
  assert.equal(rail.props.style.backgroundImage, undefined, "渐变交给 CSS，不再是 inline style（否则没法过渡）");
  assert.equal(rail.props.style.animation, undefined, "动画同样交给 CSS");
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-fill::after[\s\S]{0,260}background-image/, "渐变画在填充层的伪元素上");
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-fill::after[\s\S]{0,400}opacity: 0;/, "默认透明（非最高档什么都不画）");
  assert.match(RANGE_CSS, /transition: opacity 280ms ease/, "进出最高档靠过渡，不硬闪");
  assert.match(RANGE_CSS, /\[data-boost\][\s\S]{0,80}animation: dsh-ts-effort-flow 6s/, "6s 往复流动（最高档）");
  assert.match(RANGE_CSS, /\[data-boost="fast"\][\s\S]{0,120}animation-duration: 4s/, "Ultra 的流动更快（4s）");
  assert.equal(
    rail.props.style["--dsh-ts-dot-color"],
    DOT_BOOST_REST,
    "最高档的刻度点叠在渐变上，改成半透明白",
  );
  assert.equal(rail.props.style["--dsh-ts-dot-passed-color"], DOT_BOOST_PASSED);

  // 星尘：两份星图（整体左移 50% 无缝衔接），颗数按档位。
  const stars = walk(frame.tree).filter((element) => element.props.className === "dsh-thinking-slider-star");
  assert.equal(stars.length, STAR_COUNT.true * 2, "星图两份（各 half 一份），循环才无缝");
  assert.ok(
    walk(frame.tree).some((element) => element.props.className === "dsh-thinking-slider-stars"),
    "最高档才渲染星尘层",
  );
  const half = walk(frame.tree).filter((element) => element.props.className === "dsh-thinking-slider-star-half");
  assert.equal(half.length, 2, "两半星图");
  assert.equal(half[0].children.length, STAR_COUNT.true);
  // 星位是确定性哈希（不用 Math.random），所以同一个下标永远同一位置 —— 可断言、可复现。
  const { starStyleFor } = runtime.internals;
  assert.deepEqual(starStyleFor(0, "true"), starStyleFor(0, "true"), "星位确定性（不用 Math.random）");
  assert.notDeepEqual(starStyleFor(0, "true").left, starStyleFor(1, "true").left, "不同下标落在不同位置");
  assert.match(String(stars[0].props.style.left), /^\d+(\.\d+)?%$/);

  // 换成 low：渐变、星尘、白点全部退出，回到「蓝填充 + 灰点」。
  runtime.directory.setSnapshot(xhighSnapshot("low"));
  const plain = renderCardOpen(runtime);
  const plainRail = railOf(plain);
  const plainRange = rangeOf(plain);
  assert.equal(plainRange.props.value, 0, "low → 下标 0");
  assert.equal(plainRail.props.style.backgroundImage, undefined, "低档不该有渐变");
  assert.equal(plainRail.props.style.animation, undefined, "低档不该有动画");
  assert.equal(plainRail.props["data-boost"], undefined, "低档没有 data-boost → 渐变与星层都不显示");
  assert.equal(
    walk(plain.tree).filter((element) => element.props.className === "dsh-thinking-slider-star").length,
    0,
    "低档不渲染星尘",
  );
  assert.equal(plainRail.props.style["--dsh-ts-dot-color"], DOT_REST, "低档的刻度点是中性灰");
  assert.equal(plainRange.props.style?.["--dsh-ts-fill-color"], undefined, "颜色变量挂在滑轨外层，不再挂在 input 上");
  assert.equal(plainRange.props.style?.["--dsh-ts-ratio"], undefined, "比例也挂在滑轨外层（CSS 变量逐层下传）");
  assert.equal(plainRail.props.style["--dsh-ts-fill-color"], runtime.internals.TRACK_FILL);
  assert.equal(plainRail.props.style["--dsh-ts-rest-color"], runtime.internals.TRACK_REST);

  // 触发按钮：中性 chip + 一枚思考图标（旧版的品牌渐变圆点已删掉）。
  const trigger = frame.find((element) => element.props["aria-haspopup"] === "dialog");
  assert.equal(trigger.props.className, "dsh-thinking-slider-trigger", "chip 挂类名，hover/展开态由 CSS 管");
  const thinkPrimitive = (element) => {
    const name = element.props?.["data-primitive"] ?? "";
    return typeof name === "string" && name.startsWith("Icon") && name.includes("Think");
  };
  const triggerIcons = within(trigger).filter(thinkPrimitive);
  assert.equal(triggerIcons.length, 1, "触发按钮左侧是思考图标");
  assert.equal(triggerIcons[0].props.size, 14);
  // 卡片头左列：官方图标包在就用它，缺席时退化成内置闪电 path —— 两种都只放一枚。
  const header = frame.find((element) => element.props.style?.gridTemplateColumns === "28px 1fr 28px");
  assert.ok(header !== null, "卡片头是「闪电 / 等级名 / ↻」三列");
  const headerBolt = within(header);
  assert.ok(headerBolt.length > 1, "卡片头左列要有一个图标");
  const boltMarks = headerBolt.filter(thinkPrimitive);
  const boltSvg = headerBolt.filter((element) => element.type === "svg");
  assert.equal(
    boltMarks.length > 0 ? boltMarks.length : boltSvg.length,
    1,
    "左列只放一枚闪电图标（官方图标包在就用它，缺席时用内置 path）",
  );
});

test("apply: 热重载后 <style> 内容刷新到当前版本，标签仍然只有一个", () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const tags = () =>
    runtime.loaded.document.head.children.filter((node) => node.dataset.plugin === "dsh-thinking-slider");

  assert.equal(tags().length, 1);
  // 模拟「页面里还挂着上一版样式」：client-hmr 重载模块时 <style> 不会自己消失。
  tags()[0].textContent = "/* 上一版 */ .dsh-thinking-slider-range { height: 8px }";
  runtime.exports.apply(runtime.ctx);
  assert.equal(tags().length, 1, "重复 apply 不能越热重载越多标签");
  assert.equal(tags()[0].textContent, runtime.internals.RANGE_CSS, "旧 CSS 必须被就地刷新，否则改样式看不到效果");

  // 直接调注入函数同样幂等（且内容已经对齐 → 不再改写）。
  runtime.internals.injectRangeCss();
  runtime.internals.injectRangeCss();
  assert.equal(tags().length, 1);
  assert.equal(tags()[0].textContent, runtime.internals.RANGE_CSS);
  assert.equal(runtime.internals.RANGE_STYLE_TAG, "dsh-thinking-slider/range.css");
});

test("视觉契约: railStyleFor / railBoostAttr / railVarsFor 是组件与静态预览共用的单一定义", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const {
    railStyleFor,
    railBoostOf,
    railBoostAttr,
    railVarsFor,
    RAIL_ROW,
    RAIL_HEIGHT,
    BOOST_EFFORTS,
    TRACK_FILL,
    TRACK_REST,
    TRACK_EDGE,
    DOT_REST,
    DOT_PASSED,
    DOT_BOOST_REST,
    DOT_BOOST_PASSED,
  } = internals;

  // 布局盒只此一份：所有档位都是同一个对象引用 —— 预览与组件不可能各画一套。
  assert.equal(railStyleFor(), RAIL_ROW);
  assert.equal(railStyleFor("low"), RAIL_ROW, "无参函数，传参也不改变结果");
  assert.equal(railStyleFor("xhigh"), RAIL_ROW, "渐变不再走 inline style（否则没法过渡）");
  assert.equal("backgroundImage" in RAIL_ROW, false, "布局盒不该带渐变字段");
  assert.equal(RAIL_ROW.height, `${String(RAIL_HEIGHT)}px`);
  assert.equal(RAIL_ROW.overflow, "visible", "圆钮比轨道高，盒子必须允许溢出");

  // 最高档的判定只此一处：组件与预览都问 railBoostOf / railBoostAttr。
  assert.equal(railBoostOf(undefined), null);
  assert.equal(railBoostOf("low"), null);
  assert.equal(railBoostOf("medium"), null);
  assert.equal(railBoostOf("xhigh"), "true");
  assert.equal(railBoostOf("max"), "true");
  assert.equal(railBoostOf("ultra"), "fast", "ultra 是唯一「更快」的档");
  for (const effort of BOOST_EFFORTS) {
    assert.equal(railBoostOf(effort) === null, false, `${effort} 属于最高档`);
    assert.deepEqual(railBoostAttr(effort), { "data-boost": railBoostOf(effort) });
  }
  assert.deepEqual(railBoostAttr("low"), {}, "低档不挂属性（空对象，而不是 data-boost=undefined）");
  assert.deepEqual(railBoostAttr(undefined), {});
  assert.equal(railBoostAttr("ultra")["data-boost"], "fast");

  // 轨道变量：比例 + 六个颜色变量都挂在滑轨外层；刻度点颜色随最高档换成半透明白。
  const plain = railVarsFor(0.5, "low");
  assert.equal(plain["--dsh-ts-ratio"], "0.5", "比例写字符串，CSS 才能直接吃");
  assert.equal(plain["--dsh-ts-fill-color"], TRACK_FILL);
  assert.equal(plain["--dsh-ts-rest-color"], TRACK_REST);
  assert.equal(plain["--dsh-ts-edge"], TRACK_EDGE);
  assert.equal(plain["--dsh-ts-dot-color"], DOT_REST);
  assert.equal(plain["--dsh-ts-dot-passed-color"], DOT_PASSED);
  const boosted = railVarsFor(1, "xhigh");
  assert.equal(boosted["--dsh-ts-ratio"], "1");
  assert.equal(boosted["--dsh-ts-dot-color"], DOT_BOOST_REST, "叠在渐变上的点必须换白，否则看不清");
  assert.equal(boosted["--dsh-ts-dot-passed-color"], DOT_BOOST_PASSED);
  assert.equal(railVarsFor(0, "ultra")["--dsh-ts-ratio"], "0", "最低档就是 0，不留 6% 起步的余量");
});

test("视觉契约: 连续跟手 + 松手吸附 —— 拖动写 DOM 变量不重渲染、动效可降级", () => {
  const { internals } = boot({ snapshot: threeLevelSnapshot() });
  const { DRAG_STEP, eventValueTarget, rangeValueOf, ratioOf, setStyleVar, setRailTransition } = internals;

  // 1) 步进必须远小于 1：**拖动中**圆钮才能贴着手指落在任意位置（松手再吸附到最近档位）。
  assert.ok(DRAG_STEP > 0 && DRAG_STEP <= 0.05, `步进要小到肉眼看不出格：${DRAG_STEP}`);

  // 2) 事件取值：range 元素上 target 与 currentTarget 是同一个节点，取哪个都行；
  //    但两个都缺时要能安全返回 null（拖动途中节点被卸载）。
  // 真实 DOM 里自定义属性写在 `element.style` 上（`style.setProperty`），
  // 元素本身没有 setProperty —— 桩必须照这个形状来，否则测的是不存在的接口。
  const node = {
    value: "1.37",
    style: {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    },
  };
  assert.equal(eventValueTarget({ currentTarget: node }), node);
  assert.equal(eventValueTarget({ target: node }), node);
  assert.equal(eventValueTarget({}), null, "节点没了也不抛");
  assert.equal(rangeValueOf({ currentTarget: { value: "1.37" } }), 1.37);
  assert.equal(rangeValueOf({ currentTarget: { value: "" } }), null, "空值 → null（不是 0）");
  assert.equal(rangeValueOf({}), null);

  // 3) 拖动中直接写 CSS 变量：一个字都不进 React state，所以整张卡片不重渲染。
  setStyleVar(node, "--dsh-ts-ratio", "0.42");
  assert.equal(node.style["--dsh-ts-ratio"], "0.42");
  //    不支持 setProperty 的老式节点走 style[name] 回退，同样不抛。
  const plainNode = { style: {} };
  setStyleVar(plainNode, "--dsh-ts-ratio", "0.07");
  assert.equal(plainNode.style["--dsh-ts-ratio"], "0.07");
  setStyleVar(undefined, "--dsh-ts-ratio", "0.09");
  setStyleVar({}, "--dsh-ts-ratio", "0.09");

  // 4) 比例由连续位置换算而来：0 / 中点 / 顶档都不留余量（端点内缩交给 CSS 的 calc）。
  assert.equal(ratioOf(0, 2), 0);
  assert.equal(ratioOf(1.9, 2), 0.95, "拖动中位于 1.9 → 填充与圆钮就在 95%（松手后才吸附到 100%）");
  assert.equal(ratioOf(2, 2), 1);

  // 5) 拖动中关掉比例过渡（否则填充会「追着手指跑」而显得拖沓），松手再打开。
  setRailTransition(node, false);
  assert.equal(node.style.transition, "none");
  setRailTransition(node, true);
  assert.equal("transition" in node.style, false, "松手恢复 CSS 里那条 320ms 回弹过渡");
  setRailTransition(plainNode, false);
  assert.equal("transition" in plainNode.style, false, "老式节点没有 setProperty —— 安静跳过，不抛也不脏写");
  setRailTransition(undefined, true);

  // 6) 动效都在 CSS 里，且 prefers-reduced-motion 下全部关掉（无障碍）。
  assert.match(internals.RANGE_CSS, /@property --dsh-ts-ratio/, "填充位置是注册过的自定义属性，才能补间");
  assert.match(internals.RANGE_CSS, /transition: --dsh-ts-ratio 320ms/);
  assert.match(internals.RANGE_CSS, /prefers-reduced-motion: reduce[\s\S]{0,600}animation: none/);
  assert.match(internals.RANGE_CSS, /prefers-reduced-motion: reduce[\s\S]{0,600}transition: none/);
  assert.match(internals.RANGE_CSS, /dsh-ts-level-in/, "换档时档位名淡入");
  assert.match(internals.RANGE_CSS, /dsh-ts-card-in/, "卡片展开时整块淡入");
  assert.match(internals.RANGE_CSS, /dsh-ts-twinkle/, "最高档的星星会闪");
});

test("组件: 拖动中重渲染不把圆钮拽回跨档点；松手后吸附到最近档位中心", async () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const frame = renderCardOpen(runtime);
  const range = rangeOf(frame);
  const rerender = () => renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });

  // 跨档到 high（下标 2）：草稿记下跨档那一刻的 1.6。
  frame.fire(range, "onChange", { currentTarget: { value: "1.6" } });
  assert.equal(rangeOf(rerender()).props.value, 1.6, "跨档后 value 跟到手指位置");

  // 同档内继续拖到 1.9：不 setState（零渲染跟手）。此时若因为别的原因重渲染，
  // value 必须仍读「手指当前位置」而不是草稿里的 1.6，否则圆钮会被拽回去一顿。
  frame.fire(range, "onChange", { currentTarget: { value: "1.9" } });
  const afterFrame = rerender();
  const after = rangeOf(afterFrame);
  assert.equal(after.props.value, 1.9, "重渲染读 lastRaw，不回到跨档点 1.6");
  assert.equal(
    railOf(afterFrame).props.style["--dsh-ts-ratio"],
    "0.95",
    "填充 / 圆钮 / 刻度点共用一个比例：1.9/2 → 0.95（两端不留余量，内缩交给 CSS）",
  );

  // 松手：落点**吸附到最近的档位**（1.9 → 2），提交一次 high。
  frame.fire(range, "onPointerUp", { currentTarget: { value: "1.9" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.directory.calls.length, 1, "松手只提交一次");
  assert.equal(runtime.directory.calls[0].reasoningEffort, "high");
  const snapped = rerender();
  assert.equal(rangeOf(snapped).props.value, 2, "松手吸附到最近的档位（1.9 → 2），不会停在两档之间");
  assert.equal(railOf(snapped).props.style["--dsh-ts-ratio"], "1", "吸附后比例就是档位中心：填充画满、圆钮骑在最右");

  // 权威快照跟上（high）：草稿所在档 == 权威档 → **保留吸附后的落点**，
  // 圆钮就停在档位中心（不再需要「停在手指离开处」那套连续落点）。
  runtime.directory.setSnapshot(threeLevelSnapshot({ current: { reasoningEffort: "high" } }));
  const landed = rangeOf(renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t }));
  assert.equal(landed.props.value, 2, "落点保持，不被权威值拉走");
  assert.equal(landed.props["aria-valuetext"], "High", "档位语义也是 High");
  assert.equal(landed.props["aria-valuetext"], "High");
});

test("组件: 松手吸附 —— 两个方向都吸附到最近的档位，中点向上，两端被夹住", async () => {
  // 每一格独立 boot：滑轨是受控的，用同一个实例连测多个落点会互相污染（草稿还在）。
  // 期望值 = Math.round(落点)，再夹到 [0, lastIndex]：
  //   0.2→0 / 0.4→0 / 0.6→1 / 1.4→1 / 1.5→2（正好中点朝强度更高一侧）/ 1.9→2 / 2.7→2（夹住）。
  const cases = [
    { raw: "0.2", drag: 0.2, expect: 0, why: "刚离开最低档 → 吸回最低档" },
    { raw: "0.4", drag: 0.4, expect: 0, why: "离最低档更近 → 吸回最低档" },
    { raw: "0.6", drag: 0.6, expect: 1, why: "离中档更近 → 吸到中档" },
    { raw: "1.4", drag: 1.4, expect: 1, why: "离中档更近 → 吸到中档" },
    { raw: "1.5", drag: 1.5, expect: 2, why: "正好在中点 → 朝强度更高一侧（与 Math.round 一致）" },
    { raw: "1.9", drag: 1.9, expect: 2, why: "接近最高档 → 吸到最高档" },
    { raw: "2", drag: 2, expect: 2, why: "本来就落在档位上 → 原地不动" },
    { raw: "0", drag: 0, expect: 0, why: "最左端 → 原地不动" },
    { raw: "-0.4", drag: 0, expect: 0, why: "越界（原生 range 不会给，但吸附必须夹住不抛）" },
    { raw: "2.7", drag: 2, expect: 2, why: "越界到最右 → 夹在最后一档" },
  ];

  for (const item of cases) {
    const runtime = boot({ snapshot: threeLevelSnapshot() });
    const view = () => renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
    const frame = renderCardOpen(runtime);
    const range = rangeOf(frame);

    // 拖动中：连续跟手，**不吸附** —— 这就是「流畅度不变」的契约。
    frame.fire(range, "onChange", { currentTarget: { value: item.raw } });
    assert.equal(rangeOf(view()).props.value, item.drag, `拖动中停在 ${item.drag}（不吸附）：${item.why}`);

    // 松手：连续落点被换成最近的档位下标，圆钮吸到档位中心。
    frame.fire(range, "onPointerUp", { currentTarget: { value: item.raw } });
    await new Promise((resolve) => setImmediate(resolve));
    const landed = view();
    assert.equal(rangeOf(landed).props.value, item.expect, `松手 ${item.raw} → 档位 ${item.expect}：${item.why}`);
    assert.equal(
      railOf(landed).props.style["--dsh-ts-ratio"],
      String(item.expect / 2),
      `吸附后的比例 = 档位中心（${item.expect}/2）`,
    );
  }
});

test("组件: 吸附不改提交语义 —— 档位与吸附落点一致，同一档重复提交仍被短路", async () => {
  // 落点 0.6（吸附到 medium，下标 1）恰好等于当前档 → 不发请求；但滑轨必须照样吸附。
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const frame = renderCardOpen(runtime);
  frame.fire(rangeOf(frame), "onPointerUp", { currentTarget: { value: "0.6" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.directory.calls.length, 0, "吸附到当前档 = 空操作，不提交");
  assert.equal(
    rangeOf(renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t })).props.value,
    1,
    "空操作也要把圆钮吸回档位中心（否则看起来像没生效）",
  );

  // 落点 1.9 → high：请求体照旧，且只能发一次。
  const second = boot({ snapshot: threeLevelSnapshot() });
  const secondFrame = renderCardOpen(second);
  secondFrame.fire(rangeOf(secondFrame), "onPointerUp", { currentTarget: { value: "1.9" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(second.directory.calls, [
    { provider: "anthropic", model: "claude-opus-4", reasoningEffort: "high" },
  ], "吸附只改落点，不改请求体、也不多发请求");
});

test("组件: 拖动结束后提交失败 → 草稿丢弃、档位回到权威值", async () => {
  const directory = fakeDirectory({
    snapshot: threeLevelSnapshot(),
    select: async () => ({ ok: false, error: { message: "effort unsupported" } }),
  });
  const runtime = boot({ directory });
  const frame = renderCardOpen(runtime);
  frame.fire(rangeOf(frame), "onPointerUp", { currentTarget: { value: "2" } });
  await new Promise((resolve) => setImmediate(resolve));

  const after = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  assert.equal(rangeOf(after).props.value, 1, "失败后回到权威档（medium=1），不留乐观值");
  assert.ok(textsOf(after.tree, ["p"]).includes("effort unsupported"), "并在卡片里说明原因");
});

/* ------------------------------------------------------------------ *
 * 8. 保命纪律：apply 永不抛
 *
 * 这一节守的是最贵的一条性质：DSH 前端 boot 只要见到任何一个客户端插件入口
 * 非 active（failed / pending 都算）就整体 `throw new Error("web boot: …")`，
 * 页面停在「Failed to load plugins」，应用再也不 mount —— 用户看到的就是
 * 「DSH 打不开、只能杀进程」。所以本插件的 apply / 加载期一个异常都不许漏出去。
 * ------------------------------------------------------------------ */

/** 捕获一段时间内写进 diag 的事件名（reportDiag 走一次 POST fetch）。 */
function captureDiag(run) {
  const events = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    try {
      events.push(JSON.parse(String(init?.body)).event);
    } catch {
      /* 非本插件的请求：忽略 */
    }
    return Promise.resolve({ ok: true });
  };
  try {
    run();
  } finally {
    globalThis.fetch = original;
  }
  return events;
}

test("保命纪律: 服务访问全抛错时 apply 仍然不抛，并把失败写进 diag", () => {
  const { exports } = loadClient();
  const hostile = {
    get() {
      throw new Error('cannot get property "slots" without inject');
    },
    effect() {
      throw new Error('cannot get property "effect" without inject');
    },
    get slots() {
      throw new Error('cannot get property "slots" without inject');
    },
    get locale() {
      throw new Error('cannot get property "locale" without inject');
    },
  };

  const events = captureDiag(() => {
    assert.doesNotThrow(
      () => exports.apply(hostile),
      "apply 抛错 = web boot 整体失败 = DSH 界面打不开（这条断言就是那次崩溃的守卫）",
    );
  });

  assert.ok(events.includes("apply"), `apply 要先留一条诊断，实际=${events.join(",")}`);
  assert.ok(events.includes("seat-error"), `座位注册失败必须留痕，实际=${events.join(",")}`);
});

test("保命纪律: slots 服务缺席 → 安静跳过（seat-skip），不算错误", () => {
  const { exports } = loadClient();
  const bare = { get: () => undefined, effect: () => {}, slots: undefined, locale: undefined };

  const events = captureDiag(() => assert.doesNotThrow(() => exports.apply(bare)));

  assert.ok(events.includes("seat-skip"), `实际=${events.join(",")}`);
  assert.equal(events.includes("seat-error"), false, "「服务还没到」是正常时序，不该记成错误");
});

test("保命纪律: slots.inject / register 抛错也不许冒泡出去", () => {
  const { exports } = loadClient();
  const boom = fakeContext({ directory: fakeDirectory({ snapshot: threeLevelSnapshot() }) });
  boom.slots.inject = () => {
    throw new Error("inject 挂了");
  };
  const events = captureDiag(() => assert.doesNotThrow(() => exports.apply(boom)));
  assert.ok(events.includes("seat-error"));

  const boom2 = fakeContext({ directory: fakeDirectory({ snapshot: threeLevelSnapshot() }) });
  boom2.slots.register = () => {
    throw new Error("register 挂了");
  };
  const events2 = captureDiag(() => assert.doesNotThrow(() => exports.apply(boom2)));
  assert.ok(events2.includes("seat-error"), `实际=${events2.join(",")}`);
});

test("保命纪律: locale 面挂掉不影响座位注册", () => {
  const { exports } = loadClient();
  const ctx = fakeContext({ directory: fakeDirectory({ snapshot: threeLevelSnapshot() }) });
  ctx.locale = {
    register() {
      throw new Error("locale 服务坏了");
    },
  };

  const events = captureDiag(() => assert.doesNotThrow(() => exports.apply(ctx)));

  assert.ok(events.includes("locale-error"));
  assert.equal(ctx._registrations.length, 1, "文案面坏了也要把座位注册上");
  assert.equal(ctx._registrations[0].definition.id, "thinking-slider");
});

test("保命纪律: 官方 primitives 包加载失败时模块照样可装载、apply 不抛", () => {
  const loaded = loadClient({
    require: (id, fallback) => {
      if (id === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("这个包不存在");
      return fallback(id);
    },
  });
  const ctx = fakeContext({ directory: fakeDirectory({ snapshot: threeLevelSnapshot() }) });

  assert.doesNotThrow(() => loaded.exports.apply(ctx), "加载期抛错同样等于「DSH 打不开」");
  assert.equal(ctx._registrations.length, 1, "拿不到官方组件也要把座位注册上（最坏只是座位渲染不出来）");
  assert.equal(ctx._registrations[0].definition.order, 45);
});

test("保命纪律: 座位渲染抛错被错误边界吃掉（只丢这一个座位，diag 留 render-error）", () => {
  const loaded = loadClient({
    require: (id, fallback) => {
      if (id === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("这个包不存在");
      return fallback(id);
    },
  });
  const ctx = fakeContext({ directory: fakeDirectory({ snapshot: threeLevelSnapshot() }) });
  loaded.exports.apply(ctx);

  const events = captureDiag(() => {
    const frame = renderComponent(ctx._registrations[0].component, { sessionId: "s1", t: (key) => key });
    assert.equal(frame.tree, null, "边界兜住之后座位渲染成空，而不是把异常抛给渲染器");
  });

  assert.ok(events.includes("render-error"), `实际=${events.join(",")}`);
});

/* ------------------------------------------------------------------ *
 * 5. 模型选择（接管官方「选择模型」座位，把选模型并进滑条）
 * ------------------------------------------------------------------ */

test("modelChoicesOf: 铺平 groups + 追加不可选的失败行；账户 provider 与官方同口径", () => {
  const { internals } = boot({ snapshot: modelMenuSnapshot() });
  const rows = internals.modelChoicesOf(modelMenuSnapshot());

  assert.deepEqual(
    rows.map((row) => [row.key, row.name, row.active, row.selectable]),
    [
      ["deepseek-account/deepseek-flash", "DeepSeek-V4.1-Flash", true, true],
      ["deepseek-account/deepseek-pro", "DeepSeek-V4.1-Pro", false, true],
      ["anthropic/claude-opus-4", "Opus 4", false, true],
      ["failure/openai", "OpenAI", false, false],
    ],
  );
  assert.equal(rows[0].account, true, "deepseek-account 按官方口径当「账户」");
  assert.equal(rows[0].groupId, "deepseek-account");
  assert.deepEqual(rows[0].efforts, ["low", "medium", "high", "max"], "档位 id 摊平，换模型时用来判断能不能带过去");
  assert.equal(rows[0].reasoning, true);
  assert.equal(rows[2].reasoning, false, "没有 reasoning 字段的模型标成不推理");
  assert.deepEqual(rows[2].efforts, []);
  assert.equal(rows[3].detail, "登录已过期", "失败行的 title 就是官方给的失败原因");
  assert.equal(rows[3].provider, undefined);
});

test("modelChoicesOf: 快照缺字段 / 脏数据一律不抛（座位不能因为这个整段消失）", () => {
  const { internals } = boot({ snapshot: null });
  for (const snapshot of [null, undefined, "nope", 42, {}, { groups: "x", failures: 7 }]) {
    assert.deepEqual(internals.modelChoicesOf(snapshot), []);
  }
  const rows = internals.modelChoicesOf({
    current: null,
    groups: [
      null,
      "nope",
      { id: "p" },
      { id: "p", models: [null, "x", { name: "没有 id" }, { id: "" }, { id: "ok" }, { id: "ok", name: "" }] },
    ],
    failures: [null, "x", { id: "f" }],
  });
  assert.deepEqual(rows.map((row) => row.key), ["p/ok", "p/ok", "failure/f"]);
  assert.deepEqual(rows.map((row) => row.name), ["ok", "ok", "f"], "name 缺失时回退成 id");
  assert.deepEqual(rows.map((row) => row.active), [false, false, false]);
});

test("transferEffort: 目标模型声明了同 id 档位才带过去（官方是一律回默认档，我们有意不同）", () => {
  const { internals } = boot({ snapshot: null });
  const [flash, pro, opus] = internals.modelChoicesOf(modelMenuSnapshot()).slice(0, 3);
  assert.equal(internals.transferEffort(pro, "high"), "high", "Pro 也声明了 high → 保留");
  assert.equal(internals.transferEffort(pro, "medium"), undefined, "Pro 没有 medium → 省略字段，走它自己的默认档");
  assert.equal(internals.transferEffort(opus, "high"), undefined, "不支持推理的模型没有档位可带");
  assert.equal(internals.transferEffort(flash, undefined), undefined);
  assert.equal(internals.transferEffort(null, "high"), undefined);
});

/**
 * 假元素：只实现 client.js 在「接管官方座位」里用到的那几个接口。
 * @param {object} [options] children / parent / menuButton / contains。
 * @returns {object} 假元素。
 */
function fakeNode(options = {}) {
  const attributes = new Map();
  return {
    attributes,
    children: options.children ?? [],
    parentElement: options.parent ?? null,
    contains: (other) => (typeof options.contains === "function" ? options.contains(other) : false),
    querySelector: (selector) => (selector === 'button[aria-haspopup="menu"]' ? options.menuButton ?? null : null),
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  };
}

test("接管官方座位: 判据是「别人的 menu 按钮」，锁定态的官方座位不接管", () => {
  const { internals } = boot({ snapshot: null });
  const self = fakeNode({});
  assert.equal(internals.isNativeModelSeat(fakeNode({ menuButton: { disabled: false } }), self), true);
  assert.equal(internals.isNativeModelSeat(fakeNode({ menuButton: {} }), self), true, "没写 disabled 视为没锁");
  assert.equal(internals.isNativeModelSeat(fakeNode({ menuButton: { disabled: true } }), self), false, "官方锁住了就不碰");
  assert.equal(internals.isNativeModelSeat(fakeNode({}), self), false, "没有 menu 弹层的不是模型座位");
  assert.equal(internals.isNativeModelSeat(self, self), false, "不许把自己藏了");
  assert.equal(
    internals.isNativeModelSeat(fakeNode({ menuButton: {}, contains: (node) => node === self }), self),
    false,
    "包着自己的祖先容器不是座位（那是整排控件）",
  );
  assert.equal(internals.isNativeModelSeat(null, self), false);
});

test("接管官方座位: 从后往前挑最后一个，并沿祖先链最多找 6 层", () => {
  const { internals } = boot({ snapshot: null });
  const self = fakeNode({});
  const branch = fakeNode({ menuButton: { disabled: false } }); // 别家插件挂在同一排的分支选择器
  const native = fakeNode({ menuButton: { disabled: false } });
  assert.equal(internals.pickNativeSeat([branch, self, native], self), native, "官方座位是这一排的最后一个");
  assert.equal(internals.pickNativeSeat([branch, self], self), branch, "官方座位不在时退给同排的菜单按钮（只会藏一个）");
  assert.equal(internals.pickNativeSeat([self], self), null);
  assert.equal(internals.pickNativeSeat(null, self), null);

  // 真实 DOM：自己的 parent 还是插槽容器，再往上一层才是整排控件。
  const wrapper = fakeNode({ children: [self] });
  const row = fakeNode({ children: [wrapper, native] });
  const outer = fakeNode({ children: [row] });
  self.parentElement = wrapper;
  wrapper.parentElement = row;
  row.parentElement = outer;
  assert.equal(internals.nativeSeatOf(self), native, "要能穿过插槽容器找到整排控件里的官方座位");

  // 满 6 层还找不到 → null（降级：官方控件留着，界面上只是多一枚 chip）。
  let deep = native;
  for (let at = 0; at < 8; at += 1) deep = fakeNode({ children: [deep] });
  assert.equal(internals.nativeSeatOf(deep), null);
});

test("接管官方座位: 打标记 / 撤标记都是幂等的，找不到座位时安静返回 null", () => {
  const { internals } = boot({ snapshot: null });
  const self = fakeNode({});
  const native = fakeNode({ menuButton: { disabled: false } });
  const row = fakeNode({ children: [self, native] });
  self.parentElement = row;

  assert.equal(internals.hideNativeSeat(self), native);
  assert.equal(native.attributes.get(internals.NATIVE_SEAT_ATTR), "hidden", "CSS 就是按这个属性藏掉官方 chip");
  assert.equal(internals.NATIVE_SEAT_ATTR, "data-dsh-thinking-slider-native");

  internals.showNativeSeat(native);
  assert.equal(native.attributes.has(internals.NATIVE_SEAT_ATTR), false, "卸载时把官方控件原样还回去");
  assert.doesNotThrow(() => internals.showNativeSeat(null));
  assert.equal(internals.hideNativeSeat(null), null);
  assert.equal(internals.hideNativeSeat(fakeNode({})), null, "自己的 parent 链上什么都没有 → 不藏任何东西");
});

test("组件: 卡头里的模型行点开就是模型清单（官方菜单的同一份数据 + 分组标题）", () => {
  const runtime = boot({ snapshot: modelMenuSnapshot() });
  const frame = renderCardOpen(runtime);

  const row = frame.find((element) => element.props.className === "dsh-thinking-slider-model-row");
  assert.ok(row !== null, "卡头里应当有一行模型选择");
  assert.equal(row.props["aria-haspopup"], "listbox");
  assert.equal(row.props["aria-expanded"], false);
  assert.equal(row.props["aria-label"], "选择模型");
  assert.ok(allTexts(row).includes("DeepSeek-V4.1-Flash"), "模型行显示当前模型名");
  // 清单**常驻 DOM**（收起 ⇄ 展开两个方向都要有内容可过渡），所以「默认不展开」
  // 看的是开关与遮挡，而不是节点在不在。
  const closedReveal = frame.find((element) => element.props.className === "dsh-thinking-slider-models-reveal");
  assert.ok(closedReveal !== null, "清单常驻 DOM（过渡需要两个方向都有内容）");
  assert.equal(closedReveal.props["data-open"], "false", "默认不展开");
  assert.equal(closedReveal.props["aria-hidden"], "true", "收起态对读屏不可见");
  assert.ok(
    walk(closedReveal).every((element) => element.props.role !== "option" || element.props.tabIndex === -1),
    "收起态清单里的按钮不进 Tab 序列",
  );

  frame.fire(row, "onClick");
  const opened = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  const list = opened.find((element) => element.props.className === "dsh-thinking-slider-models");
  assert.ok(list !== null, "点一下就要展开清单");
  assert.equal(list.props.role, "listbox");
  const openReveal = opened.find((element) => element.props.className === "dsh-thinking-slider-models-reveal");
  assert.equal(openReveal.props["data-open"], "true");
  assert.equal(openReveal.props["aria-hidden"], undefined, "展开后不再遮挡读屏");
  assert.ok(
    walk(list).filter((element) => element.props.role === "option").every((element) => element.props.tabIndex === undefined),
    "展开后按钮恢复 Tab 停靠",
  );
  assert.deepEqual(optionLabels(list), ["DeepSeek-V4.1-Flash", "DeepSeek-V4.1-Pro", "Opus 4", "OpenAI"]);
  assert.deepEqual(optionSelected(list), [true, false, false, false], "当前项打勾");
  const items = walk(list).filter((element) => element.props.role === "option");
  assert.equal(items[3].props.disabled, true, "加载失败的 provider 不可选");
  assert.equal(items[3].props.title, "登录已过期");
  assert.equal(items[0].props.disabled, false);
  assert.deepEqual(groupHeadings(list, runtime.internals), ["账户", "Anthropic"], "两个 provider → 画分组标题");
});

test("组件: 模型清单「收起 ⇄ 展开」是过渡（常驻 DOM + data-open 驱动 grid-template-rows，卡片跟着长/缩）", () => {
  const runtime = boot({ snapshot: modelMenuSnapshot() });
  const frame = renderCardOpen(runtime);
  const revealOf = (node) => node.find((element) => element.props.className === "dsh-thinking-slider-models-reveal");
  const rowOf = (node) => node.find((element) => element.props.className === "dsh-thinking-slider-model-row");

  // 三层结构：reveal（开关 + 高度）→ clip（裁切 + 给负 margin 留位）→ models（淡入淡出）。
  const closed = revealOf(frame);
  assert.ok(closed !== null, "卡片关着也有清单节点（常驻）");
  assert.equal(closed.children.length, 1, "reveal 里只有一层 clip");
  const clip = closed.children[0];
  assert.equal(clip.props.className, "dsh-thinking-slider-models-clip");
  const list = clip.children[0];
  assert.equal(list.props.className, "dsh-thinking-slider-models");
  assert.equal(list.props.role, "listbox");
  assert.equal(closed.props["data-open"], "false");

  frame.fire(rowOf(frame), "onClick");
  const opened = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  const openReveal = revealOf(opened);
  assert.equal(openReveal.props["data-open"], "true");
  // 同一个节点（不重挂）：过渡才能从当前值接着走，而不是每次都从头播。
  assert.equal(openReveal.children[0].props.className, clip.props.className);
  assert.equal(openReveal.children[0].children[0].props.role, "listbox");

  // CSS：高度用 `grid-template-rows: 0fr ↔ 1fr`（这是让「高度 auto」也能过渡的写法，
  // 所以卡片本身也会长/缩），清单本体淡入 + 下移，减弱动效时全部关掉。
  const { RANGE_CSS } = runtime.internals;
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-models-reveal\s*\{[^}]*grid-template-rows: 0fr[^}]*transition: grid-template-rows/);
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-models-reveal\[data-open="true"\]\s*\{\s*grid-template-rows: 1fr/);
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-models-clip\s*\{[^}]*min-height: 0[^}]*overflow: hidden/);
  assert.match(RANGE_CSS, /\.dsh-thinking-slider-models\s*\{[^}]*opacity: 0[^}]*transition: opacity/);
  assert.match(RANGE_CSS, /\[data-open="true"\]\s*\.dsh-thinking-slider-models\s*\{[^}]*opacity: 1/);
  // reveal 夹在 gap: 10px 的内容列中间，收起时必须抵掉一条 gap（否则卡片高 10px）。
  assert.match(RANGE_CSS, /\[data-open="false"\]\s*\{\s*margin-bottom: -10px/, "收起时抵掉一条 flex gap，卡片高度不变");
  assert.match(RANGE_CSS, /transition: grid-template-rows 300ms[^}]*margin-bottom 300ms/s, "这条补偿也要过渡，开合才不跳");
  assert.match(RANGE_CSS, /prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.dsh-thinking-slider-models-reveal,/);
  // 常驻之后，挂载动画只会播一次（再也没有第二次挂载），开合必须全靠过渡。
  assert.doesNotMatch(RANGE_CSS, /\.dsh-thinking-slider-models \{[^}]*animation:/);
});

test("组件: 只有一个 provider 时不画分组标题（纯噪音）", () => {
  const runtime = boot({ snapshot: threeLevelSnapshot() });
  const frame = renderCardOpen(runtime);
  const row = frame.find((element) => element.props.className === "dsh-thinking-slider-model-row");
  frame.fire(row, "onClick");
  const opened = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  const list = opened.find((element) => element.props.className === "dsh-thinking-slider-models");
  assert.deepEqual(optionLabels(list), ["Opus 4"]);
  assert.deepEqual(groupHeadings(list, runtime.internals), []);
});

test("组件: 点清单里的另一个模型 → 提交 {provider, model}，同 id 档位带过去（High 还是 High）", async () => {
  const runtime = boot({ snapshot: modelMenuSnapshot() }); // 当前 deepseek-flash @ high
  const frame = renderCardOpen(runtime);
  frame.fire(frame.find((element) => element.props.className === "dsh-thinking-slider-model-row"), "onClick");
  const opened = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  const list = opened.find((element) => element.props.className === "dsh-thinking-slider-models");
  const pro = walk(list).filter((element) => element.props.role === "option")[1];

  opened.fire(pro, "onClick");
  // pickModel → sendSelection → directory.select 之间有三层 await，多转几个微任务再断言。
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
  assert.deepEqual(runtime.directory.calls, [
    { provider: "deepseek-account", model: "deepseek-pro", reasoningEffort: "high" },
  ]);

  // 提交成功后清单收起（换模型是一次性的动作，不该留着一堆展开的列表）——
  // 收起是过渡，节点仍在，开关回 false。
  const after = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  assert.equal(
    after.find((element) => element.props.className === "dsh-thinking-slider-models-reveal").props["data-open"],
    "false",
  );
});

test("组件: 目标模型不支持推理等级 → 请求体里整个没有 reasoningEffort 字段", async () => {
  const runtime = boot({ snapshot: modelMenuSnapshot() });
  const frame = renderCardOpen(runtime);
  frame.fire(frame.find((element) => element.props.className === "dsh-thinking-slider-model-row"), "onClick");
  const opened = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  const list = opened.find((element) => element.props.className === "dsh-thinking-slider-models");
  const opus = walk(list).filter((element) => element.props.role === "option")[2];

  opened.fire(opus, "onClick");
  await Promise.resolve();
  assert.deepEqual(runtime.directory.calls, [{ provider: "anthropic", model: "claude-opus-4" }]);
  assert.equal("reasoningEffort" in runtime.directory.calls[0], false, "省略即「用目标模型的默认档」");
});

test("组件: 点当前模型 / 点不可选的失败行 → 都不发请求", async () => {
  const runtime = boot({ snapshot: modelMenuSnapshot() });
  const frame = renderCardOpen(runtime);
  frame.fire(frame.find((element) => element.props.className === "dsh-thinking-slider-model-row"), "onClick");
  const opened = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  const list = opened.find((element) => element.props.className === "dsh-thinking-slider-models");
  const items = walk(list).filter((element) => element.props.role === "option");

  opened.fire(items[0], "onClick"); // 当前模型
  opened.fire(items[3], "onClick"); // 加载失败的 provider
  await Promise.resolve();
  assert.equal(runtime.directory.calls.length, 0, "当前模型与失败行都不该提交");
});

test("组件: 换模型失败 → 卡片里报错、清单不收（用户能直接改选另一个）", async () => {
  const runtime = boot({
    snapshot: modelMenuSnapshot(),
    directory: fakeDirectory({
      snapshot: modelMenuSnapshot(),
      select: () => ({ ok: false, error: { message: "没有权限" } }),
    }),
  });
  const frame = renderCardOpen(runtime);
  frame.fire(frame.find((element) => element.props.className === "dsh-thinking-slider-model-row"), "onClick");
  const opened = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  const list = opened.find((element) => element.props.className === "dsh-thinking-slider-models");
  opened.fire(walk(list).filter((element) => element.props.role === "option")[1], "onClick");
  await Promise.resolve();

  const failed = renderComponent(runtime.Component, { sessionId: "s1", t: runtime.t });
  assert.ok(allTexts(failed.tree).includes("没有权限"), "卡片里显示失败原因");
  assert.ok(failed.find((element) => element.props.className === "dsh-thinking-slider-models") !== null, "清单留着让用户改选");
});
