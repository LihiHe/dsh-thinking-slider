# dsh-thinking-slider —— 推理强度滑条

把 DSH Web GUI 输入框右侧的「推理等级」从**菜单点选**换成**可拖拽的滑条**：
按住滑块左右拖，拖动中**连续跟手**、松手**自动吸附到最近的档位**并提交；
拖动过程实时预览档位，但**只在松手时发一次请求**。

官方的「选择模型 + 选择推理强度」那枚 `DeepSeek-V4.1-Flash · High` chip 会被本插件**接管**：
座位本身接管不了（那是 single 插槽，见下文），所以插件在运行时把它隐掉，
把**选模型**并进自己这枚 chip 与卡片里 —— 数据和官方菜单同一份（`ctx.modelDirectories`）。

> 目标来源：用户原话「加入功能：滑动调整思考强度，与GPT类似」（m00002）；
> 视觉口径来自用户后续要求「修改思考强度滑动插件，完全仿照GPT的样式」（m00001）；
> 接管官方座位来自用户原话「修改：覆盖原版的选择思考强度与选择模型按钮（图中显示
> DeepSeekV41flash high 的部分），把选择模型功能集成到滑动条旁边」（m01989）。

## 它长什么样

输入框右侧只剩这一枚 chip（官方座位已被隐藏），它是「**谁 + 多强**」——

```
[⚡ DeepSeek-V4.1-Flash · 高 ⌃]
        ↓ 点开卡片
┌──────────────────────────────────┐
│ ⚡    高 ›                     ↻  │   ← 点「高」往上切一档
│       DeepSeek-V4.1-Flash ⌄        │   ← 点模型名展开模型清单
│  ┌────────────────────────────┐  │
│  │ ✓ DeepSeek-V4.1-Flash       │  │   ← 清单 = 官方模型菜单的同一份数据
│  │   DeepSeek-V4.1-Pro         │  │      （多 provider 时插分组标题，
│  │   OpenAI（登录已过期）      │  │        加载失败的 provider 不可选）
│  └────────────────────────────┘  │
│  ●━━━━┿━━━┿━━━┿━━━┿━━━┿━━━○    │   ← 26px 胶囊轨道 + 6 颗刻度点 + 白圆钮
└──────────────────────────────────┘
```

模型不支持推理等级时，chip 只剩模型名（它这时就是一个**纯模型选择器**），
卡片里用一行说明代替滑轨 —— 再也不会整块消失（否则藏掉官方座位后就没法切模型了）。

