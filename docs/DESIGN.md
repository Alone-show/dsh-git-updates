# dsh-git-updates 方案文档（0.3.0）

> 目标：给「从 GitHub / Git 拉取安装的插件」补上检查更新与一键更新的能力，入口放在**设置**里。
> 运行环境：DSH Desktop（`next` 通道，profile=`desktop`，DSH `0.2.2-rc.5`），Linux，Node 22，pnpm 11.28.5。
> 文档日期：2026-11-24 · 插件版本：0.4.0（`link:/home/my/Downloads/dsh-git-updates`）
>
> **0.3.0 相对 0.2.0 的变更**：界面从「插件详情页 + 插件页标签 + 全局浮层」收敛为**设置里的独立一栏**（`settings.section`），其余页面的控件全部移除；新增「更新时那一行不能消失」的粘性行机制（`lib/sticky.js`）；任务视图补齐四步状态、每步耗时与实时日志；后台巡检默认关闭。

---

## 1. 背景与问题

这个 profile 里有 6 个依赖是 `github:` 安装的：

| 依赖 | 保存的 spec | 实测已装 commit | 上游 HEAD |
| --- | --- | --- | --- |
| `dsh-quota-widget` | `github:Alone-show/dsh-quota-widget#7e879ee…` | `7e879ee` | 最新 |
| `dsh-codex-connect` | `github:franksong2702/dsh-codex-connect#aa84dac…` | `aa84dac` | 领先 |
| `dsh-delete-session` | `github:DDDMUC/dsh-delete-session` | `90a765f` | `53671e4` |
| `dsh-quick-keys` | `github:Alone-show/dsh-quick-keys` | `9d21990` | 最新 |
| `@local/cp-tools` | `github:Alone-show/cp-tools` | `9274c17` | `78add1d` |
| `@local/wechat-worklog` | `github:Alone-show/wechat_wroklog#5eb5e68…` | `5eb5e68` | `f0e2a5e`（只能走 SSH） |

DSH 自带插件管理器**已经**有更新入口（详情页「更新」、`listVersions` / `updateBundle`），但 Git 分支有硬条件：只接受 `package.json` 里**已钉完整 40 位 commit** 的依赖，而且调用方要先给出新的 semver 版本号。`github:owner/repo` 这种分支写法把解析结果记在 `pnpm-lock.yaml` 里，`package.json` 仍是分支写法；因此这 6 个插件在 UI 上没有更新按钮，想升级只能手工「卸载 → 重装」，连「现在装的是哪个 commit、上游到哪了」都看不到。

## 2. 目标与非目标

**目标**

1. 在**设置**里新增独立一栏「插件更新」：显示仓库、跟踪分支、已装 commit、上游最新 commit、上次检查时间。
2. 每行可检查更新、可一键更新到上游最新 commit，保持原「启用状态」不变。
3. **更新时那一行不能消失**：卸载阶段包会从宿主插件列表里消失，界面必须保留该行并显示进度。
4. 更新失败/取消自动回滚到原版本，并如实报告失败原因。
5. 只处理 Git 来源依赖；registry、tarball、`link:` 一律不显示。
6. 不引入新凭据、不新增常驻后台请求（页面打开或点按钮时才探测）。

**非目标**

- 不处理 `link:` 到本地克隆的插件（`dsh-kb`、`mdm-ssh`），那是 `git pull` 场景。
- 不处理 registry / tarball 来源。
- 不直接调用 `pnpm`（所有包变更委托给宿主 plugin manager）。
- 不做 GitHub API 调用（免 token、免限流），只用 `git ls-remote`。
- 不在插件详情页、插件页标签或全局浮层添加任何控件。
- 不自我更新（见 §9）。

## 3. 关键调研结论

