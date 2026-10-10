/**
 * dsh-thinking-slider —— 浏览器半边（`window.__ModuleLoader__` 客户端模块）。
 *
 * 把「推理强度」从官方模型菜单里的二级列表点选，补成一个可以**拖**的控件：
 * 输入框右侧直接拖一条滑轨选档。**外观与交互对齐新版 ChatGPT 的
 * 「思考时长（Thinking time）」滑条**：
 *   - 触发按钮 = composer 里的中性文字 chip（**没有彩色圆点**）+ 一枚思考图标
 *     + chevron，悬停/展开时才出现浅灰底；
 *   - 展开后是**单色胶囊滑轨**：已填充段 = 文字色 18%、未填充段 = 文字色 7%，
 *     外圈 1px 极淡描边，白色圆形滑块 + 投影，按住时圆钮外扩一圈光晕；
 *   - 轨道上画**刻度点**（白钮行程上的每一档一颗），档位范围另由轨道两端的档位名表达；
 *   - 只有最高档（`effort` 属于 `xhigh` / `max` / `ultra`）才换成品牌渐变 +
 *     轻微流动与辉光 —— 与 GPT 对最高思考档的高亮一致，其余档位保持纯单色。
 *
 * 功能
 *   1. **滑轨**（`conversation.input.right`，输入框右侧控件区）
 *      拖动时滑轨即时跟手（本地草稿态），松手**吸附到最近的档位**并提交一次
 *      `sessions.selectModel({ reasoningEffort })` —— 拖一次只发一次请求，
 *      不会把中间经过的等级逐个写进会话。
 *      吸附发生在**松手那一刻**：拖动中不动它（否则一格一格跳，跟手感就没了），
 *      松手后用 CSS 里那条 320ms 回弹过渡滑到最近档位中心，圆钮不会停在两档之间。
 *   2. **键盘方向键**：滑轨是原生 `input[type=range]`，
 *      Home/End/←/→/PageUp/PageDown 全部按等级吸附，按键后提交一次。
 *   3. **档位文案**：档位名（Ultra / High / Medium / Low / Minimal…）显示在
 *      卡片标题行与滑轨两端。
 *   4. **并发保护与竞态收敛**：正在提交时 `aria-busy` + 滑轨禁用，同时用
 *      序号（generation）丢弃迟到的响应，避免「连点两下 High/Low，先发的
 *      后落」把级别回退成中间值。
 *   5. **provider 默认档**：模型声明 `defaultEffort` 时，额外给出最左一档
 *      「默认」，语义与官方菜单里的 Default 完全一致。
 *
 * 与官方 UI 的关系
 *   - **不替换** `conversation.input.model` 那个官方模型座位，只在它左边追加
 *     一个紧凑控件；官方菜单里的「推理等级」二级列表照旧可用。
 *   - 数据与写入都借官方客户端服务：
 *     `ctx.modelDirectories.directoryFor(sessionId)`（等级目录、当前 provider /
 *     model / effort、pending / error 全在这一个 snapshot store 上）与
 *     `directory.select(selection)`（内部就是 `sessions.selectModel`）。
 *     本插件不写会话日志、不改宿主状态。
 *
 * 两条踩过坑的接线纪律（照抄同仓 dsh-flow-control 的可用写法）
 *   - `inject` 只声明 `["slots"]`：声明了却没到的服务会让插件**永远 pending**，
 *     界面上表现为「什么都没有」，而且没有任何报错。模型目录服务由官方
 *     model-selection 插件按需提供，可能后到，所以这里用轮询等待（`useDirectory`）。
 *   - 座位注册**不声明 `locale` 命名空间**：官方渲染器在「座位声明了命名空间
 *     但当下没有文案面」时会抛 SlotAssemblyError，整个座位直接不显示。文案因此
 *     走本文件内置的中文兜底（`t === null` 分支）。
 *
 * 诊断通道
 *   手机 WebView 没有 devtools，控件「没显示」时无法取证，所以 apply / 注册 /
 *   目录就绪 / 座位渲染 / 渲染异常都会 POST 到宿主路由 `/dsh-thinking-slider/diag`
 *   （见 lib/index.js，落到 `$DSH_HOME/thinking-slider-diag.log`）。纯排障旁路。
 *
 * @module dsh-thinking-slider/client
 */

