/**
 * dsh-git-updates —— 浏览器半侧（手写 __ModuleLoader__ 包，不经构建）。
 *
 * 只在「设置」里出现：注册一个 `settings.section`（左侧导航「插件更新」）
 * 和一个对应图标，正文是一份 Git 来源插件的列表：
 *
 *   · 每一行：仓库、已装 commit → 上游 commit、上次检查、状态徽标；
 *   · 检查更新 / 全部检查：逐行探测上游（宿主侧走 git ls-remote）；
 *   · 更新到 <sha>：二次确认后交给宿主「卸载 → 安装 → 校验」；
 *   · 进度：四步状态条 + 每步耗时 + 实时日志 + 结果横幅，可取消；
 *   · 插件名可点击：关闭设置并跳到该插件的详情页；
 *   · 关闭/切走设置后丢弃已完成任务的日志（运行中任务保留）；
 *   · 卸载期间那一行不会消失：宿主用任务快照补行，前端再留 5s 兜底。
 *
 * 不在插件详情页、插件页标签或全局浮层添加任何控件。
 */

window.__ModuleLoader__.load({
  id: 'dsh-git-updates',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useState = React.useState;

    /** 本插件的 locale 命名空间。 */
    const NS = 'git-updates';
    /** 与宿主 lib/route.js 的 ROUTE_PATH 一致。 */
    const ENDPOINT = '/api/dsh-git-updates';
    /** 有任务/检查时的轮询间隔。 */
    const POLL_BUSY_MS = 900;
    /** 空闲时的轮询间隔（只读本机路由，不发网络请求）。 */
    const POLL_IDLE_MS = 15000;
    /** 同时检查几行（检查是只读探测，互不阻塞）。 */
    const CHECK_CONCURRENCY = 3;
    /** 二次确认的有效时间。 */
    const CONFIRM_MS = 8000;
    /** 前端兜底：列表里暂时缺失的行再保留多久。 */
    const CLIENT_STICKY_MS = 5000;
    /** 离开设置页后，延迟多久清日志；避开同一次关闭里的重挂载抖动。 */
    const LOGS_CLEAR_DELAY_MS = 200;
    /** 步骤顺序；与宿主 lib/jobs.js 的 STEP_SEQUENCE 一致。 */
    const STEP_SEQUENCE = ['checking', 'removing', 'installing', 'verifying'];

    const zh = {
      'nav.label': '插件更新',
      'page.title': 'Git 插件更新',
      'page.intro': '列出从 GitHub / Git 安装的插件，检查上游并更新到最新 commit。更新会短暂卸载插件，失败或取消会自动装回原版本。',
      'page.empty': '没有从 Git 安装的插件。',
      'page.loading': '正在读取插件列表…',
      'page.unavailable': '无法读取更新服务（宿主路由不可用）。',
      'page.retry': '重试',
      'page.checkAll': '全部检查',
      'page.checkingProgress': '正在检查 {done}/{total}',
      'page.checkingCount': '正在检查 {count} 个',
      'summary.updatingCount': '正在更新 {count} 个',
      'summary.behind': '{count} 个有更新',
      'summary.pending': '{count} 个待重启',
      'summary.allCurrent': '全部已是最新',
      'summary.busy': '正在更新 {name}',
      'action.check': '检查更新',
      'action.checking': '检查中…',
      'action.updateTo': '更新到 {commit}',
      'action.confirm': '确认更新到 {commit}',
      'action.confirmHint': '再点一次确认',
      'action.cancelUpdate': '取消更新',
      'action.cancelling': '正在取消…',
      'action.busy': '更新中…',
      'action.busyStep': '{step}…',
      'action.reload': '刷新页面',
      'action.openDetail': '查看插件详情',
      'action.openLogs': '日志（{count} 条）',
      'action.closeLogs': '收起日志',
      'state.checking': '检查中',
      'state.current': '已是最新',
      'state.behind': '有更新',
      'state.unknown': '无法检查',
      'state.pendingRestart': '待重启',
      'state.missing': '未安装',
      'state.self': '本工具',
      'state.busy': '更新中',
      'state.noCommit': 'commit 未知',
      'state.pinned': '已钉 commit',
      'state.branch': '跟随 {ref}',
      'section.repository': '仓库',
      'section.installed': '已装',
      'section.latest': '上游',
      'section.checkedAt': '上次检查',
      'section.never': '尚未检查',
      'section.compare': '查看差异',
      'step.checking': '检查上游',
      'step.removing': '卸载原版本',
      'step.installing': '安装目标版本',
      'step.verifying': '校验安装结果',
      'step.pending': '待执行',
      'step.running': '运行中',
      'step.done': '已完成',
      'step.failed': '失败',
      'progress.elapsed': '用时 {time}',
      'progress.logs': '详情',
      'progress.target': '目标 {commit}',
      'result.applied': '已更新到 {commit}，已生效。',
      'result.restart': '已更新到 {commit}，重启 DSH 后生效。',
      'result.restartHint': '① 保存当前工作；② 退出并重新启动 DSH；③ 回来刷新页面。只刷新页面不会加载新代码。',
      'result.failed': '更新失败：{reason}',
      'result.failedRestored': '已回滚到更新前的版本（{commit}）。',
      'result.failedRestoreFailed': '回滚也失败了：该插件当前未安装，请到插件页重新安装。',
      'result.cancelled': '已取消，已恢复更新前的版本。',
      'result.cancelledNoRestore': '已取消。',
      'result.verifyFailed': '安装结果校验未通过。',
      'err.notManaged': '这个包不是本工具管理的 Git 依赖',
      'err.unknownCommit': '读不到已安装的 commit，可先在插件页重装该插件',
      'err.staleView': '已安装的版本已经变化，请重新检查后再更新',
      'err.alreadyLatest': '已经是最新 commit',
      'err.checkFailed': '检查上游失败',
      'err.jobRunning': '另一个更新正在进行',
      'err.selfUpdate': '不能在自身页面更新本工具，请到插件页处理',
      'err.noCommit': '读不到已安装的 commit',
      'err.auth': '没有通过仓库认证（需要本机 git 凭据）',
      'err.timeout': '探测上游超时',
      'err.network': '网络不可达',
      'err.notFound': '插件不存在或已被卸载',
      'reason.no-hmr': '没有 HMR，重启后生效',
      'reason.host-module': '宿主模块需要重启才能换新',
      'reason.module-comparison': '模块内容变化，重启后加载',
      'reason.package-moved': '包位置变化，重启后生效',
      'self.hint': '本工具自身的更新请到插件页执行。',
      'update.otherRunning': '另一个更新正在进行，稍后再试。',
      'meta.version': '版本 {version}',
    };

    const en = {
      'nav.label': 'Plugin updates',
      'page.title': 'Git plugin updates',
      'page.intro': 'Lists plugins installed from GitHub / Git, checks upstream, and updates them to the latest commit. Updating briefly uninstalls the plugin; a failure or cancellation restores the previous version.',
      'page.empty': 'No plugins are installed from Git.',
      'page.loading': 'Reading the plugin list…',
      'page.unavailable': 'The update service is unavailable (host route missing).',
      'page.retry': 'Retry',
      'page.checkAll': 'Check all',
      'page.checkingProgress': 'Checking {done}/{total}',
      'page.checkingCount': 'Checking {count}',
      'summary.updatingCount': 'Updating {count}',
      'summary.behind': '{count} update(s) available',
      'summary.pending': '{count} waiting for restart',
      'summary.allCurrent': 'All up to date',
      'summary.busy': 'Updating {name}',
      'action.check': 'Check for updates',
      'action.checking': 'Checking…',
      'action.updateTo': 'Update to {commit}',
      'action.confirm': 'Confirm update to {commit}',
      'action.confirmHint': 'Click again to confirm',
      'action.cancelUpdate': 'Cancel update',
      'action.cancelling': 'Cancelling…',
      'action.busy': 'Updating…',
      'action.busyStep': '{step}…',
      'action.reload': 'Reload page',
      'action.openDetail': 'Open plugin details',
      'action.openLogs': 'Logs ({count})',
      'action.closeLogs': 'Hide logs',
      'state.checking': 'Checking',
      'state.current': 'Up to date',
      'state.behind': 'Update available',
      'state.unknown': 'Cannot check',
      'state.pendingRestart': 'Restart pending',
      'state.missing': 'Not installed',
      'state.self': 'This tool',
      'state.busy': 'Updating',
      'state.noCommit': 'Commit unknown',
      'state.pinned': 'Pinned commit',
      'state.branch': 'Tracks {ref}',
      'section.repository': 'Repository',
      'section.installed': 'Installed',
      'section.latest': 'Upstream',
      'section.checkedAt': 'Last checked',
      'section.never': 'Never checked',
      'section.compare': 'Compare',
      'step.checking': 'Check upstream',
      'step.removing': 'Uninstall current',
      'step.installing': 'Install target',
      'step.verifying': 'Verify install',
      'step.pending': 'Pending',
      'step.running': 'Running',
      'step.done': 'Done',
      'step.failed': 'Failed',
      'progress.elapsed': '{time} elapsed',
      'progress.logs': 'Details',
      'progress.target': 'Target {commit}',
      'result.applied': 'Updated to {commit}.',
      'result.restart': 'Updated to {commit}. Restart DSH to load it.',
      'result.restartHint': '① Save your work; ② quit and restart DSH; ③ come back and reload the page. Reloading alone does not load new code.',
      'result.failed': 'Update failed: {reason}',
      'result.failedRestored': 'Rolled back to the previous version ({commit}).',
      'result.failedRestoreFailed': 'The rollback also failed: the plugin is not installed. Reinstall it from the Plugins page.',
      'result.cancelled': 'Cancelled; the previous version was restored.',
      'result.cancelledNoRestore': 'Cancelled.',
      'result.verifyFailed': 'The installed result did not verify.',
      'err.notManaged': 'This package is not a Git dependency managed here',
      'err.unknownCommit': 'The installed commit cannot be read; reinstall the plugin from the Plugins page',
      'err.staleView': 'The installed version changed; check again before updating',
      'err.alreadyLatest': 'Already at the latest commit',
      'err.checkFailed': 'Checking upstream failed',
      'err.jobRunning': 'Another update is already running',
      'err.selfUpdate': 'This tool cannot update itself here; use the Plugins page',
      'err.noCommit': 'The installed commit cannot be read',
      'err.auth': 'Repository authentication failed (local git credentials required)',
      'err.timeout': 'Timed out probing upstream',
      'err.network': 'Network unreachable',
      'err.notFound': 'The plugin does not exist or was uninstalled',
      'reason.no-hmr': 'No HMR; takes effect after restart',
      'reason.host-module': 'Host modules need a restart',
      'reason.module-comparison': 'Module content changed; loads after restart',
      'reason.package-moved': 'Package location changed; takes effect after restart',
      'self.hint': 'Update this tool from the Plugins page.',
      'update.otherRunning': 'Another update is running; try again later.',
      'meta.version': 'Version {version}',
    };

    /**
     * 替换 `{name}` 占位符。
     * @param {string} template 文案。
     * @param {Record<string, unknown>} [params] 参数。
     * @returns {string} 结果。
     */
    function interpolate(template, params = {}) {
      return String(template).replace(/\{(\w+)\}/g, (all, key) => (
        params[key] === undefined || params[key] === null ? all : String(params[key])
      ));
    }

    /**
     * 毫秒 → `1.5s` / `1m 05s`。
     * @param {unknown} ms 毫秒。
     * @returns {string} 文本；非法值返回空串。
     */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
      const seconds = ms / 1000;
      if (seconds < 60) return `${seconds.toFixed(1)}s`;
      const minutes = Math.floor(seconds / 60);
      const rest = Math.round(seconds - minutes * 60);
      return `${minutes}m ${String(rest).padStart(2, '0')}s`;
    }

    /**
     * ISO 时间 → 本地 `HH:MM:SS`。
     * @param {unknown} iso ISO 字符串。
     * @returns {string} 文本。
     */
    function formatClock(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const parsed = Date.parse(iso);
      if (!Number.isFinite(parsed)) return '';
      return new Date(parsed).toTimeString().slice(0, 8);
    }

    /**
     * ISO 时间 → 本地 `YYYY-MM-DD HH:mm`。
     * @param {unknown} iso ISO 字符串。
     * @returns {string} 文本。
     */
    function formatDate(iso) {
      if (iso === undefined || iso === null || iso === '') return '—';
      const parsed = Date.parse(String(iso));
      if (!Number.isFinite(parsed)) return String(iso);
      const date = new Date(parsed);
      const pad = value => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /**
     * 取 commit 前 7 位。
     * @param {unknown} commit 完整 sha。
     * @returns {string} 短 sha。
     */
    function short(commit) {
      if (typeof commit !== 'string' || commit === '') return '—';
      return commit.length > 7 ? commit.slice(0, 7) : commit;
    }

    /**
     * 汇总列表状态，供页首文案使用。
     * @param {any[]} views 列表。
     * @param {any[] | any} [activeJobs] 正在跑的任务（也兼容传单个任务）。
     * @returns {{ behind: string[], pending: string[], total: number, active: Array<string | null> }} 汇总。
     */
    function summarize(views, activeJobs = []) {
      const behind = [];
      const pending = [];
      for (const view of Array.isArray(views) ? views : []) {
        if (view?.check?.state === 'behind') behind.push(view.package);
        if (view?.pendingRestart !== undefined && view?.pendingRestart !== null) pending.push(view.package);
      }
      const total = new Set([...behind, ...pending]).size;
      const jobs = Array.isArray(activeJobs) ? activeJobs : (activeJobs === null || activeJobs === undefined ? [] : [activeJobs]);
      return { behind, pending, total, active: jobs.map(job => job?.package ?? job?.packageName ?? null) };
    }

    /**
     * 一行能做什么：只看这一行自己的状态，不受其它行检查/更新的影响。
     * @param {any} view 行。
     * @param {{ checking?: boolean }} [local] 这一行是否正在检查。
     * @returns {{ canCheck: boolean, canUpdate: boolean, canCancel: boolean }} 能力。
     */
    function rowActions(view, local = {}) {
      const job = view?.job;
      const running = job?.status === 'running' || job?.status === 'cancelling';
      const checking = local.checking === true;
      const missing = view?.installedMissing === true;
      return {
        canCheck: !checking && !running && !missing,
        canUpdate: !checking && !running && !missing && view?.self !== true
          && view?.check?.state === 'behind'
          && typeof view?.installed?.commit === 'string',
        canCancel: running,
      };
    }

    /**
     * 四步状态条的数据。
     * @param {any} job 任务。
     * @param {(key: string, params?: any) => string} t 翻译函数。
     * @returns {Array<{ step: string, label: string, status: string, duration: string }>} 行。
     */
    function stepRows(job, t) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      return STEP_SEQUENCE.map(step => {
        const found = steps.find(item => item.step === step);
        const status = found?.status ?? (job?.status === 'done' ? 'done' : 'pending');
        return {
          step,
          label: t(`step.${step}`),
          status,
          duration: typeof found?.durationMs === 'number' && found.durationMs > 0 ? formatDuration(found.durationMs) : '',
        };
      });
    }

    /**
     * 一行的展示阶段。
     * @param {{ phase: string, view: any, job: any }} input 输入。
     * @returns {'loading'|'busy'|'behind'|'current'|'hidden'|'error'} 阶段。
     */
    function phaseOf(input) {
      const { phase, view, job } = input;
      if (phase === 'loading' || phase === 'idle') return 'loading';
      if (phase === 'error') return 'error';
      if (job?.status === 'running' || job?.status === 'cancelling' || phase === 'updating') return 'busy';
      if (view?.applicable === false) return 'hidden';
      if (view?.check?.state === 'behind') return 'behind';
      if (view?.check?.state === 'current') return 'current';
      return 'current';
    }

    /**
     * 重启原因码 → 文案；未知码不显示。
     * @param {unknown} code 原因码。
     * @param {(key: string) => string} t 翻译函数。
     * @returns {string} 文本。
     */
    function restartReasonText(code, t) {
      const keys = {
        'no-hmr': 'reason.no-hmr',
        'host-module': 'reason.host-module',
        'module-comparison': 'reason.module-comparison',
        'package-moved': 'reason.package-moved',
      };
      const key = keys[code];
      return key === undefined ? '' : t(key, {});
    }

    /**
     * 更新中按钮文案：当前步骤 + 省略号。
     * @param {any} job 任务。
     * @param {(key: string, params?: any) => string} t 翻译函数。
     * @returns {string} 文本。
     */
    function busyLabel(job, t) {
      if (job !== null && job !== undefined && STEP_SEQUENCE.includes(job.step)) {
        return t('action.busyStep', { step: t(`step.${job.step}`) });
      }
      return t('action.busy');
    }

    /**
     * 错误码 → 可读文案；未知码原样返回宿主消息。
     * @param {unknown} code 错误码。
     * @param {unknown} message 宿主消息。
     * @param {(key: string, params?: any) => string} t 翻译函数。
     * @returns {string} 文本。
     */
    function errorText(code, message, t) {
      const keys = {
        NOT_MANAGED: 'err.notManaged',
        UNKNOWN_INSTALLED_COMMIT: 'err.unknownCommit',
        STALE_VIEW: 'err.staleView',
        ALREADY_LATEST: 'err.alreadyLatest',
        CHECK_FAILED: 'err.checkFailed',
        JOB_RUNNING: 'err.jobRunning',
        SELF_UPDATE: 'err.selfUpdate',
        'no-commit': 'err.noCommit',
        auth: 'err.auth',
        timeout: 'err.timeout',
        network: 'err.network',
        NOT_FOUND: 'err.notFound',
      };
      const key = keys[code];
      if (key !== undefined) return t(key, {});
      return typeof message === 'string' && message !== '' ? message : String(code ?? '');
    }

    /**
     * 合并上一次与本次的列表：正在更新的行不会因为一次轮询缺失就消失。
     * @param {any[]} previous 上一次的行（带 `__seenAt`）。
     * @param {any[]} incoming 本次的行。
     * @param {number} [now] 当前时间。
     * @returns {any[]} 合并后的行。
     */
    function mergeViews(previous, incoming, now = Date.now()) {
      const fresh = Array.isArray(incoming) ? incoming : [];
      const names = new Set(fresh.map(view => view.package));
      const rows = fresh.map(view => ({ ...view, __seenAt: now }));
      for (const view of Array.isArray(previous) ? previous : []) {
        if (view === null || typeof view !== 'object' || names.has(view.package)) continue;
        const running = view.job?.status === 'running' || view.job?.status === 'cancelling';
        const seenAt = typeof view.__seenAt === 'number' ? view.__seenAt : now;
        if (running || now - seenAt <= CLIENT_STICKY_MS) rows.push({ ...view, __seenAt: seenAt });
      }
      return rows.sort((left, right) => String(left.package).localeCompare(String(right.package)));
    }

    /**
     * 本地化一个可能带翻译的标题。
     * @param {(text: any) => string} resolveText locale 服务。
     * @param {unknown} value bundle.meta.title。
     * @param {string} fallback 回退。
     * @returns {string} 文本。
     */
    function textOf(resolveText, value, fallback) {
      if (value === undefined || value === null) return fallback;
      try {
        const text = resolveText(value);
        return typeof text === 'string' && text !== '' ? text : fallback;
      } catch {
        return fallback;
      }
    }

    /**
     * 点击插件名：打开插件详情页，成功后才关闭设置弹层。
     * @param {{ openBundle?: (name: string) => boolean, close?: () => void }} props 注入面 + owner props。
     * @param {unknown} packageName 包名。
     * @returns {boolean} 是否真的发起了跳转。
     */
    function openBundleDetail(props, packageName) {
      if (typeof packageName !== 'string' || packageName === '') return false;
      if (typeof props?.openBundle !== 'function') return false;
      let opened = false;
      try {
        opened = props.openBundle(packageName) === true;
      } catch {
        opened = false;
      }
      if (!opened) return false;
      if (typeof props.close === 'function') props.close();
      return true;
    }

    /**
     * GitHub 比较链接；其它宿主不生成。
     * @param {any} view 行。
     * @returns {string | undefined} 链接。
     */
    function compareHref(view) {
      if (view?.host !== 'github.com') return undefined;
      const installed = view.installed?.commit;
      const latest = view.check?.latest;
      if (installed === undefined || latest === undefined) return undefined;
      if (typeof view.repository !== 'string' || view.repository === '') return undefined;
      return `https://github.com/${view.repository}/compare/${installed}...${latest}`;
    }

    /**
     * 运行中任务的实时耗时：轮询间隔内也能走秒。
     * @param {any} job 任务摘要。
     * @param {number} now 当前时间。
     * @returns {number} 毫秒。
     */
    function liveElapsed(job, now) {
      if (job === null || job === undefined) return 0;
      if ((job.status === 'running' || job.status === 'cancelling') && typeof job.startedAt === 'string') {
        const started = Date.parse(job.startedAt);
        if (Number.isFinite(started)) return Math.max(0, now - started);
      }
      return typeof job.elapsedMs === 'number' ? job.elapsedMs : 0;
    }

    /** 设置页样式；随组件挂载/卸载，其它页面不受影响。 */
    const CSS = `
      .gu-page { display: grid; gap: 16px; padding: 4px 2px 8px; color: var(--dsw-alias-label-primary); }
      .gu-head { display: grid; gap: 6px; }
      .gu-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
      .gu-intro { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-tertiary); }
      .gu-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
      .gu-summary { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
      /* 按钮复制 DSH 原生 Button（Button.module.css）的 .button + .sm 规格与变体。 */
      .gu-btn {
        box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
        gap: 4px; border: none; border-radius: var(--dsw-radius-sm, 8px); cursor: pointer;
        height: 28px; padding: 0 10px; font-size: 12px; line-height: 18px;
        background: transparent; color: var(--dsw-alias-label-primary);
      }
      .gu-btn:disabled { cursor: not-allowed; opacity: .4; }
      @media (hover: hover) {
        .gu-btn.gu-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
        .gu-btn.gu-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
        .gu-btn.gu-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      }
      .gu-btn.gu-ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
      .gu-btn.gu-outline {
        border: .5px solid transparent;
        box-shadow: inset 0 0 0 var(--dsh-hairline-width, .5px) var(--dsh-button-outline-color, var(--dsw-alias-border-l3));
      }
      .gu-btn.gu-primary {
        background: var(--dsw-alias-button-primary-fill);
        color: var(--dsw-alias-label-primary-foreground);
      }
      .gu-btn.gu-armed {
        color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
        --dsh-button-outline-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);
      }
      .gu-icon { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; }
      .gu-icon svg { width: 13px; height: 13px; }
      .gu-list { display: grid; gap: 10px; }
      .gu-row {
        display: grid; gap: 10px; padding: 12px;
        border-radius: 10px;
        box-shadow: inset 0 0 0 var(--dsh-hairline-width, .5px) var(--dsw-alias-border-l3);
      }
      .gu-row-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; }
      .gu-name { font-size: 13.5px; font-weight: 600; }
      .gu-name-link {
        margin: 0; padding: 0; border: none; background: none;
        font-family: inherit; color: inherit; text-align: left; cursor: pointer;
      }
      @media (hover: hover) { .gu-name-link:hover { text-decoration: underline; text-underline-offset: 2px; } }
      .gu-name-link:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 2px; border-radius: 4px;
      }
      .gu-pkg { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .gu-badges { display: inline-flex; flex-wrap: wrap; gap: 4px; }
      .gu-badge { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
      .gu-badge.behind { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
      .gu-badge.current { color: var(--dsw-alias-state-success-primary, #16a34a); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 12%, transparent); }
      .gu-badge.error, .gu-badge.missing { color: var(--dsw-alias-state-error-primary, #dc2626); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 12%, transparent); }
      .gu-badge.busy { color: var(--dsw-alias-state-warn-primary); }
      .gu-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
      .gu-meta code { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .gu-link { color: var(--dsw-alias-label-secondary); text-decoration: underline; text-underline-offset: 2px; }
      .gu-row-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .gu-row-note { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
      .gu-row-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #dc2626); }
      .gu-job { display: grid; gap: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l3); }
      .gu-steps { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
      .gu-step { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
      .gu-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .45; }
      .gu-step[data-status="running"] { color: var(--dsw-alias-state-warn-primary); }
      .gu-step[data-status="running"] .gu-dot { opacity: 1; animation: gu-pulse 1.1s ease-in-out infinite; }
      .gu-step[data-status="done"] { color: var(--dsw-alias-label-secondary); }
      .gu-step[data-status="done"] .gu-dot { opacity: 1; }
      .gu-step[data-status="failed"] { color: var(--dsw-alias-state-error-primary, #dc2626); }
      .gu-step[data-status="failed"] .gu-dot { opacity: 1; }
      .gu-step-time { opacity: .7; }
      @keyframes gu-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
      .gu-job-line { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); align-items: center; }
      .gu-banner { font-size: 12px; line-height: 1.6; padding: 8px 10px; border-radius: 8px; }
      .gu-banner.ok { color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 10%, transparent); }
      .gu-banner.warn { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
      .gu-banner.error { color: var(--dsw-alias-state-error-primary, #dc2626); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 10%, transparent); }
      .gu-hint { font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
      .gu-logs { margin: 0; padding: 8px 10px; list-style: none; max-height: 170px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11px; line-height: 1.6; }
      .gu-logs li { white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-tertiary); }
      .gu-logs li[data-level="warn"] { color: var(--dsw-alias-state-warn-primary); }
      .gu-logs li[data-level="error"] { color: var(--dsw-alias-state-error-primary, #dc2626); }
      .gu-empty { font-size: 12.5px; color: var(--dsw-alias-label-tertiary); }
    `;

    /**
     * 一次同源 JSON 请求。
     * @param {'GET'|'POST'} method 方法。
     * @param {any} [body] JSON 体。
     * @returns {Promise<any>} 响应体。
     */
    async function request(method, body) {
      const init = { method, credentials: 'same-origin', headers: {} };
      if (method === 'POST') {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body ?? {});
      }
      const response = await fetch(ENDPOINT, init);
      let data;
      try {
        data = await response.json();
      } catch {
        data = undefined;
      }
      if (!response.ok || data?.ok !== true) {
        const error = new Error(data?.error?.message ?? `HTTP ${response.status}`);
        error.code = data?.error?.code ?? `HTTP_${response.status}`;
        throw error;
      }
      return data;
    }

    /** 离开设置页后延迟清日志的定时器；同一模块内新挂载会取消它。 */
    let clearLogsTimer = null;

    /** 取消待执行的日志清理。 */
    function cancelScheduledLogClear() {
      if (clearLogsTimer === null) return;
      clearTimeout(clearLogsTimer);
      clearLogsTimer = null;
    }

    /** 安排一次延迟清日志：只丢已完成任务的日志，失败静默。 */
    function scheduleLogClear() {
      cancelScheduledLogClear();
      clearLogsTimer = setTimeout(() => {
        clearLogsTimer = null;
        void request('POST', { action: 'clearLogs' }).catch(() => {});
      }, LOGS_CLEAR_DELAY_MS);
    }

    /** 一个内联图标。 */
    function Glyph(props) {
      const paths = props.paths;
      return h('span', { className: 'gu-icon', 'aria-hidden': 'true' },
        h('svg', {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }, paths.map((d, index) => h('path', { key: index, d }))));
    }

    const ICONS = {
      refresh: ['M13.5 8a5.5 5.5 0 1 1-1.6-3.9', 'M13.5 2.5v3.2h-3.2'],
      check: ['M3 8.5l3 3 7-7'],
      cancel: ['M4 4l8 8', 'M12 4l-8 8'],
      warn: ['M8 2.5l6 11H2z', 'M8 6.5v3', 'M8 11.5v.5'],
    };

    /**
     * 设置页的「插件更新」正文。
     * @param {any} props 插槽 props（t、注入的 resolveText/openBundle、owner 的 close）。
     * @returns {any} React 节点。
     */
    function PluginUpdatesSection(props) {
      const t = props.t;
      const resolveText = props.resolveText ?? (value => (typeof value === 'string' ? value : ''));
      const [phase, setPhase] = useState('loading');
      const [views, setViews] = useState([]);
      const [activeJobs, setActiveJobs] = useState([]);
      const [error, setError] = useState(null);
      const [checking, setChecking] = useState({});
      const [armed, setArmed] = useState(null);
      const [rowErrors, setRowErrors] = useState({});
      const [openLogs, setOpenLogs] = useState({});
      const [now, setNow] = useState(() => Date.now());
      const mounted = useRef(true);
      const armedTimer = useRef(null);
      const refreshRef = useRef(null);
      const autoChecked = useRef(false);

      /**
       * 读一次列表并把结果合进页面。
       * @returns {Promise<any | null>} 宿主响应。
       */
      const refresh = async () => {
        try {
          const data = await request('GET');
          if (mounted.current !== true) return data;
          const incoming = Array.isArray(data.packages) ? data.packages : [];
          setViews(previous => mergeViews(previous, incoming, Date.now()));
          setActiveJobs(Array.isArray(data.activeJobs) ? data.activeJobs : []);
          setPhase('ready');
          setError(null);
          return data;
        } catch (caught) {
          if (mounted.current !== true) return null;
          setError(caught);
          setPhase(previous => (previous === 'ready' ? previous : 'error'));
          return null;
        }
      };
      refreshRef.current = refresh;

      /**
       * 逐行检查上游；一行失败只影响那一行。
       * @param {string[]} names 包名。
       * @param {boolean} [force] 是否忽略缓存。
       * @returns {Promise<void>} 完成后返回。
       */
      const checkRows = async (names, force = true) => {
        const list = [...new Set((Array.isArray(names) ? names : []).filter(name => typeof name === 'string' && name !== ''))];
        if (list.length === 0) return;
        setChecking(previous => {
          const next = { ...previous };
          for (const name of list) next[name] = true;
          return next;
        });
        const queue = [...list];
        const worker = async () => {
          while (mounted.current === true) {
            const name = queue.shift();
            if (name === undefined) return;
            try {
              const data = await request('POST', { action: 'check', package: name, force });
              if (mounted.current === true && data?.package?.package !== undefined) {
                const checked = data.package;
                if (checked.applicable !== false) {
                  setViews(previous => previous.map(view => (
                    view.package === checked.package
                      ? { ...checked, job: view.job, __seenAt: Date.now() }
                      : view
                  )));
                }
              }
            } catch (caught) {
              if (mounted.current === true) {
                setRowErrors(previous => ({ ...previous, [name]: caught }));
              }
            } finally {
              if (mounted.current === true) {
                setChecking(previous => {
                  const next = { ...previous };
                  delete next[name];
                  return next;
                });
              }
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(CHECK_CONCURRENCY, list.length) }, () => worker()),
        );
      };

      /** 首次加载：取列表，把过期/未检查的行自动查一遍。 */
      const bootstrap = async () => {
        const data = await refresh();
        if (mounted.current !== true || autoChecked.current === true) return;
        autoChecked.current = true;
        const rows = Array.isArray(data?.packages) ? data.packages : [];
        const stale = rows
          .filter(view => view?.check === undefined || view.check.at === null || view.check.stale === true)
          .map(view => view.package);
        if (stale.length > 0) await checkRows(stale, false);
        await refresh();
      };

      useEffect(() => {
        mounted.current = true;
        // 上一次关闭设置的清理还没发出去就重新打开了：保留日志。
        cancelScheduledLogClear();
        const boot = async () => {
          // 先丢已完成任务的旧日志，再读列表，页面就不会闪一下旧日志。
          await request('POST', { action: 'clearLogs' }).catch(() => {});
          if (mounted.current !== true) return;
          await bootstrap();
        };
        void boot();
        return () => {
          mounted.current = false;
          if (armedTimer.current !== null) clearTimeout(armedTimer.current);
          // 关闭设置/切走这一页：已完成任务的日志不再保留。
          scheduleLogClear();
        };
        // 只在挂载时跑一次。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const checkingCount = Object.keys(checking).length;
      const busy = activeJobs.length > 0 || checkingCount > 0;

      useEffect(() => {
        const timer = setInterval(() => { void refreshRef.current?.(); }, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
        return () => clearInterval(timer);
      }, [busy]);

      useEffect(() => {
        if (activeJobs.length === 0) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [activeJobs.length > 0]);

      /**
       * 点一次「更新」：第一次进入确认态，8 秒内再点才真的更新。
       * @param {any} view 行。
       */
      const armOrUpdate = view => {
        const commit = view?.check?.latest;
        if (typeof commit !== 'string' || commit === '') return;
        if (armed !== null && armed.package === view.package && armed.commit === commit) {
          if (armedTimer.current !== null) clearTimeout(armedTimer.current);
          armedTimer.current = null;
          setArmed(null);
          void startUpdate(view, commit);
          return;
        }
        setArmed({ package: view.package, commit });
        if (armedTimer.current !== null) clearTimeout(armedTimer.current);
        armedTimer.current = setTimeout(() => {
          armedTimer.current = null;
          setArmed(null);
        }, CONFIRM_MS);
      };

      /**
       * 真正起一次更新。
       * @param {any} view 行。
       * @param {string} commit 目标 commit。
       * @returns {Promise<void>} 完成后返回。
       */
      const startUpdate = async (view, commit) => {
        setRowErrors(previous => {
          const next = { ...previous };
          delete next[view.package];
          return next;
        });
        try {
          const data = await request('POST', {
            action: 'update',
            package: view.package,
            confirm: true,
            expectedCommit: view.installed?.commit,
            targetCommit: commit,
          });
          if (mounted.current !== true) return;
          if (data?.job !== undefined && data.job !== null) {
            setActiveJobs(previous => [
              ...previous.filter(job => job.package !== data.job.package),
              data.job,
            ]);
            setViews(previous => previous.map(row => (
              row.package === view.package ? { ...row, job: data.job } : row
            )));
          }
          await refresh();
        } catch (caught) {
          if (mounted.current !== true) return;
          setRowErrors(previous => ({ ...previous, [view.package]: caught }));
          await refresh();
        }
      };

      /**
       * 取消某一行的更新；只停这一行的任务，不影响其它并行任务。
       * @param {any} job 该行的任务摘要。
       * @returns {Promise<void>} 完成后返回。
       */
      const cancelUpdate = async job => {
        try {
          await request('POST', {
            action: 'cancel',
            confirm: true,
            ...(typeof job?.id === 'string' ? { jobId: job.id } : {}),
            ...(typeof job?.package === 'string' ? { package: job.package } : {}),
          });
        } catch (caught) {
          setError(caught);
        }
        await refresh();
      };

      const summary = summarize(views, activeJobs);

      const header = h('header', { key: 'head', className: 'gu-head' }, [
        h('h2', { key: 'title', className: 'gu-title' }, t('page.title')),
        h('p', { key: 'intro', className: 'gu-intro' }, t('page.intro')),
      ]);

      const toolbar = h('div', { key: 'toolbar', className: 'gu-toolbar' }, [
        h('button', {
          key: 'checkAll',
          type: 'button',
          className: 'gu-btn gu-outline',
          disabled: phase !== 'ready' || views.length === 0,
          onClick: () => {
            const names = views
              .filter(view => view.job?.status !== 'running'
                && view.job?.status !== 'cancelling'
                && view.installedMissing !== true
                && checking[view.package] !== true)
              .map(view => view.package);
            void checkRows(names, true);
          },
        }, h(Glyph, { key: 'icon', paths: ICONS.refresh }), t('page.checkAll')),
        checkingCount > 0
          ? h('span', { key: 'checking', className: 'gu-summary' }, t('page.checkingCount', { count: String(checkingCount) }))
          : null,
        summary.active.length > 0
          ? h('span', { key: 'busy', className: 'gu-summary' }, t('summary.updatingCount', { count: String(summary.active.length) }))
          : null,
        summary.total === 0 && phase === 'ready' && views.length > 0
          ? h('span', { key: 'current', className: 'gu-summary' }, t('summary.allCurrent'))
          : h('span', { key: 'summary', className: 'gu-summary' }, [
            summary.behind.length > 0 ? t('summary.behind', { count: String(summary.behind.length) }) : '',
            summary.behind.length > 0 && summary.pending.length > 0 ? ' · ' : '',
            summary.pending.length > 0 ? t('summary.pending', { count: String(summary.pending.length) }) : '',
          ].filter(Boolean).join('')),
      ]);

      /** 一行里的任务进度。 */
      const renderJob = (view, job) => {
        const rows = stepRows(job, t);
        const elapsed = liveElapsed(job, now);
        const running = job.status === 'running' || job.status === 'cancelling';
        const logs = Array.isArray(job.logs) ? job.logs : [];
        const logsOpen = openLogs[view.package] === true;
        const shown = logsOpen ? logs : logs.slice(-5);
        const result = job.result;
        const cancelled = result?.error?.code === 'CANCELLED';
        const restored = result?.restore !== undefined;
        const restoreFailed = restored && (result.restore.application === 'failed' || result.restore.error !== undefined);
        let banner = null;
        if (running) {
          banner = h('div', { key: 'banner', className: 'gu-banner warn' }, [
            h('div', { key: 'msg' }, job.message ?? ''),
            h('div', { key: 'elapsed', className: 'gu-hint' }, t('progress.elapsed', { time: formatDuration(elapsed) })),
          ]);
        } else if (job.status === 'done' && result?.verified === true) {
          const commit = short(result.to?.commit);
          if (result.application === 'restart-required') {
            banner = h('div', { key: 'banner', className: 'gu-banner warn' }, [
              h('div', { key: 'msg' }, t('result.restart', { commit })),
              h('div', { key: 'hint', className: 'gu-hint' }, t('result.restartHint')),
              h('button', {
                key: 'reload',
                type: 'button',
                className: 'gu-btn gu-primary',
                style: { marginTop: '6px' },
                onClick: () => { globalThis.location?.reload?.(); },
              }, t('action.reload')),
            ]);
          } else {
            banner = h('div', { key: 'banner', className: 'gu-banner ok' }, t('result.applied', { commit }));
          }
        } else if (job.status === 'failed') {
          const reason = result?.error?.message ?? job.error?.message ?? t('result.verifyFailed');
          const children = [h('div', { key: 'msg' }, t('result.failed', { reason }))];
          if (cancelled) {
            children.push(h('div', { key: 'extra', className: 'gu-hint' }, restored && !restoreFailed
              ? t('result.cancelled')
              : t('result.cancelledNoRestore')));
          } else if (restored) {
            children.push(h('div', { key: 'extra', className: 'gu-hint' }, restoreFailed
              ? t('result.failedRestoreFailed')
              : t('result.failedRestored', { commit: short(result.from?.commit) })));
          }
          banner = h('div', { key: 'banner', className: 'gu-banner error' }, children);
        }
        return h('div', { key: 'job', className: 'gu-job' }, [
          h('ul', { key: 'steps', className: 'gu-steps' }, rows.map(row => h('li', {
            key: row.step,
            className: 'gu-step',
            'data-status': row.status,
            title: t(`step.${row.status}`),
          }, [
            h('span', { key: 'dot', className: 'gu-dot' }),
            h('span', { key: 'label' }, row.label),
            row.duration === '' ? null : h('span', { key: 'time', className: 'gu-step-time' }, row.duration),
          ]))),
          h('div', { key: 'line', className: 'gu-job-line' }, [
            h('span', { key: 'target' }, t('progress.target', { commit: short(result?.to?.commit ?? view.check?.latest) })),
            h('span', { key: 'elapsed' }, t('progress.elapsed', { time: formatDuration(elapsed) })),
          ]),
          banner,
          logs.length === 0 ? null : h('div', { key: 'logs' }, [
            h('button', {
              key: 'toggle',
              type: 'button',
              className: 'gu-btn gu-ghost',
              onClick: () => setOpenLogs(previous => ({ ...previous, [view.package]: previous[view.package] !== true })),
            }, logsOpen ? t('action.closeLogs') : t('action.openLogs', { count: String(logs.length) })),
            h('ul', { key: 'list', className: 'gu-logs', style: { marginTop: '6px' } }, shown.map((entry, index) => h('li', {
              key: `${String(index)}-${entry.at}`,
              'data-level': entry.level ?? 'info',
            }, `${formatClock(entry.at)} ${entry.message}`))),
          ]),
        ]);
      };

      const rows = views.map(view => {
        const job = view.job;
        const running = job?.status === 'running' || job?.status === 'cancelling';
        const checkingRow = checking[view.package] === true;
        const rowError = rowErrors[view.package];
        const isArmed = armed !== null && armed.package === view.package && armed.commit === view.check?.latest;
        const check = view.check ?? {};
        const installed = view.installed?.commit;
        const latest = check.latest;
        const behind = check.state === 'behind' && typeof latest === 'string';
        const unknown = check.state === 'unknown';
        const compare = compareHref(view);
        const missing = view.installedMissing === true;
        const badges = [];
        if (view.self === true) badges.push(h('span', { key: 'self', className: 'gu-badge' }, t('state.self')));
        if (running) badges.push(h('span', { key: 'busy', className: 'gu-badge busy' }, t('state.busy')));
        else if (checkingRow) badges.push(h('span', { key: 'checking', className: 'gu-badge' }, t('state.checking')));
        else if (missing) badges.push(h('span', { key: 'missing', className: 'gu-badge missing' }, t('state.missing')));
        else if (unknown) badges.push(h('span', { key: 'unknown', className: 'gu-badge error', title: check.error?.message ?? '' }, t('state.unknown')));
        else if (behind) badges.push(h('span', { key: 'behind', className: 'gu-badge behind' }, t('state.behind')));
        else if (check.state === 'current') badges.push(h('span', { key: 'current', className: 'gu-badge current' }, t('state.current')));
        if (view.pendingRestart !== undefined && view.pendingRestart !== null) {
          badges.push(h('span', { key: 'pending', className: 'gu-badge busy', title: restartReasonText(view.pendingRestart.reason, t) }, t('state.pendingRestart')));
        }
        const actions = rowActions(view, { checking: checkingRow });
        const disableCheck = !actions.canCheck || phase !== 'ready';
        const disableUpdate = !actions.canUpdate;
        return h('article', {
          key: view.package,
          className: 'gu-row',
          'data-busy': running ? 'true' : undefined,
          'aria-busy': running ? 'true' : undefined,
        }, [
          h('div', { key: 'head', className: 'gu-row-head' }, [
            typeof props.openBundle === 'function'
              ? h('button', {
                key: 'name',
                type: 'button',
                className: 'gu-name gu-name-link',
                title: t('action.openDetail'),
                onClick: () => { openBundleDetail(props, view.package); },
              }, textOf(resolveText, view.title, view.package))
              : h('span', { key: 'name', className: 'gu-name' }, textOf(resolveText, view.title, view.package)),
            h('span', { key: 'pkg', className: 'gu-pkg' }, view.package),
            typeof view.installed?.version === 'string'
              ? h('span', { key: 'version', className: 'gu-badge' }, t('meta.version', { version: view.installed.version }))
              : null,
            h('span', { key: 'badges', className: 'gu-badges' }, badges),
          ]),
          h('div', { key: 'meta', className: 'gu-meta' }, [
            h('span', { key: 'repo' }, `${t('section.repository')}: ${String(view.repository ?? view.source ?? '')}`),
            h('span', { key: 'ref' }, view.pinned === true
              ? t('state.pinned')
              : t('state.branch', { ref: String(view.ref ?? 'HEAD') })),
            h('span', { key: 'installed' }, [
              `${t('section.installed')} `,
              h('code', { key: 'sha', title: String(installed ?? '') }, short(installed)),
            ]),
            h('span', { key: 'latest' }, [
              `${t('section.latest')} `,
              h('code', { key: 'sha', title: String(latest ?? '') }, short(latest)),
            ]),
            compare === undefined
              ? null
              : h('a', { key: 'compare', className: 'gu-link', href: compare, target: '_blank', rel: 'noreferrer noopener' }, t('section.compare')),
            h('span', { key: 'checked' }, `${t('section.checkedAt')}: ${check.at === undefined || check.at === null ? t('section.never') : formatDate(check.at)}`),
          ]),
          h('div', { key: 'actions', className: 'gu-row-actions' }, [
            h('button', {
              key: 'check',
              type: 'button',
              className: 'gu-btn gu-outline',
              disabled: disableCheck,
              onClick: () => { void checkRows([view.package], true); },
            }, h(Glyph, { key: 'icon', paths: ICONS.refresh }), checkingRow ? t('action.checking') : t('action.check')),
            behind && !running
              ? h('button', {
                key: 'update',
                type: 'button',
                className: isArmed ? 'gu-btn gu-outline gu-armed' : 'gu-btn gu-primary',
                disabled: disableUpdate,
                title: isArmed ? t('action.confirmHint') : t('action.updateTo', { commit: short(latest) }),
                onClick: () => armOrUpdate(view),
              }, h(Glyph, { key: 'icon', paths: isArmed ? ICONS.warn : ICONS.refresh }),
              isArmed
                ? t('action.confirm', { commit: short(latest) })
                : t('action.updateTo', { commit: short(latest) }))
              : null,
            running
              ? h('button', {
                key: 'cancel',
                type: 'button',
                className: 'gu-btn gu-outline',
                disabled: job.status === 'cancelling',
                onClick: () => { void cancelUpdate(job); },
              }, h(Glyph, { key: 'icon', paths: ICONS.cancel }),
              job.status === 'cancelling' ? t('action.cancelling') : t('action.cancelUpdate'))
              : null,
            view.self === true ? h('span', { key: 'self', className: 'gu-row-note' }, t('self.hint')) : null,
          ]),
          rowError === undefined || rowError === null
            ? null
            : h('div', { key: 'error', className: 'gu-row-error' }, errorText(rowError.code, rowError.message, t)),
          job === undefined || job === null ? null : renderJob(view, job),
        ]);
      });

      const body = phase === 'loading' && views.length === 0
        ? h('p', { key: 'loading', className: 'gu-empty' }, t('page.loading'))
        : (phase === 'error' && views.length === 0
          ? h('div', { key: 'error', className: 'gu-banner error' }, [
            h('div', { key: 'msg' }, t('page.unavailable')),
            h('div', { key: 'reason', className: 'gu-hint' }, errorText(error?.code, error?.message, t)),
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'gu-btn gu-outline',
              style: { marginTop: '6px' },
              onClick: () => { setPhase('loading'); void refresh(); },
            }, t('page.retry')),
          ])
          : (views.length === 0
            ? h('p', { key: 'empty', className: 'gu-empty' }, t('page.empty'))
            : h('div', { key: 'list', className: 'gu-list' }, rows)));

      return h('div', { className: 'gu-page' }, [
        h('style', { key: 'css' }, CSS),
        header,
        toolbar,
        body,
      ]);
    }

    /**
     * 设置左侧导航里的图标（与 `settings.section` 的 id 对应）。
     * @param {{ size?: number }} props 插槽 props。
     * @returns {any} React 节点。
     */
    function PluginUpdatesIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, [
        h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.5-3.7' }),
        h('path', { key: 'b', d: 'M13.2 2.8v3.1h-3.1' }),
      ]);
    }

    const inject = ['slots', 'locale'];

    /**
     * 注册设置页的「插件更新」一栏。只注册设置页，不碰其它页面。
     * @param {any} ctx 浏览器插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'git-updates: 设置页字典');
      const t = ctx.locale.bind(NS);
      const injected = () => ({
        resolveText: text => (typeof ctx.locale.resolveText === 'function'
          ? ctx.locale.resolveText(text)
          : (typeof text === 'string' ? text : '')),
        // 插件页由 ui-plugin-manager 提供；缺失时名称退回普通文本（不关闭设置）。
        openBundle: packageName => {
          const navigation = typeof ctx.get === 'function' ? ctx.get('pluginNavigation') : undefined;
          if (navigation === undefined || navigation === null || typeof navigation.openBundle !== 'function') return false;
          navigation.openBundle(packageName);
          return true;
        },
      });
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'plugin-updates',
          order: 20,
          label: () => t('nav.label'),
          locale: NS,
          inject: injected,
        }, PluginUpdatesSection)),
        'git-updates: 设置页「插件更新」',
      );
      ctx.effect(
        () => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'plugin-updates',
          locale: NS,
        }, PluginUpdatesIcon)),
        'git-updates: 设置页图标',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.NS = NS;
    // 纯函数给 Node 单测用；Loader 不读这些额外导出。
    exports.__test = {
      formatDuration,
      formatClock,
      formatDate,
      short,
      interpolate,
      summarize,
      stepRows,
      phaseOf,
      restartReasonText,
      busyLabel,
      errorText,
      mergeViews,
      rowActions,
      compareHref,
      liveElapsed,
      openBundleDetail,
      scheduleLogClear,
      cancelScheduledLogClear,
      PluginUpdatesSection,
      PluginUpdatesIcon,
      dicts: { zh, en },
    };
    return module.exports;
  },
});