**「完全仿照 GPT」的六条硬约束**（照 ChatGPT composer 的推理强度滑条，参考实现见
[openclaw PR #155402](https://github.com/openclaw/openclaw/pull/155402) 里同款控件的 CSS）：

> ⚠️ 这张表是**第一轮**（2026-10-11 上午）的口径。同日更晚用户拿了素材图要求按素材重做，
> 于是轨高、圆钮尺寸、刻度点、最高档渐变与星尘全部换了规格 —— **以
> [手感：连续跟手 + 动效](#手感连续跟手--动效2026-10-11) 一节和预览页为准**，
> 下表里「刻度点都没有」「中性 20px 圆钮」这些已经是历史。

| 元素 | GPT 口径 | 本插件实现 |
| --- | --- | --- |
| 触发 chip | 中性文字 chip + 图标，**没有彩色圆点** | `TRIGGER` 无背景、无边框，图标是官方 `IconThinkOutlineRegular`（中性色） |
| 轨道 | 一根**单色胖胶囊**（26px 高、满圆角、1px 极淡描边） | `RANGE_CSS` 的 `height: 26px` + `inset 0 0 0 1px var(--dsh-ts-edge)` |
| 已填充段 | 文字色 **18%** | `TRACK_FILL = color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)` |
| 未填充段 | 文字色 **7%** | `TRACK_REST = … 7% …`（深浅主题自动成立） |
| 圆钮 | 白色实心 + 柔和投影，按住外扩光晕 | 20px，`:active` 外扩 6px **中性**光晕（不用品牌色） |
| 刻度点 / ± 步进 | **都没有** | 无 `−/+` 按钮、无刻度点；档位范围靠两端档位名表达 |
| 最高档 | **只有最高档**才上品牌色 + 流动 | `BOOST_EFFORTS = ["xhigh","max","ultra"]`：容器打 `data-boost`，渐变由 `RANGE_CSS` 的 `[data-boost]::before` 画（`linear-gradient(105deg, …)`、`background-size: 220% 100%`、`dsh-ts-effort-flow` 6s 往返，`ultra` 4s），并把轨道自身置为透明让渐变透出来；进/出最高档是一次 **280ms 的淡入淡出**，不是硬闪 |

其余细节：

- **拖动**：连续跟手 + 松手吸附。`onInput` 只把填充比例写进 CSS 变量（零重渲染），
  松手（`onPointerUp`）时把落点**吸附到最近的档位**（`Math.round`，一半处朝强度更高一侧）并提交一次。
  整条滑条就是唯一操作面 —— GPT 样式里没有 ± 步进按钮，也没有刻度点。
- **选模型**：卡头那行模型名就是按钮，点开是官方模型菜单的同一份数据（多 provider 插分组标题，
  当前项打勾，加载失败的行不可选、hover 显示原因）。清单**常驻 DOM**、开合是 300ms 过渡：
  卡头那行点一下，卡片高度跟着一起长/缩（外层 `grid-template-rows: 0fr ↔ 1fr`），清单本体淡入 + 轻微下移。
  收起态只是被裁掉，所以顺手把每行 `tabIndex` 设成 `-1`、给整块加 `aria-hidden`，读屏与 Tab 都不会碰到它。
- **键盘**：`Tab` 聚焦滑条，`←/→`、`Home/End`、`PageUp/PageDown` 按**整档**移动后自动提交（`Tab` 本身不提交）。
- **两端标签**：左端是最低档、右端是最高档的名字（目录声明了 `defaultEffort` 时左端就是那个档，
  没声明时左端是「默认」）。
- **返回默认**：只在「能回到一个默认档」且当前不在默认档时出现；样式是中性文字按钮，不用品牌色。
- **并发保护**：用目录对象上的世代计数器丢弃迟到的响应，快速连拖不会出现「A 的结果盖掉 B 的结果」。
- **加载中**：目录还在加载且一个具名档位都没有时，滑条锁定为只读（`.rail:has(range:disabled)` 压到 55% 透明）。
- **降级**：`@media (prefers-reduced-motion: reduce)` 下关掉最高档的流动动画与全部过渡（填充、圆钮、档位名、模型清单开合）。
- **预览**：`node preview/build-preview.mjs && node preview/serve.mjs` → <http://127.0.0.1:3017/>
  用插件自己的真实常量渲染一份离线外观（含浅色/深色切换与**可直接拖的交互演示**），手机上不用 devtools 也能核对手感。

### 手感：连续跟手 + 松手吸附 + 动效（2026-10-11）

拖动中「连续跟手」，松手「吸附到最近档位」——两个动作分工明确。每一条改动都有具体的病根：

| 改了什么 | 为什么（原来的病根） |
| --- | --- |
| `step: 0.01`，`value` 用**连续位置**，档位语义交给 `Math.round` | 原来 `step: 1` + 受控整数只有 4~5 个落点，圆钮一格格跳 |
| 拖动中只写 `--dsh-ts-fill`（`setProperty`），**不进 React state** | 原来每个 `input` 事件都 `setState` → 整张卡片重渲染 → 掉帧 |
| 拖动中临时 `transition: none`，松手恢复 `--dsh-ts-fill 260ms cubic-bezier(0.22,1,0.36,1)` | 开着过渡，填充会花 260ms 去「追」手指，手感发黏 |
| **松手把草稿值换成 `Math.round(落点)`**（吸附），且过渡在写草稿前恢复 | 原来落点保持连续值 → 圆钮**有概率停在两档之间**，既不在档位中心、也和档位名对不上；换成整数后由 CSS 那条 320ms 回弹过渡滑过去，看起来是「被最近的档位吸过去」，而不是「啪」一跳 |
| 吸附**只在松手那一刻**做，拖动中一次都不吸 | 拖动中也吸附的话，3~5 档的滑条会一格格跳，跟手感立刻没了（这正是当年从 `step: 1` 改掉的原因） |
| 松手时把 `lastRaw` 记成**手指离开处的连续值** | 浏览器松手时会补发一个重复的 `input` 事件，不带这一条就会把刚吸附好的圆钮拽回两档之间 |
| 权威档采纳后**保留吸附落点** | 原来 `setDraft(null)` 会让圆钮「啪」地跳回档位中心 |
| 提交中不禁用滑条（`busy` 时只加 `data-busy` 把圆钮压到 72% 透明） | 原来 `disabled: locked \|\| busy` 会让 `:has(:disabled){opacity:.55}` 在往返期间闪整行 |
| 渐变改由 `[data-boost]::before` 画，进/出最高档走 `opacity` 280ms | 原来渐变是 inline style，进出最高档是硬闪 |
| 档位名 `<p key={levelName}>` 重挂 + `dsh-ts-level-in` 200ms 淡入上浮 | 原来换档是数字硬切，看不出「换了一档」 |
| 模型清单**常驻 DOM**，开合交给 `data-open` + `grid-template-rows: 0fr ↔ 1fr`（300ms） | 原来「展开才挂载」：收起时内容先在 1 帧内消失、空出来的高度再慢慢收，像被「抽走」；常驻才能让淡出与收缩同步，卡片高度也一起过渡（reveal 夹在 `gap: 10px` 的内容列中间，收起时用 `margin-bottom: -10px` 抵掉一条 gap，卡片高度与改动前逐像素一致） |
| 清单本体 `opacity` + `translateY(-6px)` + 内层 `clip`（`overflow: hidden`）承担裁切 | `overflow: hidden` 得有自己的盒子才裁得干净；`clip` 顺手给清单 `margin: 0 -6px` 留出横向余量，否则细滚动条会被裁掉半边 |
| 拖动中若重渲染，位置读 `lastRaw`（ref）而不是草稿值 | 否则任何一次外部重渲染（目录快照更新等）都会把圆钮从手指底下拽回上一个跨档点 |
| 键盘按**整档**移动 | `step` 是 0.01，交给浏览器就变成 0.01 的微调，按 100 次才走一格 |
| `@media (prefers-reduced-motion: reduce)` 关掉动画与过渡 | 无障碍：前庭敏感用户不该被流动渐变打扰 |

## 语义完全跟随官方模型菜单

推理档位不是自己编的，全部来自官方客户端服务 `ctx.modelDirectories`，
判档规则与官方「推理等级」菜单（`@deepseek-ai/dsh-client-ui-model-selection`）逐条对齐：

| 情况 | 官方菜单 | 本控件 |
| --- | --- | --- |
| 模型没有 `reasoning` 字段 | 不显示 Effort 行 | 卡片里换成一行说明（`card.noEffort`），chip 只显示模型名 —— 但**座位继续渲染**，因为官方那枚 chip 已被它隐藏 |
| 模型有 `reasoning` 但 `efforts: []` | 只有默认档 | 滑轨锁成单点，不可拖 |
| 未显式选 effort、目录声明 `defaultEffort` | 显示该默认档 | 滑块停在该档（`effectiveEffort = reasoningEffort ?? defaultEffort`） |
| 目录**没有**声明 `defaultEffort` | 多一项「Default」 | 最左多一档「默认」，选中时**整字段省略** |
| 提交档位 | `selectModel({provider, model, reasoningEffort})` | 同一路径：`directory.select(...)` |
| 提交模型 | 同上 | 同一路径（`sendSelection`），切换模型时档位按 `transferEffort` 迁移 |
| provider 加载失败 | 菜单里一行不可选的失败项 | 清单里同一行不可选，hover 显示原因（`failures`） |

「默认」档提交时请求体里**不带** `reasoningEffort` 字段（而不是发一个空值）——这是官方的
「provider default」语义。

### 接管官方「选择模型」座位

官方那枚 chip 注册在插槽 `conversation.input.model`（`@deepseek-ai/dsh-client-ui-model-selection`），
而这个插槽是 **single** 类型：`@deepseek-ai/dsh-client-ui-slots/lib/index.js:172` 对重复注册直接
`throw new Error('single slot "…" already has a registration …')`。**抢占不进去，也不该去抢**
（注册顺序一变就是一颗炸掉整个前端的雷）。

所以走「运行时让位」：

1. 官方那一排控件的 DOM 是 `div.standardControls` 的
   `[renderSlot("conversation.input.right"), renderSlot("conversation.input.model")]`，
   官方 chip 是其中**最后一个元素子节点**。
2. 插件从自己座位的父节点往上找（最多 6 层），取「最后一个装了别人 `aria-haspopup="menu"`
   按钮的兄弟节点」——那就是官方座位，给它打上 `data-dsh-thinking-slider-native="hidden"`，
   CSS 里 `display: none !important`。
3. 切换会话会让官方座位**重挂 DOM**（session 作用域 entry 带 session generation key），
   标记会丢，所以用 `MutationObserver(childList)` 盯着父节点重打标记。
4. 官方座位处于锁死状态（`disabled`，即 `locked = removed || inert || !live`）时**不接管**，
   保持原样；目录还没就绪（`directory === null`）时也不接管 —— 失败模式是「两个 chip 都在」，
   而不是「一个都没有」。
5. 卸载/切会话时移除标记，把官方座位交还回去。整段副作用全在 `try {} catch {}` 里，
   任何异常都只降级成「不接管」，不会像裸调 `ctx.slots.inject` 那样带走整个前端 boot。
6. **跑任务时这一排可能整行消失**，此时本插件的 chip 和官方那枚 chip **一起**不显示 ——
   不是插件坏了。真机上实测到两条独立的隐藏链路（`seat-geometry` 的 `killers` 字段会把
   「到底是哪条 CSS 规则干的」直接指出来）：
   - **皮肤**（实机证据）：装了 `@smalltailqwq/dsh-client-ui-skin-maid-atelier` 时它有一条
     `body[data-dsh-maid-atelier] [data-phase=active] [data-composer-seat][data-maid-composer-capsule] :is([data-input-scroll],[data-composer-card]>[class*=row]){display:none!important}`
     —— 会话 `phase=active`（正在跑）且合成器处于胶囊模式时，**整行控件**被皮肤收起来。
     这是皮肤有意的胶囊行为，不是本插件能也不该去对抗的。
   - **官方**：`tools` 与 `standardControls` 都带 `hidden: activity`
     （`@deepseek-ai/dsh-client-ui-conversation/lib/client.js:17494`、`:17530-17531`，
     配 `.uV2eYG_tools[hidden],.uV2eYG_standardControls[hidden]{display:none}`），
     有后台活动回报时官方自己也会把这排藏掉。
   两种情况都在**会话空闲时自动恢复**（接管成立时只剩本插件这一枚 chip）。
   要确认视觉效果，只能在**空闲时刻**截图。

**与官方的一处有意不同**：换模型时官方 `selectionOf` 一律回到新模型的 `defaultEffort`，
本插件走 `transferEffort` —— 目标模型也声明了**同 id** 的档位就把它带过去（「高」还是「高」），
没声明才省略该字段（等于用新模型的默认档）。跨 provider 换模型时这个差别最明显。

## 架构：双面包 + 两条接线纪律

插件是**双面包**：

- `lib/index.js`（宿主半边）：功能上什么都不做，只注册一条排障用的诊断路由
  `POST /dsh-thinking-slider/diag`（把浏览器半边回报的状态逐行追加到
  `$DSH_HOME/thinking-slider-diag.log`）。它存在的另一个理由是——双面包要在
  `dsh.profile.bundles` 里有一行且能 `import` 成功，浏览器半边 `./client`
  才会被 web app 组合进 `window.__DSH_BOOT__`。
- `lib/client.js`（浏览器半边）：全部功能。通过 `window.__ModuleLoader__.load({id, factory})`
  注册，`require` 只用 `react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives` 三个模块。

**没有打任何引擎补丁**（对比 `dsh-flow-control` 需要 `tools/patch-engine.mjs`）：
选中推理等级直接调官方客户端服务 `directory.select({provider, model, reasoningEffort})`，
与官方模型菜单共享同一份 pending / 竞态 / 错误语义，因此不需要宿主侧状态。

挂载点是官方的 list 插槽 `conversation.input.right`（`order: 45`，排在流控按钮 39/40 之后），
**不替换**官方 `conversation.input.model` 模型座位。

三条踩过坑的接线纪律（第一版「重启后输入框右侧什么都没有」就是因为第 3 条）：

1. **factory 顶部必须自己声明 `module` / `exports`**。真实契约是
   `dsh-client-modules/lib/client.js` 的 `materialize()`：
   `exports: registered.factory(this.makeRequire(ownerId, edges))` —— factory
   **只拿到 `require` 一个参数**，模块接口就是它的**返回值**，浏览器里没有
   `module` / `exports` 这两个自由变量。直接写 `exports.apply = apply; return
   module.exports;` 会在**首次装载时**抛 `ReferenceError: exports is not defined`，
   表现是插件静静地什么都没注册（没有任何界面提示）。正确开头（官方 bundle 与
   `dsh-flow-control` 都这么写）：

   ```js
   window.__ModuleLoader__.load({
     id: "dsh-thinking-slider",
     factory: (require) => {
       var module = { exports: {} };
       var exports = module.exports;
       /* … */
       return module.exports;
     },
   });
   ```

   单测必须**同样只传 `require`**（`test/helpers.mjs` 的 `loadClient` 已按此收严），
   否则这个错误在测试里永远看不见。
2. **`inject` 只声明 `["slots"]`**。声明了却没到的服务会让插件永远停在 pending，
   界面上同样表现为「什么都没有」，也没有报错（引擎日志里只有
   `N entries did not activate` 这种不含插件名的汇总行）。模型目录服务
   `modelDirectories` 由官方 `dsh-client-ui-model-selection` 按需提供，可能后到，
   所以客户端用轮询等待（`useDirectory`，250ms × 40 ≈ 10 秒）。
3. **座位注册不声明 `locale` 命名空间**。官方渲染器（`dsh-client-ui-renderer`）在
   「座位声明了命名空间、当下却没有文案面」时会抛 `SlotAssemblyError`，整个座位
   直接不显示。文案于是走本插件内置的中文兜底（`t === null` 分支）。
   想用官方 `t` 就必须先确认文案面已经就绪。

## 为什么它不会再弄死 DSH（2026-10-11 加固）

这一节的由来：用户报「这个插件这么容易崩，DSH 已经因为这个插件死 3 次了」（m00457）。

### 机制：一个插件抛错 = 整个界面打不开

DSH 前端 boot 收集所有客户端插件入口，只要有一个**不是 active**（failed 和
`pending (waiting for service…)` 都算），就整体抛错：

```
web boot: 1 entry did not activate
dsh-thinking-slider: failed
```

外层 catch 走 `page.fail(...)`，页面停在 **「Failed to load plugins」**，应用永远不
mount —— 用户看到的现象就是「DSH 打不开，只能杀进程重启」。这条错误与它前面的
`apply-throw` 都写在诊断日志里（当时的证据：02:43–02:56 之间 6 次
`did not activate`，每次前面都有一条 `apply-throw`）。

### 三处加固

| 纪律 | 做法 |
| --- | --- |
| `apply()` 永不抛 | 每一步都过 `quiet(label, step)`：失败只写一条 diag（`apply-error` / `css-error` / `locale-error` / `seat-error` / `seat-skip`），返回值 `undefined`。最坏降级 = 座位没注册，界面照常。 |
| 服务访问永不裸奔 | `ctx.get(...)`、`ctx.slots`、`ctx.locale`、`client.modelDirectories` 全部走「try + 属性兜底」；cordis 的未 `inject` 服务被访问时会抛 `cannot get property "X" without inject`，那正是历史上把 boot 带走的那条异常。 |
| 加载期也不行 | `require("@deepseek-ai/dsh-client-ui-primitives")` 包在 `loadPrimitives()` 里，失败退化成 `{}`；图标缺席时 `ThinkIcon === null` 只是不画图标，不会让 `createElement(undefined)` 抛错。 |
| 渲染期兜底 | 座位外面本来就有一层 `SliderBoundary`（错误边界），渲染异常 → 只丢掉这一个座位 + diag `render-error`。 |

### 发布也要原子

`node tools/publish.mjs`：先跑单测（不通过不发布）→ 重建静态预览 → **写同目录临时
文件再 `rename()`** → 逐字节复核。为什么不能就地 `cp`：client-hmr 每 500ms 给
bundle 做 `stat`，一变就让浏览器重新拉这个文件；读到写了一半的 JS（语法错误）会让
入口变成 failed，回到上面那条「界面打不开」。`rename()` 在同一目录内是原子的，
读者只会看到旧版或新版。

## 诊断通道

手机 WebView 没有 devtools，控件不显示时无从取证，所以浏览器半边会把
`apply` / 插槽注册 / 目录就绪 / 座位渲染（含 `sessionId`、目录是否可用、模型是否
支持推理、档位数）/ 渲染异常都 POST 到宿主路由，落到：

```bash
tail -f /data/user/0/app.dsh.mobile/files/dsh-home/thinking-slider-diag.log
```

判读方式：

| 日志里有什么 | 说明 |
| --- | --- |
| 连日志文件都没有 | 宿主半边没被激活（profile 没组合进去） |
| 只有 `host-apply`（引擎每次启动一行） | 宿主起来了，但浏览器半边没回报 —— bundle 没装载 / `apply` 没跑 |
| 有 `apply`，没有 `register` | 插槽注入没跑（服务没到 / 插件 pending） |
| 有 `register`，没有 `seat-render` | 座位没有渲染（组合失败或座位被跳过） |
| `seat-render` 里 `sessionId: null` | 座位没拿到会话（不是 session 作用域） |
| `seat-render` 里 `hasDirectory: false` | 目录服务还没到（会显示虚线占位点） |
| `seat-render` 里 `supported: false` | 当前模型没有推理等级 —— 卡片里换成一行说明，chip 只剩模型名（座位**仍然**渲染） |
| `render-error` | 渲染抛异常，座位已被边界吃掉（控件不显示） |
| `native-seat` `{hidden:true}` | 官方那枚「选择模型」chip 已被隐藏（接管成功）；`{hidden:false}` 是交还或没找到 |
| `native-seat-error` | 接管官方座位时抛了异常（已被吞掉，行为降级成「两个 chip 都在」） |
| `seat-geometry`（每次挂载一行） | 座位的几何取证。**「chip 看不见」先看这个**：`chain` 是自身往上 12 层的 `TAG.class\|display/WxH`（`#hidden` = 该层带 hidden 属性、`#mark` = 该层是插件打的接管标记、`#inline` = 该层内联 `display:none`）；`marked` 是被标记的官方座位是谁；`instances` 列出文档里所有 `…_standardControls`（`MINE` 前缀 = 自己这枚 chip 所在的那个）；`killers` 用 `rowEl.matches(selectorText)` 逐个样式表反查，**直接列出「是哪条 CSS 规则把这排隐藏了」**——实机就是这么抓到皮肤那条 `[data-maid-composer-capsule] … [data-composer-card]>[class*=row]{display:none!important}` 的。 |
| `apply-error` / `css-error` / `locale-error` / `seat-error` | `apply` 的某一步失败（已被 `quiet` 吞掉，所以界面不会死）；看 `message` 字段定位 |
| `seat-skip` | `slots` 服务还没到，这一轮安静跳过（正常时序，不算错误） |
| `primitives-missing` | 官方组件包 `require` 失败，插件退化成「无图标」继续跑 |

这条通道只是排障旁路，删掉 `apply` 里的路由注册不影响控件本身。

## 安装

```bash
DSH_HOME=/data/user/0/app.dsh.mobile/files/dsh-home
cp -r /storage/emulated/0/.A工作区/dsh-thinking-slider "$DSH_HOME/harness/plugins/dsh-thinking-slider"
ln -sfn ../../../harness/plugins/dsh-thinking-slider "$DSH_HOME/profiles/web/node_modules/dsh-thinking-slider"
```

然后在 `$DSH_HOME/profiles/web/package.json` 里加两处（`cp` 备份后手改或让 pnpm 处理都可以）：

```jsonc
"dependencies": { "dsh-thinking-slider": "link:/data/user/0/app.dsh.mobile/files/dsh-home/harness/plugins/dsh-thinking-slider" },
"dsh": { "profile": { "bundles": [ /* … 追加 */ "dsh-thinking-slider" ] } }
```

**最后必须重启引擎**（GUI 设置 → 重启引擎）——profile 的 bundles 列表只在引擎启动时组合。

卸载：从 `dsh.profile.bundles` 与 `dependencies` 里删掉两行，删掉
`node_modules/dsh-thinking-slider` 软链和 `harness/plugins/dsh-thinking-slider` 目录，重启引擎。

## 测试

```bash
cd /storage/emulated/0/.A工作区/dsh-thinking-slider
node --test test/*.test.mjs      # 57 passed / 0 failed
```

零依赖：`test/helpers.mjs` 里自带一个极简 react 桩（`createElement` / `useState` / `useRef` /
`useEffect` / `useSyncExternalStore` /`createPortal` 的最小可用实现，按组件函数用 `WeakMap`
保存 hook 状态，所以可以跨帧模拟「点开卡片 → 拖动 → 松手」）、primitives 桩（每个组件渲染成
带 `data-primitive` 的 div）、假的 `document` 和假的 cordis ctx
（`slots.inject` 会立刻回调 `register`，与真实注册表一致）。

> 为什么不能直接跑真件：`@deepseek-ai/dsh-client-ui-primitives` 是带 CSS import 的 ESM，
> Node 里 require 不动；react 也不在引擎的 node_modules 解析路径上。所以桩掉。

覆盖范围：档位判定的四种形态、`buildStops` / `stopIndexOf` / `resetIndexOf` / `fillPercent`、
槽位注册（`order: 45`、不声明 `locale`）、卡片布局（卡头三列 / 等级行 `›` / 模型行 / 滑轨 / **没有 ± 步进按钮**）、
模型选择（`modelChoicesOf` 铺平 provider 与失败行、分组标题只在多 provider 时插、当前项勾选、
点另一个模型提交 `{provider, model}` 且档位按 `transferEffort` 迁移、点当前项/失败行不发请求、
失败时清单不收以便直接改选）、接管官方座位（`isNativeModelSeat` 的判据、
`pickNativeSeat` 从后往前挑、`nativeSeatOf` 最多上溯 6 层、`hideNativeSeat`/`showNativeSeat` 幂等、
属性名 `data-dsh-thinking-slider-native`）、
GPT 视觉契约（轨道颜色不含品牌色、`BOOST_EFFORTS` 固定为 `xhigh/max/ultra`、`railStyleFor()` 只出布局、
`railBoostOf`/`railBoostAttr` 决定 `data-boost`、`rangeVarsFor` 只在最高档让轨道透明、热重载后 `<style>` 内容被刷新且标签仍只有一个）、
手感契约（`step: 0.01` 拖动中连续不吸附、拖动中同档内不改 state、重渲染读 `lastRaw` 不被拽回跨档点、
**松手吸附到最近档位**（两个方向 / 正好中点朝强度更高一侧 / 两端越界被夹住 / 本来就是档位则原地不动 /
空操作也要吸回档位中心 / 吸附只改落点不改请求体）、失败后草稿丢弃、
模型清单开合（常驻 DOM、`data-open` 驱动 `grid-template-rows` 0fr ↔ 1fr、收起态 `aria-hidden` + 每行 `tabIndex: -1`、
三层结构 reveal/clip/models、同一个节点不重挂）、`prefers-reduced-motion` 关掉动画与过渡）、
「拖动只提交一次」、provider-default 省略字段、同档短路、键盘按整档移动后提交、滑条顶端语义、
「返回默认」两条分支、`{ok:false}` 与抛异常两条错误路径、迟到响应被丢弃、加载中锁定、
没有 `t` 时回退中文文案。

## 兼容性

用了这些官方公共接口（均在 2026-10 的引擎构建里核对过）：

- 插槽：`conversation.input.right`（`kind:"list"`、`scope:"session"` → 组件收到 `sessionId`）。
  座位**不声明** `locale` 命名空间（声明了却没有文案面会让整个座位被渲染器丢弃），
  文案走内置字典 + 中文兜底。
- 服务：`slots`、`locale`、`modelDirectories`（`ctx.provide("locale", …)` /
  `super(ctx, "modelDirectories")`）。
- 目录：`directory.store.getSnapshot()/subscribe()`、`directory.load()`、`directory.select()`。
- primitives：`MenuSurface`、`Toast`(`onDone`)、`Tooltip`(`label`)、`IconThinkOutlineRegular`、
  `IconChevronDownOutlineRegular`、`IconChevronUpOutlineRegular`、`IconLoadingOutlineRegular`、
  `useAnchoredPosition`、`useDismissOnOutsidePointer`。
- 样式：自己的 `<style data-plugin-css="dsh-thinking-slider/range.css">`（幂等注入，热重载时按内容
  就地刷新，不会把旧 CSS 留在页面上），原生 `<input type="range">` +
  `::-webkit-slider-runnable-track` / `::-webkit-slider-thumb` / `::-moz-range-track` /
  `::-moz-range-progress`；单色胶囊用 `--dsh-ts-fill-color` / `--dsh-ts-rest-color` /
  `--dsh-ts-edge` 三个变量画，最高档由 `.dsh-thinking-slider-rail` 上的
  `--dsh-ts-track-bg: transparent` + 品牌渐变接管；颜色全部取 DSH 的 `--dsw-alias-*` 变量，
  跟随浅色/深色主题（深色下自动变成「近白的 18% / 7%」胶囊）。