| 事实 | 依据 | 对方案的影响 |
| --- | --- | --- |
| 运行的是打包版，源码在 `app.asar` 里 | `DSH_INSTALL_DIR=/opt/DSH NEXT/resources/app.asar` | 不能改宿主 `plugin-manager`，只能做第三方 bundle |
| `BundleInfo` 暴露 `source`、`update`、`installed`、`enabled` | `@deepseek-ai/dsh-plugin-manager` `types.ts` | 用 `listBundles()` 当唯一事实来源 |
| `updateBundle` 的 Git 分支要求「当前 + 目标都钉 commit」且要 semver 版本 | `src/index.ts: updateRefusal/planGitUpdate` | 分支形式依赖只能自己编排；本工具也不联网读目标版本号 |
| HMR 存在时 `installBundle` 对已装包抛 `already-installed` | `src/index.ts` | 更新必须「先 removeBundle 再 installBundle」 |
| 宿主会发 `plugin-manager/install-log` / `install-state` / `update-state` | `src/types.ts` Events | 进度卡可显示真实 pnpm 输出与安装阶段 |
| pnpm 把 Git 依赖的实际 commit 记在 lockfile | `version: https://codeload…/tar.gz/<sha>` | 已装 commit 有可靠来源，无需 `.git` 目录 |
| `git ls-remote` 在本机可用，HTTPS 私有仓库会失败、SSH 可用 | 实测 `wechat_wroklog` | 探测需要 HTTPS → SSH 回退 |
| 设置页声明 `settings.section` / `settings.section.icon` | `dsh-client-ui-settings/src/client/contract/slots.ts` | 入口是一个独立的设置页，正好放列表与进度 |
| 设置页内容区由 `ui-settings-general` 渲染，注册项支持 `inject` | `SettingsRoot.tsx` / `ui-settings-plugin-inventory` | 页面可拿到 `ctx.locale.resolveText` 等能力 |

## 4. 方案选型

| 方案 | 可行性 | 结论 |
| --- | --- | --- |
| A. 改 `/opt/DSH NEXT` 里的 `plugin-manager` | 需改 `app.asar`，每次应用升级失效 | 否 |
| B. 直接复用 `updateBundle` | 分支形式依赖被拒绝，且需要目标 semver 版本 | 否 |
| C. 新 bundle + 复用 `removeBundle`/`installBundle`/`cancelInstall`，自己编排与回滚 | 全部走已发布的服务与设置插槽 | **采用** |
| D. 自己跑 `pnpm add` | 绕过宿主锁、激活、回滚，容易弄坏 profile | 否 |

代价：**更新后要重启 DSH** 才能加载新宿主代码；浏览器侧改 `client.js` 后要刷新页面。

## 5. 总体架构

```
┌──────────────────────── 浏览器（设置弹层）────────────────────────┐
│ client.js（手写 __ModuleLoader__ 包，不经构建）                    │
│   settings.section       ← 「插件更新」整页（列表 + 进度 + 取消）    │
│   settings.section.icon  ← 左侧导航图标                            │
│   纯函数：mergeViews / stepRows / phaseOf / format…（Node 单测）    │
└───────────────┬──────────────────────────────────────────────────┘
                │ 同源 fetch，JSON，带 confirm
┌───────────────▼──────────────── 宿主（Electron 主进程）───────────┐
│ index.js ── ctx.connection.fetch.register('/api/dsh-git-updates')  │
│   依赖：connection · pluginManager · profileContext                 │
│   订阅 plugin-manager/install-log、install-state → 任务日志         │
│   后台巡检（默认关）· 自身包名保护                                  │
│   lib/route.js      动作的 HTTP 外壳 + 错误码映射                  │
│   lib/service.js    视图合成 / 缓存 / 并发去重 / 前置校验 / 任务   │
│   lib/sticky.js     实时行 + 任务快照 → 卸载期间行不消失            │
│   lib/probe.js      git ls-remote（HTTPS→SSH，超时，禁交互）       │
│   lib/lockfile.js   pnpm-lock.yaml → 已装 commit                   │
│   lib/git-source.js 保存的 spec → 仓库/分支/是否钉 commit          │
│   lib/update.js     remove → install → verify →（失败）restore     │
│   lib/jobs.js       单任务 + 四步 + 耗时 + 日志                    │
│   lib/state.js      <profile>/.git-updates/state.json              │
└───────────────┬──────────────────────────────────────────────────┘
                │ 委托（不自己跑 pnpm）
        ctx.pluginManager.removeBundle / installBundle / cancelInstall
```

设计原则：

1. **包变更只有一个出口**：宿主 plugin manager。本插件只负责「查上游 + 算目标 + 编排 + 校验 + 回滚」。
2. **事实来源唯一**：包与来源来自 `listBundles()`，已装 commit 来自 `pnpm-lock.yaml`，上游来自 `git ls-remote`。
3. **可解释、可回滚**：每一步保留宿主返回的 `ChangeResult`；失败/取消把旧 commit 装回去。
4. **界面只动设置**：不占详情页、插件页标签、全局浮层。

## 6. 数据流

### 6.1 检查（只读）

1. 打开设置页 → 组件挂载 → `GET /api/dsh-git-updates` 取列表（不联网）。
2. 对 `check.at === null` 或缓存过期的行，逐行 `POST {action:'check'}`。
3. 宿主探测：`git -c core.askPass= ls-remote --exit-code -- <https url> <ref|HEAD>`；凭据类失败且允许回退时改试 SSH。
4. 比较 `latest` 与已装 commit → `current` / `behind`；失败 → `unknown` + `{kind, message}`。
5. 结果写 `.git-updates/state.json` 的 `lastCheck`，返回给页面。

