/**
 * dsh-thinking-slider 单测脚手架。
 *
 * 浏览器半边是个 CJS 工厂（`window.__ModuleLoader__.load({id, factory})`），
 * factory 里 `require("react")` / `require("@deepseek-ai/dsh-client-ui-primitives")`。
 * 纯 Node 里两头都拿不到：
 *   - `react` / `react-dom` 不在引擎 node_modules 的可解析路径上；
 *   - primitives 是带 CSS 导入的 ESM 包，`require` 直接炸。
 * 所以这里造一层最小替身：够组件跑完一次渲染、够事件回调被调用即可，
 * 不断言任何真实 React 行为（那属于官方包的测试范围）。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

/** 每个 effect 依次排队，由测试显式 flush —— 不模拟 React 的调度时机。 */
let effects = [];

/**
 * 「帧」与会话状态：
 *   替身 React 不实现真实的 hook 状态保存，但如果每次调用都从零开始，
 *   测试就没法模拟「点开卡片 → 同一次交互里继续拖滑轨」。所以这里给每个被渲染的
 *   组件函数挂一个按调用序号索引的状态表：只要还在渲染同一个组件函数，state/ref
 *   就跨帧保留 —— 与真实 React 对同一实例的行为一致（组件重新挂载时由测试自己
 *   用 renderComponent 重开一帧，语义上等于卸载重挂）。
 */
let currentOwner = null;
const OWNER_STATE = new WeakMap();
/** 类组件实例：按组件类型复用，模拟 React 对同一实例的跨帧保留。 */
const CLASS_INSTANCES = new WeakMap();

function hookOwner() {
  if (currentOwner === null) throw new Error("hook called outside of renderComponent()");
  let state = OWNER_STATE.get(currentOwner);
  if (state === undefined) {
    state = { cursor: 0, values: [], refs: [], deps: [] };
    OWNER_STATE.set(currentOwner, state);
  }
  return state;
}

/** 每次渲染开始前把 hook 游标归零（但保留已保存的值）。 */
function beginRender(owner) {
  currentOwner = owner;
  const state = hookOwner();
  state.cursor = 0;
  return state;
}

const react = {
  Fragment: Symbol("react.fragment"),
  /** 类组件基类（错误边界要用 `extends react.Component`）。 */
  Component: class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }

    setState(next) {
      this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) };
    }
  },
  createElement(type, props, ...children) {
    const flat = [];
    for (const child of children) {
      if (Array.isArray(child)) flat.push(...child);
      else flat.push(child);
    }
    return { $$dshElement: true, type, props: props ?? {}, children: flat };
  },
  useState(initial) {
    const state = hookOwner();
    const slot = state.cursor++;
    if (!(slot in state.values)) {
      state.values[slot] = typeof initial === "function" ? initial() : initial;
    }
    const set = (next) => {
      const previous = state.values[slot];
      state.values[slot] = typeof next === "function" ? next(previous) : next;
    };
    return [state.values[slot], set];
  },
  useMemo(factory) {
    hookOwner().cursor += 1;
    return factory();
  },
  useCallback(fn) {
    hookOwner().cursor += 1;
    return fn;
  },
  useRef(initial) {
    const state = hookOwner();
    const slot = state.cursor++;
    if (!(slot in state.refs)) state.refs[slot] = { current: initial };
    return state.refs[slot];
  },
  useEffect(fn, deps) {
    const state = hookOwner();
    const slot = state.cursor++;
    const previous = state.deps[slot];
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps.length !== previous.length ||
      deps.some((dep, index) => !Object.is(dep, previous[index]));
    state.deps[slot] = deps;
    if (changed) effects.push({ fn, deps });
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    // 真实 React 在这里订阅；测试关心的是「读到的快照对不对」。
    // 订阅回调由 directory 替身触发，测试自己重新渲染一帧来观察结果。
    hookOwner().cursor += 1;
    if (typeof subscribe === "function") subscribe(() => {});
    return getSnapshot();
  },
};

const reactDom = {
  /** portal 在测试里退化成「占位元素」，渲染树遍历器照样进得去。 */
  createPortal(children, container) {
    return { $$dshElement: true, $$portal: true, container, type: "portal", props: {}, children: [children] };
  },
};

/** primitives 替身：每个导出都是可渲染的占位组件，透传 children。 */
const primitiveNames = [
  "Button",
  "HoverCard",
  "IconChevronDownOutlineRegular",
  "IconChevronUpOutlineRegular",
  "IconLoadingOutlineRegular",
  "IconThinkOutlineRegular",
  "MenuSurface",
  "StateDot",
  "Toast",
  "Tooltip",
  "useAnchoredPosition",
  "useDismissOnOutsidePointer",
];

