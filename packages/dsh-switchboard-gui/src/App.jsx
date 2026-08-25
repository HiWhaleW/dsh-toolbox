import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createDemoApi, detectDemoMode } from "./demo-api.js";

const bundleMeta = {
  "@dsh-toolbox/product-research-workbench": { icon: "bi-search", tone: "blue", description: "产品研究与洞察生成工具集。" },
  "@dsh-toolbox/context-switchboard": { icon: "bi-diagram-3", tone: "purple", description: "上下文路由与智能调度。" },
  "@dsh-toolbox/plugin-preflight": { icon: "bi-shield-check", tone: "teal", description: "插件预检与合规性检查。" },
  "@dsh-toolbox/compatibility-radar": { icon: "bi-radar", tone: "amber", description: "插件兼容性检测与风险提示。" },
  "@deepseek-ai/dsh-base": { icon: "bi-box-seam", tone: "slate", description: "DeepSeek Harness 基础运行 Bundle。" },
};

const navItems = [
  ["profiles", "bi-file-earmark-code", "DSH Profiles"],
  ["plugins", "bi-box", "插件"],
  ["activity", "bi-activity", "活动"],
  ["settings", "bi-gear", "设置"],
];

const activityKinds = {
  backup: "备份",
  health: "验证",
  plan: "计划",
  apply: "应用",
  rollback: "回滚",
  report: "报告",
};

function icon(name, className = "") {
  return <i className={`bi ${name} ${className}`} aria-hidden="true" />;
}