### 6.2 更新（有序、可回滚）

```
确认 (expectedCommit, targetCommit)
  └─ service.update 前置校验 → 捕获 snapshot → 起任务（全局单任务）
       checking   客户端已确认目标 → 立即完成；脚本调用未带目标 → 任务外先探测
       removing   removeBundle(name)                       失败 → REMOVE_FAILED，不安装不回滚
       installing installBundle(<base>#<sha>, {enabled, requestId})   失败/取消 → 回滚
       verifying  锁文件 commit === 目标；node_modules/<name>/package.json 同名且声明 dsh.bundle.patch
                  不过 → VERIFY_FAILED → 回滚
       restoring  installBundle(<base>#<旧commit> 或原 baseSpec, {enabled})（取消也走）
  └─ 结束：写 lastUpdate；成功且 restart-required 写 restartPending；任务终态可轮询
```

要点：

- **为什么目标 commit 由客户端带回**：确认态里已经显示过这个 commit；带回来就立即安装，避免确认后再盲等最长 15s 的探测，也避免实际安装与用户确认的不一致。
- **为什么回滚要钉旧 commit**：分支可能在更新期间前进，只有 sha 能精确复原「更新前那个版本」。
- **取消语义**：`requestId` 传给 `installBundle`，页面点「取消」时宿主 `cancelInstall` 终止 pnpm 并还原文件；若卸载已经完成，编排会把旧版本装回去。
- **校验放在安装后**：不联网读目标 commit 的 `package.json`，宁可装完再验、验不过自动回滚。

### 6.3 为什么需要「粘性行」

更新必须 `removeBundle` → `installBundle`。`removeBundle` 完成后，包从 `package.json`、`pnpm-lock.yaml` 与 `listBundles()` 里都消失了，页面如果只按实时列表渲染，**正在更新的那一行会在最需要看进度的几秒到几十秒里消失**。

方案（`lib/sticky.js` + 浏览器 5s 兜底）：

1. `service.update()` 在起任务前把当前行存进 `job.snapshot`。
2. `service.list()` 每次刷新实时快照；返回时把「实时行 + 任务行」合并：
   - 实时行还在 → 用它，附上该包最近的任务；
   - 实时行缺失、但任务在跑或结束不足 30 分钟 → 用快照补一行，标 `sticky: true` / `installedMissing: true`；
   - 没任务也没实时行 → 不补，避免把用户已卸载的插件一直挂着。
3. 浏览器 `mergeViews()` 再保留上一份行 5 秒，避免一次轮询抖动。
4. 回滚失败时粘性行保留到宿主进程结束，并显示「未安装」，不用消失来掩盖失败。

## 7. 实现

### 7.1 宿主挂载（`index.js`）

- `export const inject = ['pluginManager', 'profileContext']`；`profileContext.dir` 是 profile 目录。
- `apply` 是 async：先 `await service.ready`（启动对账），再注册路由与定时器，页面第一次读到的就是干净状态。
- 订阅 `plugin-manager/install-log` / `install-state`，把当前 `requestId` 的安装输出写进任务日志。
- `ownPackage` 从本包 `package.json` 读，用于禁止自我更新。
- 后台巡检：`backgroundCheckMs > 0` 时才 `setTimeout` + `setInterval` 调 `service.sweep()`；默认 0。
- `ctx.inject(['connection'], …)` 里注册 `ctx.connection.fetch.register(...)`；没有 connection 就只记日志。
- 挂载成功后打一行 `[git-updates] 已挂载 /api/dsh-git-updates（profile: …）`。

### 7.2 来源解析（`lib/git-source.js`）

支持形式：`github:o/r`、`github:o/r#main`、`github:o/r#<40位>`、`https://github.com/o/r`、`git+https://…git#v1`、`git@github.com:o/r.git`、`git+ssh://git@host/o/r.git#main`。明确拒绝 `file:` / `link:` / `workspace:` / `npm:` / 相对与绝对路径 / `.tgz`。派生 `httpsUrl`、`sshUrl`、`sshGitUrl`、`compareUrl`。

两种 spec 必须分开：

| 函数 | 形态 | 用途 |
| --- | --- | --- |
| `pinnedSpec(source, commit)` | `github:owner/repo#<sha>` | 状态/展示/日志里的规范写法（pnpm 落盘也是这个） |
| `installSpec(source, name, commit, {ssh})` | `<包名>@<地址>#<sha>`，`ssh` 时地址是 `git+ssh://…` | 真正交给 `pnpm add` 的写法 |