const primitives = {};
for (const name of primitiveNames) {
  if (name.startsWith("use")) continue;
  // 注意：标记走 data-primitive，不能占用 aria-label —— 测试要靠 aria-label 定位真实控件。
  const Stub = (props) =>
    react.createElement("div", { ...props, "data-primitive": name }, props.children);
  Stub.displayName = `Stub(${name})`;
  primitives[name] = Stub;
}
// 锚点定位 / 外部点击关闭：测试里都退化成空实现。
primitives.useAnchoredPosition = () => ({ left: 12, top: 12 });
primitives.useDismissOnOutsidePointer = () => {};

/** 极简 document：client.js 只用到 createElement / querySelector / head.appendChild。 */
export function fakeDocument() {
  const head = { children: [], appendChild(node) { head.children.push(node); } };
  return {
    head,
    body: {},
    /** 只认 `style[data-plugin-css="..."]` 这一种选择器 —— client.js 的幂等注入查询。 */
    querySelector(selector) {
      const match = /^(?:style)?\[data-plugin-css="(.*)"\]$/.exec(String(selector));
      if (match === null) return null;
      return head.children.find((node) => node.dataset?.pluginCss === match[1]) ?? null;
    },
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), dataset: {}, textContent: "", style: {} };
    },
  };
}

/**
 * 装载 client.js，返回它挂在 `module.exports` 上的东西。
 *
 * 真实浏览器里 `factory` **只拿到 `require` 一个参数**，模块的对外接口就是
 * factory 的**返回值**（`dsh-client-modules/lib/client.js` 的 `materialize()`：
 * `exports: registered.factory(this.makeRequire(ownerId, edges))`）。所以这里
 * 刻意不注入 `module` / `exports`：factory 里若直接引用它们，会像浏览器里一样
 * 抛 `ReferenceError`。官方 bundle 与 dsh-flow-control 都在 factory 顶部自己
 * 声明 `var module = { exports: {} }; var exports = module.exports;`。
 * @param {{window?: object, document?: object}} [options]
 */
export function loadClient(options = {}) {
  const source = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
  const documentStub = options.document ?? fakeDocument();
  let captured = null;
  const windowStub = options.window ?? {
    __ModuleLoader__: {
      load(definition) {
        captured = definition;
      },
    },
  };
  const baseRequire = (id) => {
    if (id === "react") return react;
    if (id === "react-dom") return reactDom;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`unexpected require(${id})`);
  };
  // `options.require` 让用例能模拟「官方包加载失败」（第 2 个参数是原始 shim）。
  const requireShim =
    typeof options.require === "function" ? (id) => options.require(id, baseRequire) : baseRequire;
  const runner = new Function("window", "document", "require", source);
  runner(windowStub, documentStub, requireShim);
  if (captured === null) throw new Error("client.js did not call window.__ModuleLoader__.load");
  const exported = captured.factory(requireShim);
  if (typeof exported !== "object" || exported === null || typeof exported.apply !== "function") {
    throw new Error("client.js factory 的返回值里没有 apply —— 模块接口的形状不对");
  }
  return { exports: exported, definition: captured, document: documentStub, window: windowStub };
}

/** 渲染树遍历：把 createElement 的元素树按前序摊平。 */
export function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (!node.$$dshElement) return out;
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

/** 取第一个满足条件的元素（含 portal 内部）。 */
export function findElement(node, predicate) {
  return walk(node).find(predicate) ?? null;
}

/** 按 aria-label 找元素 —— 组件里每个可点元素都有 label，测试就靠它定位。 */
export function findByLabel(node, label) {
  return findElement(node, (element) => element.props["aria-label"] === label);
}

/** 找到那个 `<input type="range">`。 */
export function findRange(node) {
  return findElement(node, (element) => element.type === "input" && element.props.type === "range");
}

/** 触发一个 React 事件 prop（onClick / onChange / onPointerUp …）。 */
export function fire(element, handlerName, event = {}) {
  const handler = element?.props?.[handlerName];
  if (typeof handler !== "function") {
    throw new Error(`element ${String(element?.type)} has no ${handlerName} handler`);
  }
  // 真实 DOM 里 range 这类元素的 `target` 与 `currentTarget` 是**同一个** input，
  // client.js 的拖动逻辑因此只看 currentTarget。这里保持一致：调用方给了哪个就用哪个，
  // 两个字段指向同一个对象 —— 否则「该读 target 还是 currentTarget」在测试里会给出不同答案。
  const el = event.currentTarget ?? event.target ?? element.props;
  return handler({ ...event, currentTarget: el, target: el });
}