function shortPackageName(packageName) {
  return packageName.replace(/^@dsh-toolbox\//, "");
}

function formatTime(value) {
  if (!value) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function visiblePlanChangeCount(plan) {
  const directChanges = plan.changes.additions.length + plan.changes.removals.length;
  return directChanges || plan.changes.moved.length;
}

function activityIcon(activity) {
  if (activity.status === "success") return "bi-check-circle";
  if (activity.status === "warning" || activity.status === "error") return "bi-exclamation-triangle";
  return "bi-info-circle";
}

function Modal({ title, subtitle, iconName, children, onClose, wide = false }) {
  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-header">
          <span className="modal-icon">{icon(iconName)}</span>
          <div><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <button className="icon-button modal-close" onClick={onClose} aria-label="关闭">{icon("bi-x-lg")}</button>
        </header>
        {children}
      </section>
    </div>
  );
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(onClose, 4200);
    return () => window.clearTimeout(timer);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.kind ?? "info"}`} role="status">
      {icon(toast.kind === "error" ? "bi-exclamation-octagon" : toast.kind === "success" ? "bi-check-circle" : "bi-info-circle")}
      <span>{toast.message}</span>
      <button onClick={onClose} aria-label="关闭提示">{icon("bi-x")}</button>
    </div>
  );
}

function ActivityItem({ activity, extended = false }) {
  return (
    <article className={`activity-item ${extended ? "activity-item-extended" : ""}`}>
      <span className={`activity-icon ${activity.status}`}>{icon(activityIcon(activity))}</span>
      <div>
        <div className="activity-title"><strong>{activity.title}</strong><time>{extended ? formatDateTime(activity.createdAt) : formatTime(activity.createdAt)}</time></div>
        <p>{activity.detail}</p>
        <div className="activity-meta">
          <span className={`activity-tag ${activity.status}`}>{activityKinds[activity.kind] ?? "操作"}</span>
          {extended && activity.profile && <span className="activity-profile">Profile · {activity.profile}</span>}
        </div>
      </div>
    </article>
  );
}

export function App() {
  const demoMode = detectDemoMode();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [activeNav, setActiveNav] = useState("profiles");
  const [plan, setPlan] = useState(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState(null);
  const [bundleDetail, setBundleDetail] = useState(null);
  const [clearActivityOpen, setClearActivityOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [activityFilters, setActivityFilters] = useState({ profile: "", kind: "", status: "" });
  const [activityPage, setActivityPage] = useState({ activities: [], total: 0, nextCursor: null });
  const [activityLoading, setActivityLoading] = useState(false);
  const tokenRef = useRef("");
  const mainRef = useRef(null);
  const demoApiRef = useRef(null);
  if (demoMode && !demoApiRef.current) demoApiRef.current = createDemoApi();

  const api = useCallback(async (path, options = {}) => {
    if (demoMode) return demoApiRef.current(path, options);
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.method && options.method !== "GET" ? { "x-dsh-switchboard-token": tokenRef.current } : {}),
        ...(options.headers ?? {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
    return payload;
  }, [demoMode]);

  const load = useCallback(async (profileName) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api(`/api/bootstrap${profileName ? `?profile=${encodeURIComponent(profileName)}` : ""}`);
      tokenRef.current = payload.token;
      setData(payload);
      setPlan(payload.pendingPlans?.at(-1) ?? null);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const profile = data?.selectedProfile;
  const healthOk = Boolean(data?.health?.ok);
  const activeBundles = profile?.bundleDetails ?? [];
  const inactiveBundles = profile?.inactiveBundleDependencies ?? [];
  const bundleRows = useMemo(() => [
    ...activeBundles,
    ...inactiveBundles.map((bundle) => ({ ...bundle, resolved: true, hasPatch: true, inactive: true })),
  ], [activeBundles, inactiveBundles]);
  const transactions = data?.transactions ?? [];
  const recentActivities = data?.recentActivities ?? [];

  const fetchActivities = useCallback(async ({ append = false, cursor = null } = {}) => {
    setActivityLoading(true);
    try {
      const params = new URLSearchParams({ limit: "40" });
      for (const [key, value] of Object.entries(activityFilters)) if (value) params.set(key, value);
      if (cursor) params.set("cursor", cursor);
      const result = await api(`/api/activities?${params}`);
      setActivityPage((current) => ({
        activities: append ? [...current.activities, ...result.activities] : result.activities,
        total: result.total,
        nextCursor: result.nextCursor,
      }));
    } catch (activityError) {
      setToast({ kind: "error", message: activityError.message });
    } finally {
      setActivityLoading(false);
    }
  }, [activityFilters, api]);

  useEffect(() => {
    if (activeNav === "activity" && data) fetchActivities();
  }, [activeNav, data?.sessionId, activityFilters, fetchActivities]);

  async function refreshActivitySurfaces() {
    const params = new URLSearchParams({ limit: "8" });
    if (profile?.name) params.set("profile", profile.name);
    const recent = await api(`/api/activities?${params}`);
    setData((current) => ({ ...current, recentActivities: recent.activities, events: recent.activities }));
    if (activeNav === "activity") await fetchActivities();
  }

  function navigate(target) {
    setActiveNav(target);
    window.requestAnimationFrame(() => mainRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
  }

  async function runHealth() {
    if (!profile) return;
    setBusy("health");
    try {
      const result = await api(`/api/profiles/${encodeURIComponent(profile.name)}/health`, { method: "POST", body: "{}" });
      setData((current) => ({ ...current, health: result.health }));
      await refreshActivitySurfaces();
      setToast({ kind: result.health.ok ? "success" : "error", message: result.health.ok ? (demoMode ? "在线演示：已模拟 DSH 健康检查" : "DSH 健康检查通过") : "健康检查发现问题，请查看运行信息" });
    } catch (healthError) {
      setToast({ kind: "error", message: healthError.message });
    } finally {
      setBusy("");
    }
  }

  async function createPlan(packageName, currentlyActive) {
    if (!profile || packageName === "@deepseek-ai/dsh-base") return;
    const nextBundles = currentlyActive ? profile.bundles.filter((name) => name !== packageName) : [...profile.bundles, packageName];
    setBusy(packageName);
    try {
      const result = await api(`/api/profiles/${encodeURIComponent(profile.name)}/plans`, {
        method: "POST",
        body: JSON.stringify({ nextBundles }),
      });
      setPlan(result.plan);
      setPlanOpen(true);
      await refreshActivitySurfaces();
    } catch (planError) {
      setToast({ kind: "error", message: planError.message });
    } finally {
      setBusy("");
    }
  }

  async function applyPlan() {
    if (!plan) return;
    setBusy("apply");
    try {
      await api(`/api/plans/${encodeURIComponent(plan.id)}/apply`, { method: "POST", body: JSON.stringify({ validateRuntime: true }) });
      setPlan(null);
      setPlanOpen(false);
      setToast({ kind: "success", message: demoMode ? "在线演示：变更只应用到当前浏览器内存" : "Bundle 变更已应用，DSH 运行时验证通过" });
      await load(profile.name);
    } catch (applyError) {
      setToast({ kind: "error", message: applyError.message });
    } finally {
      setBusy("");
    }
  }

  async function rollback() {
    if (!rollbackTarget) return;
    setBusy("rollback");
    try {
      await api(`/api/transactions/${encodeURIComponent(rollbackTarget.id)}/rollback`, { method: "POST", body: JSON.stringify({ validateRuntime: true }) });
      setRollbackTarget(null);
      setBackupsOpen(false);
      setToast({ kind: "success", message: demoMode ? "在线演示：已模拟备份恢复与验证" : "Profile 已恢复到所选备份并通过 DSH 验证" });
      await load(profile.name);
    } catch (rollbackError) {
      setToast({ kind: "error", message: rollbackError.message });
    } finally {
      setBusy("");
    }
  }

  async function createBackup() {
    if (!profile) return;
    setBusy("backup");
    try {
      await api(`/api/profiles/${encodeURIComponent(profile.name)}/backups`, { method: "POST", body: "{}" });
      setToast({ kind: "success", message: demoMode ? "在线演示：已在浏览器内存中创建手动备份" : "当前 Profile 的手动备份已保存" });
      await load(profile.name);
    } catch (backupError) {
      setToast({ kind: "error", message: backupError.message });
    } finally {
      setBusy("");
    }
  }

  async function generateReport() {
    if (!profile) return;
    setBusy("report");
    try {
      const result = await api(`/api/profiles/${encodeURIComponent(profile.name)}/report`, { method: "POST", body: "{}" });
      await refreshActivitySurfaces();
      setToast({ kind: "success", message: demoMode ? `在线演示：已模拟生成 ${result.reports.length} 份报告` : `已生成 ${result.reports.length} 份本地报告（Markdown + HTML）` });
    } catch (reportError) {
      setToast({ kind: "error", message: reportError.message });
    } finally {
      setBusy("");
    }
  }

  async function clearCurrentSession() {
    setBusy("clear-activity");
    try {
      const result = await api("/api/activities/session/clear", { method: "POST", body: "{}" });
      setClearActivityOpen(false);
      await refreshActivitySurfaces();
      setToast({ kind: "success", message: `已清除当前会话的 ${result.cleared} 条活动，历史会话未受影响` });
    } catch (clearError) {
      setToast({ kind: "error", message: clearError.message });
    } finally {
      setBusy("");
    }
  }

  if (loading && !data) return (
    <div className="splash"><div className="brand-mark"><strong>DSH</strong> Switchboard</div><span className="spinner" aria-label="正在读取本地 DSH Profile" /><p>正在读取本地 DSH Profiles…</p></div>
  );

  const profileHeader = (
    <header className="profile-header">
      <button className="back-link" onClick={() => setProfilesOpen(true)}>{icon("bi-folder2-open")} 切换 Profile</button>
      <div className="profile-title-row"><h1>{profile?.name}</h1><span className="profile-pill">当前 Profile</span></div>
      <p>DSH Profile · 路径：<code>$DSH_HOME/profiles/{profile?.name}</code></p>
    </header>
  );

  const healthCard = profile && (
    <section className={`health-card ${healthOk ? "healthy" : "unhealthy"}`}>
      <div className="health-summary">
        <span className="health-icon">{icon(healthOk ? "bi-check-lg" : "bi-exclamation-lg")}</span>
        <div><h2>DSH Profile {healthOk ? "健康" : "需要处理"}</h2><code>dsh --profile {profile.name} --dump-config</code><p>{healthOk ? "配置验证通过，Profile 可安全使用。" : (data.health?.runtime?.diagnostic ?? "请运行健康检查查看详情。")}</p></div>
      </div>
      <div className="runtime-info"><span>运行时</span><strong>@deepseek-ai/dsh {data.runtime?.version ?? "未检测到"}</strong><strong>Node.js {data.nodeVersion}</strong></div>
      <button className="text-button" onClick={runHealth}>重新检查 {icon("bi-chevron-right")}</button>
    </section>
  );

  const profilesView = profile && (
    <div className="view-stack" data-view="profiles">
      {profileHeader}
      {healthCard}
      <section className="profile-actions-grid" aria-label="Profile 快捷操作">
        <button onClick={() => navigate("plugins")}><span className="action-card-icon">{icon("bi-box")}</span><strong>管理 Profile Bundles</strong><p>{bundleRows.length} 个已安装 Bundle；所有改动先生成计划。</p><span>进入插件页 {icon("bi-arrow-right")}</span></button>
        <button onClick={() => setBackupsOpen(true)}><span className="action-card-icon">{icon("bi-archive")}</span><strong>备份与回滚</strong><p>{transactions.filter((item) => item.backupAvailable).length} 份本地事务备份可查询。</p><span>查看备份 {icon("bi-arrow-right")}</span></button>
        <button onClick={generateReport} disabled={busy === "report"}><span className="action-card-icon">{icon("bi-file-earmark-text")}</span><strong>生成 Profile 报告</strong><p>保存 Markdown 和 HTML 到 Switchboard 私有数据目录。</p><span>{busy === "report" ? "正在生成…" : "生成报告"} {icon("bi-arrow-right")}</span></button>
      </section>
      <section className="profiles-panel">
        <header><div><h2>本地 DSH Profiles</h2><p>来自 <code>$DSH_HOME/profiles</code>，不会读取或展示 API 凭据。</p></div><button className="secondary-button" onClick={() => load(profile.name)}>{icon("bi-arrow-repeat")} 重新扫描</button></header>
        <div className="profiles-list">
          {(data.profiles ?? []).map((item) => (
            <button key={item.name} className={item.name === profile.name ? "selected" : ""} onClick={() => item.name !== profile.name && load(item.name)} disabled={Boolean(item.error)}>
              <span className="profile-picker-icon">{icon(item.error ? "bi-exclamation-triangle" : "bi-folder2-open")}</span>
              <span><strong>{item.name}</strong><small>{item.error ? item.error : `${item.bundles} 个 Bundle · ${item.dependencies} 个依赖`}</small></span>
              {item.name === profile.name ? <span className="current-mark">当前</span> : icon("bi-chevron-right")}
            </button>
          ))}
        </div>
      </section>
    </div>
  );

  const pluginsView = profile && (
    <div className="view-stack" data-view="plugins">
      <header className="section-page-header"><button className="back-link" onClick={() => navigate("profiles")}>{icon("bi-chevron-left")} DSH Profiles</button><div className="section-title-row"><div><h1>插件</h1><p>管理 Profile <strong>{profile.name}</strong> 的 DSH Profile Bundles</p></div><span className="profile-pill">{profile.name}</span></div></header>
      <section className={`change-strip ${plan ? "has-plan" : ""}`}>
        <span className="strip-icon">{icon(plan ? "bi-info-circle" : "bi-check-circle")}</span>
        <div><strong>{plan ? `检测到待应用的 Bundle 变更（${visiblePlanChangeCount(plan)} 项）` : "当前没有待应用的 Bundle 变更"}</strong><p>{plan ? "变更来自 Profile Bundles，建议在应用前进行审阅。" : "点击 Bundle 开关即可先生成一份不会修改文件的变更计划。"}</p></div>
        <div className="strip-actions">
          <button className="primary-button" onClick={() => plan && setPlanOpen(true)} disabled={!plan}>{plan ? "审阅 Bundle 变更" : "无待审变更"} {icon("bi-chevron-right")}</button>
          <button className="secondary-button" onClick={runHealth} disabled={busy === "health"}>{busy === "health" ? <span className="mini-spinner" /> : icon("bi-activity")} 运行 DSH 健康检查</button>
          <button className="secondary-button" onClick={() => setBackupsOpen(true)}>{icon("bi-archive")} 查看备份</button>
        </div>
      </section>
      <section className="bundles-panel">
        <header><div><h2>Profile Bundles <span>({bundleRows.length})</span></h2><p>开关只生成计划；审阅确认后才会备份、写入和验证。</p></div></header>
        <div className="bundle-table-header"><span>Bundle 名称</span><span>版本</span><span>状态</span><span>兼容性</span><span>操作</span></div>
        <div className="bundle-list">
          {bundleRows.map((bundle) => {
            const meta = bundleMeta[bundle.packageName] ?? { icon: "bi-box", tone: "slate", description: "DSH Profile Bundle" };
            const active = !bundle.inactive;
            const locked = bundle.packageName === "@deepseek-ai/dsh-base";
            const compatible = bundle.resolved && bundle.hasPatch;
            return (
              <article className="bundle-row" key={bundle.packageName}>
                <div className="bundle-identity"><span className={`bundle-icon ${meta.tone}`}>{icon(meta.icon)}</span><div><strong>{bundle.packageName}</strong><p>{meta.description}</p></div></div>
                <span className="version-tag">{bundle.version ?? "未知"}</span>
                <span className={`state-label ${active ? "success" : "muted"}`}><span className="status-dot" />{active ? "运行中" : "未启用"}</span>
                <span className={`state-label ${compatible ? "success" : "warning"}`}>{icon(compatible ? "bi-check-circle" : "bi-exclamation-triangle")} {compatible ? "兼容" : "需检查"}</span>
                <div className="bundle-actions">
                  <button className={`switch ${active ? "on" : ""}`} role="switch" aria-checked={active} aria-label={`${active ? "停用" : "启用"} ${shortPackageName(bundle.packageName)}`} disabled={locked || busy === bundle.packageName} onClick={() => createPlan(bundle.packageName, active)}><span /></button>
                  <button className="icon-button" aria-label={`查看 ${shortPackageName(bundle.packageName)} 详情`} onClick={() => setBundleDetail({ ...bundle, active, compatible, meta })}>{icon("bi-three-dots-vertical")}</button>
                </div>
              </article>
            );
          })}
        </div>
        <div className="bundle-boundary-note">{icon("bi-terminal")} 安装或卸载包仍由官方 <code>dsh plugin</code> 流程负责；Switchboard 管理已安装 Bundle 的 Profile 启用状态。</div>
      </section>
    </div>
  );

  const activityView = (
    <div className="view-stack" data-view="activity">
      <header className="section-page-header"><button className="back-link" onClick={() => navigate("profiles")}>{icon("bi-chevron-left")} DSH Profiles</button><div className="section-title-row"><div><h1>活动中心</h1><p>SQLite 中保存的本地操作记录，可按 Profile、类型和状态筛选。</p></div><span className="activity-total">{activityPage.total} 条记录</span></div></header>
      <section className="activity-center-panel">
        <div className="activity-toolbar">
          <label>Profile<select value={activityFilters.profile} onChange={(event) => setActivityFilters((current) => ({ ...current, profile: event.target.value }))}><option value="">全部 Profile</option>{(data?.profiles ?? []).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
          <label>类型<select value={activityFilters.kind} onChange={(event) => setActivityFilters((current) => ({ ...current, kind: event.target.value }))}><option value="">全部类型</option>{Object.entries(activityKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>状态<select value={activityFilters.status} onChange={(event) => setActivityFilters((current) => ({ ...current, status: event.target.value }))}><option value="">全部状态</option><option value="success">成功</option><option value="info">信息</option><option value="warning">警告</option><option value="error">失败</option></select></label>
          <button className="secondary-button" onClick={() => fetchActivities()} disabled={activityLoading}>{activityLoading ? <span className="mini-spinner" /> : icon("bi-arrow-repeat")} 刷新</button>
        </div>
        <div className="activity-center-list">
          {activityPage.activities.length ? activityPage.activities.map((activity) => <ActivityItem key={activity.id} activity={activity} extended />) : <div className="activity-empty">{icon("bi-clock-history")}<h2>没有匹配的活动</h2><p>更改筛选条件，或先运行一次 DSH 健康检查。</p></div>}
        </div>
        {activityPage.nextCursor && <button className="load-more-button" onClick={() => fetchActivities({ append: true, cursor: activityPage.nextCursor })} disabled={activityLoading}>{activityLoading ? "正在读取…" : "加载更多活动"}</button>}
      </section>
    </div>
  );

  const settingsView = (
    <div className="view-stack" data-view="settings">
      <header className="section-page-header"><button className="back-link" onClick={() => navigate("profiles")}>{icon("bi-chevron-left")} DSH Profiles</button><div className="section-title-row"><div><h1>设置</h1><p>本机 DSH 运行环境、数据位置与隐私边界。</p></div><span className="local-badge"><span className="status-dot success" />本地优先</span></div></header>
      <section className="settings-panel">
        <div className="setting-row"><span className="setting-icon">{icon("bi-folder2-open")}</span><div><strong>DSH_HOME</strong><p>Profile 的读取来源</p><code>{data?.dshHome ?? "—"}</code></div></div>
        <div className="setting-row"><span className="setting-icon">{icon("bi-database")}</span><div><strong>Switchboard 数据目录</strong><p>SQLite、备份和报告的私有本地目录</p><code>{data?.dataDir ?? "—"}</code></div></div>
        <div className="setting-row"><span className="setting-icon">{icon("bi-cpu")}</span><div><strong>本机运行时</strong><p>用于执行真实 DSH 配置验证</p><code>@deepseek-ai/dsh {data?.runtime?.version ?? "未检测到"} · Node.js {data?.nodeVersion ?? "—"}</code></div><button className="secondary-button" onClick={() => load(profile?.name)} disabled={loading}>{icon("bi-arrow-repeat")} 重新检测</button></div>
        <div className="privacy-note settings-privacy">{icon("bi-shield-lock")}<div><strong>API 凭据不会显示在界面中</strong><p>GUI 只读取 Profile 结构、Bundle 元数据和运行验证结果。所有活动记录和报告保存在本机，不连接云服务。</p></div></div>
      </section>
    </div>
  );

  return (
    <div className={`app-shell ${demoMode ? "demo-mode" : ""}`}>
      {demoMode && <div className="demo-banner" role="note">{icon("bi-globe2")}<strong>在线交互演示</strong><span>所有操作仅在当前浏览器内存中模拟，刷新即复原；不会连接或读取你的 DSH。</span><a href="https://github.com/HiWhaleW/dsh-toolbox#five-minute-installation">安装本地完整版 {icon("bi-arrow-up-right")}</a></div>}
      <aside className="sidebar">
        <div className="brand"><div className="brand-name"><strong>DSH</strong> Switchboard</div><p>DeepSeek Harness 本地控制台</p></div>
        <nav aria-label="主要导航">{navItems.map(([key, iconName, label]) => <button key={key} className={activeNav === key ? "active" : ""} aria-current={activeNav === key ? "page" : undefined} onClick={() => navigate(key)}>{icon(iconName)}<span>{label}</span></button>)}</nav>
        <div className="sidebar-runtime"><div className="runtime-label"><span className={data?.runtime?.installed ? "status-dot success" : "status-dot danger"} />{demoMode ? "DSH 演示数据" : data?.runtime?.installed ? "DSH 运行中" : "DSH 未检测到"}</div><code>@deepseek-ai/dsh {data?.runtime?.version ?? "未安装"}</code><code>Node.js {data?.nodeVersion ?? "—"}</code><button className="secondary-button full" onClick={() => load(profile?.name)} disabled={loading}>{icon("bi-arrow-repeat")} {demoMode ? "复原演示" : "重新扫描"}</button></div>
        <button className="sidebar-help" onClick={() => setToast({ kind: "info", message: demoMode ? "在线演示只使用浏览器内存；本地安装后才会连接真实 DSH。" : "所有操作均在本机完成；变更前会先生成计划。" })}>{icon("bi-question-circle")} 帮助与反馈</button>
      </aside>

      <div className="workspace">
        <main className="main-content" ref={mainRef}>
          {error ? <section className="empty-state error-state">{icon("bi-exclamation-triangle")}<h1>无法打开 DSH Switchboard</h1><p>{error}</p><button className="primary-button" onClick={() => load()}>重试</button></section>
            : !profile ? <section className="empty-state">{icon("bi-folder2-open")}<h1>还没有发现 DSH Profile</h1><p>Switchboard 会从 <code>{data?.dshHome ?? "$DSH_HOME"}/profiles</code> 读取本地 Profile，不会连接云服务。</p><button className="secondary-button" onClick={() => load()}>{icon("bi-arrow-repeat")} 重新扫描</button></section>
              : activeNav === "profiles" ? profilesView : activeNav === "plugins" ? pluginsView : activeNav === "activity" ? activityView : settingsView}
        </main>

        <aside className="activity-panel">
          <header><h2>近期活动</h2><button onClick={() => navigate("activity")}>查看全部</button></header>
          <p className="activity-date">今天 · {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date())}</p>
          <div className="activity-list">{recentActivities.length ? recentActivities.map((activity) => <ActivityItem key={activity.id} activity={activity} />) : <div className="activity-empty">{icon("bi-clock-history")}<p>还没有本地操作记录</p></div>}</div>
          <button className="clear-activity" onClick={() => setClearActivityOpen(true)}>{icon("bi-trash3")} 清除本次会话活动</button>
        </aside>
      </div>

      <footer className="status-bar"><span>{demoMode ? "演示数据：" : "DSH 数据目录："}<code>{data?.dshHome ?? "—"}</code></span><button onClick={() => navigate("settings")}>{demoMode ? "查看演示说明" : "查看目录"}</button><span className="local-status"><span className="status-dot success" />{demoMode ? "安全演示 · 不读取本机" : "本地优先 · 未连接云服务"}</span></footer>

      {planOpen && plan && <Modal wide title="审阅 Bundle 变更" subtitle={`只会影响本地 DSH Profile “${plan.profile}”`} iconName="bi-shield-check" onClose={() => setPlanOpen(false)}><div className="plan-body"><div className="plan-notice">{icon("bi-info-circle")} 当前只是计划，尚未修改任何 Profile 文件。</div><div className="change-columns"><section><span>当前 Bundle</span>{plan.previousBundles.map((name) => <code key={name}>{name}</code>)}</section><span className="change-arrow">{icon("bi-arrow-right")}</span><section><span>变更后</span>{plan.nextBundles.map((name) => <code key={name}>{name}</code>)}</section></div><div className="change-summary">{plan.changes.additions.map((name) => <p key={`add-${name}`} className="addition">{icon("bi-plus-circle")} 启用 {name}</p>)}{plan.changes.removals.map((name) => <p key={`remove-${name}`} className="removal">{icon("bi-dash-circle")} 停用 {name}</p>)}{plan.changes.additions.length + plan.changes.removals.length === 0 && plan.changes.moved.map((name) => <p key={`move-${name}`}>{icon("bi-arrow-down-up")} 调整 {name} 的加载顺序</p>)}</div>{plan.warnings?.length > 0 && <div className="plan-warnings">{plan.warnings.map((warning) => <p key={warning}>{icon("bi-exclamation-triangle")} {warning}</p>)}</div>}<div className="safety-grid"><div>{icon("bi-archive")}<strong>先创建本地备份</strong><span>原始 Profile 可恢复</span></div><div>{icon("bi-fingerprint")}<strong>拒绝过期计划</strong><span>状态变化后不会误写</span></div><div>{icon("bi-arrow-counterclockwise")}<strong>验证失败自动恢复</strong><span>真实运行 DSH 校验</span></div></div></div><footer className="modal-actions"><button className="secondary-button" onClick={() => setPlanOpen(false)}>稍后处理</button><button className="primary-button" onClick={applyPlan} disabled={busy === "apply"}>{busy === "apply" ? <span className="mini-spinner" /> : icon("bi-shield-check")} 应用并验证</button></footer></Modal>}

      {backupsOpen && !rollbackTarget && <Modal wide title="Profile 备份与回滚" subtitle="备份保存在 Switchboard 私有本地数据目录" iconName="bi-archive" onClose={() => { setBackupsOpen(false); setRollbackTarget(null); }}><div className="backup-toolbar"><div><strong>主动保存当前 Profile</strong><p>手动快照可在以后恢复；恢复前还会自动保存当时的状态。</p></div><button className="primary-button" onClick={createBackup} disabled={busy === "backup"}>{busy === "backup" ? <span className="mini-spinner" /> : icon("bi-download")} 立即备份</button></div><div className="backup-list">{transactions.filter((transaction) => transaction.backupAvailable).length ? transactions.filter((transaction) => transaction.backupAvailable).map((transaction) => { const manual = transaction.action === "manual-backup"; const restorable = manual ? ["available", "restore-failed"].includes(transaction.status) : transaction.status === "applied"; return <article key={transaction.id}><span className={`backup-state ${transaction.status}`}>{icon(restorable ? "bi-check-circle" : "bi-arrow-counterclockwise")}</span><div><strong>{manual ? transaction.status === "restored" ? "已恢复的手动备份" : "手动 Profile 备份" : transaction.status === "applied" ? "Bundle 变更前备份" : "已回滚的事务"}</strong><code>{transaction.id}</code><p>{manual ? `完整 Profile 快照 · ${formatTime(transaction.updatedAt)}` : `${transaction.changes.additions.length} 项启用 · ${transaction.changes.removals.length} 项停用 · ${formatTime(transaction.updatedAt)}`}</p></div>{restorable && <button className="secondary-button danger-button" onClick={() => setRollbackTarget(transaction)}>{manual ? "恢复" : "回滚"}</button>}</article>; }) : <div className="modal-empty">{icon("bi-archive")}<h3>还没有备份</h3><p>点击“立即备份”，或在应用 Bundle 变更时自动创建。</p></div>}</div></Modal>}

      {rollbackTarget && <Modal title={rollbackTarget.action === "manual-backup" ? "确认恢复手动备份？" : "确认回滚 Profile？"} subtitle={rollbackTarget.action === "manual-backup" ? "恢复前会先自动备份当前 Profile" : "此操作会先检查 Profile 是否在事务后被其他程序修改"} iconName="bi-arrow-counterclockwise" onClose={() => setRollbackTarget(null)}><div className="confirm-body"><p>将恢复事务 <code>{rollbackTarget.id}</code> 对应的本地备份，并再次运行 DSH 配置验证。</p><div className="confirm-warning">{icon("bi-exclamation-triangle")} {rollbackTarget.action === "manual-backup" ? "当前状态会先保存为新的恢复点；若验证失败，Switchboard 会自动撤销本次恢复。" : "如果检测到后续人工修改，Switchboard 会拒绝覆盖。"}</div></div><footer className="modal-actions"><button className="secondary-button" onClick={() => setRollbackTarget(null)}>取消</button><button className="primary-button danger-primary" onClick={rollback} disabled={busy === "rollback"}>{busy === "rollback" ? <span className="mini-spinner" /> : icon("bi-arrow-counterclockwise")} {rollbackTarget.action === "manual-backup" ? "安全恢复" : "安全回滚"}</button></footer></Modal>}

      {profilesOpen && <Modal title="选择 DSH Profile" subtitle={`从 ${data?.dshHome ?? "$DSH_HOME"}/profiles 发现的本地配置`} iconName="bi-file-earmark-code" onClose={() => setProfilesOpen(false)}><div className="profile-picker">{(data?.profiles ?? []).map((item) => <button key={item.name} className={item.name === profile?.name ? "selected" : ""} onClick={async () => { setProfilesOpen(false); await load(item.name); }}><span className="profile-picker-icon">{icon(item.error ? "bi-exclamation-triangle" : "bi-folder2-open")}</span><span><strong>{item.name}</strong><small>{item.error ? item.error : `${item.bundles} 个 Bundle · ${item.dependencies} 个依赖`}</small></span>{item.name === profile?.name ? <span className="current-mark">当前</span> : icon("bi-chevron-right")}</button>)}</div></Modal>}

      {bundleDetail && <Modal title="Bundle 详情" subtitle={bundleDetail.packageName} iconName={bundleDetail.meta.icon} onClose={() => setBundleDetail(null)}><div className="bundle-detail"><dl><div><dt>版本</dt><dd>{bundleDetail.version ?? "未知"}</dd></div><div><dt>Profile 状态</dt><dd>{bundleDetail.active ? "已启用" : "未启用"}</dd></div><div><dt>解析来源</dt><dd>{bundleDetail.source ?? "未知"}</dd></div><div><dt>兼容性</dt><dd>{bundleDetail.compatible ? "兼容" : "需要检查"}</dd></div><div><dt>补丁声明</dt><dd>{bundleDetail.hasPatch ? "已声明" : "未声明"}</dd></div></dl></div><footer className="modal-actions"><button className="primary-button" onClick={() => setBundleDetail(null)}>完成</button></footer></Modal>}

      {clearActivityOpen && <Modal title="清除本次会话活动？" subtitle="只删除本次打开 Switchboard 后产生的活动" iconName="bi-trash3" onClose={() => setClearActivityOpen(false)}><div className="confirm-body"><p>活动记录将从本地 SQLite 删除。以前会话的记录、Profile 事务和备份不会受到影响。</p><div className="confirm-warning">{icon("bi-info-circle")} 这项操作不可撤销，但不会修改任何 DSH Profile 文件。</div></div><footer className="modal-actions"><button className="secondary-button" onClick={() => setClearActivityOpen(false)}>取消</button><button className="primary-button danger-primary" onClick={clearCurrentSession} disabled={busy === "clear-activity"}>{busy === "clear-activity" ? <span className="mini-spinner" /> : icon("bi-trash3")} 确认清除</button></footer></Modal>}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