为什么要显式包名：pnpm 11 对「仓库名 ≠ 包名 + commit fragment」的 Git 依赖会把 fragment 混进 alias（`wechat_wroklog#<sha>`），报 `ERR_PNPM_INVALID_DEPENDENCY_NAME`；写成 `@local/wechat-worklog@git+ssh://…#<sha>` 后 pnpm 落盘仍归一成 `github:owner/repo#<sha>`。私有仓库（锁文件是 `git+ssh`，或探测只能走 SSH）直接用 SSH 地址，不依赖 pnpm 的 HTTPS 自动回退，也不弹凭据。

### 7.3 已装 commit（`lib/lockfile.js`）

只扫 `importers:` 段，取每个依赖的 `specifier` 与 `version`；从 `version` 提 commit：`/tar.gz/<sha>` → `#<sha>` → 裸 40 位，先剥 peer 后缀 `(ws@8.23.0)`。纯文本解析，不引 YAML 库。读不到时视图里 `installed.commit` 缺失，更新被拒（`UNKNOWN_INSTALLED_COMMIT`）——「无法精确回滚」比「装作能更新」安全。

### 7.4 上游探测（`lib/probe.js`）

- `probeSource`：`git -c core.askPass= ls-remote --exit-code -- <url> <ref|HEAD>`；解析优先 `refs/tags/<ref>^{}`，其次 `refs/heads/<ref>`、`refs/tags/<ref>`，最后任意 `/<ref>` 后缀。
- `probeRefs`：`git ls-remote --symref <url>` 一次列全部分支，返回远端 HEAD、默认分支与每个分支的尖端，用 `branchForCommit()` 按已装 commit 反查跟踪分支。
- 两者都：禁 askpass/终端提示，默认 15s 超时并 `SIGKILL` 整个进程组，输出上限 256 KiB；失败分类 `timeout/auth/network/not-found/unknown`，只有 `auth` 触发 SSH 回退。

**为什么需要反查分支**：spec 被钉成 `#<sha>` 后，`source.ref` 就丢了；如果仓库默认 HEAD 与插件分支不同（例如 `wechat_wroklog` 的 `main` 与 `dsh-plugin`），直接探 HEAD 会把插件更到根本不含 bundle 的提交。现在的顺序是：spec 里的分支 → `trackedRefs` 配置 → 已记录的 `trackedRef` → 用已装 commit 匹配分支尖端 → 远端 HEAD（都找不到时）。

### 7.5 业务层（`lib/service.js`）

- `describe(name)`：`listBundles()` + lockfile + state → `{bundle, view, source}`。
- `view(name)` / `list()`：只合成视图，不联网；`list()` 走 `mergeSticky()`。
- `check(name, {force})`：缓存 TTL（默认 10 分钟）内直接返回；同一包并发检查共用一个 `Promise`。钉 commit 且没有已知分支时走 `probeRefs` 反查，学到分支后写进状态的 `trackedRef`。
- `update` 安装时按「锁文件是否 `git+ssh` / 上次探测传输」决定用 SSH 地址，并统一使用 `installSpec`（显式包名）。
- `update(name, {expectedCommit, targetCommit, force})` 前置校验顺序：
  1. 自身包 → `SELF_UPDATE`；
  2. 必须是受管 Git 依赖（`NOT_MANAGED`）；
  3. 读得到已装 commit（`UNKNOWN_INSTALLED_COMMIT`）；
  4. 客户端上报的 `expectedCommit` 必须与当前一致（`STALE_VIEW`）；
  5. 已有任务 → `JOB_RUNNING`；未带目标时先检查（`CHECK_FAILED` / `ALREADY_LATEST`）；
  6. 起任务，任务体调 `runUpdate`。
- `update` 若同一个包已有任务，先于 `describe()` 拒绝（包可能已被卸载，否则会误报 `NOT_MANAGED`）。
- 任务结束后写 `lastCheck`（成功时置 `current`）与 `lastUpdate`；`restart-required` 写 `restartPending`。
- `list()` 用 `mergeSticky(views, runner.entries())` 把每个包最近的任务挂到行上；路由另返回 `activeJobs` 供页首显示并行任务数。
- `onInstallLog(chunk)` / `onInstallState(progress)`：仅当 `requestId` 与当前任务一致时追加日志。

### 7.6 更新编排（`lib/update.js`）

