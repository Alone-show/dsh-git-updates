# Git 插件更新

在设置页的「插件更新」一栏里，检查并更新从 GitHub / Git 安装的插件：显示已装 commit 与上游最新 commit，一键更新到上游，过程有步骤条、耗时和日志；**卸载期间那一行不会消失**，失败自动回滚。

## 入口

只在 **设置 → 插件更新**（`settings.section`，id `plugin-updates`）出现；插件详情页、插件页标签和全局浮层不再添加任何控件。

## 功能

- **只认 Git 来源**：`github:owner/repo`、`github:owner/repo#branch`、`git+https://…`、`git@host:owner/repo`。registry 包、tarball、`link:` 本地克隆不显示任何行。
- **上游怎么读**：本机 `git ls-remote` 读跟踪 ref（没写分支就读远端 `HEAD`）。子进程禁掉一切交互（`GIT_TERMINAL_PROMPT=0`、清空 askpass、`SSH_ASKPASS_REQUIRE=never`），只用本机配置，不会弹窗要用户名/密码。HTTPS 被挡住（凭据失败，或 GitHub 对私有仓库匿名返回的 `Repository not found.`）时按配置改试 SSH；已确认只能走 SSH 的仓库之后直接先走 SSH。不 fetch 仓库、不调 GitHub API、不发 token。
- **已装 commit 从哪来**：`<profile>/pnpm-lock.yaml` 里 pnpm 记录的 codeload tarball 地址（也兼容 `git+ssh://…#<sha>` 与 peer 后缀）。
- **跟踪分支**：spec 里有分支就用它；被钉成 commit 后用已装 commit 反查哪个分支的尖端是它（`git ls-remote --symref`），学到后持久化；分支已前进对不上时可用 `trackedRefs` 配置显式指定，避免把仓库默认分支误当插件分支。
- **私有仓库**：锁文件解析到 `git+ssh`、或任何一次探测/更新确认过只能走 SSH（状态里粘性的 `transport: ssh`）时，安装改用本机 SSH key，并以「包名@`git+ssh://…`」形式交给 pnpm，避开 pnpm 11 的 `ERR_PNPM_INVALID_DEPENDENCY_NAME` 与 HTTPS 凭据提示。
- **更新怎么做**：确认态里看到的目标 commit 会随 POST 回传（`targetCommit`），宿主直接装这个 commit、不再重新探测，所以确认后立刻进入步骤条；随后卸载 → 安装目标 commit → 校验（锁文件 commit、包名、`dsh.bundle.patch`）→ 失败或取消时把原 spec 装回去。默认钉到具体 commit（`#<sha>`），回滚可精确复原；可用 `pinCommits: false` 改为分支跟随。
- **行不消失**：包被卸载后会从 `listBundles()` 消失；宿主在任务开跑前保存该行快照，列表接口把「实时行 + 任务快照」合并返回（`sticky: true`），页面照常显示进度；前端再保留 5 秒兜底，避免轮询闪烁。回滚失败时也保留该行并标「未安装」。
- **过程可见**：任务视图带固定四步（检查上游/卸载/安装/校验）、每步状态与耗时、整体耗时、带时间戳的日志；页面画成步骤条 + 可展开日志，行内按钮显示当前步骤。安装阶段还会把宿主 `plugin-manager/install-log` / `install-state` 的实时输出写进日志。
- **结果持久**：成功/失败、`restartReason` 与「待重启」写进状态文件；需要重启时横幅在**刷新页面后依然存在**，宿主重启后由启动对账清掉。
- **检查不阻塞**：首次打开自动检查未检查/过期行（最多 3 行并行）；「全部检查」也是并行。某行查完即可更新，不需要等整批；检查期间其它行照常操作。
- **并行更新**：不同插件可同时更新（默认上限 3，`maxConcurrentUpdates`），每行独立的四步进度、日志和「取消更新」；同一个插件仍只允许一个任务。宿主用 profile 写锁把 pnpm 操作串起来，因此并行不会写坏 profile。取消按 `jobId` 只停那一行。
- **本工具不自我更新**：自身若以 Git 来源出现，那一行只给提示，请到插件页更新。

## 后台巡检

默认关闭（`backgroundCheckMs: 0`），因为设置页打开时会自行检查。显式配置后，宿主在启动 `backgroundCheckStartMs`（默认 1 分钟）后做第一次巡检，之后每 `backgroundCheckMs` 一次：对每个受管 Git 插件串行 `git ls-remote`，结果写状态文件；有更新任务在跑或上一次巡检还没结束时跳过。

## 数据面

宿主半侧注册同源路由 `GET/POST /api/dsh-git-updates`：

| 请求 | 作用 |
| --- | --- |
| `GET`（不带 package） | 全部受管包的视图 + `activeJob`；每行可能带 `job` 进度摘要、`sticky`/`installedMissing`、`self` |
| `GET ?package=<name>` | 读缓存视图（已装/上游 commit、上次检查、上次更新、待重启、`check.stale`；读不到已装 commit 时 `check.state: "unknown"` 且 `error.kind: "no-commit"`） |
| `GET ?package=<name>&probe=1[&force=1]` | 读视图并向上游探测一次 |
| `GET ?jobId=<id>` | 读更新任务：`steps`（含每步 `durationMs/status`）、`logs`、`elapsedMs` |
| `GET` 返回的 `activeJobs` | 所有正在跑的任务摘要（每行按 `job` 取自己的那个） |
| `POST {action:"check", package, force}` | 强制检查上游 |
| `POST {action:"update", package, confirm:true, expectedCommit, targetCommit}` | 起更新任务；`targetCommit` 是确认态里的目标，给出时跳过重新探测 |
| `POST {action:"cancel", confirm:true, jobId, package?}` | 只取消指定的更新任务 |

`package` 必须是插件管理器里真实存在的受管包；POST 要求 JSON 与 `confirm:true`。错误码：`SELF_UPDATE / STALE_VIEW / ALREADY_LATEST / UNKNOWN_INSTALLED_COMMIT / JOB_RUNNING` → 409，`NOT_FOUND / NOT_MANAGED` → 404，`CHECK_FAILED` → 502。

## 状态

`<profile>/.git-updates/state.json`（0600，原子写）只记上次检查/上次更新/待重启，以及每个包该走哪种传输的 `transport`（`https` / `ssh`），不含凭据。待重启条目带宿主进程标识（pid + 进程启动时刻），下一个宿主进程启动时清掉并记 `lastUpdate.restartedAt`。