/**
 * 展开函数组件与类组件：把元素树里的自定义组件就地渲染成宿主元素。
 *
 * 真实 React 会这么干；替身 React 也必须这么干，否则 `SliderBoundary` 那层
 * 错误边界会把里面的控件挡住。类组件按类型复用同一个实例（state 跨帧保留）。
 * @param {object} node - 元素 / 元素数组 / 文本。
 * @returns {object} 展开后的树。
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expand);
  if (!node.$$dshElement) return node;
  const type = node.type;
  if (typeof type === "function") {
    const props = {
      ...node.props,
      children: node.children.length === 1 ? node.children[0] : node.children,
    };
    const isClass = typeof type.prototype?.render === "function";
    if (isClass) {
      let instance = CLASS_INSTANCES.get(type);
      if (instance === undefined) {
        instance = new type(props);
        CLASS_INSTANCES.set(type, instance);
      } else {
        instance.props = props;
      }
      if (instance.state !== null && typeof instance.state === "object" && instance.state.failed === true) return null;
      const rendered = instance.render();
      try {
        return expand(rendered);
      } catch (error) {
        // 替身 React 也要实现错误边界：真 React 里子组件渲染抛错会被
        // `getDerivedStateFromError` 接住（`SliderBoundary` 就靠这个把整站保住）。
        const derive = type.getDerivedStateFromError;
        if (typeof derive !== "function") throw error;
        instance.state = { ...(instance.state ?? {}), ...derive(error) };
        if (typeof instance.componentDidCatch === "function") instance.componentDidCatch(error, {});
        return null;
      }
    }
    const saved = currentOwner;
    beginRender(type);
    try {
      return expand(type(props));
    } finally {
      currentOwner = saved;
    }
  }
  const children = node.children.map(expand).filter((child) => child !== null && child !== undefined);
  // Fragment / portal 里什么都没有 ⇒ 整段不渲染（真实 React 的语义），
  // 否则「组件返回 null」会被外面那层错误边界包装成一个空壳元素。
  if (children.length === 0 && (typeof node.type === "symbol" || node.type === "portal")) return null;
  return { ...node, children };
}

/**
 * 单次渲染：跑一遍组件函数，收集 effect，返回元素树与工具函数。
 * `flushEffects()` 把 effect 排队执行一次（副作用里的 setState 由替身即时生效），
 * 测试需要「副作用跑完后的树」时再渲染一次即可。
 */
export function renderComponent(component, props) {
  effects = [];
  if (typeof component !== "function") throw new Error(`renderComponent: component 不是函数（收到 ${typeof component}）`);
  const tree = expand({ $$dshElement: true, type: component, props: props ?? {}, children: [] });
  const flushEffects = () => {
    const queue = effects;
    effects = [];
    for (const { fn } of queue) fn();
  };
  return {
    tree,
    flushEffects,
    find: (predicate) => findElement(tree, predicate),
    byLabel: (label) => findByLabel(tree, label),
    range: () => findRange(tree),
    /** 触发这一帧里某个元素的事件处理 —— 见 client.test.mjs 里关于「帧」的说明。 */
    fire: (element, handlerName, event = {}) =>
      fire(element, handlerName, event),
  };
}

/**
 * 造一个 `ModelDirectory` 替身：store 快照可换、select 可记录 / 可失败。
 * @param {object} [options]
 * @param {object} [options.snapshot] 初始快照。
 * @param {(...args:any[])=>any} [options.select] select 实现（默认成功）。
 */