| 步骤 | 动作 | 失败时 |
| --- | --- | --- |
| `removing` | 仅 HMR 下 `removeBundle(name)`；保留原 `enabled` | `REMOVE_FAILED`，不进安装、不回滚 |
| `installing` | `installBundle(spec, {enabled, requestId})` | 回滚（`INSTALL_FAILED` / `CANCELLED`） |
| `verifying` | 锁文件 commit === 目标；`node_modules/<name>/package.json` 的 `name` 相符且声明 `dsh.bundle.patch` | 回滚（`VERIFY_FAILED`） |
| `restoring` | `installBundle(<base>#<旧 commit>)`，读不到旧 commit 时退回原 `baseSpec` | 记 `RESTORE_FAILED`，保留现场与粘性行 |

### 7.7 任务（`lib/jobs.js`）

- 每个包同时最多一个任务（同包再点 → `JOB_RUNNING` 409）；不同包可以并行，受 `maxConcurrentUpdates` 限制（超出 → `JOB_LIMIT` 409）。
- 任务视图：`{id, packageName, requestId, step, status, message, startedAt, finishedAt, elapsedMs, steps[], logs[], result, error, snapshot}`。
- `steps` 固定四步 `checking/removing/installing/verifying`，每步 `status/startedAt/finishedAt/durationMs`。
- `logs` 最多 50 条（`{at, level, message}`）；`addLog(requestId, …)` 供宿主事件追加。
- `status`：`running` / `cancelling` / `done` / `failed`；`done` 仍可能是「失败但已回滚」（看 `result.verified`）。
- 保留最近 20 个已完成任务；`entries()` 供粘性行使用。

### 7.8 状态文件（`lib/state.js`）

`<profile>/.git-updates/state.json`：`{version, packages: {<name>: {lastCheck, lastUpdate, restartPending}}}`。目录 0700、文件 0600；临时文件 + `rename` 原子替换；坏 JSON / 版本不符当空状态。只存可重建信息，不含 token、不含带凭据的 URL。`restartPending` 带 `bootId`（pid + 进程启动时刻），启动对账时清掉上一进程的标记。

### 7.9 路由（`lib/route.js`）

基址 `/api/dsh-git-updates`，同源、`requestBody: 'buffered'`。

| 请求 | 作用 |
| --- | --- |
| `GET`（无 package） | 所有受管包视图 + `activeJob` |
| `GET ?package=<name>` | 单包视图（不联网） |
| `GET ?package=<name>&probe=1[&force=1]` | 视图 + 探测 |
| `GET ?jobId=<id>` | 任务进度 |
| `POST {action:'check', package, force?}` | 强制检查 |
| `POST {action:'update', package, confirm:true, expectedCommit?, targetCommit?}` | 起更新任务 |
| `POST {action:'cancel', confirm:true, jobId, package?}` | 只取消指定任务 |

错误码 → HTTP：`NOT_FOUND/NOT_MANAGED` 404、`STALE_VIEW/ALREADY_LATEST/UNKNOWN_INSTALLED_COMMIT/JOB_RUNNING/SELF_UPDATE` 409、`CHECK_FAILED` 502、`INVALID_BODY/INVALID_ACTION` 400、`BODY_TOO_LARGE` 413、`INTERNAL` 500。POST 只接受 `content-type: application/json`。

### 7.10 配置（`lib/config.js`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `probeTimeoutMs` | 15000 | 单次 `git ls-remote` 超时（1s–120s） |
| `sshFallback` | true | HTTPS 凭据失败时改试 SSH |
| `pinCommits` | true | 更新后是否钉到具体 commit |
| `cacheTtlMs` | 600000 | 检查结果缓存 |
| `maxConcurrentUpdates` | 3 | 同时更新的插件数上限（1–8） |
| `trackedRefs` | `{}` | 包名 → 跟踪分支；钉 commit 后分支已前进、无法按已装 commit 反查时用它 |
| `backgroundCheckMs` | 0 | 后台巡检间隔；0 关闭 |
| `backgroundCheckStartMs` | 60000 | 开启巡检时的首次延迟 |
| `maxBodyBytes` | 8192 | POST 体积上限 |
| `gitCommand` | `git` | 可指到特定 git 可执行文件 |

覆盖方式：profile 的 `cordis.patch.yml` 里同 id 的 `config`（Loader 用同名覆盖整段 config）。

## 8. 界面

### 8.1 位置与插槽

| 插槽 | kind | 注册项 | 渲染位置 |
| --- | --- | --- | --- |
| `settings.section` | list | `{id:'plugin-updates', order:20, label:()=>t('nav.label')}` | 设置弹层左侧导航新增独立一页，内容占满右侧 |
| `settings.section.icon` | list | `{id:'plugin-updates'}` | 该导航行的 16px 图标 |