window.__ModuleLoader__.load({
  id: "dsh-thinking-slider",
  factory: (require) => {
    // 模块接口 = 本 factory 的返回值。`require` 是 factory 唯一拿到的参数，
    // 浏览器里没有 `module` / `exports` 这两个自由变量（dsh-client-modules 的
    // materialize() 只传 require、只取返回值），所以必须自己声明。
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    // 官方包加载失败也只能降级（见 loadPrimitives）：加载期抛错同样等于「DSH 打不开」。
    const primitives = loadPrimitives(require);

    const {
      IconChevronDownOutlineRegular,
      IconChevronUpOutlineRegular,
      IconLoadingOutlineRegular,
      IconThinkOutlineRegular,
      MenuSurface,
      Toast,
      Tooltip,
      useAnchoredPosition,
      useDismissOnOutsidePointer,
    } = primitives;

    /**
     * 思考图标：primitives 缺席时退化成「不画图标」，而不是让 createElement
     * 拿到 undefined（那会抛错，把整个座位打成空白）。
     */
    const ThinkIcon =
      IconThinkOutlineRegular === undefined || IconThinkOutlineRegular === null ? null : IconThinkOutlineRegular;

    /**
     * 素材取色（用户 m01184 给的设计稿：模型名 `GPT-6 Astra` 的推理强度滑条）。
     *
     * 数值是用 ffmpeg 逐像素量出来的（取色脚本与记录在
     * `$DSH_HOME/.scratch/ref-slider/`），不是目测：
     *   - 填充蓝 `rgb(48,120,240)`；空轨道 `rgb(56,56,56)`；卡片底 `rgb(34,34,34)`
     *   - 刻度点 `rgb(133,133,133)`；被填充盖住时是浅蓝 `rgb(109,181,255)`
     *   - 圆钮直径 49px vs 轨道 38px ⇒ **圆钮比轨道还高**，上下各溢出约 1/7
     *   - 档位点间距 72px、端点内缩 24px（= 圆钮半径）⇒ 点就落在圆钮的行程上
     *   - Ultra 渐变两帧相位不同（深蓝→靛→洋紫），说明素材本身就是**流动**的
     */
    const REF = {
      accent: "#3078f0",
      ultraText: "#a050f0",
      ultra: ["#0818e0", "#4020e8", "#a828e8", "#c65cf5"],
    };

    /** 颜色退回值：主题变量缺失时仍然像官方控件。 */
    const COLOR = {
      /** 填充色 = 品牌蓝（素材是饱和蓝，不是「文字色 18%」那种灰调）。 */
      accent: `var(--dsw-alias-state-business-primary, ${REF.accent})`,
      /** 最高档渐变里的品牌色（跟主题走，避免和主题脱节）。 */
      accentBrand: "var(--dsw-alias-state-business-primary, #4d6bfe)",
      /** 素材里 Ultra 档的等级名与闪电图标是紫色。 */
      ultraInk: REF.ultraText,
      labelPrimary: "var(--dsw-alias-label-primary, inherit)",
      labelSecondary: "var(--dsw-alias-label-secondary, #666)",
      labelTertiary: "var(--dsw-alias-label-tertiary, #8a8a8a)",
      labelCaption: "var(--dsw-alias-label-caption, #999)",
      labelDimmed: "var(--dsw-alias-label-dimmed, #bbb)",
      border: "var(--dsw-alias-border-l2, rgba(128,128,128,0.28))",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))",
      active: "var(--dsw-alias-interactive-bg-active, rgba(128,128,128,0.18))",
      error: "var(--dsw-alias-state-error-primary, #d54941)",
    };

    /**
     * 轨道配色（素材口径）：已填充段是**饱和蓝**，未填充段是深灰胶囊，
     * 外面再套一圈 1px 的极淡描边把胶囊边勾出来。
     *
     * 注意这里与旧版（openclaw 的 GPT 口径：文字色 18% / 7% 的单色胶囊）
     * 已经不同 —— 用户 m01184 给的素材里，左半段是明确的品牌蓝 `rgb(48,120,240)`，
     * 右半段是 `rgb(56,56,56)`，所以填充走品牌色、未填充走「文字色 14%」
     * （深色主题下正好落在素材的 #383838 上，浅色主题下自动变成浅灰）。
     */
    const TRACK_FILL = COLOR.accent;
    const TRACK_REST = `color-mix(in srgb, ${COLOR.labelPrimary} 14%, transparent)`;
    const TRACK_EDGE = `color-mix(in srgb, ${COLOR.border} 70%, transparent)`;
    /** 刻度点：素材 `rgb(133,133,133)`；被填充盖住的那颗是浅蓝 `rgb(109,181,255)`。 */
    const DOT_REST = `color-mix(in srgb, ${COLOR.labelPrimary} 42%, transparent)`;
    const DOT_PASSED = `color-mix(in srgb, ${COLOR.accent} 55%, #fff)`;
    /** 最高档的刻度点叠在渐变上，所以改成半透明白（参考实现也是这个口径）。 */
    const DOT_BOOST_REST = "rgba(255,255,255,0.5)";
    const DOT_BOOST_PASSED = "rgba(255,255,255,0.92)";

    /**
     * 最高档（max / xhigh / ultra）的填充渐变：素材实测的四段色
     * （深蓝 `#0818e0` → 靛 `#4020e8` → 洋紫 `#a828e8` → 亮紫 `#c65cf5`）。
     *
     * `105deg` + `background-size: 220% 100%`，靠 `background-position` 无限往复
     * 流动（`dsh-ts-effort-flow`，最高档 6s、Ultra 4s）。素材里两行 Ultra 的相位
     * 不同，正是这条流动动画的两帧。
     */
    const BOOST_GRADIENT = `linear-gradient(105deg, ${REF.ultra[0]} 0%, ${REF.ultra[1]} 24%, ${REF.ultra[2]} 48%, ${REF.ultra[3]} 62%, ${REF.ultra[1]} 82%, ${REF.ultra[0]} 100%)`;

    /** 算「最高档」的 effort 取值：素材里只有最高那几档是彩色的。 */
    const BOOST_EFFORTS = ["xhigh", "max", "ultra"];

    /**
     * 素材的几何比例（实测：轨道 38px / 圆钮 49px / 刻度点 5px，轨道宽 408px）。
     *
     * 素材是按 408px 宽画的，本插件卡片里的轨道是 272px 宽，按比例换算：
     * 轨道 26px、圆钮 30px（素材里圆钮 49 > 轨道 38，**圆钮比轨道高**，所以这里
     * 30 > 26，上下各溢出 2px）、刻度点 4px。
     */
    const RAIL_HEIGHT = 26;
    /** 圆钮直径：故意比轨道大，上下溢出 —— 素材里那颗白钮就是骑在轨道上的。 */
    const KNOB_SIZE = 30;
    /** 端点内缩 = 圆钮半径：原生 range 的行程就是「中心从 edge 走到 width-edge」，刻度点因此落在圆钮的行程上。 */
    const RAIL_EDGE = KNOB_SIZE / 2;
    /** 刻度点直径（素材 5px / 轨道宽 408px 的比例）。 */
    const DOT_SIZE = 4;
    /** 最高档星尘颗数：Ultra 22 颗、其余最高档 12 颗、非最高档 0 颗。 */
    const STAR_COUNT = { fast: 22, true: 12 };

    /**
     * 原生滑轨的步进 = 0.01。
     *
     * 这里**不是**「按档吸附」：档位语义由 `Math.round(连续值)` 决定，步进只决定
     * 手指拖动能落在多少个位置上。总量 3~5 档的滑轨如果按档吸附，拖动就只有
     * 3~5 个落点、圆钮一格一格地跳 —— 这就是之前「一点也不丝滑」的原因。
     */
    const DRAG_STEP = 0.01;

    /* ------------------------------------------------------------------ *
     * 纯函数（可单测）
     * ------------------------------------------------------------------ */

    /**
     * 从模型目录快照里取出「当前模型 + 它的可选推理等级」。
     *
     * 返回结构的两种形态必须分开：
     *   - `supported === false`：当前模型**根本不支持**推理等级（官方菜单里
     *     连 Effort 那一行都不出现）—— 控件应当整块隐藏，而不是显示一个死滑轨；
     *   - `levels.length === 0`：支持，但目录暂时只给出了默认档 —— 显示滑轨并
     *     停在「默认」档。
     * @param {object|null|undefined} snapshot - `directory.store.getSnapshot()`。
     * `effectiveEffort` 是**官方口径的当前档**：显式选择的 effort，没有就用目录声明的
     * `defaultEffort`。官方模型菜单就是这么算的
     * （`dsh-client-ui-model-selection/lib/client.js:564`：`state.current?.reasoningEffort ?? reasoning?.defaultEffort`），
     * 所以两边显示的档位必须一致 —— 否则会出现「官方菜单显示 Medium、滑条显示默认」的矛盾。
     * @returns {{supported:boolean, levels:Array<{id:string,name:string}>, defaultEffort:string|undefined,
     *   provider:({id:string,name?:string}|undefined), model:({id:string,name?:string}|undefined),
     *   currentEffort:string|undefined, effectiveEffort:string|undefined, pending:object|null, status:string}}
     *   归一化后的目录视图。
     */
    function resolveLevels(snapshot) {
      const empty = {
        supported: false,
        levels: [],
        defaultEffort: undefined,
        provider: undefined,
        model: undefined,
        currentEffort: undefined,
        effectiveEffort: undefined,
        pending: null,
        status: "idle",
      };
      if (snapshot === null || typeof snapshot !== "object") return empty;
      const current = snapshot.current;
      if (current === null || current === undefined) {
        return { ...empty, status: typeof snapshot.status === "string" ? snapshot.status : "idle" };
      }
      const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
      const group = groups.find((candidate) => candidate !== null && candidate !== undefined && candidate.id === current.provider);
      const model = group === undefined || !Array.isArray(group.models)
        ? undefined
        : group.models.find((candidate) => candidate !== null && candidate !== undefined && candidate.id === current.model);
      const reasoning = model === undefined || model === null ? undefined : model.reasoning;
      const rawEfforts = reasoning === undefined || reasoning === null || !Array.isArray(reasoning.efforts) ? [] : reasoning.efforts;
      const levels = rawEfforts
        .filter((level) => level !== null && level !== undefined && typeof level.id === "string" && level.id.length > 0)
        .map((level) => ({ id: level.id, name: typeof level.name === "string" && level.name.length > 0 ? level.name : level.id }));
      // `reasoning === undefined` 才是「不支持」；只有空 efforts 是「只支持默认档」。
      const supported = reasoning !== undefined && reasoning !== null;
      const defaultEffort = supported && typeof reasoning.defaultEffort === "string" ? reasoning.defaultEffort : undefined;
      const currentEffort = typeof current.reasoningEffort === "string" ? current.reasoningEffort : undefined;
      return {
        supported,
        levels,
        defaultEffort,
        provider: group === undefined ? { id: current.provider } : group,
        model: model === undefined ? { id: current.model } : model,
        currentEffort,
        effectiveEffort: currentEffort === undefined ? defaultEffort : currentEffort,
        pending: snapshot.pending ?? null,
        status: typeof snapshot.status === "string" ? snapshot.status : "idle",
      };
    }

    /**
     * 构造滑轨的位置表 —— 与官方 Effort 菜单逐项对齐。
     *
     * 官方（`dsh-client-ui-model-selection/lib/client.js:557-563`）只在模型**没有**声明
     * `defaultEffort` 时才补一个「provider default」项：
     *   `[...reasoning.defaultEffort === void 0 ? [{key:"provider-default", effort:void 0}] : [], ...reasoning.efforts]`
     * 声明了 `defaultEffort` 时，那一档本身就是默认档，再补一项只会多出一个永远
     * 和某个具名档等价的重复位置。所以这里同样按 `defaultEffort === undefined` 决定。
     * @param {object} view - {@link resolveLevels} 的结果。
     * @returns {{key:string, effort:(string|undefined), name:string}[]} 顺序即滑轨顺序。
     */
    function buildStops(view) {
      const stops = [];
      if (view.defaultEffort === undefined && view.levels.length > 0) {
        stops.push({ key: "provider-default", effort: undefined, name: "默认" });
      }
      for (const level of view.levels) stops.push({ key: `effort:${level.id}`, effort: level.id, name: level.name });
      return stops;
    }

    /**
     * 当前档在 stops 里的下标；匹配不到时退回「默认」档或首档。
     * 用 `effectiveEffort`（官方口径）而不是裸的 `currentEffort`，保证滑条停在
     * 官方菜单显示的那一档上。
     * @param {object} view - {@link resolveLevels} 的结果。
     * @param {{effort:(string|undefined)}[]} stops - {@link buildStops} 的结果。
     * @returns {number} 0..stops.length-1（stops 为空时返回 0）。
     */
    function stopIndexOf(view, stops) {
      if (stops.length === 0) return 0;
      const found = stops.findIndex((stop) => stop.effort === view.effectiveEffort);
      if (found !== -1) return found;
      return 0;
    }

    /**
     * 「返回默认」按钮要跳到的下标；-1 表示当前就是默认档、没有可回的目标。
     *
     * 目标 = 目录声明的默认档（没声明就是用「provider default」那一档），
     * 且仅当它确实存在、并且与当前档不同时才给出按钮。
     * @param {object} view - {@link resolveLevels} 的结果。
     * @param {{effort:(string|undefined)}[]} stops - {@link buildStops} 的结果。
     * @param {number} index - 当前档下标。
     * @returns {number} 目标下标或 -1。
     */
    function resetIndexOf(view, stops, index) {
      if (stops.length <= 1) return -1;
      const target = view.defaultEffort === undefined ? 0 : stops.findIndex((stop) => stop.effort === view.defaultEffort);
      if (target < 0 || target === index) return -1;
      return target;
    }

    /**
     * 滑轨位置 → `0..1` 的**比例**（写给 CSS 变量 `--dsh-ts-ratio`）。
     *
     * 这是整条滑轨唯一的几何输入：填充宽度、圆钮位置、已通过刻度点的裁剪
     * 全部由它算出来，所以三者永远对齐 —— 填充边界就压在圆钮中心下面，
     * 和素材里一模一样。用比例而不是百分比，是因为宽度必须写成
     * `calc(edge + ratio * (100% - 2*edge))` 才能跟原生 range 的行程重合。
     * @param {number} position - 连续位置（0..lastIndex，可以是小数）。
     * @param {number} lastIndex - 最大下标（档位数 - 1）。
     * @returns {number} 0..1 的比例。
     */
    function ratioOf(position, lastIndex) {
      if (!(lastIndex > 0)) return 0;
      const clamped = Math.min(Math.max(position, 0), lastIndex);
      return clamped / lastIndex;
    }

    /**
     * 确定性伪随机 `0..1`（**不用 Math.random**）。
     *
     * 星尘的位置必须「看起来随机、但每次渲染都一样」：用 Math.random 会让每次
     * 重渲染时星星乱跳（也让单测没法断言）。这里用经典的 sin 哈希。
     * @param {number} index - 星序号。
     * @param {number} salt - 用途盐值（位置 / 大小 / 周期各用不同盐）。
     * @returns {number} 0..1。
     */
    function starHash01(index, salt) {
      const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
      return value - Math.floor(value);
    }

    /**
     * 最高档的星尘颗数（素材里十来颗；参考实现 MAX 22 颗、次档 12 颗、非最高档 0 颗）。
     * @param {("fast"|"true"|null)} boost - `railBoostOf` 的结果。
     * @returns {number} 颗数。
     */
    function starCountFor(boost) {
      if (boost === null || boost === undefined) return 0;
      return STAR_COUNT[boost] ?? STAR_COUNT.true;
    }

    /**
     * 一颗星的内联样式：位置、大小、闪烁周期与相位都是确定性伪随机。
     * @param {number} index - 星序号。
     * @param {("fast"|"true")} boost - 档位标记（fast = Ultra，闪得更快）。
     * @returns {object} 可直接塞进 React `style` 的对象。
     */
    function starStyleFor(index, boost) {
      const fast = boost === "fast";
      const round = (value) => Math.round(value * 100) / 100;
      return {
        left: `${String(round(starHash01(index, 1) * 92 + 4))}%`,
        top: `${String(round(starHash01(index, 2) * 56 + 22))}%`,
        "--dsh-ts-star-scale": String(round(0.55 + starHash01(index, 3) * 1.05)),
        "--dsh-ts-star-delay": `${String(round(-starHash01(index, 4) * (fast ? 1.6 : 2.6)))}s`,
        "--dsh-ts-star-period": `${String(round((fast ? 1.1 : 1.8) + starHash01(index, 5) * (fast ? 0.8 : 1.2)))}s`,
      };
    }

    /** 档位下标 → 写给会话的 effort 值（默认档是 undefined，必须整个字段省略）。 */
    /**
     * @param {{effort:(string|undefined)}|undefined} stop - 目标档。
     * @returns {string|undefined} effort id 或 undefined。
     */
    function effortOf(stop) {
      return stop === undefined ? undefined : stop.effort;
    }

    /* ------------------------------------------------------------------ *
     * 模型选择（纯函数）
     * ------------------------------------------------------------------ */

    /** 官方「账户」provider：显示名与官方菜单同口径（`provider.account`）。 */
    const ACCOUNT_PROVIDER = "deepseek-account";

    /**
     * 快照 → 可选模型行。
     *
     * 数据源与官方模型菜单**完全相同**（`snapshot.groups` / `snapshot.failures`，
     * 见官方 `optionsOf`：`dsh-client-ui-model-selection/lib/client.js:1145-1162`），
     * 所以两处永远列出同一批模型、同一顺序 —— 我们只是把它画进了滑条卡片里。
     * 只做铺平与归一化：不排序、不去重；加载失败的 provider 追加为**不可选**行，
     * 让用户至少知道「这里本来还有东西」。
     * @param {object|null} snapshot - 目录快照。
     * @returns {{key:string, provider:(string|undefined), model:(string|undefined), name:string,
     *   groupId:(string|undefined), groupName:(string|undefined), account:boolean, efforts:string[],
     *   reasoning:boolean, active:boolean, selectable:boolean, detail:string}[]} 模型行。
     */
    function modelChoicesOf(snapshot) {
      if (snapshot === null || typeof snapshot !== "object") return [];
      const rows = [];
      const current = snapshot.current === null || snapshot.current === undefined ? null : snapshot.current;
      const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
      for (const group of groups) {
        if (group === null || typeof group !== "object") continue;
        const provider = typeof group.id === "string" ? group.id : undefined;
        const models = Array.isArray(group.models) ? group.models : [];
        for (const model of models) {
          if (model === null || typeof model !== "object") continue;
          if (typeof model.id !== "string" || model.id.length === 0) continue;
          const reasoning = model.reasoning === null || model.reasoning === undefined ? null : model.reasoning;
          rows.push({
            key: `${String(provider)}/${model.id}`,
            provider,
            model: model.id,
            name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
            groupId: provider,
            groupName: typeof group.name === "string" && group.name.length > 0 ? group.name : provider,
            account: provider === ACCOUNT_PROVIDER,
            efforts: reasoning === null || !Array.isArray(reasoning.efforts)
              ? []
              : reasoning.efforts
                  .map((effort) => (
                    typeof effort === "string"
                      ? effort
                      : effort === null || effort === undefined ? undefined : effort.id
                  ))
                  .filter((id) => typeof id === "string" && id.length > 0),
            reasoning: reasoning !== null,
            active: current !== null && current.provider === provider && current.model === model.id,
            selectable: true,
            detail: "",
          });
        }
      }
      const failures = Array.isArray(snapshot.failures) ? snapshot.failures : [];
      for (const failure of failures) {
        if (failure === null || typeof failure !== "object") continue;
        rows.push({
          key: `failure/${String(failure.id)}`,
          provider: undefined,
          model: undefined,
          name: typeof failure.name === "string" && failure.name.length > 0 ? failure.name : String(failure.id),
          groupId: undefined,
          groupName: undefined,
          account: failure.id === ACCOUNT_PROVIDER,
          efforts: [],
          reasoning: false,
          active: false,
          selectable: false,
          detail: typeof failure.message === "string" ? failure.message : "",
        });
      }
      return rows;
    }

    /**
     * 换模型时把当前档位带过去。
     *
     * **与官方有意不同**：官方 `selectionOf`（`dsh-client-ui-model-selection/lib/client.js:1172-1185`）
     * 换模型时一律回到新模型的 `reasoning.defaultEffort`；这里只要新模型**显式声明**
     * 了同 id 的档位就保留 —— 换 provider 时「高」还是「高」，滑条不会自己跳一格。
     * 没声明就省略该字段：省略就是「用目标模型的默认档」，与官方口径一致。
     * @param {object} choice - {@link modelChoicesOf} 的行。
     * @param {string|undefined} effort - 当前生效档位。
     * @returns {string|undefined} 带过去的 effort，或 undefined（走目标模型默认档）。
     */
    function transferEffort(choice, effort) {
      if (choice === null || typeof choice !== "object") return undefined;
      if (typeof effort !== "string" || effort.length === 0) return undefined;
      return Array.isArray(choice.efforts) && choice.efforts.indexOf(effort) !== -1 ? effort : undefined;
    }

    /* ------------------------------------------------------------------ *
     * 接管官方模型座位
     * ------------------------------------------------------------------ */

    /**
     * 打在官方模型座位 DOM 上的标记属性。
     *
     * 官方座位占的是 **single** 插槽 `conversation.input.model`，注册位被别人占了
     * 就抛 `single slot "..." already has a registration`（`dsh-client-ui-slots/lib/index.js:172`）
     * —— 抢不过来，只能在运行时给它的 DOM 打标记 + 用 CSS 藏掉。
     */
    const NATIVE_SEAT_ATTR = "data-dsh-thinking-slider-native";

    /**
     * 这个元素是不是官方模型座位？
     *
     * 判据是官方 trigger 的 `aria-haspopup="menu"`（官方 `ModelSelect` 开的是菜单弹层）
     * —— 我们自己的 chip 用 `aria-haspopup="dialog"`，所以绝不会误伤自己。
     * 官方把它锁住时（会话已移除 / inert / 非 live → 官方按钮 `disabled`）**不接管**：
     * 那是官方有意关掉的门，我们不该在旁边再开一扇。
     * @param {object} node - 候选元素。
     * @param {object} self - 我们自己的根元素。
     * @returns {boolean} 是官方模型座位则为 true。
     */
    function isNativeModelSeat(node, self) {
      if (node === null || node === undefined || typeof node !== "object") return false;
      if (node === self) return false;
      if (typeof node.contains === "function" && node.contains(self)) return false;
      if (typeof node.querySelector !== "function") return false;
      const button = node.querySelector('button[aria-haspopup="menu"]');
      if (button === null || button === undefined) return false;
      return button.disabled !== true;
    }

    /**
     * 从一组兄弟元素里挑出官方模型座位：**从后往前**找第一个符合条件的。
     *
     * 位置本身是有语义的：官方 composer 里 `conversation.input.model` 紧跟在
     * `conversation.input.right` 之后（`dsh-client-ui-conversation/lib/client.js:17532`），
     * 所以官方座位永远是这一排控件里的最后一个。从后往前找，同一排里别的插件挂的
     * 菜单按钮（比如分支选择器）就不会被误认。
     * @param {ArrayLike<object>} children - 兄弟元素（`container.children`）。
     * @param {object} self - 我们自己的根元素。
     * @returns {object|null} 官方座位元素或 null。
     */
    function pickNativeSeat(children, self) {
      if (children === null || children === undefined) return null;
      const list = Array.from(children);
      for (let at = list.length - 1; at >= 0; at -= 1) {
        if (isNativeModelSeat(list[at], self)) return list[at];
      }
      return null;
    }

    /**
     * 在 DOM 里定位官方模型座位：从我们自己往上找**最近的、孩子里带菜单按钮的**容器。
     * 找不到就返回 null（降级：官方控件留着，界面上只是多一枚 chip，不会少一个功能）。
     * @param {object} self - 我们自己的根元素。
     * @returns {object|null} 官方座位元素或 null。
     */
    function nativeSeatOf(self) {
      if (self === null || self === undefined || typeof self !== "object") return null;
      let container = self.parentElement === undefined ? null : self.parentElement;
      for (let depth = 0; container !== null && container !== undefined && depth < 6; depth += 1) {
        const found = pickNativeSeat(container.children, self);
        if (found !== null) return found;
        container = container.parentElement === undefined ? null : container.parentElement;
      }
      return null;
    }

    /**
     * 给官方模型座位打标记（幂等）。CSS 里 `[data-dsh-thinking-slider-native="hidden"]`
     * 就是那条 `display: none !important`。
     * @param {object} self - 我们自己的根元素。
     * @returns {object|null} 被打上标记的元素，或 null（没找到 / 打不上去）。
     */
    function hideNativeSeat(self) {
      const seat = nativeSeatOf(self);
      if (seat === null) return null;
      try {
        if (typeof seat.setAttribute === "function") seat.setAttribute(NATIVE_SEAT_ATTR, "hidden");
      } catch {
        return null;
      }
      return seat;
    }

    /** 撤掉标记：卸载 / 目录不可用时把官方控件原样还回去。 */
    function showNativeSeat(seat) {
      if (seat === null || seat === undefined) return;
      try {
        if (typeof seat.removeAttribute === "function") seat.removeAttribute(NATIVE_SEAT_ATTR);
      } catch {
        /* 节点已经不在了（宿主已经把它卸掉）：无需还原 */
      }
    }

    /* ------------------------------------------------------------------ *
     * 模块级状态
     * ------------------------------------------------------------------ */

    /** @type {object|null} 客户端根上下文（apply 时赋值）。 */
    let client = null;
    /** 订阅者集合（Toast 用）。 */
    const subscribers = new Set();
    /** @type {{key:number,text:string,tone:("error"|"success"|undefined)}|null} */
    let notice = null;
    let noticeSeq = 0;
    /** 诊断回报的宿主路由与序号。 */
    const DIAG_ROUTE = "/dsh-thinking-slider/diag";
    let diagSeq = 0;

    /** 通知所有插槽组件重渲染。 */
    function publish() {
      for (const subscriber of subscribers) subscriber();
    }

    /** 订阅模块级 Toast 状态；返回自增版本号以强制重渲染。 */
    function useNoticeState() {
      const [, bump] = react.useState(0);
      react.useEffect(() => {
        const subscriber = () => bump((value) => value + 1);
        subscribers.add(subscriber);
        return () => {
          subscribers.delete(subscriber);
        };
      }, []);
      return notice;
    }

    /** 弹一条 Toast。 */
    function showNotice(text, tone) {
      noticeSeq += 1;
      notice = tone === undefined ? { key: noticeSeq, text } : { key: noticeSeq, text, tone };
      publish();
    }

    /** 把任意抛出物转成一行可读文本。 */
    function messageOf(error) {
      if (error instanceof Error) return error.message;
      if (typeof error === "string") return error;
      return String(error);
    }

    /* ------------------------------------------------------------------ *
     * 诊断通道
     * ------------------------------------------------------------------ */

    /**
     * 向宿主回报一条浏览器侧状态（宿主半边把它写进 `diag.log`）。
     *
     * 手机上的 WebView 没有 devtools，静默失败时无从取证，所以留这条一次性
     * 通道：`apply` 是否被调用、槽位是否注册、目录服务是否就绪、组件渲染到
     * 哪一步、有没有渲染异常，全部可以在宿主侧读到。回报本身失败绝不影响
     * 控件功能（catch 吞掉）。
     * @param {string} event - 事件名。
     * @param {object} [payload] - 附带字段。
     * @returns {void}
     */
    function reportDiag(event, payload) {
      try {
        if (typeof fetch !== "function") return;
        diagSeq += 1;
        const body = JSON.stringify({ event, seq: diagSeq, at: Date.now(), ...(payload === undefined ? {} : payload) });
        void fetch(DIAG_ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body,
        }).catch(() => {});
      } catch {
        /* 诊断失败：什么都不做 */
      }
    }

    /**
     * 把一步操作包成「绝不会抛」。
     *
     * 这是本插件最重要的一条保命纪律：**DSH 前端 boot 只要有一个入口的 apply
     * 抛错，整个 `web boot` 就整体失败** —— 前端停在「Failed to load plugins」，
     * 界面根本打不开，用户只能杀进程重启（`dsh-web-frontend` 里 boot 的
     * `activate()` 见到任何非 active 的入口就 `throw new Error("web boot: …")`）。
     * 所以插件里所有注册动作都必须自己吞掉异常：最坏结果只能是「控件不显示」，
     * 绝不能是「DSH 打不开」。
     *
     * 吞掉的异常不会静默消失 —— 走同一本 diag 日志（`label` 即事件名）。
     * @param {string} label - 失败时写进 diag 的事件名。
     * @param {Function} step - 要执行的一步。
     * @returns {*} `step()` 的返回值；抛错时 `undefined`。
     */
    function quiet(label, step) {
      try {
        return step();
      } catch (error) {
        reportDiag(label, { message: messageOf(error) });
        return undefined;
      }
    }

    /**
     * 取官方 primitives 包；取不到就退化成空对象。
     *
     * 加载期（factory 执行时）同样不允许抛错：`require` 失败会让入口停在 failed，
     * 一样是「DSH 打不开」。退化成 `{}` 之后，取不到的组件会在渲染期被座位的错误
     * 边界兜住，只影响自己这一个座位。
     * @param {Function} req - factory 传入的 `require`。
     * @returns {object} primitives 包面（失败时空对象）。
     */
    function loadPrimitives(req) {
      try {
        const loaded = req("@deepseek-ai/dsh-client-ui-primitives");
        return loaded === undefined || loaded === null ? {} : loaded;
      } catch (error) {
        reportDiag("primitives-missing", { message: messageOf(error) });
        return {};
      }
    }

    /** 当前 ctx 上能看到的服务快照（诊断用）。 */
    function serviceProbe() {
      const has = (name) => {
        if (client === null) return false;
        try {
          if (typeof client.get === "function" && client.get(name) !== undefined) return true;
          return client[name] !== undefined && client[name] !== null;
        } catch {
          // 取服务本身失败（cordis 里未 inject 的服务会抛「cannot get property …」）：
          // 记成「没有」。诊断探针自己绝不能把异常带到 apply 里去。
          return false;
        }
      };
      return {
        slots: has("slots"),
        modelDirectories: has("modelDirectories") && directoriesService() !== null,
        locale: has("locale"),
      };
    }

    /**
     * 取官方模型目录服务。
     *
     * `ctx.get` 优先（cordis 服务的正规读法），退回属性访问 —— 与
     * dsh-flow-control 里 `sessionsService()` 同一套兜底策略。
     * @returns {object|null} `modelDirectories` 服务面，取不到时 null。
     */
    function directoriesService() {
      if (client === null) return null;
      let service;
      try {
        service = typeof client.get === "function" ? client.get("modelDirectories") : undefined;
      } catch {
        service = undefined;
      }
      if (service === undefined || service === null) {
        try {
          service = client.modelDirectories;
        } catch {
          // 属性访问同样可能抛（cordis 的未 inject 服务）—— 一律当成「取不到」。
          service = undefined;
        }
      }
      return service === undefined || service === null ? null : service;
    }

    /**
     * 解析某个会话的共享模型目录（就是官方模型菜单用的那一份）。
     * @param {string|undefined} sessionId - 会话标识。
     * @returns {object|null} `ModelDirectory` 实例（含 store 与 select），不可用时 null。
     */
    function directoryOf(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      const service = directoriesService();
      if (service === null || typeof service.directoryFor !== "function") return null;
      try {
        return service.directoryFor(sessionId) ?? null;
      } catch {
        return null;
      }
    }

    /** 等待模型目录服务的重试节奏（250ms × 40 ≈ 10 秒）。 */
    const DIRECTORY_RETRY_MS = 250;
    const DIRECTORY_RETRY_LIMIT = 40;

    /**
     * 取当前会话的模型目录，**等待服务就绪**。
     *
     * `modelDirectories` 由官方 `dsh-client-ui-model-selection` 提供，它本身是
     * 按需加载的客户端插件，可能晚于本插件就绪（官方 UI 用
     * `ctx.inject(["slots","modelDirectories"], …)` 等它）。本插件只 inject
     * `slots`（与同仓 dsh-flow-control 一样，避免「服务永不到来 → 插件永远
     * pending → 界面上什么都没有」这种无声失败），所以这里轮询补上等待。
     * @param {string|undefined} sessionId - 会话标识。
     * @returns {object|null} 目录实例；等待期间为 null（界面显示占位点）。
     */
    function useDirectory(sessionId) {
      const [directory, setDirectory] = react.useState(() => directoryOf(sessionId));
      react.useEffect(() => {
        const immediate = directoryOf(sessionId);
        if (immediate !== null) {
          setDirectory(immediate);
          return undefined;
        }
        let tries = 0;
        const timer = setInterval(() => {
          tries += 1;
          const next = directoryOf(sessionId);
          if (next !== null) {
            clearInterval(timer);
            reportDiag("directory-ready", { sessionId, tries });
            setDirectory(next);
            return;
          }
          if (tries >= DIRECTORY_RETRY_LIMIT) {
            clearInterval(timer);
            reportDiag("directory-missing", { sessionId, tries, services: serviceProbe() });
          }
        }, DIRECTORY_RETRY_MS);
        return () => {
          clearInterval(timer);
        };
      }, [sessionId]);
      return directory;
    }

    /* ------------------------------------------------------------------ *
     * 样式
     * ------------------------------------------------------------------ */

    /**
     * 触发按钮：composer 里的中性 chip。
     *
     * GPT 的 composer 控件不带任何彩色标记（旧版的品牌渐变圆点是这里最
     * 「不像 GPT」的一处），所以这个 chip 只用中性文字色，悬停/展开的浅灰底
     * 交给 RANGE_CSS 里的 `.dsh-thinking-slider-trigger` 规则。
     */
    const TRIGGER = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      height: "28px",
      // 这枚 chip 现在顶替了官方座位，要装下「模型名 · 档位」两段文字。
      maxWidth: "min(240px, 45cqw)",
      padding: "0 6px",
      border: "none",
      borderRadius: "8px",
      background: "transparent",
      color: COLOR.labelSecondary,
      font: "inherit",
      fontSize: "13px",
      lineHeight: "20px",
      cursor: "pointer",
      whiteSpace: "nowrap",
    };

    /** 触发按钮被锁定（子会话 / 目录不可用）。 */
    const TRIGGER_DISABLED = {
      ...TRIGGER,
      color: COLOR.labelDimmed,
      cursor: "default",
    };

    /**
     * 等待模型目录服务时的占位点（虚线空心圆）。
     *
     * 只为可观测性存在：目录服务由官方 model-selection 插件提供，可能晚一点
     * 就绪；有这个点在，就能一眼区分「座位没挂上」和「目录还没到」。
     */
    const TRIGGER_WAIT = {
      display: "inline-block",
      flex: "none",
      width: "6px",
      height: "6px",
      margin: "0 4px",
      borderRadius: "50%",
      border: `1px dashed ${COLOR.labelDimmed}`,
    };

    /** 触发按钮左边的「思考」图标：中性色（GPT 的 chip 没有彩色标记）。 */
    const TRIGGER_ICON = {
      flex: "none",
      color: COLOR.labelTertiary,
    };

    /** 触发按钮上的模型名：这枚 chip 顶替了官方座位，模型名是它的主体。 */
    const TRIGGER_MODEL = {
      flexShrink: 1000,
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: COLOR.labelSecondary,
    };

    /** 模型名与档位之间的那个「·」。 */
    const TRIGGER_SEP = {
      flex: "none",
      color: COLOR.labelTertiary,
    };

    /** 触发按钮上的等级文字（caption 色，跟官方座位的 effort 文字一致）：不参与压缩。 */
    const TRIGGER_LEVEL = {
      flex: "none",
      whiteSpace: "nowrap",
      color: COLOR.labelCaption,
    };

    /** 卡片外壳：锚定在触发按钮上方，超出输入栏裁剪区所以走 portal。 */
    const CARD = {
      position: "fixed",
      zIndex: "1200",
      width: "min(300px, calc(100vw - 24px))",
      padding: "12px 14px 12px",
      // 浮层自带一层柔和投影；官方 MenuSurface 只提供材质（半透明底 + 模糊）与圆角。
      boxShadow: "0 12px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
    };

    /**
     * 卡片内容列：三行（头 / 滑轨 / 底），进场时整块淡入上浮（`dsh-ts-card-in`）。
     *
     * 之所以再包一层而不是把 flex 直接写在 MenuSurface 上：进场动画需要一个
     * 我们自己能挂 class 的元素，而 MenuSurface 是官方组件、class 不一定落到 DOM。
     */
    const CARD_INNER = {
      display: "flex",
      flexDirection: "column",
      gap: "10px",
    };

    /**
     * 卡片头：三列 —— 左闪电、中间「等级名 › + 模型名」、右重置图标。
     *
     * 这是素材的结构（`GPT-6 Astra` 那七张卡）：等级名与模型名居中，左右两个
     * 图标各自贴边。用 grid 的 `28px 1fr 28px` 保证中间那列**真的居中**
     * （flex 的 space-between 在两个图标宽度不同时会歪）。
     */
    const CARD_HEADER = {
      display: "grid",
      gridTemplateColumns: "28px 1fr 28px",
      alignItems: "center",
      gap: "6px",
    };

    /** 中间那列：等级名一行 + 模型名一行。 */
    const CARD_NAME_BLOCK = {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "2px",
      minWidth: 0,
    };

    /** 「等级名 ›」这一行本身是个按钮（点一下切到下一档），所以要把按钮默认样式抹平。 */
    const CARD_NAME_ROW = {
      display: "inline-flex",
      alignItems: "center",
      gap: "2px",
      padding: "2px 6px",
      margin: 0,
      border: "none",
      borderRadius: "8px",
      background: "transparent",
      font: "inherit",
      cursor: "pointer",
      maxWidth: "100%",
      minWidth: 0,
    };

    /** 卡片头左侧的闪电图标（素材里是灰色轮廓，Ultra 档变紫并带一点辉光）。 */
    const CARD_BOLT = {
      flex: "none",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      color: COLOR.labelTertiary,
      transition: "color 240ms ease, filter 240ms ease",
    };

    const CARD_LEVEL = {
      margin: 0,
      // 素材里等级名是蓝色；Ultra 档由 JS 换成紫色（见 `cardInkOf`）。
      color: COLOR.accent,
      fontSize: "13px",
      fontWeight: "600",
      lineHeight: "18px",
      whiteSpace: "nowrap",
      transition: "color 240ms ease",
    };

    /** 等级名后面的 `›`：素材里就是一个灰色箭头。 */
    const CARD_CHEVRON = {
      color: COLOR.labelTertiary,
      fontSize: "13px",
      lineHeight: "18px",
      transition: "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)",
    };

    /** 卡片头中那行模型名（素材里等级名下面那行 `GPT-6 Astra`）。 */
    const CARD_MODEL = {
      margin: 0,
      maxWidth: "100%",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: COLOR.labelSecondary,
      fontSize: "12px",
      fontWeight: "400",
      lineHeight: "16px",
    };

    /**
     * 滑轨行：只有滑轨本身 —— 没有 ± 步进按钮，拖就是唯一操作。
     *
     * `position: relative` 是整套**自绘滑轨**的定位基准：底色轨道、填充、刻度点、
     * 白圆钮、星尘全是这一层的绝对定位子元素；原生 `input` 只负责命中测试与
     * 无障碍（它的轨道与圆钮在 CSS 里被画成透明，见 `RANGE_CSS`）。
     */
    const RAIL_ROW = {
      position: "relative",
      width: "100%",
      height: `${String(RAIL_HEIGHT)}px`,
      borderRadius: "999px",
      // 圆钮比轨道高，必须允许溢出。
      overflow: "visible",
    };

    /** 辅助文字：卡片底部只在提交失败时出现的那行错误。 */
    const HINT = {
      margin: 0,
      color: COLOR.labelTertiary,
      fontSize: "12px",
      lineHeight: "16px",
    };

    const ERROR_TEXT = {
      ...HINT,
      color: COLOR.error,
    };

    /* ---- 卡片里的模型选择（「选择模型」集成进来的那一行） ---- */

    /**
     * 卡片头里那行模型名现在是**按钮**：点一下在滑条上方展开模型清单。
     *
     * 布局沿用素材（等级名下面居中一行模型名），只是多了一枚 ▾ 并且可点 ——
     * 这样既没有多出一行、也不改变素材里的视觉层级。
     */
    const MODEL_ROW = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "4px",
      maxWidth: "100%",
      padding: "2px 8px",
      margin: 0,
      border: "none",
      borderRadius: "8px",
      background: "transparent",
      font: "inherit",
      cursor: "pointer",
    };

    /** 模型行里的名字：过长省略，▾ 贴在文字右边。 */
    const MODEL_ROW_LABEL = {
      ...CARD_MODEL,
      flex: "0 1 auto",
      minWidth: 0,
    };

    /** 模型行右边那枚 ▾：展开时由 CSS 转 180°。 */
    const MODEL_ROW_CHEVRON = {
      flex: "none",
      color: COLOR.labelTertiary,
      transition: "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)",
    };

    /** 模型清单：超过 168px 就滚动，卡片高度不会被模型数量撑爆。 */
    const MODEL_LIST = {
      display: "flex",
      flexDirection: "column",
      gap: "1px",
      maxHeight: "168px",
      overflowY: "auto",
      margin: "0 -6px",
      padding: "2px 6px",
      borderRadius: "10px",
    };

    /** provider 分组标题（只有多于一个 provider 时才出现）。 */
    const MODEL_GROUP = {
      margin: 0,
      padding: "6px 8px 2px",
      color: COLOR.labelTertiary,
      fontSize: "11px",
      lineHeight: "14px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    };

    /** 模型清单里的一行（当前项左边有一枚勾）。 */
    const MODEL_ITEM = {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      width: "100%",
      minHeight: "30px",
      padding: "0 8px",
      border: "none",
      borderRadius: "8px",
      background: "transparent",
      color: COLOR.labelSecondary,
      font: "inherit",
      fontSize: "13px",
      lineHeight: "18px",
      textAlign: "left",
      cursor: "pointer",
      whiteSpace: "nowrap",
    };

    /** 模型行左边那枚勾（占位等宽，没有勾的行也不会歪）。 */
    const MODEL_CHECK = {
      flex: "none",
      width: "12px",
      color: COLOR.accent,
      fontSize: "12px",
      lineHeight: "18px",
      textAlign: "center",
    };

    /** 不可选行（provider 加载失败）：整行变灰且不可点。 */
    const MODEL_FAILURE = {
      ...MODEL_ITEM,
      color: COLOR.error,
      cursor: "default",
      opacity: 0.8,
    };

    /** 「该模型没有推理等级」：只有模型清单、没有滑条时的那行说明。 */
    const MODEL_NOTE = {
      flex: "none",
      color: COLOR.labelTertiary,
      fontSize: "12px",
      lineHeight: "18px",
    };

    /** 「返回默认」：素材里是卡片头右上角那个 ↻ 图标按钮，中性色、不用品牌色。 */
    const RESET_BUTTON = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "28px",
      height: "28px",
      padding: 0,
      border: "none",
      borderRadius: "50%",
      background: "transparent",
      color: COLOR.labelTertiary,
      cursor: "pointer",
      transition: "color 200ms ease, background-color 200ms ease",
    };

    /** ↻ 图标本体：按下时转半圈（`transform` 过渡在 CSS 里）。 */
    const RESET_GLYPH = {
      display: "block",
    };

    /**
     * 滑轨外层容器（`.dsh-thinking-slider-rail`）的样式。
     *
     * 只管布局：**颜色与比例一律交给 `RANGE_CSS`**（底色轨道、填充、刻度点、
     * 圆钮、星尘都是这一层的子元素；原生 input 的轨道与圆钮被画成透明）。
     * @returns {object} 可直接塞进 React `style` 的对象。
     */
    function railStyleFor() {
      return RAIL_ROW;
    }

    /**
     * 当前档位要不要上品牌渐变。
     * @param {unknown} effort - 当前档位的 effort 取值。
     * @returns {("fast"|"true"|null)} `"fast"` = ultra（流动更快、星更多），`"true"` = 其余最高档，`null` = 不上色。
     */
    function railBoostOf(effort) {
      if (BOOST_EFFORTS.indexOf(String(effort)) === -1) return null;
      return String(effort) === "ultra" ? "fast" : "true";
    }

    /**
     * `railBoostOf` 的 React 属性形式 —— 真正上色的是 `RANGE_CSS` 里的 `[data-boost]`。
     *
     * 组件与 `preview/` 的静态预览共用这一个函数，预览因此不会和真实控件漂移。
     * @param {unknown} effort - 当前档位的 effort 取值。
     * @returns {object} `{"data-boost":"true"}` / `{"data-boost":"fast"}` / `{}`。
     */
    function railBoostAttr(effort) {
      const boost = railBoostOf(effort);
      return boost === null ? {} : { "data-boost": boost };
    }

    /**
     * 最高档的文字/图标配色：素材里 Ultra 档的等级名与闪电图标是紫色
     * （`#a050f0`），其余档位是品牌蓝 / 中性灰。
     * @param {("fast"|"true"|null)} boost - `railBoostOf` 的结果。
     * @returns {{level:string, bolt:string, glow:string}} 三处颜色。
     */
    function cardInkOf(boost) {
      if (boost === null) return { level: COLOR.accent, bolt: COLOR.labelTertiary, glow: "none" };
      return {
        level: COLOR.ultraInk,
        bolt: COLOR.ultraInk,
        glow: `drop-shadow(0 0 6px ${COLOR.ultraInk})`,
      };
    }

    /**
     * 滑轨那一层的 CSS 变量：**比例**（填充宽度 + 圆钮位置 + 刻度点裁剪全靠它）
     * 与几组颜色。整块挂在 `.dsh-thinking-slider-rail` 上，子元素共享。
     *
     * 为什么要用比例而不是百分比：填充宽度必须写成
     * `calc(edge + ratio * (100% - 2*edge))` 才能和原生 range 圆钮的行程完全重合
     * （`edge` = 圆钮半径），这样「填充边界压在圆钮中心下面」在**任意宽度**下都成立。
     * 同样与 `preview/` 共用，避免预览与真实控件两套数值。
     * @param {number} ratio - 0..1 的位置比例（见 `ratioOf`）。
     * @param {unknown} effort - 当前档位的 effort 取值（决定刻度点用灰点还是白点）。
     * @returns {object} 可直接塞进 React `style` 的对象。
     */
    function railVarsFor(ratio, effort) {
      const boost = railBoostOf(effort);
      return {
        "--dsh-ts-ratio": String(ratio),
        "--dsh-ts-fill-color": TRACK_FILL,
        "--dsh-ts-rest-color": TRACK_REST,
        "--dsh-ts-edge": TRACK_EDGE,
        "--dsh-ts-dot-color": boost === null ? DOT_REST : DOT_BOOST_REST,
        "--dsh-ts-dot-passed-color": boost === null ? DOT_PASSED : DOT_BOOST_PASSED,
      };
    }

    /** 滑轨样式 <style> 标签的 id（幂等注入用）。 */
    const RANGE_STYLE_TAG = "dsh-thinking-slider/range.css";

    /**
     * 滑轨样式 —— 素材口径的**蓝色填充 + 刻度点 + 白圆钮 + 最高档流光星尘**。
     *
     * 这一层是「自绘滑轨」：原生 `input[type=range]` 的轨道与圆钮被画成透明，
     * 只保留命中盒与无障碍语义；可见的五层（底色 / 填充 / 刻度点 / 圆钮 / 星尘）
     * 全部由这里的 CSS 画，位置由 `--dsh-ts-ratio` 一个变量驱动，
     * 所以填充边界、圆钮中心、已通过刻度点三者永远对齐。
     */
    const RANGE_CSS = `
/* 把「比例」注册成可补间的数值类型：点击轨道 / 键盘跳档 / 返回默认时，
   填充、圆钮、刻度点会一起缓动过去；拖动中由 JS 临时把过渡关掉（跟手优先）。
   —— 「丝滑」就是这两半合起来的手感。 */
@property --dsh-ts-ratio {
  syntax: "<number>";
  inherits: true;
  initial-value: 0;
}

/* 滑轨行：比例过渡挂在这一层，所有子元素共享同一个已补间的值。 */
.dsh-thinking-slider-rail {
  transition: --dsh-ts-ratio 320ms cubic-bezier(0.34, 1.28, 0.64, 1), box-shadow 280ms ease;
}

/* 底色轨道：胖胶囊 + 1px 极淡描边。 */
.dsh-thinking-slider-track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--dsh-ts-rest-color, rgba(128,128,128,0.14));
  box-shadow: inset 0 0 0 1px var(--dsh-ts-edge, rgba(128,128,128,0.2));
  pointer-events: none;
}

/* 填充段：宽度 = 圆钮半径 + ratio * (100% - 2*圆钮半径)，
   和原生 range 圆钮的行程完全重合 —— 所以填充边界总是压在圆钮中心下面。 */
.dsh-thinking-slider-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: 999px;
  width: calc(${RAIL_EDGE}px + var(--dsh-ts-ratio, 0) * (100% - ${RAIL_EDGE * 2}px));
  background: var(--dsh-ts-fill-color, #3078f0);
  pointer-events: none;
  transition: background-color 320ms ease;
}
/* 最高档：填充段上叠一层流动的品牌渐变，用 opacity 淡入淡出 —— 进/出最高档
   是一次 280ms 的过渡，而不是渐变硬闪。 */
.dsh-thinking-slider-fill::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background-image: ${BOOST_GRADIENT};
  background-size: 220% 100%;
  background-position: 50% 50%;
  opacity: 0;
  transition: opacity 280ms ease;
}
.dsh-thinking-slider-rail[data-boost] .dsh-thinking-slider-fill::after { opacity: 1; }

/* 刻度点：每档一颗，铺在圆钮的行程上（左右各内缩一个圆钮半径）。
   两层同样的点：底层灰点，上层「已通过」的浅蓝点，后者被裁到填充宽度。 */
.dsh-thinking-slider-dots {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 ${RAIL_EDGE}px;
  pointer-events: none;
}
.dsh-thinking-slider-dot {
  width: ${DOT_SIZE}px;
  height: ${DOT_SIZE}px;
  border-radius: 50%;
  background: var(--dsh-ts-dot-color, rgba(128,128,128,0.42));
  transition: background-color 240ms ease;
}
.dsh-thinking-slider-dots-passed {
  clip-path: inset(0 calc(100% - (${RAIL_EDGE}px + var(--dsh-ts-ratio, 0) * (100% - ${RAIL_EDGE * 2}px))) 0 0);
}
.dsh-thinking-slider-dots-passed .dsh-thinking-slider-dot {
  background: var(--dsh-ts-dot-passed-color, rgba(109,181,255,1));
}

/* 白圆钮：**自己画的**（原生圆钮透明）。位置同样由比例算出来，所以它会跟着
   填充边界一起缓动；直径比轨道大，上下各溢出 2px —— 素材里那颗钮就是骑在轨道上的。 */
.dsh-thinking-slider-knob {
  position: absolute;
  top: 50%;
  left: calc(${RAIL_EDGE}px + var(--dsh-ts-ratio, 0) * (100% - ${RAIL_EDGE * 2}px));
  width: ${KNOB_SIZE}px;
  height: ${KNOB_SIZE}px;
  margin: -${KNOB_SIZE / 2}px 0 0 -${KNOB_SIZE / 2}px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,0.22), 0 3px 10px rgba(0,0,0,0.16);
  pointer-events: none;
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 180ms ease, opacity 160ms ease;
}
.dsh-thinking-slider-rail:hover .dsh-thinking-slider-knob { transform: scale(1.06); }
.dsh-thinking-slider-rail:has(.dsh-thinking-slider-range:active) .dsh-thinking-slider-knob {
  transform: scale(1.16);
  box-shadow: 0 1px 2px rgba(0,0,0,0.22), 0 4px 12px rgba(0,0,0,0.2), 0 0 0 7px color-mix(in srgb, var(--dsw-alias-state-business-primary, #3078f0) 14%, transparent);
}
/* 提交中：只把圆钮压暗一点点，**不禁用滑轨** —— 禁用会让整行在提交往返里闪一下
   透明度，那正是「拖到松手时感觉卡一下」的来源之一。 */
.dsh-thinking-slider-rail:has(.dsh-thinking-slider-range[data-busy="true"]) .dsh-thinking-slider-knob { opacity: 0.72; }
.dsh-thinking-slider-rail:has(.dsh-thinking-slider-range:disabled) { opacity: 0.55; }
.dsh-thinking-slider-rail:has(.dsh-thinking-slider-range:disabled) .dsh-thinking-slider-knob { transform: none; }
.dsh-thinking-slider-rail:has(.dsh-thinking-slider-range:focus-visible) {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #3078f0) 55%, transparent);
}

/* 最高档：轨道外一圈亮边 + 外发光（让它在浅色/深色页面上都「烫」起来）。 */
.dsh-thinking-slider-rail[data-boost] {
  box-shadow: 0 0 0 1px color-mix(in srgb, ${COLOR.accentBrand} 45%, transparent), 0 0 12px color-mix(in srgb, ${COLOR.accentBrand} 24%, transparent);
}

/* 星尘：两半同样的星图首尾相接，整体左移 50% 后正好无缝循环（素材里那些白点）。 */
.dsh-thinking-slider-stars {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transition: opacity 320ms ease;
}
.dsh-thinking-slider-rail[data-boost] .dsh-thinking-slider-stars { opacity: 1; }
.dsh-thinking-slider-starfield {
  display: flex;
  width: 200%;
  height: 100%;
  animation: dsh-ts-starfield 3s linear infinite;
}
.dsh-thinking-slider-rail[data-boost="fast"] .dsh-thinking-slider-starfield { animation-duration: 1.6s; }
.dsh-thinking-slider-star-half { position: relative; width: 50%; height: 100%; }
.dsh-thinking-slider-star {
  position: absolute;
  width: 2px;
  height: 2px;
  margin: -1px 0 0 -1px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 4px rgba(255,255,255,0.8);
  animation: dsh-ts-twinkle var(--dsh-ts-star-period, 2.2s) ease-in-out var(--dsh-ts-star-delay, 0s) infinite alternate;
}

/* 原生 input：轨道与圆钮全部透明，只留命中盒（尺寸与自绘轨道一致）。
   拖动、点击、键盘因此仍然是浏览器原生行为，视觉却完全由上面几层决定。 */
.dsh-thinking-slider-range {
  -webkit-appearance: none;
  appearance: none;
  position: relative;
  z-index: 2;
  margin: 0;
  width: 100%;
  height: ${RAIL_HEIGHT}px;
  background: transparent;
  cursor: pointer;
  touch-action: pan-y;
}
.dsh-thinking-slider-range:disabled { cursor: default; }
.dsh-thinking-slider-range::-webkit-slider-runnable-track {
  height: ${RAIL_HEIGHT}px;
  border-radius: 999px;
  background: transparent;
  box-shadow: none;
}
.dsh-thinking-slider-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: ${KNOB_SIZE}px;
  height: ${KNOB_SIZE}px;
  margin-top: ${(RAIL_HEIGHT - KNOB_SIZE) / 2}px;
  border: none;
  border-radius: 50%;
  background: transparent;
  box-shadow: none;
}
.dsh-thinking-slider-range::-moz-range-track {
  height: ${RAIL_HEIGHT}px;
  border-radius: 999px;
  background: transparent;
}
.dsh-thinking-slider-range::-moz-range-progress { background: transparent; }
.dsh-thinking-slider-range::-moz-range-thumb {
  width: ${KNOB_SIZE}px;
  height: ${KNOB_SIZE}px;
  border: none;
  border-radius: 50%;
  background: transparent;
  box-shadow: none;
}

/* 触发 chip：中性 hover / 展开态；最高档时整枚 chip 由 JS 换成紫色。 */
.dsh-thinking-slider-trigger { transition: color 240ms ease, background-color 200ms ease; }
.dsh-thinking-slider-trigger:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.dsh-thinking-slider-trigger:active,
.dsh-thinking-slider-trigger[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,0.18)); }
.dsh-thinking-slider-trigger:focus-visible { outline: 2px solid var(--dsw-alias-label-primary, #0d0d0d); outline-offset: 1px; }

/* 官方「选择模型 / 推理等级」座位（single 插槽，抢不过来）：
   本插件已经接管这两件事，所以运行时给它打上这个标记把官方那枚 chip 藏掉。
   标记只在**我们自己能用同一份目录数据**（目录服务已就绪）且官方座位**没被锁**时
   才打上去，卸载时撤掉 —— 控件不可用时用户永远还有官方那一扇门。 */
[${NATIVE_SEAT_ATTR}="hidden"] { display: none !important; }

/* 卡片里的模型行（模型名 ▾）：点开滑条上方的模型清单。 */
.dsh-thinking-slider-model-row { transition: color 200ms ease, background-color 200ms ease; }
.dsh-thinking-slider-model-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.dsh-thinking-slider-model-row:active,
.dsh-thinking-slider-model-row[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,0.18)); }
.dsh-thinking-slider-model-row:focus-visible { outline: 2px solid var(--dsw-alias-label-primary, #0d0d0d); outline-offset: 1px; }
.dsh-thinking-slider-model-row[aria-expanded="true"] .dsh-thinking-slider-model-chevron { transform: rotate(180deg); }

/* 模型清单的开合过渡（图二「收起」↔ 图一「展开」）。
   外层 reveal 用 grid-template-rows 的 0fr ↔ 1fr —— 这是少数能把「高度 auto」也
   做成可过渡的办法，于是**卡片自身的高度跟着一起长/缩**，不是清单「啪」地出现、
   卡片再跳一下。内层 clip 负责裁切（顺便给清单那 -6px 的横向负 margin 留出位置，
   否则细滚动条会被裁掉半边）。清单本体再淡入 + 轻微下移。
   注意清单是**常驻 DOM**的（不是展开才挂载）：收起时若节点直接消失，内容会在
   1 帧内先没了、空出来的高度再慢慢收，看着像被「抽走」；常驻才能让淡出与收缩
   同步。收起态用 aria-hidden + 每行 tabIndex -1 挡住读屏与 Tab。 */
.dsh-thinking-slider-models-reveal {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 300ms cubic-bezier(0.22, 1, 0.36, 1),
    margin-bottom 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.dsh-thinking-slider-models-reveal[data-open="true"] { grid-template-rows: 1fr; }
/* 卡片内容列是 gap: 10px：reveal 夹在卡头与滑轨之间，收起时它会白吃一条 gap
   （卡片比改动前高 10px、多出一条空带）。抵掉一个，卡片高度与以前逐像素一致；
   展开时清单本来就要吃两个 gap，所以是 0。margin 一起过渡，开合才不跳。 */
.dsh-thinking-slider-models-reveal[data-open="false"] { margin-bottom: -10px; }
.dsh-thinking-slider-models-clip {
  min-height: 0;
  overflow: hidden;
  /* 让出清单 margin: 0 -6px 的那 6px：横向不能裁，纵向要裁。 */
  margin: 0 -6px;
  padding: 0 6px;
}
.dsh-thinking-slider-models {
  opacity: 0;
  transform: translateY(-6px);
  transition: opacity 170ms ease, transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
  scrollbar-width: thin;
}
.dsh-thinking-slider-models-reveal[data-open="true"] .dsh-thinking-slider-models { opacity: 1; transform: none; }
.dsh-thinking-slider-model-item { transition: background-color 180ms ease, color 180ms ease; }
.dsh-thinking-slider-model-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.dsh-thinking-slider-model-item:focus-visible { outline: 2px solid var(--dsw-alias-label-primary, #0d0d0d); outline-offset: -2px; }
.dsh-thinking-slider-model-item[aria-selected="true"] .dsh-thinking-slider-model-name { color: var(--dsw-alias-label-primary, inherit); }

/* 卡片进场：淡入 + 轻微上浮。 */
.dsh-thinking-slider-card { animation: dsh-ts-card-in 180ms cubic-bezier(0.22, 1, 0.36, 1); }

/* 档位名切换：淡入 + 上浮（React 侧给 key，动画因此每次换档都会重播）。 */
.dsh-thinking-slider-level { animation: dsh-ts-level-in 200ms cubic-bezier(0.22, 1, 0.36, 1); }

/* 「等级名 ›」按钮：hover 时箭头右移一点 —— 素材里那个 \`›\` 就是「下一档」的暗示。 */
.dsh-thinking-slider-advance { transition: color 200ms ease, background-color 200ms ease; }
.dsh-thinking-slider-advance:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.dsh-thinking-slider-advance:hover .dsh-thinking-slider-chevron { transform: translateX(2px); }
.dsh-thinking-slider-advance:disabled { cursor: default; opacity: 0.75; }
.dsh-thinking-slider-advance:focus-visible { outline: 2px solid var(--dsw-alias-label-primary, #0d0d0d); outline-offset: 1px; }

/* 重置 ↻：按下时转半圈，hover 时变亮并出现一枚中性底。 */
.dsh-thinking-slider-reset:hover { color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.dsh-thinking-slider-reset:active .dsh-thinking-slider-reset-glyph { transform: rotate(-180deg); }
.dsh-thinking-slider-reset-glyph { transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1); }
.dsh-thinking-slider-reset:focus-visible { outline: 2px solid var(--dsw-alias-label-primary, #0d0d0d); outline-offset: 1px; }

/* 最高档的「流动」：填充段上那层渐变缓慢左右移动（最高档 6s、Ultra 4s）。 */
.dsh-thinking-slider-rail[data-boost] .dsh-thinking-slider-fill::after { animation: dsh-ts-effort-flow 6s ease-in-out infinite alternate; }
.dsh-thinking-slider-rail[data-boost="fast"] .dsh-thinking-slider-fill::after { animation-duration: 4s; }

@keyframes dsh-ts-card-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes dsh-ts-level-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes dsh-ts-effort-flow {
  from { background-position: 0% 50%; }
  to { background-position: 100% 50%; }
}
@keyframes dsh-ts-starfield {
  from { transform: translate3d(0, 0, 0); }
  to { transform: translate3d(-50%, 0, 0); }
}
@keyframes dsh-ts-twinkle {
  from { opacity: 0.25; transform: scale(calc(var(--dsh-ts-star-scale, 1) * 0.55)); }
  to { opacity: 1; transform: scale(var(--dsh-ts-star-scale, 1)); }
}

/* 系统级「减弱动态效果」：动效全部关掉，控件仍然完全可用。 */
@media (prefers-reduced-motion: reduce) {
  .dsh-thinking-slider-rail,
  .dsh-thinking-slider-fill,
  .dsh-thinking-slider-fill::after,
  .dsh-thinking-slider-knob,
  .dsh-thinking-slider-star,
  .dsh-thinking-slider-starfield,
  .dsh-thinking-slider-card,
  .dsh-thinking-slider-models-reveal,
  .dsh-thinking-slider-models-clip,
  .dsh-thinking-slider-models,
  .dsh-thinking-slider-level,
  .dsh-thinking-slider-range {
    animation: none !important;
    transition: none !important;
  }
}
`;

    /**
     * 幂等地把 range 样式注入 <head>。
     *
     * 注意不能只按标签判重：client-hmr 热重载会重新执行本模块，但 `<style>`
     * 标签还留在页面里 —— 只判存在就会把**旧样式**留在页面上，改了视觉却看不到
     * 效果。所以这里顺手按内容对齐一次（永远只有一个标签）。
     */
    function injectRangeCss() {
      if (typeof document === "undefined") return;
      const tagId = RANGE_STYLE_TAG;
      const existing = document.querySelector(`style[data-plugin-css="${tagId}"]`);
      if (existing !== null && existing !== undefined) {
        if (existing.textContent !== RANGE_CSS) existing.textContent = RANGE_CSS;
        return;
      }
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-thinking-slider";
      tag.dataset.pluginCss = tagId;
      tag.textContent = RANGE_CSS;
      document.head.appendChild(tag);
    }

    /**
     * 取事件里的滑轨元素（真实 DOM 里 `target` 与 `currentTarget` 是同一个 input）。
     *
     * 单测脚手架给的 `currentTarget` 是 props 对象（带 `style` 没有 `setProperty`），
     * 所以下面几个 DOM 小工具都必须「拿不到就静默跳过」，绝不能抛 —— 与 `quiet()`
     * 同一条保命纪律：**任何 UI 细节都不许把宿主 boot 弄挂**。
     * @param {object} event - React 合成事件。
     * @returns {object|null}
     */
    function eventValueTarget(event) {
      if (event === null || event === undefined) return null;
      return event.currentTarget === undefined ? event.target ?? null : event.currentTarget;
    }

    /**
     * 读滑轨当前的**连续值**。
     * @param {object} event - React 合成事件。
     * @returns {number|null} 非有限值时返回 null（调用方按「没读到」处理）。
     */
    function rangeValueOf(event) {
      const el = eventValueTarget(event);
      if (el === null || el === undefined) return null;
      const raw = el.value;
      // `""`/`null` 不是 0：range 没拿到值时不能把圆钮拽到最低档。
      if (raw === "" || raw === null || raw === undefined) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    }

    /**
     * 把 CSS 自定义属性写到元素上（真实 DOM 必须走 `setProperty`）。
     * @param {object} target - 元素。
     * @param {string} name - 自定义属性名。
     * @param {string} value - 值。
     */
    function setStyleVar(target, name, value) {
      const style = target === null || target === undefined ? null : target.style;
      if (style === null || style === undefined) return;
      if (typeof style.setProperty === "function") {
        style.setProperty(name, value);
        return;
      }
      style[name] = value;
    }

    /**
     * 开关**滑轨比例**的过渡（挂在 `.dsh-thinking-slider-rail` 上）。
     *
     * 拖动中必须**零延迟跟手**（所以临时写一条 inline `transition: none` 压住
     * `RANGE_CSS` 里那条 320ms 回弹过渡），松手后再移除，让点击轨道 / 键盘跳档 /
     * 返回默认的填充·圆钮·刻度点一起缓动过去 —— 「丝滑」就是这两半合起来的手感。
     * @param {object} target - 滑轨外层元素（不是 input，变量挂在它上面）。
     * @param {boolean} enabled - true = 恢复 CSS 里的过渡。
     */
    function setRailTransition(target, enabled) {
      const style = target === null || target === undefined ? null : target.style;
      if (style === null || style === undefined || typeof style.setProperty !== "function") return;
      if (enabled) {
        if (typeof style.removeProperty === "function") style.removeProperty("transition");
        return;
      }
      style.setProperty("transition", "none");
    }

    /** 目录不可用时的空订阅（必须返回稳定的函数引用，否则 React 每次渲染都重订阅）。 */
    const NOOP_UNSUBSCRIBE = () => {};

    /**
     * 提交序号：每条目录一个自增计数器（挂在 directory 上而非组件 ref）。
     * 同一会话的多个控件实例共用它，才能保证「先发后到」的响应一定被丢弃。
     * @param {object} directory - `ModelDirectory` 实例。
     * @returns {number} 本次提交的序号。
     */
    function nextGeneration(directory) {
      directory.__dshThinkingSliderGeneration = (directory.__dshThinkingSliderGeneration ?? 0) + 1;
      return directory.__dshThinkingSliderGeneration;
    }

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */

    /**
     * 内联 SVG 兜底图标：官方图标原语拿不到时用，保证卡片头两端的图标永远在。
     * 描边一律 `currentColor`，因此最高档转紫（`cardInkOf` 给的色）能一起生效。
     */

    /** 闪电轮廓（素材卡片左侧那个）。 */
    function BoltGlyph(props) {
      const size = typeof props?.size === "number" ? props.size : 16;
      return react.createElement(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          style: { display: "block" },
        },
        react.createElement("path", { d: "M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" }),
      );
    }

    /** 圆形箭头（素材卡片右侧那个 ↻）。 */
    function ResetGlyph(props) {
      const size = typeof props?.size === "number" ? props.size : 16;
      return react.createElement(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          className: "dsh-thinking-slider-reset-glyph",
          style: { display: "block" },
        },
        react.createElement("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
        react.createElement("path", { d: "M21 4v5h-5" }),
      );
    }

    /**
     * 输入框右侧的「推理强度」滑条。
     *
     * 只在当前模型**声明了推理等级**时渲染（否则官方模型菜单里也没有这一项，
     * 我们不该凭空多出一个控件）。
     * @param {object} props - 插槽注入的 props（sessionId + useSession + 标准 t）。
     * @returns {object|null} 触发按钮与展开后的卡片。
     */
    function ThinkingSlider(props) {
      const sessionId = props.sessionId;
      const directory = useDirectory(sessionId);
      const t = typeof props.t === "function" ? props.t : null;
      const [, bump] = react.useState(0);
      const [open, setOpen] = react.useState(false);
      /**
       * 拖动草稿：`{ value, base }`。
       *   - `value` 是滑轨位置（0..lastIndex）；**拖动中**它是连续的（可以是 1.4 这种
       *     小数），**松手后**被吸附成整数档位下标；
       *   - `base` 是按下瞬间的权威档位下标，用来区分「服务端还没采纳我的选择」和
       *     「档位被外部改了」这两件完全相反的事。
       * 拖动中之所以保持连续值而不是整数档位：圆钮要**贴着手指走**，按档吸附的话
       * 3~5 档的滑轨会变成一格一格地跳，跟手感立刻没了。档位语义交给
       * `Math.round(value)`，吸附推迟到松手（见 `onRelease`）。
       * @type {[{value:number, base:number}|null, Function]}
       */
      const [draft, setDraft] = react.useState(null);
      /** @type {react.MutableRefObject<boolean>} 拖动中，忽略 snapshot 回写。 */
      const dragging = react.useRef(false);
      /** 上一次 input 的连续值：松手时同步补发的重复事件直接丢弃。 */
      const lastRaw = react.useRef(null);
      /** 拖动中已经渲染过的档位：同一档内不 setState（填充直接写 DOM，零渲染跟手）。 */
      const dragLevel = react.useRef(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState("");
      /** 卡片里的模型清单是否展开（挑完一个、或卡片关掉就收起）。 */
      const [modelsOpen, setModelsOpen] = react.useState(false);
      const rootRef = react.useRef(null);
      const cardRef = react.useRef(null);
      /** 滑轨外层：`--dsh-ts-ratio` 与拖动期的过渡开关都写在它身上（子元素共享）。 */
      const railRef = react.useRef(null);
      /** 被我们藏起来的官方模型座位（卸载时按这个引用还原）。 */
      const nativeSeat = react.useRef(null);
      /** 官方座位当前是不是被藏着的：只在状态翻转时写诊断，避免 MutationObserver 刷屏。 */
      const nativeHidden = react.useRef(null);
      /** 临时：每次挂载只报一次自身几何（排查 chip 不显示）。 */
      const geometryLogged = react.useRef(false);
      const activeNotice = useNoticeState();

      // 目录快照订阅：官方模型菜单读的是同一个 store。
      const snapshot = react.useSyncExternalStore(
        react.useCallback(
          (onChange) => {
            if (directory === null || typeof directory.store.subscribe !== "function") return NOOP_UNSUBSCRIBE;
            return directory.store.subscribe(onChange);
          },
          [directory],
        ),
        react.useCallback(() => (directory === null ? null : directory.store.getSnapshot()), [directory]),
        () => null,
      );

      // 首次挂载拉一次目录（官方座位也是这么做的），失败静默 —— 目录不可用时
      // 控件自己会隐藏，不必打扰用户。
      react.useEffect(() => {
        if (directory === null) return;
        try {
          directory.load().catch(() => {});
        } catch {
          /* 目录不可用：控件隐藏 */
        }
      }, [directory]);

      /**
       * 顶替官方「选择模型 / 推理等级」座位。
       *
       * 官方座位占的是 **single** 插槽 `conversation.input.model`，注册位被别人占了就抛
       * 错，抢不过来 —— 只能等它渲染出来，给它的 DOM 打标记 + 用 CSS 藏掉。三个条件
       * 必须同时成立才藏：
       *   1. 我们自己的目录数据可用（`directory !== null`）：同一份 `groups` 我们也能列；
       *   2. 在 DOM 里找到了官方座位，且它**没被官方锁住**（见 `isNativeModelSeat`）；
       *   3. 之后每次座位被重挂（切会话会重挂 DOM 节点）都能重新打上标记 → MutationObserver。
       * 任何一条不成立就什么都不做：最坏结果是「多一枚 chip」，绝不会是「少一个功能」。
       */
      react.useEffect(() => {
        if (directory === null) return undefined;
        const self = rootRef.current;
        if (self === null || self === undefined) return undefined;
        const sync = () => {
          const seat = hideNativeSeat(self);
          if (seat !== null) nativeSeat.current = seat;
          if (nativeHidden.current !== (seat !== null)) {
            nativeHidden.current = seat !== null;
            reportDiag("native-seat", { hidden: seat !== null, sessionId: sessionId ?? null });
          }
          // 几何取证（排查「chip 不显示」）：每次挂载只报一次。
          //
          // Android WebView 没有 devtools，座位「看不见」时第一嫌疑不是样式写错，而是
          // **祖先被隐藏**——官方在会话跑任务时会把整行控件 `display:none`（见 README
          // 诊断表：跑任务时连官方那枚 chip 一起消失）。只报一次即可，报的是
          // `seat-geometry`，`chain` 字段把自身往上 8 层的 `TAG.class|display/WxH` 全列出来，
          // 一眼看出是哪一层断了布局。
          if (geometryLogged.current !== true) {
            geometryLogged.current = true;
            quiet("geometry-error", () => {
              const rect = self.getBoundingClientRect();
              const style = window.getComputedStyle(self);
              const parent = self.parentElement;
              // 逐层往上取证：哪一层 display:none / 零布局，一眼看出来。
              // `#hidden` = 该层带 hidden 属性，`#inline` = 该层内联样式里写了 display:none。
              const chain = [];
              let node = self;
              for (let up = 0; node !== null && up < 12; up += 1) {
                const box = node.getBoundingClientRect();
                const own = window.getComputedStyle(node);
                const flags = `${node.hasAttribute("hidden") ? "#hidden" : ""}${node.hasAttribute(NATIVE_SEAT_ATTR) ? "#mark" : ""}${String(node.getAttribute("style") ?? "").replace(/\s+/g, "").includes("display:none") ? "#inline" : ""}`;
                chain.push(`${node.tagName}.${String(node.className).slice(0, 30)}|${own.display}/${Math.round(box.width)}x${Math.round(box.height)}${flags}`);
                node = node.parentElement;
              }
              // 官方 composer 可能有多个实例（会话里的、首页 hero 的、隐藏的测量用的……）。
              // 数一数文档里所有 `…_standardControls`，看我们这枚 chip 落在哪一个身上：
              // 若只有「不包含 self 的实例是可见的」，说明座位挂在了隐藏实例里。
              const instances = [];
              let mine = 0;
              for (const el of Array.from(document.querySelectorAll('[class*="standardControls"]'))) {
                const box = el.getBoundingClientRect();
                const inside = el.contains(self) === true;
                if (inside) mine += 1;
                instances.push(`${inside ? "MINE" : "----"}|${String(el.className).slice(0, 34)}|display=${window.getComputedStyle(el).display}${el.hasAttribute("hidden") ? "#hidden" : ""}|${Math.round(box.width)}x${Math.round(box.height)}|y=${Math.round(box.y)}`);
              }
              // 被标记的节点是谁 + 「那一层 display:none 是哪条规则写的」：逐个样式表用
              // `rowEl.matches(selectorText)` 反查，比翻源码可靠（CSS module 哈希会变）。
              const markedEl = document.querySelector(`[${NATIVE_SEAT_ATTR}]`);
              const marked = markedEl === null
                ? "none"
                : `${markedEl.tagName}.${String(markedEl.className).slice(0, 40)}|display=${window.getComputedStyle(markedEl).display}|text=${String(markedEl.textContent ?? "").slice(0, 24)}`;
              let rowEl = self;
              while (rowEl !== null && String(rowEl.className).indexOf("_row") < 0) rowEl = rowEl.parentElement;
              const killers = [];
              if (rowEl !== null) {
                for (const sheet of Array.from(document.styleSheets)) {
                  let list = null;
                  try { list = sheet.cssRules; } catch { list = null; }
                  if (list === null) continue;
                  for (const rule of Array.from(list)) {
                    const sel = rule.selectorText;
                    if (typeof sel !== "string") continue;
                    const shown = String(rule.style === undefined || rule.style === null || rule.style.display === undefined ? "" : rule.style.display);
                    let hit = false;
                    try { hit = rowEl.matches(sel) === true; } catch { hit = false; }
                    if (hit === true && shown !== "") killers.push(`${sel.slice(0, 200)}{display:${shown}}`);
                    if (killers.length > 12) break;
                  }
                  if (killers.length > 12) break;
                }
              }
              reportDiag("seat-geometry", {
                tag: self.tagName,
                className: String(self.className).slice(0, 80),
                popup: String(self.getAttribute("aria-haspopup") ?? ""),
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                position: style.position,
                offsetParent: self.offsetParent === null ? "null" : `${self.offsetParent.tagName}.${String(self.offsetParent.className).slice(0, 36)}`,
                parentTag: String(parent === null ? "" : parent.tagName),
                parentClass: String(parent === null ? "" : parent.className).slice(0, 120),
                parentChildren: parent === null ? -1 : parent.children.length,
                siblings: parent === null ? [] : Array.from(parent.children).map((child) => `${String(child.className).slice(0, 48)}${child.hasAttribute(NATIVE_SEAT_ATTR) ? "#hidden" : ""}`),
                chain,
                instances,
                mine,
                marked,
                killers,
                text: String(self.textContent ?? "").slice(0, 60),
                sessionId: sessionId ?? null,
              });
            });
          }
        };
        quiet("native-seat-error", sync);
        let observer = null;
        quiet("native-seat-error", () => {
          const container = self.parentElement;
          if (container === null || container === undefined) return;
          if (typeof MutationObserver !== "function") return;
          observer = new MutationObserver(() => quiet("native-seat-error", sync));
          observer.observe(container, { childList: true });
        });
        return () => {
          try {
            if (observer !== null) observer.disconnect();
          } catch {
            /* 观察器已经没了：无需断开 */
          }
          showNativeSeat(nativeSeat.current);
          nativeSeat.current = null;
          nativeHidden.current = null;
        };
      }, [directory, sessionId]);

      // 卡片关掉时把模型清单一起收起：下次打开是一张干净的卡片。
      react.useEffect(() => {
        if (!open) setModelsOpen(false);
      }, [open]);

      const view = react.useMemo(() => resolveLevels(snapshot), [snapshot]);
      const stops = react.useMemo(() => buildStops(view), [view]);
      /** 可选模型行：与官方模型菜单同一份快照（`snapshot.groups` / `snapshot.failures`）。 */
      const modelRows = react.useMemo(() => modelChoicesOf(snapshot), [snapshot]);
      /** 多于一个 provider 时才画分组标题（只有一个 provider 时标题纯属噪音）。 */
      const manyProviders = react.useMemo(() => {
        const seen = new Set();
        for (const row of modelRows) if (row.selectable === true && row.groupId !== undefined) seen.add(row.groupId);
        return seen.size > 1;
      }, [modelRows]);
      const serverIndex = stopIndexOf(view, stops);
      const lastIndex = Math.max(stops.length - 1, 0);
      /** 滑轨的**连续**位置：拖动中 / 松手后取自草稿，没有草稿时跟权威档位。 */
      const thumbPosition = draft === null ? serverIndex : draft.value;
      /**
       * 拖动中对外呈现的位置：优先用 `lastRaw`（手指最后一次所在处），而不是草稿里
       * 那个「跨档瞬间记下的值」。原因：拖动中若因为别的原因（目录快照更新、通知条
       * 出现…）触发一次重渲染，受控 `value` 会被 React 重新写进 DOM；用草稿值就会
       * 把圆钮从手指底下拽回上一个跨档点（看得出来的一顿）。用 ref 里的最新值就不会。
       */
      const livePosition = dragging.current && lastRaw.current !== null ? lastRaw.current : thumbPosition;
      /** 档位语义（整数下标）：标签、提交、最高档判定都只看它。 */
      const index = Math.min(Math.max(Math.round(thumbPosition), 0), lastIndex);

      // 一次性诊断：把「挂载了、目录有没有、模型有没有等级」送回宿主日志。
      react.useEffect(() => {
        reportDiag("seat-render", {
          sessionId: sessionId ?? null,
          propKeys: Object.keys(props),
          hasDirectory: directory !== null,
          supported: view.supported,
          levels: view.levels.length,
          status: view.status ?? null,
          model: view.model === undefined ? null : view.model.id,
        });
      }, [sessionId, directory, view.supported, view.levels.length, view.status, view.model]);

      // 草稿的落地判定，分三种情况：
      //   1. 权威档位 == 草稿所在档 → 已被采纳：**保留落点**，不清草稿 —— 圆钮不会
      //      在提交成功后回跳到档位中心（那一下回跳正是「松手后一顿」的来源）；
      //   2. 权威档位 == 草稿的 base → 还没落地，继续等，别把乐观值撤掉；
      //   3. 其余 = 档位被外部改了（别的控件 / 别的会话）→ 丢弃草稿，回到权威值。
      react.useEffect(() => {
        if (draft === null || dragging.current) return;
        const level = Math.round(draft.value);
        if (serverIndex === level || serverIndex === draft.base) return;
        setDraft(null);
      }, [draft, serverIndex]);

      const position = useAnchoredPosition({
        open,
        anchorRef: rootRef,
        panelRef: cardRef,
        side: "top",
        align: "start",
        gap: 8,
        margin: 12,
      });
      useDismissOnOutsidePointer(rootRef, open, setOpen, cardRef);

      const currentStop = stops[index] ?? stops[0];
      const levelName = currentStop === undefined ? "默认" : currentStop.name;
      const modelLabel = view.model === undefined ? "" : view.model.name ?? view.model.id;

      /**
       * 唯一的提交入口：模型 + 档位一起发（官方 `directory.select` 收的就是这三项）。
       *
       * 世代号（`nextGeneration`）保证迟到的响应被丢弃：连点两次不同模型时，先回来的
       * 那个不会把界面拉回上一个选择。`busy` 只把 chip 上的箭头换成转圈、圆钮稍微压暗，
       * **不禁用**控件 —— 禁用会让整行闪一下透明度，手感上就是「卡一下」。
       * @param {object} selection - `{provider, model, reasoningEffort?}`。
       * @returns {Promise<boolean>} 是否成功（false = 失败，或已被更新的请求取代）。
       */
      const sendSelection = react.useCallback(
        async (selection) => {
          if (directory === null) return false;
          if (selection === null || selection === undefined || typeof selection !== "object") return false;
          if (selection.provider === undefined || selection.model === undefined) return false;
          const mine = nextGeneration(directory);
          setBusy(true);
          setError("");
          try {
            const result = await directory.select(selection);
            if (mine !== directory.__dshThinkingSliderGeneration) return false; // 迟到的响应：丢弃
            if (result !== undefined && result !== null && result.ok === false) {
              const failure = result.error;
              throw new Error(
                failure !== undefined && failure !== null && typeof failure.message === "string"
                  ? failure.message
                  : "选择推理等级失败",
              );
            }
            return true;
          } catch (failure) {
            if (mine !== directory.__dshThinkingSliderGeneration) return false;
            setError(messageOf(failure));
            setDraft(null);
            return false;
          } finally {
            if (mine === directory.__dshThinkingSliderGeneration) setBusy(false);
          }
        },
        [directory],
      );

      /** 提交第 index 档（`undefined` effort 表示 provider 默认档）。 */
      const commit = react.useCallback(
        async (targetIndex) => {
          if (directory === null) return;
          const stop = stops[targetIndex];
          if (stop === undefined) return;
          const effort = effortOf(stop);
          // 用官方口径的当前档做空操作判断：即使快照里没有显式的 reasoningEffort，
          // 目录声明的 defaultEffort 也已经等于「再选一次同一个档」。
          if (effort === view.effectiveEffort && targetIndex === serverIndex) return;
          await sendSelection({
            provider: view.provider === undefined ? undefined : view.provider.id,
            model: view.model === undefined ? undefined : view.model.id,
            ...effort === undefined ? {} : { reasoningEffort: effort },
          });
        },
        [directory, stops, view.effectiveEffort, view.model, view.provider, serverIndex, sendSelection],
      );

      /**
       * 挑一个模型（卡片里那份清单里的任意一行）。
       *
       * 档位按 {@link transferEffort} 带过去：目标模型声明了同 id 的档位就保留，
       * 否则省略，让目录自己落到它的默认档 —— 与官方菜单换模型的落地方式一致。
       * @param {object} row - {@link modelChoicesOf} 的一行。
       * @returns {Promise<void>}
       */
      const pickModel = react.useCallback(
        async (row) => {
          if (row === null || row === undefined || typeof row !== "object") return;
          if (row.selectable !== true) return;
          if (row.active === true) {
            setModelsOpen(false);
            return;
          }
          const effort = transferEffort(row, view.effectiveEffort);
          const done = await sendSelection({
            provider: row.provider,
            model: row.model,
            ...effort === undefined ? {} : { reasoningEffort: effort },
          });
          if (done) {
            setModelsOpen(false);
            setDraft(null);
          }
        },
        [sendSelection, view.effectiveEffort],
      );

      /** 连续位置 → 合法档位下标。 */
      const levelOf = (value) => Math.min(Math.max(Math.round(value), 0), lastIndex);

      /**
       * 拖动：**只有跨档那几次才 setState**。
       *
       * 每来一个 input 事件都 setState 的话，React 会把整张卡片重渲染一遍；
       * 这里改成把比例直接写进滑轨外层的 CSS 变量（零渲染、零延迟跟手），
       * 一次拖动最多触发 4~5 次渲染（跨档时，为了换档位名与最高档配色）。
       */
      const onInput = (event) => {
        const value = rangeValueOf(event);
        if (value === null) return;
        const clamped = Math.min(Math.max(value, 0), lastIndex);
        if (lastRaw.current === clamped) return; // 松手时补发的重复事件
        lastRaw.current = clamped;
        dragging.current = true;
        // 变量挂在滑轨外层（填充 / 圆钮 / 刻度点都读它）；测试脚手架里 mount 不出
        // 真实 ref 时退回事件目标，保证单测走的是同一条路径。
        const rail = railRef.current ?? eventValueTarget(event);
        // 拖动中关掉比例过渡：开着的话填充会花 320ms 去「追」手指。
        setRailTransition(rail, false);
        const level = levelOf(clamped);
        if (dragLevel.current === level) {
          setStyleVar(rail, "--dsh-ts-ratio", String(ratioOf(clamped, lastIndex)));
          return;
        }
        dragLevel.current = level;
        setDraft({ value: clamped, base: draft === null ? serverIndex : draft.base });
      };

      /** 跳档（返回默认 / 点 `›` / 键盘）：落点、提交一次。填充与圆钮由 CSS 过渡缓动到位。 */
      const jumpTo = (target) => {
        const level = levelOf(target);
        // 保险：万一上一次拖动的 inline `transition: none` 还留在元素上，跳档会瞬移。
        if (railRef.current !== null) setRailTransition(railRef.current, true);
        dragging.current = false;
        dragLevel.current = null;
        lastRaw.current = level;
        setDraft({ value: level, base: serverIndex });
        void commit(level);
      };

      /**
       * 松手 / 失焦 / 手势被打断：**吸附到最近的档位**并提交一次。
       *
       * 吸附 = 把草稿值从连续落点换成 `Math.round(落点)`（档位下标），圆钮因此永远
       * 落在档位中心，不可能停在两档之间。为什么放在**松手这一刻**：拖动中必须保持
       * 连续才有跟手感（按档吸附会一格一格跳）；松手时手指已经离开，此时用 CSS 里
       * 那条 320ms 回弹过渡滑过去，看起来是「被最近的档位吸过去」，而不是「啪」一跳。
       *
       * 顺序不能反：先恢复过渡，React 随后提交的新比例才会补间；反过来的话，
       * 第一次吸附会瞬移（inline `transition: none` 还挂在元素上）。
       */
      const onRelease = (event) => {
        const raw = rangeValueOf(event);
        const clamped = Math.min(Math.max(raw === null ? thumbPosition : raw, 0), lastIndex);
        // 吸附落点：最近档位（正好在中点时向上，与 Math.round 一致）。
        const level = levelOf(clamped);
        setRailTransition(railRef.current ?? eventValueTarget(event), true);
        dragging.current = false;
        dragLevel.current = null;
        // 记的是**手指离开处的连续值**：浏览器松手时会补发一个重复的 input 事件，
        // 带的就是这个值，靠它把重复事件丢掉 —— 否则刚吸附好的圆钮又被拽回两档之间。
        lastRaw.current = clamped;
        setDraft({ value: level, base: draft === null ? serverIndex : draft.base });
        void commit(level);
      };

      /** 键盘：按**整档**移动（step 是 0.01，交给浏览器就变成 0.01 的微调了）。 */
      const onKey = (event) => {
        const key = event === null || event === undefined || event.key === undefined ? "" : String(event.key);
        const level = levelOf(thumbPosition);
        let target = null;
        if (key === "ArrowRight" || key === "ArrowUp") target = level + 1;
        else if (key === "ArrowLeft" || key === "ArrowDown") target = level - 1;
        else if (key === "PageUp") target = level + 2;
        else if (key === "PageDown") target = level - 2;
        else if (key === "Home") target = 0;
        else if (key === "End") target = lastIndex;
        if (target === null) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        jumpTo(target);
      };

      if (sessionId === undefined) return null;
      // 目录服务还没到：留一个极小的占位点，证明「座位确实挂上了」。此时**不接管**
      // 官方座位 —— 官方那枚 chip 眼下还是切模型 / 切档位的唯一入口。
      if (directory === null) return react.createElement("span", { style: TRIGGER_WAIT, "aria-hidden": "true" });

      // 这枚 chip 现在顶替了官方「选择模型 + 推理等级」座位，所以模型不支持推理等级时
      // **不能**像以前那样把整个座位渲染成 null —— 那会把「切模型」的唯一入口一起抽走。
      // 降级方式改成「只少一根滑条」：卡片里照样能挑模型，只是没有档位可选。
      const triggerText = modelLabel === "" ? (t === null ? "选择模型" : t("trigger.pick")) : modelLabel;

      // 目录还在加载、且快照里连一个具名档位都没有时，滑轨只读：
      // 此时档位列表随时会被刷新覆盖，让用户拖动只会得到一个马上失效的草稿。
      // 已经拿到具名档位（stops.length > 1）就不锁，加载中的刷新不影响档位语义。
      const locked = view.status === "loading" && stops.length <= 1;
      // 位置比例（0..1）取**连续位置**而不是整数档位：拖动中它就是手指的位置。
      // 填充宽度、圆钮位置、已通过的刻度点，全都由这一个数算出来。
      const ratio = ratioOf(livePosition, lastIndex);
      // 「返回默认」的目标：优先目录声明的默认档，没声明就用「provider default」档。
      // -1 表示当前就在默认档 → 不出这个按钮。
      const resetIndex = resetIndexOf(view, stops, index);

      // 当前档位的 effort：`railBoostAttr` / `railVarsFor` / 星尘都按它判断要不要上品牌渐变。
      const boostEffort = effortOf(currentStop);
      // 素材里的最高档：整条轨道流动渐变 + 白色星尘，闪电与等级名一起转紫。
      const boost = railBoostOf(boostEffort);
      const ink = cardInkOf(boost);
      const starCount = starCountFor(boost);

      const rangeNode = react.createElement("input", {
        type: "range",
        className: "dsh-thinking-slider-range",
        min: 0,
        max: lastIndex,
        // 连续步进：档位语义交给 Math.round，拖动因此是「跟手」而不是「一格格跳」。
        step: DRAG_STEP,
        value: livePosition,
        // 提交中**不禁用**滑轨（禁用会让整行闪一下透明度、手感发顿）；连点也只发一次
        // 有效请求，迟到的响应由 nextGeneration 序号丢弃。
        disabled: locked,
        "data-busy": busy ? "true" : undefined,
        "aria-label": t === null ? "推理强度" : t("trigger.aria"),
        "aria-valuetext": levelName,
        onChange: onInput,
        onPointerUp: onRelease,
        onPointerCancel: onRelease,
        onKeyDown: onKey,
        onBlur: (event) => {
          if (dragging.current) onRelease(event);
        },
      });

      /**
       * 刻度点：**每一档一个点**，排在滑轨正中，和原生 range 的圆钮行程重合
       * （`padding: 0 13px` = 内缩一个圆钮半径）。
       *
       * 画两层：底层灰点常驻；上层是「已通过」的点，用 `clip-path` 裁到填充宽度，
       * 于是被填充盖住的点自动变成素材里那颗浅蓝点，而不用逐个算哪几个点已到达。
       */
      const dots = (passed) =>
        react.createElement(
          "div",
          {
            className: passed
              ? "dsh-thinking-slider-dots dsh-thinking-slider-dots-passed"
              : "dsh-thinking-slider-dots",
            "aria-hidden": "true",
          },
          stops.map((_stop, at) => react.createElement("span", { key: at, className: "dsh-thinking-slider-dot" })),
        );

      // 整版星空要两份：整体左移 50% 时后半段正好补上前半段，循环才无缝。
      const starHalf = (half) =>
        react.createElement(
          "div",
          { key: half, className: "dsh-thinking-slider-star-half" },
          Array.from({ length: starCount }, (_unused, at) =>
            react.createElement("i", {
              key: at,
              className: "dsh-thinking-slider-star",
              style: starStyleFor(at, boost),
            }),
          ),
        );

      // 滑轨外层容器：布局盒 + 共享的 `--dsh-ts-ratio`，五层自绘子元素（底轨 / 填充 /
      // 两层刻度点 / 星尘）+ 骑在上面的白圆钮，最后才是真正接收手势的原生 `input`。
      const railNode = react.createElement(
        "div",
        {
          ref: railRef,
          className: "dsh-thinking-slider-rail",
          style: { ...railStyleFor(), ...railVarsFor(ratio, boostEffort) },
          ...railBoostAttr(boostEffort),
        },
        react.createElement("div", { className: "dsh-thinking-slider-track", "aria-hidden": "true" }),
        react.createElement("div", { className: "dsh-thinking-slider-fill", "aria-hidden": "true" }),
        dots(false),
        dots(true),
        boost === null
          ? null
          : react.createElement(
              "div",
              { className: "dsh-thinking-slider-stars", "aria-hidden": "true" },
              react.createElement("div", { className: "dsh-thinking-slider-starfield" }, [0, 1].map(starHalf)),
            ),
        react.createElement("div", { className: "dsh-thinking-slider-knob", "aria-hidden": "true" }),
        rangeNode,
      );

      /**
       * 模型清单：官方模型菜单的同一份数据，只是画在了滑条上方。
       *
       * **常驻 DOM**，开合交给外层 reveal 的 `grid-template-rows: 0fr ↔ 1fr`
       * （`data-open` 是开关）：这样「图二 ⇄ 图一」两个方向的过渡都有内容可淡，
       * 卡片高度也跟着一起长/缩。收起时用 `aria-hidden` + 每行 `tabIndex: -1`
       * 挡住读屏与 Tab —— 常驻不等于「还活着」。
       *
       * 多 provider 时插分组标题（只有一个 provider 时标题是纯噪音）；末尾是
       * 「provider 加载失败」的不可选行 —— 让用户看得见「这里本来还有东西」。
       */
      const modelListNode = modelRows.length > 0
        ? react.createElement(
            "div",
            {
              className: "dsh-thinking-slider-models-reveal",
              "data-open": modelsOpen ? "true" : "false",
              "aria-hidden": modelsOpen ? undefined : "true",
            },
            react.createElement(
              "div",
              { className: "dsh-thinking-slider-models-clip" },
              react.createElement(
                "div",
                {
                  className: "dsh-thinking-slider-models",
                  style: MODEL_LIST,
                  role: "listbox",
                  "aria-label": t === null ? "选择模型" : t("card.selectModel"),
                },
                modelRows.map((row, at) => {
                  const previous = at === 0 ? null : modelRows[at - 1];
                  const heading = row.selectable === true && manyProviders && (previous === null || previous.groupId !== row.groupId)
                    ? react.createElement(
                        "p",
                        { key: `group:${String(row.groupId)}`, style: MODEL_GROUP },
                        row.account ? (t === null ? "账户" : t("card.account")) : row.groupName,
                      )
                    : null;
                  const item = react.createElement(
                    "button",
                    {
                      key: row.key,
                      type: "button",
                      role: "option",
                      className: "dsh-thinking-slider-model-item",
                      style: row.selectable === true ? MODEL_ITEM : MODEL_FAILURE,
                      disabled: row.selectable !== true,
                      // 收起时清单只是「被裁掉」，按钮仍在 DOM 里 —— 去掉 Tab 停靠点。
                      tabIndex: modelsOpen ? undefined : -1,
                      "aria-selected": row.active === true,
                      title: row.detail === "" ? undefined : row.detail,
                      onClick: () => {
                        void pickModel(row);
                      },
                    },
                    react.createElement("span", { style: MODEL_CHECK, "aria-hidden": "true" }, row.active === true ? "✓" : ""),
                    react.createElement("span", { className: "dsh-thinking-slider-model-name", style: MODEL_ROW_LABEL }, row.name),
                  );
                  return heading === null ? item : [heading, item];
                }),
              ),
            ),
          )
        : null;

      const card = open && typeof document !== "undefined"
        ? require("react-dom").createPortal(
            react.createElement(
              MenuSurface,
              {
                ref: cardRef,
                className: undefined,
                style: { ...CARD, ...(position ?? { visibility: "hidden", left: 0, top: 0 }) },
                role: "group",
                "aria-label": t === null ? "推理强度" : t("card.aria"),
              },
              react.createElement(
                "div",
                { className: "dsh-thinking-slider-card-inner", style: CARD_INNER },
                react.createElement(
                  "div",
                  { style: CARD_HEADER },
                  // 左：闪电（素材里最高档会跟着变紫，并带上一点光晕）。
                  react.createElement(
                    "span",
                    { style: { ...CARD_BOLT, color: ink.bolt, filter: ink.glow }, "aria-hidden": "true" },
                    ThinkIcon === null
                      ? react.createElement(BoltGlyph, { size: 15 })
                      : react.createElement(ThinkIcon, { size: 15 }),
                  ),
                  // 中：等级名 + `›`，下面一行是**模型选择**（点开模型清单）。
                  react.createElement(
                    "div",
                    { style: CARD_NAME_BLOCK },
                    // `›` 在素材里就是「再往上还有」的暗示：点一下正好切到下一档。
                    // 模型没有推理等级时这一整行缺席，中间列只剩模型行。
                    view.supported
                      ? react.createElement(
                          "button",
                          {
                            type: "button",
                            className: "dsh-thinking-slider-advance",
                            style: CARD_NAME_ROW,
                            disabled: index >= lastIndex,
                            "aria-label": t === null ? "调到下一档" : t("card.nextLevel"),
                            onClick: () => jumpTo(index + 1),
                          },
                          // key 用档位名：换档时 React 重挂这一个 <span>，`dsh-ts-level-in`
                          // 动画因此每次换档都会重播（淡入 + 轻微上浮），而不是文字硬切。
                          react.createElement(
                            "span",
                            {
                              key: levelName,
                              className: "dsh-thinking-slider-level",
                              style: { ...CARD_LEVEL, color: ink.level },
                            },
                            levelName,
                          ),
                          react.createElement(
                            "span",
                            { className: "dsh-thinking-slider-chevron", style: CARD_CHEVRON, "aria-hidden": "true" },
                            "›",
                          ),
                        )
                      : null,
                    // 模型行：素材里这行是静态的模型名，现在它自己就是「选择模型」按钮
                    // —— 不多占一行，也不改变素材的视觉层级。
                    react.createElement(
                      "button",
                      {
                        type: "button",
                        className: "dsh-thinking-slider-model-row",
                        style: MODEL_ROW,
                        disabled: modelRows.length === 0 || busy,
                        "aria-haspopup": "listbox",
                        "aria-expanded": modelsOpen,
                        "aria-label": t === null ? "选择模型" : t("card.selectModel"),
                        onClick: () => setModelsOpen((value) => !value),
                      },
                      react.createElement("span", { style: MODEL_ROW_LABEL }, triggerText),
                      react.createElement(IconChevronDownOutlineRegular, {
                        size: 14,
                        className: "dsh-thinking-slider-model-chevron",
                        style: MODEL_ROW_CHEVRON,
                      }),
                    ),
                  ),
                  // 右：重置 ↻（只在偏离默认档时出现；缺席时用等宽占位保住中间列的居中）。
                  resetIndex === -1
                    ? react.createElement("span", { style: { display: "block", width: "28px" }, "aria-hidden": "true" })
                    : react.createElement(
                        "button",
                        {
                          type: "button",
                          className: "dsh-thinking-slider-reset",
                          style: RESET_BUTTON,
                          disabled: busy,
                          "aria-label": t === null ? "返回默认" : t("card.providerDefault"),
                          onClick: () => jumpTo(resetIndex),
                        },
                        react.createElement(ResetGlyph, { size: 16 }),
                      ),
                ),
                modelListNode,
                view.supported
                  ? railNode
                  : react.createElement(
                      "p",
                      { style: MODEL_NOTE },
                      t === null ? "该模型没有推理等级" : t("card.noEffort"),
                    ),
                error === "" ? null : react.createElement("p", { style: ERROR_TEXT }, error),
              ),
            ),
            document.body,
          )
        : null;

      return react.createElement(
        react.Fragment,
        null,
        react.createElement(
          "span",
          { ref: rootRef, style: { display: "inline-flex", alignItems: "center", minWidth: 0 } },
          react.createElement(
            Tooltip,
            {
              label: t === null ? `${modelLabel} · ${levelName}` : t("trigger.tooltip", { model: modelLabel, level: levelName }),
              side: "top",
              delayMs: 400,
            },
            react.createElement(
              "button",
              {
                type: "button",
                className: "dsh-thinking-slider-trigger",
                style: busy ? TRIGGER_DISABLED : TRIGGER,
                "aria-label": view.supported
                  ? t === null
                    ? `推理强度：${modelLabel} · ${levelName}`
                    : t("trigger.ariaEffort", { model: modelLabel, level: levelName })
                  : triggerText,
                "aria-haspopup": "dialog",
                "aria-expanded": open,
                "aria-busy": busy,
                onClick: () => setOpen((value) => !value),
              },
              ThinkIcon === null
                ? null
                : react.createElement(ThinkIcon, { size: 14, "aria-hidden": "true", style: TRIGGER_ICON }),
              // 模型名 + 档位：换模型也在这一枚 chip 里完成，所以它必须一直是「谁 + 多强」。
              // 模型不支持推理等级时只剩模型名（这时它就是一个纯模型选择器）。
              react.createElement("span", { className: "dsh-thinking-slider-trigger-model", style: TRIGGER_MODEL }, triggerText),
              view.supported
                ? react.createElement(
                    react.Fragment,
                    null,
                    react.createElement("span", { style: TRIGGER_SEP, "aria-hidden": "true" }, "·"),
                    react.createElement("span", { className: "dsh-thinking-slider-trigger-level", style: TRIGGER_LEVEL }, levelName),
                  )
                : null,
              busy
                ? react.createElement(IconLoadingOutlineRegular, { size: 14 })
                : open
                  ? react.createElement(IconChevronDownOutlineRegular, { size: 14 })
                  : react.createElement(IconChevronUpOutlineRegular, { size: 14 }),
            ),
          ),
        ),
        card,
        activeNotice === null
          ? null
          : react.createElement(Toast, {
              key: activeNotice.key,
              text: activeNotice.text,
              tone: activeNotice.tone,
              onDone: () => {
                notice = null;
                publish();
              },
            }),
      );
    }

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */

    /** 字典命名空间。 */
    const NS = "thinking-slider";

    const zh = {
      "trigger.current": "推理强度",
      "trigger.aria": "推理强度",
      "trigger.tooltip": "{model} · 推理强度 {level}",
      "trigger.ariaEffort": "推理强度：{model} · {level}",
      "card.title": "推理强度",
      "card.aria": "推理强度",
      "card.nextLevel": "调到下一档",
      "card.providerDefault": "返回默认",
      "trigger.pick": "选择模型",
      "card.selectModel": "选择模型",
      "card.account": "账户",
      "card.noEffort": "该模型没有推理等级",
    };

    const en = {
      "trigger.current": "Effort",
      "trigger.aria": "Reasoning effort",
      "trigger.tooltip": "{model} · reasoning effort {level}",
      "trigger.ariaEffort": "Reasoning effort: {model} · {level}",
      "card.title": "Reasoning effort",
      "card.aria": "Reasoning effort",
      "card.nextLevel": "Next level",
      "card.providerDefault": "Reset to default",
      "trigger.pick": "Select model",
      "card.selectModel": "Select model",
      "card.account": "Account",
      "card.noEffort": "This model has no reasoning effort",
    };

    /* ------------------------------------------------------------------ *
     * 插件体
     * ------------------------------------------------------------------ */

    /**
     * 渲染错误边界：控件自己炸了也不能把官方输入框一起带走。
     *
     * 上报 `render-error` 之后渲染 `null` —— 界面看起来就是「没有这个控件」，
     * 但宿主日志里能查到原因。
     */
    class SliderBoundary extends react.Component {
      /** @param {object} props - 组件属性。 */
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      /** @param {object} error - 抛出的错误。 @returns {object} 下一个 state。 */
      static getDerivedStateFromError(error) {
        return { failed: true, message: messageOf(error) };
      }

      /** @param {object} error - 抛出的错误。 @returns {void} */
      componentDidCatch(error) {
        reportDiag("render-error", { message: messageOf(error) });
      }

      /** @returns {object|null} 子节点或 null。 */
      render() {
        return this.state.failed ? null : react.createElement(react.Fragment, null, this.props.children);
      }
    }

    /** 插槽座位：错误边界 + 真正的滑条。 */
    function ThinkingSliderSeat(props) {
      return react.createElement(SliderBoundary, null, react.createElement(ThinkingSlider, props));
    }
    /**
     * 必需服务。
     *
     * 只要 `slots` —— 与同仓 `dsh-flow-control` 一致：声明了没到的服务会让整个
     * 插件停在 pending，界面上的表现就是「什么都没有」，排查成本极高。官方模型
     * 目录服务（`modelDirectories`）在本插件里用轮询等待（见 `useDirectory`）。
     */
    const inject = ["slots"];

    /**
     * 客户端插件体。
     *
     * **本函数在任何情况下都不允许抛异常**（每一步都走 `quiet()`）：DSH 前端 boot
     * 见到任何一个入口非 active 就整体失败（失败/pending 都算），表现为界面直接
     * 停在「Failed to load plugins」——用户看到的就是「DSH 打不开、必须杀进程」。
     * 这里最坏的降级是「座位没注册、控件看不见」，绝不会带走整个界面。
     * @param {object} ctx - 客户端根上下文。
     * @returns {void}
     */
    function apply(ctx) {
      client = ctx;
      quiet("apply-error", () => reportDiag("apply", { services: serviceProbe() }));
      // 1) 样式：注入失败只是「控件长得不对」，不影响功能。
      quiet("css-error", () => injectRangeCss());
      // 2) 语言面：官方 locale 服务可能后到，也可能永远不到（那就走内置中文兜底）。
      quiet("locale-error", () => {
        const face = typeof ctx.get === "function" ? (ctx.get("locale") ?? ctx.locale) : ctx.locale;
        if (face !== undefined && face !== null && typeof face.register === "function") {
          ctx.effect(() => face.register(NS, { zh, en }), "dsh-thinking-slider: dictionaries");
        }
      });
      // 3) 座位注册：`slots` 在 inject 里声明过，正常一定在；这里再挡一次是为了
      //    防止「框架先调 apply、服务后到」这类时序把它变成致命的。
      quiet("seat-error", () => {
        const slots = typeof ctx.get === "function" ? (ctx.get("slots") ?? ctx.slots) : ctx.slots;
        if (slots === undefined || slots === null || typeof slots.inject !== "function") {
          reportDiag("seat-skip", { reason: "slots 服务不可用" });
          return;
        }
        slots.inject("conversation.input.right", () => {
          reportDiag("register", { slot: "conversation.input.right" });
          return slots.register(
            {
              name: "conversation.input.right",
              id: "thinking-slider",
              // 40 之后：官方流控的「分支 / 暂停」按钮（39/40）排在前面，
              // 滑条紧贴官方模型座位。
              // 注意：**不声明 `locale`** —— 座位一旦声明命名空间而当下没有文案面，
              // 官方渲染器会抛 SlotAssemblyError，整个座位都不显示。
              order: 45,
            },
            ThinkingSliderSeat,
          );
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;

    /**
     * 内部实现，仅供单测使用（不属于插件对外 API）。
     * 浏览器半边跑在 `window.__ModuleLoader__` 里，测试进程没有别的办法触达这些
     * 纯函数与模块级状态，所以在这里开一个小口子。
     */
    exports.__internals = {
      resolveLevels,
      buildStops,
      stopIndexOf,
      resetIndexOf,
      ratioOf,
      effortOf,
      // 模型选择：从目录快照铺平出可选模型行，以及「换模型时档位怎么带过去」。
      modelChoicesOf,
      transferEffort,
      ACCOUNT_PROVIDER,
      // 接管官方「选择模型」座位：这几个纯函数只吃 DOM 形状，不碰全局，
      // 单测里用假对象就能断言「挑的是哪一个子节点」。
      NATIVE_SEAT_ATTR,
      isNativeModelSeat,
      pickNativeSeat,
      nativeSeatOf,
      hideNativeSeat,
      showNativeSeat,
      messageOf,
      nextGeneration,
      ThinkingSlider,
      RANGE_CSS,
      RANGE_STYLE_TAG,
      injectRangeCss,
      // 组件与 preview/ 静态预览共用的样式函数（单一定义，预览不会漂移）。
      railStyleFor,
      railBoostOf,
      railBoostAttr,
      railVarsFor,
      cardInkOf,
      // 星尘：确定性伪随机（不用 Math.random）与数量 / 单颗样式。
      starHash01,
      starCountFor,
      starStyleFor,
      // 拖动交互：步进与几个「写 DOM」小工具，单测直接断言它们的行为。
      DRAG_STEP,
      eventValueTarget,
      rangeValueOf,
      setStyleVar,
      setRailTransition,
      // 视觉契约：素材口径是「蓝色填充 + 比轨道高的白圆钮 + 每档一颗刻度点 +
      // 最高档流动渐变与星尘」，这些是单测与 preview/ 静态预览能断言的**全部**
      // 外观常量与几何（改了样式却动了语义契约，会在这里被拦住）。
      // 除纯函数外都只是惰性数据，没有副作用。
      REF,
      TRACK_FILL,
      TRACK_REST,
      TRACK_EDGE,
      DOT_REST,
      DOT_PASSED,
      DOT_BOOST_REST,
      DOT_BOOST_PASSED,
      DOT_SIZE,
      BOOST_GRADIENT,
      BOOST_EFFORTS,
      RAIL_HEIGHT,
      KNOB_SIZE,
      RAIL_EDGE,
      STAR_COUNT,
      COLOR,
      TRIGGER,
      TRIGGER_DISABLED,
      TRIGGER_WAIT,
      TRIGGER_ICON,
      TRIGGER_LEVEL,
      TRIGGER_MODEL,
      TRIGGER_SEP,
      MODEL_ROW,
      MODEL_ROW_LABEL,
      MODEL_ROW_CHEVRON,
      MODEL_LIST,
      MODEL_GROUP,
      MODEL_ITEM,
      MODEL_CHECK,
      MODEL_FAILURE,
      MODEL_NOTE,
      RAIL_ROW,
      CARD,
      CARD_INNER,
      CARD_HEADER,
      CARD_NAME_BLOCK,
      CARD_NAME_ROW,
      CARD_BOLT,
      CARD_CHEVRON,
      CARD_MODEL,
      CARD_LEVEL,
      RESET_BUTTON,
      RESET_GLYPH,
      HINT,
      ERROR_TEXT,
      get notice() {
        return notice;
      },
      showNotice,
      reset() {
        notice = null;
        subscribers.clear();
      },
    };

    return module.exports;
  },
});