export function fakeDirectory(options = {}) {
  let snapshot = options.snapshot ?? null;
  const listeners = new Set();
  const calls = [];
  const directory = {
    calls,
    loadCount: 0,
    load() {
      directory.loadCount += 1;
      return Promise.resolve();
    },
    store: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async select(selection) {
      calls.push(selection);
      if (typeof options.select === "function") return options.select(selection);
      return { ok: true };
    },
    /** 测试用：换快照并通知订阅者。 */
    setSnapshot(next) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
  return directory;
}

/**
 * 造一个客户端 ctx 替身（slots / modelDirectories / locale / effect）。
 * @param {{directory?: object|null, directoryFor?: Function}} [options]
 * @param {object|null} [options.directory] 默认返回的目录替身。
 * @param {Function} [options.directoryFor] 自定义 `directoryFor(sessionId)`（可用来模拟抛错）。
 */
export function fakeContext(options = {}) {
  const directory = options.directory ?? null;
  const registrations = [];
  const dictionaries = [];
  const injections = [];
  const deregistrations = [];
  const ctx = {
    _dictionaries: dictionaries,
    _injections: injections,
    _registrations: registrations,
    _deregistrations: deregistrations,
    get(name) {
      if (name === "modelDirectories") return ctx.modelDirectories;
      return undefined;
    },
    modelDirectories: {
      directoryFor: (sessionId) => (typeof options.directoryFor === "function" ? options.directoryFor(sessionId, directory) : directory),
    },
    locale: {
      register(namespace, dict) {
        dictionaries.push({ namespace, dict });
      },
    },
    effect(fn) {
      return typeof fn === "function" ? fn() : undefined;
    },
    slots: {
      inject(name, register) {
        // 真实插槽注册表就是在 inject 时把回调跑起来的（回调返回 deregister 句柄）。
        injections.push({ name, register });
        const dispose = register();
        deregistrations.push(dispose);
      },
      register(definition, component) {
        registrations.push({ definition, component });
        return () => {};
      },
    },
  };
  return ctx;
}

/** 组装一套完整 fixture：装载模块 → apply → 触发插槽注册，返回各部件。 */
export function boot(options = {}) {
  const loaded = loadClient();
  const directory = options.directory ?? fakeDirectory({ snapshot: options.snapshot });
  const ctx = fakeContext({ directory, directoryFor: options.directoryFor });
  loaded.exports.apply(ctx);
  const registration = ctx._registrations[0] ?? null;
  const Component = registration === null ? null : registration.component;
  const internals = loaded.exports.__internals;
  return {
    loaded,
    exports: loaded.exports,
    directory,
    ctx,
    registration,
    Component,
    internals,
    t: (key, params) => {
      const dict = ctx._dictionaries[0]?.dict?.zh ?? {};
      let text = dict[key] ?? key;
      for (const [name, value] of Object.entries(params ?? {})) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
      return text;
    },
  };
}

/** 常用快照：一个三段等级的模型（low / medium / high，默认 medium）。 */
export function threeLevelSnapshot(overrides = {}) {
  return {
    current: { provider: "anthropic", model: "claude-opus-4", reasoningEffort: "medium", ...(overrides.current ?? {}) },
    groups: overrides.groups ?? [
      {
        id: "anthropic",
        name: "Anthropic",
        models: [
          {
            id: "claude-opus-4",
            name: "Opus 4",
            reasoning: {
              defaultEffort: "medium",
              efforts: [
                { id: "low", name: "Low" },
                { id: "medium", name: "Medium" },
                { id: "high", name: "High" },
              ],
            },
          },
        ],
      },
    ],
    status: overrides.status ?? "ready",
    pending: overrides.pending ?? null,
  };
}

/**
 * 常用快照：两个 provider（其中一个官方**账户** provider）+ 一个加载失败的 provider。
 *
 * 用来测卡片里的模型清单：`deepseek-account` 要按官方口径显示成「账户」，
 * 有两个 provider 时才画分组标题，加载失败的 provider 只能是一条不可选行。
 * 结构照抄官方 `optionsOf`（`dsh-client-ui-model-selection/lib/client.js:1145-1162`）
 * 吃的那份 `ModelDirectory` 快照。
 * @param {object} [overrides] 覆盖 current / groups / failures / status / pending。
 * @returns {object} 目录快照。
 */
export function modelMenuSnapshot(overrides = {}) {
  return {
    current: { provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high", ...(overrides.current ?? {}) },
    groups: overrides.groups ?? [
      {
        id: "deepseek-account",
        name: "DeepSeek",
        models: [
          {
            id: "deepseek-flash",
            name: "DeepSeek-V4.1-Flash",
            reasoning: {
              defaultEffort: "medium",
              efforts: [
                { id: "low", name: "Low" },
                { id: "medium", name: "Medium" },
                { id: "high", name: "High" },
                { id: "max", name: "Max" },
              ],
            },
          },
          {
            id: "deepseek-pro",
            name: "DeepSeek-V4.1-Pro",
            reasoning: {
              defaultEffort: "high",
              efforts: [{ id: "high", name: "High" }, { id: "ultra", name: "Ultra" }],
            },
          },
        ],
      },
      {
        id: "anthropic",
        name: "Anthropic",
        models: [{ id: "claude-opus-4", name: "Opus 4" }],
      },
    ],
    failures: overrides.failures ?? [{ id: "openai", name: "OpenAI", message: "登录已过期" }],
    status: overrides.status ?? "ready",
    pending: overrides.pending ?? null,
  };
}