设置页之外**没有**任何注册；插槽注册项带 `locale` 命名空间（`git-updates`），组件拿到 `t`；`inject` 提供 `resolveText`，用来解析 `bundle.meta.title`。

### 8.2 视觉规格

- 页面：标题 16px/600、说明 12.5px 三级文字、行卡片 10px 圆角 + 半像素描边。
- 按钮：复刻插件页 `Button` 的 `outline`/`sm` 规格——高 28px、内边距 `0 10px`、字号 12px/18px、圆角 `var(--dsw-radius-sm)`、`box-shadow: inset 0 0 0 var(--dsh-hairline-width) var(--dsh-button-outline-color)`、hover 用 `--dsw-alias-interactive-bg-hover`、禁用 `opacity:.4`。
- 确认态不刷成实心，只把描边/文字换成 `--dsw-alias-state-warn-primary`（与 0.2.0 一致）。
- 图标全部内联 SVG（13px），不依赖 symbol id；颜色继承 `currentColor`。
- 样式随组件挂载/卸载（组件内渲染 `<style>`），全部类名 `gu-` 前缀，不影响其它设置页。

### 8.3 状态矩阵

| 状态 | 行内表现 |
| --- | --- |
| 加载中 | 「正在读取插件列表…」 |
| 无 Git 插件 | 「没有从 Git 安装的插件。」 |
| 已最新 | 绿色徽标「已是最新」；按钮仍是「检查更新」 |
| 有更新 | 琥珀徽标 + 上游 commit + compare 链接 + 「更新到 `<sha>`」 |
| 确认态（8s） | 按钮变「确认更新到 `<sha>`」，描边/文字转 warning，8 秒内再点执行 |
| 检查中 | 行内徽标「检查中」+ 按钮「检查中…」+ 页首 `n/m` |
| 更新中 | 该行四步状态条（含每步耗时）、实时日志、整体耗时、「取消更新」；只禁用这一行的按钮，其它行照常检查/更新 |
| 完成 | 绿色横幅「已更新到 `<sha>`，已生效」或「重启 DSH 后生效」+ 指引 |
| 失败并回滚 | 红色横幅 + 原因 + 「已回滚到更新前的版本（`<sha>`）」 |
| 回滚失败 | 红色横幅「该插件当前未安装」；该行保留（`sticky`） |
| 无法检查 | 琥珀提示 + 失败原因；认证失败额外说明需要本机 git 凭据 |
| 自身 | 「本工具」徽标 + 更新按钮禁用 + 提示到插件页更新 |
| 粘性行 | 显示快照里的 commit 与任务进度，不因包被卸载而消失 |

### 8.4 交互流程

1. **打开即检查**：先读列表（快），对未检查/过期行自动探测，最多 3 行并行；每行独立完成，某行查完即可更新，不必等整批。
2. **二次确认**：点「更新」→ 按钮变「确认更新」→ 8 秒内再点才执行（`CONFIRM_MS=8000`）。
3. **进度**：任务起后忙时 900ms、空闲 15s 轮询 `GET`；每行的 `job.steps/logs` 驱动自己的四步条与日志。多个插件可同时更新，每行有自己的「取消更新」，按 `jobId` 只停那一行。
4. **结果**：成功刷新视图并提示生效/重启；失败展示原因与回滚结论。
5. **刷新要求**：宿主数据改完立即读得到（lockfile），但**新代码要重启 DSH**；浏览器侧改 `client.js` 后需刷新页面。

### 8.5 文案

字典在 `client.js` 内（`zh` / `en`，命名空间 `git-updates`），缺词条回退 key，不会白屏。关键项：`nav.label`（插件更新）、`action.check`、`action.updateTo`、`action.confirm`、`action.cancelUpdate`、`step.*`、`result.*`、`err.*`、`reason.*`。

### 8.6 可访问性与降级

- 按钮有 `title` / `aria-label` 语义（确认态 title 提示再点一次）；状态同时用文字表达，不只靠颜色。
- 步骤条是 `ul/li`，图标 `aria-hidden`。
- 组件卸载清定时器；轮询只在挂载期间进行。
- 宿主路由不可用（headless / 旧版本）→ 页内「无法读取更新服务」，不抛错、不影响设置其它页。

## 9. 安全与权限

