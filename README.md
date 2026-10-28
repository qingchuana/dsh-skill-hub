# dsh-skill-hub

> 插件包名 **`skill-tool`**（npm 上未被占用，可直接发布）；仓库名沿用 `dsh-skill-hub`。

DSH Desktop 的 **技能管理插件**：在设置页里管理 `$DSH_HOME/skills`（本机即 `~/.dsh/skills`）下的 Agent 技能，并提供给 Agent 一个 `skill_hub` 工具。

原生扫描器会监听这个目录，改动 **不需要重启、不需要刷新**；本插件只是把「文件系统约定」变成可操作的界面，并且把扫描器**默默跳过**的技能暴露出来。

> 配套插件 **`dsh-mcp-hub`**（MCP 服务器管理，含 SSE / Burp / Yakit）在另一个仓库：
> [github.com/qingchuana/dsh-mcp-hub](https://github.com/qingchuana/dsh-mcp-hub)。
> 两者互不依赖，可以只装其中一个。

---

## 装上

把本仓库克隆（或解压）到本地，然后在 DSH 里：

```text
plugin_manager action=install_bundle target=<本仓库绝对路径>
```

设置页出现「**技能管理**」一节（`settings.section`，order 27）。不需要 npm 安装依赖：Host 半边用到的 `@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-typert-protocol` 由 DSH 宿主运行时提供，浏览器半边的 `react` 由客户端模块加载器供给。

修改 Host 侧代码后需要重启 DSH 才会加载新的模块代（Client 侧重新打包后刷新页面即可）。

---

## 页面能做什么

| 区域 | 行为 |
| --- | --- |
| 列表 | 列出注册表里**所有**来源的技能：名称、描述、使用时机、来源徽标；自己的技能额外标 `managed`。注册表对整个根失明时改为直接读磁盘，行上加一个 `未注册` 徽标（见「诊断」） |
| 启停 | 两个开关 —— **模型可自动调用** / **可用 `/skill` 调用**，直接改 `SKILL.md` 的 `disable-model-invocation` 与 `user-invocable`（行内编辑，保留注释、未知键、CRLF 与引号风格） |
| 新建 | 填名称 / 描述 / `whenToUse` / 正文，生成最小骨架 |
| 编辑 | 打开 **SKILL.md 原文**，边打字边跑校验，`ok` 才允许保存；只读来源也能查看原文 |
| 复制到我的技能 | 把别的来源（`~/.agents/skills`、预设内置等）的技能复制进管理目录，之后就能改 |
| 删除 | 默认先备份，再删目录 |
| 备份 | 列出备份，可一键恢复；恢复前若同名已存在会先备份它 |
| 安装向导 | **本地目录/`.md`/`.zip`**、**GitHub 仓库**、**URL** 三个页签。本地页签有三个入口：**「选择 .zip / .md 文件…」开真正的系统文件窗口**（浏览器自己的 `<input type="file">`，选完把字节上传给宿主，落地成临时文件再走同一套安装流程）、**「选择文件夹…」**（系统目录选择框，`uiWorkspace.pickDirectory()`，桌面壳给了桥接时优先用桥接）、**「浏览…」**（展开宿主给的文件浏览器：**面包屑逐级可点**、`↑` 回上一级、**「技能根目录」/「主目录」快捷跳转**，每行带**类型标签与大小**，目录以 `/` 结尾并显示 `›`，包显示 `选用`；隐藏文件、软链、`README.md` 不列；超过 400 项会明说被截断；点包即扫描并收起面板）。GitHub 页签有**「列出仓库里的技能」**：下载仓库归档并列出**每一个**含 `SKILL.md` 的技能（带描述与校验结果），点一个就装一个。之后一律 `scanDir` **预演**候选，点候选安装；支持「安装全部」「覆盖同名」 |
| 设置 | 下载镜像前缀（GitHub 直连不通时用 `https://gh-proxy.com/` 之类）、备份保留数量 |

### 诊断（这是本插件相对其他管理器的重点）

页面只在**真的有问题**时报，并且按原因区分，不再一句话概括：

1. **目录里没有 `SKILL.md`**、**文件读不出来**（权限/编码）、**frontmatter 不合规**（附原始报错）。这三类技能扫描器只会写一行 `logger.warn` 就跳过，在别处**完全看不到**。
2. **被更高优先级来源覆盖**：同名技能在优先级更高的根里也存在，模型看到的是那一份。
3. **磁盘上合规但没进注册表**：只有在注册表**确实报了本根的其他技能**时，缺席的条目才按这条报警（例如旧键 `disableModelInvocation` 让扫描器跳过了这个文件）。
4. **被其他插件覆盖 invocation**：文件里写的是「启用」，但注册表报告的是「禁用」—— 例如 `dsh-agent-skills` 会按名字集中禁用（见下文）。页面会同时显示**文件里的值**和**注册表实际值**，避免开关看起来坏了。

另外一条更隐蔽的情况：**注册表对整个根失明**（`registryBlind`）。`ctx.skills` 是分层注册表，一次读取只合并「全局层 + 调用方作用域的链」，而本插件是宿主级插件（全局层）；当技能由 agent preset 作用域的 provider 提供、或原本把 preset 层桥接到全局的第三方插件被卸载时，`snapshot()` 会返回空目录 —— 此时**不是文件坏了**。这种情况下页面**不弹任何说明**，列表直接读磁盘、行上只加一个「未注册」小徽标，`read` / `edit` / `enable` / `disable` / `remove` 都走 `findOnDisk()` 回落；原因只写进 `skill_hub list` 的工具输出和本 README，供排查用。

---

## Agent 工具

```text
skill_hub action=list|read|create|edit|install|remove|enable|disable|scan|backups|restore
```

- `list` 会附带 `Settings page last seen: …`，用于确认设置页（Client 半边）是否挂载过并按 `heartbeat()` 轮询。
- `read` 对只读来源也有效；`create` / `edit` / `remove` / `enable` / `disable` 只作用于管理目录。
- `install` 支持 `source`（本地路径）、`repo` + `ref` + `path`、`url`，以及 `mirror`（`repo`/`url` 下载的镜像前缀，本机直连 GitHub 不通时用 `https://gh-proxy.com/`）、`all`、`name`、`overwrite`。
- `scan` 只预演，不落盘。

---

## 落盘位置

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/skills/<name>/SKILL.md` | 管理的技能（`$DSH_HOME/skills/<name>.md` 这种单文件形式也支持） |
| `$DSH_HOME/skill-hub/config.json` | 镜像前缀、备份保留数 |
| `$DSH_HOME/skill-hub/backups/<skill>/<时间戳>-<原因>/` | 编辑、删除、恢复覆盖前留下的备份 |

写入都是「临时文件 + rename」的原子写，不经过第三方库。

---

## 与 `dsh-agent-skills` 的关系（可选插件，装了才需要看）

`dsh-agent-skills`（设置页里的「技能」，第三方插件）管理的是**别的 Agent 的技能目录**：`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.config/opencode/skills`、`~/.gemini/skills`，状态存在 `$DSH_HOME/agent-skills/state.json`。没有装它时本节可以跳过（本插件不依赖它）。

两者**存储不重叠**，但存在一个真实的交互：它的 provider 会按 **名字** 覆盖 `invocation`，哪怕技能不在它的目录里。本机上它的 `state.json` 把 10 个技能（包括预设自带的 cordis 系列）全列进了 `disabledSkills`，于是注册表报告它们全部 `{modelInvocable:false, userInvocable:false}`。

后果：

- 技能列表里会看到 `off` 与 `被覆盖` 徽标，并给出注册表实际值；
- 在本插件里拨动开关**只改文件**，如果那个名字仍在该插件的禁用表里，模型侧不会生效。

想让某个技能真正生效，两条路：在「技能」页里重新启用它，或从 `$DSH_HOME/agent-skills/state.json` 的 `disabledSkills` 里删掉它的名字。若只打算用一套管理界面，可以停用其中一个插件（`plugin_manager action=set_bundle`）。

---

## 实现要点

- **零依赖 frontmatter 手术**（`lib/frontmatter.js`）：只做行级增删改，所以未知键、注释、`|`/`>` 块标量、引号、CRLF 都原样保留；`truthy`/`falsy` 与扫描器同样接受 `true/yes/on/1` 与 `false/no/off/0`；`validateSkill` 只把扫描器**真正会抛错**的东西当错误（缺 `name`/`description`、非法名、旧键 `disableModelInvocation` 等），长度与目录名不一致只算警告。
- **零依赖 tar.gz 阅读器**（`lib/tar.js`）：ustar 前缀、GNU `L` 长名、PAX `x`/`g`、base-256 数字；拒绝绝对路径、`..`、NUL 路径；跳过符号链接与 `.git`/`node_modules` 等垃圾。
- **零依赖 zip 阅读器**（`lib/zip.js`）：读中央目录而非本地头，支持 stored(0)/deflate(8)，拒绝加密条目与 ZIP64、跳过软链/设备条目，逐条做路径穿越校验；返回结构与 `extractTarGz` 一致，所以两种归档共用同一套「找 `SKILL.md` → 列候选 → 安装」逻辑。
- **安装前预演**：`scanDir`、归档候选与仓库列表都先返回 `{name, description, valid, errors, renamable, suggested}`，界面里真正坏的候选直接禁用并显示原因。
- **名字不合规不再拒装，而是改名救回来**：扫描器源码里 `dsh-skill-filesystem` 对 `!isSkillName(name)` 只写一行 `logger.warn` 就**整条跳过**（`skill file … ignored: invalid skill name`），所以 `name: Web和AI安全测试专家` 这种大写 + 中文的技能即使装进去也永远不会被加载。因此本插件的原则是：**只有名字语法这一个问题**（`renamable`）时照装不误 —— 取一个合法 kebab 名（名字里能读出的 ASCII 优先，否则用目录名，例如 `Web和AI安全测试专家` + 目录 `web-ai-security-expert` → `web-ai-security-expert`；两边都没有 ASCII 时兜底 `skill`），装完**只改写 frontmatter 的 `name` 这一个字段**（`setField` 行级替换，正文与未知键原样保留），并在界面与工具输出里明确报告 `renamed: {from, to}`，安装前的那一行也会先写清「将安装为 X」。同理，**显式填「安装为」也会改写 `name`**，避免出现「目录叫 A、`name` 写 B」这种注册表和目录对不上的状态；而名字之外还有缺陷（例如同时缺 `description`）的候选仍然照旧拒绝，绝不猜。
- **取包方式对齐桌面软件的习惯**（借鉴 cc-switch 的 Skills 面板：Discover / 浏览仓库 / ZIP 一键装）：真正的文件窗口用浏览器自己的 `<input type="file">`，仓库列表用一次归档下载在内存里解包列出，安装一律回到同一条 `installDir`/`installUrl` 路径 —— 界面只负责「让用户点到那个包」。
- **不重复实现扫描逻辑**：技能列表优先来自 `ctx.skills.snapshot()`，本插件只做投影、诊断与写盘，写完调 `invalidateCache()`；**读不到时以磁盘为准**（见下条）。

---

## 测试

```powershell
npm test          # 四套测试：frontmatter / tar / Host 集成 / Client 渲染
npm run check     # 契约检查：方法名 + SRC 签名 + wire 一致性 + 每个 payload 键都被 Host 读取
npm run verify    # 两者一起跑
```

也可以逐个跑（都从**自身文件位置**定位资源，在任何工作目录下结果一致）：

```powershell
node tools\test-frontmatter.mjs      # 76 项：解析/增删改/校验 + 真实 SKILL.md 夹具（可选）
node tools\test-tar.mjs              # 17 项：合成归档、bsdtar PAX、真实 GitHub 归档
node tools\test-zip.mjs              # 34 项：合成 zip（存储/压缩/目录/软链/加密/ZIP64/损坏）+ 系统 Compress-Archive
node tools\test-skill-hub.mjs        # 213 项：Host 半边集成测试（真代码 + 临时 $DSH_HOME，含 .zip、上传包、仓库列表、目录浏览、改名救回）
node tools\test-skill-hub-client.mjs # 169 项：Client 半边（无浏览器渲染 + 点击回调 + 开关可见性 + 文件窗口/目录浏览/仓库列表/改名提示 + 列表不被压扁的布局回归）
node tools\check-reserved-names.mjs  # 方法名冲突 + SRC 签名规则 + wire 一致性
node tools\check-remote-payloads.mjs # 客户端发的每个键 Host 都读、方法双向可达
```

共 **509 项**。

- 真实 SKILL.md 夹具（DSH 预设自带的技能、以及你已安装的某个技能）是**可选**的：找不到就打印一行 `skip` 并继续，整套仍然全绿；用 `DSH_APP_DIR` / `DSH_HOME` 可以指向别的副本。
- 两个 `check-*.mjs` 需要宿主里的 gateway 源码来做契约校验，会自动探测常见安装位置（`DSH_GATEWAY` 可直接指定文件），找不到就 `skip` 并以 0 退出。
- CI（`.github/workflows/verify.yml`）在每次 push / PR 上跑 `npm test` + `npm run check`：套件零依赖、不访问外网（真实归档那 3 项失败会自动降级为 `skip`），CI 上没有 DSH 时契约检查也会干净跳过。

- `test-skill-hub.mjs` 用桩替换 `@deepseek-ai/*` 依赖，在临时 `$DSH_HOME` 上跑真实的 Host 代码，并且**逐字使用 client.js 构造的 payload** 调每一个 Remote 方法 —— 参数名写错会在这里失败，而不是在设置页里失败；它还用假的 registry 复现「provider 覆盖 invocation」，验证诊断只报告、不盲从。
- `test-skill-hub-client.mjs` 不用浏览器也不用 React：它提供假的 `window.__ModuleLoader__` / `document` / `react` 与一个可控 hook 引擎（useState / useCallback / useEffect，按 React 的调用顺序），因此能执行真实的 `client.js`、逐分支渲染（加载、报错、被覆盖、未加载、被更高优先级覆盖、备份、编辑器只读/非法、安装向导三页签与候选、目录浏览面板、设置、确认删除），并直接调用按钮 `onClick` 断言发给 Host 的 payload。它还把描述符列表与 Host 的 `REMOTE_METHODS` 做**双向**机械比对，并检查两份字典键一致、无死键、每个 `t()` 字面量都有译文、CSS 只用主题 token（并额外钉住「关闭态开关必须可见」：轨道用 `--dsw-alias-state-idle-primary` 而不是页面底色，旋钮自带描边 —— 之前白旋钮压在 `bg-layer-2` 上，浅色主题里等于看不见）。
- **Remote 方法签名必须满足网关的 SRC 规则**：网关从 `Function.prototype.toString` 里取出形参列表，要求是「唯一标识符」——不能有解构、默认值、rest（`dsh-api-gateway/lib/index.js` 的 `methodParameterNames`，违规时报 `gateway/signature-invalid`），而且**形参名就是客户端要发的 wire 名**。所以 Host 侧写成 `async save(input)`（默认值在函数体里补），客户端描述符的 `wire` 必须是 `input`。这条规则现在被两处测试钉住：`test-skill-hub.mjs` 用真实方法对象跑一遍网关的解析逻辑，`test-skill-hub-client.mjs` 与 `check-reserved-names.mjs` 再把客户端 wire 与形参名逐一比对。
- **客户端发什么，Host 就得读什么**：`check-remote-payloads.mjs` 把 `client.js` 每个 `api.x({...})` 调用点的键，与 Host 方法体里 `input.x` / `payload?.x` / `const {…} = input` 的读取逐一比对，并双向检查「已发布的方法都被页面调用」「页面调用的方法都已发布」。没有这层检查时，一个只改了形参名或键名的编辑会让按钮静默失效 —— 这正是 SRC 签名 bug 能溜过去的同类盲区。
- **不合规的名字有测试钉住到底**：`test-frontmatter.mjs` 钉住 `renamable`/`suggested` 的判定（只有「名字语法」这一个错才算可救、合法名永不标记、名字之外还有错就不救）、建议名**必定**满足扫描器正则 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（与 `dsh-skill/lib/index.js` 的 `SKILL_NAME` 逐字相同）；`test-skill-hub.mjs` 用真目录/真文档跑通「装进去 → frontmatter 被改写 → 正文一字不动 → 以新名字注册」，并确认缺 `description` 的候选仍然被拒；`test-skill-hub-client.mjs` 确认「可救的候选按钮可点、不可救的按钮禁用、安装前后都写明改成了什么」。
- **覆盖/截断/散装文档都有测试钉住**：三条覆盖路径（本地目录 `installDir`、文档 `installUrl`、压缩包 `installUrl`）在删除旧技能前都必须先落一份 `reason: overwrite` 的备份；拷贝触到 500 文件 / 8 MB 上限时必须显式报告不完整（而不是显示成功）；备份 id 在同一秒内不冲突（加 `-2` 后缀）、列表按带毫秒的 `at` 排序；根目录下的散装 `<name>.md` 视为技能（删除/覆盖只备份那一个文件，恢复时按文档还原）。
- **被压扁的列表有测试钉住**：`.skill-hub-files` 是「`max-height: 300px` 的 flex 列 + 内部滚动」，而 `.skill-hub-file` 声明了 `height: 30px` 却没写 `flex: 0 0 auto` —— 于是条目一多，flex 直接把每行压到 **16px**（26 个条目时 computed height `16px`、`flex-shrink: 1`）：内容是塞满了，可滚动条根本不出现，只有条目少时才恢复 30px。这是在真实设置页里用 CDP 量出来的（17 条目 → 17px；26 条目 → 16–17px；修好后两者都是 30px 且 `scrollHeight 780 / clientHeight 300` 正常内部滚动）。现在 `.skill-hub-files > *` 与 `.skill-hub-modal-body > *:not(.skill-hub-spacer)` 都禁止收缩，`test-skill-hub-client.mjs` 加了三项布局回归断言（同时仍钉住 `max-height` 与 `overflow-y: auto` 必须成对出现）。
- **注册表对本根失明时以磁盘为准**：`ctx.skills` 是**分层**注册表（`registerProvider` 落进调用方作用域所属的层，一次读取只合并「全局层 + 调用方作用域的链」）。本插件是宿主级插件，只读得到全局层；如果技能由 agent preset 作用域里的 provider 提供，或是原本把 preset 层桥接到全局的那个第三方插件被卸载了，`snapshot()` 就会返回空目录 —— 此时**不是文件坏了**。所以：`registryBlind`（本根所有合规技能都没进注册表）时，**页面不弹任何说明**（用户明确不要那段解释），只在行上加一个「未注册」小徽标，行改为直接读磁盘（`registered: false`），并且 `read`/`edit`/`enable`/`disable`/`remove` 都走 `findOnDisk()` 回落，编辑删除照常可用；「失明」这件事只写进 `skill_hub list` 的工具输出和本 README，供排查用。只有当注册表**确实报了本根的其他技能**时，缺席的条目才按「磁盘上合规但没进注册表」逐条报警（例如 legacy key 被扫描器跳过）。

---

### 在真实 DSH 里调试

- 安装、升级、启停都走 `plugin_manager`（`install_bundle` / `set_bundle`），不要手改 profile 的 `package.json`。
- 改 `index.js`（Host 半边）**必须重启 DSH**；只改 `client.js` 时，客户端包在重启/安装时重新打包，之后刷新页面即可。
- 宿主日志：`%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`（`.error.log` 是另一份）。
- 技能目录本身由系统扫描器监听，**改文件不需要重启也不需要刷新**；只有插件自己的代码需要。
- 界面结构可用内置 Cordis Inspect 查（这两条是**客户端** provider）：`Slots.listSubTree` 看插槽树，`Theme.listTokens` 看主题 token（本插件只用 `--dsw-alias-*` 上色）。
- **不麻烦用户也能自测界面**：本机装了 `chrome-devtools-mcp`（stdio，注册在 `~/.dsh/mcp-hub/servers.json`：`node F:\work\dsh插件\.mcp\node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js`），可以直接驱动一个 Chrome 打开 `http://127.0.0.1:43120/`，点按钮、读 console/network。两个坑：① 这个 URL **必须带进程 token**（`/?token=…`，从 DSH Desktop 设置里的「本地地址」取），否则一律 403 `forbidden`（认证层失败其实是 401，403 说明根本没走到认证层）；② 截图对模型无用（不声明图像输入），要用 a11y 快照 + `evaluate_script` 量 `getComputedStyle` —— 上面那个「26 条目时行高 16px」就是这么量出来的。

## 目录结构

```
dsh-skill-hub/
├─ index.js            Host 半边：磁盘管理、诊断、安装器、Remote 服务、skill_hub 工具
├─ client.js           浏览器半边：设置页（列表/开关/编辑器/安装向导/备份）
├─ lib/frontmatter.js  零依赖 frontmatter 行级手术 + 校验（与扫描器同规则）
├─ lib/tar.js          零依赖 tar.gz 阅读器（ustar/GNU L/PAX/base-256）
├─ lib/zip.js          零依赖 zip 阅读器（stored/deflate，拒绝加密与 ZIP64）
├─ cordis.patch.yml    安装时挂进 profile 的 Loader 补丁
├─ locale/{zh,en}.json 页面文案（有词典一致性测试）
├─ icon.svg            设置页图标
└─ tools/              测试、契约检查与桩（见上）
```

## 许可

[MIT](LICENSE) © 2026 qingchuana

## 已知限制

- 只管理 `$DSH_HOME/skills` 一个根；其他根只能查看/复制（这是刻意的，避免和 `dsh-agent-skills` 抢目录）。
- **页面拿不到文件路径，但能拿到文件本身**：DSH 给插件的只有目录选择器（`uiWorkspace.pickDirectory()`），客户端服务目录里没有任何文件选择服务，会话输入框的 `pickFiles()` 是聊天附件专用且只返回「有没有被调用」，Electron 的 `dialog.showOpenDialog` 只在 DSH 自己的数据目录设置里用、没暴露给插件。所以选包有两条路：**「选择 .zip / .md 文件…」**（浏览器自带的 `<input type="file">`，是最接近桌面软件「打开文件」的东西，但只给字节不给路径 —— 插件把字节 base64 上传给宿主，宿主写成 `$DSH_HOME/skill-hub/uploads` 下的临时文件，再当作普通来源走同一套扫描/安装）和 **「浏览…」**（宿主 `listLocal` 列目录，因为 `listDirectory` 只列目录、看不到文件）。两个按钮**一定渲染**，拿不到目录选择器时点它会直接在页面上写出原因，不会静默消失。
- **浏览面板从哪里开始**：路径框里填了什么就从它的**父目录**开始（填的是包），否则从 `$DSH_HOME` 开始，所以一开始看到的可能是主目录而不是技能目录 —— 面板右上角的**「技能根目录」/「主目录」**两个跳转就是为了这一步，面包屑也能直接点回任意上级。
- **上传的限制**：单包 ≤ 16 MB（base64 后约 21 MB，超过在解码前就拒绝，也避免顶到传输帧上限），只收 `.zip` / `.tar.gz` / `.tgz` / `.md`，`README.md` 不收；上传目录最多留 8 个，每次启动清空。上传文件名只取 basename 并落进固定目录，`../` 无法逃逸（有测试钉住）。
- **「列出仓库里的技能」是真下载**：它拉整份归档（走和 `installUrl` 同一条下载/镜像/超时/大小上限通道），在内存里解包后列出所有 `SKILL.md`，所以点「安装这个」会**再下载一次**（现有安装器按 `path` 从归档里取子树）。仓库很大时会慢，`MAX_DOWNLOAD_BYTES`（32 MB）会先拦住。
- **`.zip` 支持范围**：只解压 stored(0) 与 deflate(8)；加密条目、unsupported method、ZIP64、软链/设备条目会被跳过并在结果里说明；**不校验 CRC**（坏流会在 inflate 阶段失败）。解压在 `$DSH_HOME/skill-hub/tmp` 下进行，同一时刻只留一份、每次启动清空；zip 里的候选在真正安装时会**重新从压缩包解出来**，所以页面上那份候选列表即使过期也不会装错东西。
- **来源标签是「类别」不是「路径」**：别的 provider 会把 `.agents`、`.claude`、`.codex`、`.config/opencode`、`.gemini` 下的技能统一报成 `source: 'user-agents'`（见 `dsh-agent-skills/lib/discovery.js`），所以界面只用中性词（「其他 Agent 目录」），并**在只读技能行里直接显示真实目录**；来源 id 不认识时原样显示，不猜成某个路径。
- 「复制到我的技能」是打开安装向导并预填该技能所在目录，拷的是**整个目录**（含 `references/`、`tools/` 等子文件），同名已存在会跳过（除非勾选覆盖）。因为 `$DSH_HOME/skills` 的 rank 是 400、别的 Agent 目录是 500，**副本会赢下同名竞争**（本机实测：复制 `solve-challenge` 后它变成 `managed`，原件目录不动）；但 `dsh-agent-skills` 的按名禁用仍然生效，所以副本会显示「被覆盖」徽章。
- 拷贝上限是 500 文件 / 8 MB / 6 层；触到上限会明确报「复制不完整」并列出被跳过的路径，`JUNK_DIRS`（`.git`、`node_modules`、`.idea`、`.vscode`、`__MACOSX`）与 `JUNK_FILES`（`.DS_Store`、`Thumbs.db`）不拷。二进制文件用 `copyFile` 原样复制（测试里逐字节校验）。
- 发现规则与扫描器一致：**只往下看一层**（`<root>/<dir>/SKILL.md` 或 `<root>/<name>.md`）。
- GitHub 直连在部分网络下不通：页面里填镜像前缀（本机实测 `https://gh-proxy.com/` 可用），或对进程设置 `HTTPS_PROXY`。
- `name` 与目录名不一致时扫描器按 `name` 索引，本插件按 `name` 操作，并在校验里给警告。