| 面 | 处理 |
| --- | --- |
| 路由鉴权 | 走 `ctx.connection.fetch`（与 Web GUI 同一套 cookie/token 鉴权），不自己开裸 HTTP 端口 |
| 写操作 | 必须 `POST` + `application/json` + `confirm:true`；`package` 只能是 `listBundles()` 里真实存在的受管 Git 依赖 |
| 自身保护 | `ownPackage` 命中时 `SELF_UPDATE`（409），列表标 `self`，按钮禁用 |
| 凭据 | 探测只用本机 git 配置；不读、不写、不转发任何 token；状态文件不含带凭据 URL |
| 命令注入 | 只调用 `git`，参数数组传参（不拼 shell），ref/URL 来自 profile 声明 |
| 交互劫持 | 禁 askpass/终端提示，超时杀进程组；sshd/代理卡住不会挂起宿主 |
| 破坏性 | 更新前记录原 commit；失败/取消自动回滚；期间插件短暂不可用，已在说明中写明 |

## 10. 测试与验证

### 10.1 单测（`node --test "test/*.test.js"`，106 个全过）

| 文件 | 覆盖 |
| --- | --- |
| `test/git-source.test.js` | 简写/分支/commit/https/scp/ssh/GitLab 子组；registry/`link:`/tarball/路径一律拒绝；`pinnedSpec` |
| `test/lockfile.test.js` | importers 解析、codeload URL、peer 后缀、`git+ssh#ref`、缺失条目 |
| `test/probe.test.js` | ref 匹配、失败分类、环境加固、本地 bare 仓库的真实 `git ls-remote`、真实超时 |
| `test/state.test.js` | 缺失/损坏/版本不符、0600、原子写、启动对账 |
| `test/update.test.js` | 成功路径、`pinCommits:false`、安装失败/校验失败回滚、卸载失败不回滚、取消后重装旧版本 |
| `test/jobs.test.js` | 四步状态、每步耗时、50 条日志上限、取消、单任务、留存窗口 |
| `test/sticky.test.js` | 粘性行合并、实时行优先、无快照不造行、结果裁剪 |
| `test/sticky-service.test.js` | **卸载期间行仍在**、安装日志进入任务、回滚失败保留行、自身保护、四步耗时 |
| `test/service.test.js` | 非 Git 过滤、检查落状态、探测失败、更新全流程、并发、取消 |
| `test/route.test.js` | GET/POST/job、confirm 校验、content-type、413、405、错误码（含 `SELF_UPDATE`） |
| `test/client.test.js` | 格式化、汇总、步骤条、阶段判断、字典同步/占位符、`mergeViews`、compare 链接 |

### 10.2 真机验证（本 profile）

| 项 | 证据 |
| --- | --- |
| 宿主挂载 | 日志 `[git-updates] 已挂载 /api/dsh-git-updates（profile: …）`，无 error/warn |
| 设置页入口 | 设置左侧出现「插件更新」，列表恰好 6 个 Git 来源插件 |
| 检查 | `dsh-quick-keys` / `dsh-quota-widget` / `dsh-codex-connect` 显示已最新；其余显示有更新；`@local/wechat-worklog` 走 SSH 回退成功 |
| 真实更新 | `dsh-delete-session` 从 `90a765f`（0.3.2）更新到 `53671e4`（0.5.1），`package.json` 钉到 `#53671e4`、lockfile codeload sha 同步，状态文件 `lastUpdate.verified:true` |
| 私有仓库 | `@local/wechat-worklog` 通过本机 SSH 以 `@local/wechat-worklog@git+ssh://…` 安装到 `dsh-plugin` 分支的 `f0e2a5e`（0.2.3）；`probeRefs` 实测能反查出 `dsh-plugin`，不会更新到 `main` 的 `1fa69ca` |
| 卸载期间行不消失 | 更新进行中每 250ms 轮询一次：`article.gu-row` 从未缺失；宿主列表同时返回 `sticky:true`；四步（检查/卸载/安装/校验）与实时日志都在，`已回滚` 未出现 |
| 无控制台错误 | 整个「打开设置 → 检查 → 更新 → 完成」过程 `console error` / `pageerror` 均为 0 |

### 10.3 未验证 / 如实记录

- **真实回滚演练**：没有为了测试而故意让线上插件安装失败；回滚路径由单测（假 manager + 临时 profile 文件）覆盖。
- **视觉像素级比对**：没有浏览器控制权，按设置页/`Button.module.css` 的规格复刻，需人工看一次实际页面。
- **Windows 路径/进程组**：`kill(-pid)` 分支仅 POSIX 生效，未在本机验证。

## 11. 已知限制与风险

1. **更新后必须重启 DSH**：宿主 JS 不会热替换（浏览器侧还要刷新页面）。
2. **更新期间插件短暂卸载**：HMR 下 `installBundle` 拒绝覆盖已装包，只能先卸后装；重装会把 bundle 重新追加到 `dsh.profile.bundles` 末尾，可能改变配置优先级（宿主既有行为）。
3. **粘性行只在宿主内存里**：宿主进程重启后，未装回来的插件那一行会消失（这是真实状态）。
4. **不预检兼容性**：不联网读目标 commit 的 `package.json`，靠「装后校验 + 自动回滚」兜底。
5. **默认钉 commit 会改写依赖声明**；想要分支跟随需 `pinCommits: false`（代价是回滚不精确）。
6. **上游「落后 vs 回退」分不清**：`git ls-remote` 不带历史，只判断「不同」，页面用中立措辞并给 compare 链接。
7. **私有仓库依赖本机凭据**：HTTPS token 或 SSH key，二者皆无时只能报「无法检查」。
8. **不自我更新**：本工具若以 Git 来源出现，只提示到插件页更新，否则卸载自身会让设置页与路由一起消失。
9. **并行更新的排队**：宿主用 profile 写锁把真正的 pnpm/卸载/安装串行执行，并行只保证各行进度与回滚互不阻塞；同时更新很多插件时后面的任务会等在锁上。
10. **钉 commit 后可能丢失分支**：已装 commit 不再等于任何分支尖端时无法自动反查，需要 `trackedRefs` 显式指定；否则退回按远端 HEAD 判断（可能把仓库默认分支误当成插件分支）。
11. **pnpm 别名限制**：Git 依赖一律用「包名@地址」显式安装；其它工具若直接 `pnpm add github:owner/repo#sha` 仍可能触发 pnpm 11 的 alias 报错。
9. **多 profile**：状态文件按 profile 隔离；插件本身也只服务当前 profile。

## 12. 后续可做的事

- 批量更新：在列表页顺序更新多个插件，结束时汇总。
- 更新摘要：读 `git log`/CHANGELOG（`git fetch --depth`）展示变更条目。
- 一键回滚：把 `lastUpdate.from` 里的旧 commit 变成「回滚到 `<sha>`」按钮。
- 支持 `link:` 本地克隆：检测 git 仓库、`status -sb`、`pull --ff-only`，脏工作区拒绝。
- 视觉回归：接入浏览器自动化后对设置页截图比对。

## 13. 附录

### A. 文件地图

```
dsh-git-updates/
├── package.json           # exports / dsh.bundle.patch / dsh.client
├── cordis.patch.yml       # 插入行 id=git-updates
├── index.js               # 宿主挂载、事件订阅、路由注册、后台巡检
├── client.js              # 浏览器半侧：设置页一栏 + 状态仓库 + 样式 + 纯函数
├── lib/config.js          # 配置归一
├── lib/git-source.js      # spec → 仓库/ref/pinned
├── lib/lockfile.js        # lockfile → 已装 commit
├── lib/probe.js           # git ls-remote 探测（HTTPS→SSH）
├── lib/inventory.js       # bundle + lockfile + state → 视图
├── lib/sticky.js          # 实时行 + 任务快照 → 卸载期间行不消失
├── lib/service.js         # 视图/检查/更新/任务/取消
├── lib/update.js          # remove→install→verify→restore
├── lib/jobs.js            # 四步任务、耗时、日志
├── lib/state.js           # .git-updates/state.json
├── lib/route.js           # HTTP 外壳与错误映射
├── locale/{zh,en}.json    # meta.title / meta.description
├── docs/DETAIL.md         # 插件详情页文档
├── docs/DESIGN.md         # 本文档
├── icon.svg
└── test/*.test.js         # 106 个单测
```

### B. 安装与观察

```sh
# 安装（本地开发用 link:）
plugin_manager install_bundle  target="link:/home/my/Downloads/dsh-git-updates"

# 观察运行
grep -h "git-updates" ~/.dsh/logs/*.jsonl | tail
cat /home/my/.dsh/profiles/desktop/.git-updates/state.json

# 单测
cd /home/my/Downloads/dsh-git-updates && node --test "test/*.test.js"
```

### C. 术语

| 词 | 含义 |
| --- | --- |
| 受管包 | `listBundles()` 里 `installed && availability==='profile' && !official && !readOnlyReason` 且来源能解析成 Git 的依赖 |
| 已装 commit | `pnpm-lock.yaml` 记录的该依赖解析结果 |
| 跟踪 ref | 保存 spec 的 fragment（分支/标签）；缺省时用远端 `HEAD` |
| 钉 commit | 依赖声明写成 `<base>#<40 位 sha>` |
| 回滚 | 把旧 commit 对应的 spec 重新装回，并恢复原启用状态 |
| 粘性行 | 包被卸载、实时列表里没有了，但任务还在跑（或刚结束）时，用快照补回来的那一行 |
