const demoBundles = [
  { packageName: "@deepseek-ai/dsh-base", version: "0.1.1-rc.2", source: "demo", resolved: true, hasPatch: true },
  { packageName: "@dsh-toolbox/compatibility-radar", version: "0.2.1", source: "demo", resolved: true, hasPatch: true },
  { packageName: "@dsh-toolbox/context-switchboard", version: "0.2.1", source: "demo", resolved: true, hasPatch: true },
  { packageName: "@dsh-toolbox/plugin-preflight", version: "0.2.1", source: "demo", resolved: true, hasPatch: true },
  { packageName: "@dsh-toolbox/product-research-workbench", version: "0.2.1", source: "demo", resolved: true, hasPatch: true },
];

const profileDefinitions = {
  "toolbox-final": demoBundles.map((bundle) => bundle.packageName),
  "research-lab": [
    "@deepseek-ai/dsh-base",
    "@dsh-toolbox/product-research-workbench",
    "@dsh-toolbox/context-switchboard",
  ],
};

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function initialActivities() {
  return [
    { id: "demo-health-1", sessionId: "demo-session", profile: "toolbox-final", kind: "health", status: "success", title: "DSH 配置验证通过", detail: "在线演示已模拟 dsh --profile toolbox-final --dump-config。", createdAt: minutesAgo(2) },
    { id: "demo-plan-1", sessionId: "demo-session", profile: "toolbox-final", kind: "plan", status: "info", title: "Bundle 变更计划已生成", detail: "演示计划不会读取或修改访客电脑上的任何文件。", createdAt: minutesAgo(5) },
    { id: "demo-report-1", sessionId: "historic-demo", profile: "research-lab", kind: "report", status: "success", title: "Profile 报告已生成", detail: "模拟生成 Markdown 与 HTML 两种本地报告。", createdAt: minutesAgo(18) },
    { id: "demo-rollback-1", sessionId: "historic-demo", profile: "toolbox-final", kind: "rollback", status: "success", title: "Profile 已安全回滚", detail: "模拟备份恢复和 DSH 运行时验证。", createdAt: minutesAgo(31) },
  ];
}

function parseBody(options) {
  if (!options?.body) return {};
  return typeof options.body === "string" ? JSON.parse(options.body) : options.body;
}

function planChanges(previousBundles, nextBundles) {
  return {
    additions: nextBundles.filter((name) => !previousBundles.includes(name)),
    removals: previousBundles.filter((name) => !nextBundles.includes(name)),
    moved: [],
  };
}

export function detectDemoMode(location = globalThis.location) {
  const forced = import.meta.env?.VITE_DSH_DEMO === "true";
  const hostname = location?.hostname ?? "";
  return forced || hostname.endsWith(".chatgpt.site") || hostname.endsWith(".openai.site");
}

export function createDemoApi() {
  const bundlesByProfile = Object.fromEntries(Object.entries(profileDefinitions).map(([name, bundles]) => [name, [...bundles]]));
  let activities = initialActivities();
  let transactions = [{
    id: "demo-transaction-001",
    profile: "toolbox-final",
    status: "applied",
    backupAvailable: true,
    changes: { additions: ["@dsh-toolbox/compatibility-radar"], removals: [], moved: [] },
    updatedAt: minutesAgo(31),
  }];
  let pendingPlan = null;
  let counter = 10;

  function addActivity(activity) {
    activities = [{
      id: `demo-activity-${counter++}`,
      sessionId: "demo-session",
      createdAt: new Date().toISOString(),
      ...activity,
    }, ...activities];
  }

  function profileDetails(name) {
    const bundles = bundlesByProfile[name] ?? bundlesByProfile["toolbox-final"];
    return {
      name,
      bundles,
      bundleDetails: demoBundles.filter((bundle) => bundles.includes(bundle.packageName)),
      inactiveBundleDependencies: demoBundles.filter((bundle) => !bundles.includes(bundle.packageName)),
    };
  }

  function bootstrap(profileName) {
    const selectedName = bundlesByProfile[profileName] ? profileName : "toolbox-final";
    const profiles = Object.entries(bundlesByProfile).map(([name, bundles]) => ({ name, bundles: bundles.length, dependencies: bundles.length }));
    return {
      token: "demo-session-token",
      sessionId: "demo-session",
      demo: true,
      dshHome: "在线演示数据（不读取本机）",
      dataDir: "当前浏览器内存（刷新即复原）",
      runtime: { installed: true, version: "0.1.1-rc.2" },
      nodeVersion: "24.19.0",
      profiles,
      selectedProfile: profileDetails(selectedName),
      health: { ok: true, runtime: { diagnostic: "在线演示：已模拟 DSH 配置验证。" } },
      transactions,
      pendingPlans: pendingPlan ? [pendingPlan] : [],
      recentActivities: activities.filter((activity) => activity.profile === selectedName).slice(0, 8),
    };
  }

  return async function demoApi(path, options = {}) {
    const requestUrl = new URL(path, "https://demo.dsh.local");
    const method = options.method ?? "GET";

    if (method === "GET" && requestUrl.pathname === "/api/bootstrap") {
      return bootstrap(requestUrl.searchParams.get("profile"));
    }

    if (method === "GET" && requestUrl.pathname === "/api/activities") {
      let filtered = activities;
      for (const [key, field] of [["profile", "profile"], ["kind", "kind"], ["status", "status"]]) {
        const value = requestUrl.searchParams.get(key);
        if (value) filtered = filtered.filter((activity) => activity[field] === value);
      }
      if (requestUrl.searchParams.get("session") === "current") filtered = filtered.filter((activity) => activity.sessionId === "demo-session");
      const limit = Math.min(Number(requestUrl.searchParams.get("limit") ?? 40), 200);
      return { activities: filtered.slice(0, limit), total: filtered.length, nextCursor: null };
    }

    const healthMatch = requestUrl.pathname.match(/^\/api\/profiles\/([^/]+)\/health$/);
    if (method === "POST" && healthMatch) {
      const profile = decodeURIComponent(healthMatch[1]);
      addActivity({ profile, kind: "health", status: "success", title: "DSH 配置验证通过", detail: "在线演示已模拟运行时健康检查。" });
      return { health: { ok: true, runtime: { diagnostic: "在线演示：配置验证通过。" } } };
    }

    const backupMatch = requestUrl.pathname.match(/^\/api\/profiles\/([^/]+)\/backups$/);
    if (method === "POST" && backupMatch) {
      const profile = decodeURIComponent(backupMatch[1]);
      const transaction = {
        id: `demo-backup-${counter++}`,
        profile,
        action: "manual-backup",
        status: "available",
        backupAvailable: true,
        changes: { additions: [], removals: [], moved: [] },
        updatedAt: new Date().toISOString(),
      };
      transactions = [transaction, ...transactions];
      addActivity({ profile, kind: "backup", status: "success", title: "Profile 手动备份已创建", detail: "在线演示已在浏览器内存中模拟保存快照。" });
      return { transaction };
    }

    const planMatch = requestUrl.pathname.match(/^\/api\/profiles\/([^/]+)\/plans$/);
    if (method === "POST" && planMatch) {
      const profile = decodeURIComponent(planMatch[1]);
      const previousBundles = [...(bundlesByProfile[profile] ?? [])];
      const nextBundles = parseBody(options).nextBundles ?? previousBundles;
      pendingPlan = {
        id: `demo-plan-${counter++}`,
        profile,
        previousBundles,
        nextBundles,
        changes: planChanges(previousBundles, nextBundles),
        warnings: ["在线演示模式：确认后只更新当前浏览器内存，刷新页面即可复原。"],
      };
      addActivity({ profile, kind: "plan", status: "info", title: "Bundle 变更计划已生成", detail: "演示计划尚未应用。" });
      return { plan: pendingPlan };
    }

    const applyMatch = requestUrl.pathname.match(/^\/api\/plans\/([^/]+)\/apply$/);
    if (method === "POST" && applyMatch && pendingPlan?.id === decodeURIComponent(applyMatch[1])) {
      bundlesByProfile[pendingPlan.profile] = [...pendingPlan.nextBundles];
      const transaction = {
        id: `demo-transaction-${counter++}`,
        profile: pendingPlan.profile,
        status: "applied",
        backupAvailable: true,
        changes: pendingPlan.changes,
        updatedAt: new Date().toISOString(),
      };
      transactions = [transaction, ...transactions];
      addActivity({ profile: pendingPlan.profile, kind: "apply", status: "success", title: "Bundle 变更已应用", detail: "演示状态已更新；没有写入本机文件。" });
      pendingPlan = null;
      return { transaction };
    }

    const reportMatch = requestUrl.pathname.match(/^\/api\/profiles\/([^/]+)\/report$/);
    if (method === "POST" && reportMatch) {
      const profile = decodeURIComponent(reportMatch[1]);
      addActivity({ profile, kind: "report", status: "success", title: "Profile 报告已生成", detail: "在线演示已模拟 Markdown 与 HTML 报告。" });
      return { reports: [`${profile}.md`, `${profile}.html`] };
    }

    const rollbackMatch = requestUrl.pathname.match(/^\/api\/transactions\/([^/]+)\/rollback$/);
    if (method === "POST" && rollbackMatch) {
      const id = decodeURIComponent(rollbackMatch[1]);
      const target = transactions.find((transaction) => transaction.id === id);
      if (target?.action === "manual-backup") {
        transactions = [{
          id: `demo-recovery-${counter++}`,
          profile: target.profile,
          action: "manual-backup",
          status: "available",
          backupAvailable: true,
          changes: { additions: [], removals: [], moved: [] },
          updatedAt: new Date().toISOString(),
        }, ...transactions];
      }
      transactions = transactions.map((transaction) => transaction.id === id ? { ...transaction, status: transaction.action === "manual-backup" ? "restored" : "rolled-back" } : transaction);
      addActivity({ profile: target?.profile ?? "toolbox-final", kind: "rollback", status: "success", title: target?.action === "manual-backup" ? "Profile 手动备份已恢复" : "Profile 已安全回滚", detail: "在线演示已模拟备份恢复与验证。" });
      return { transaction: transactions.find((transaction) => transaction.id === id) };
    }

    if (method === "POST" && requestUrl.pathname === "/api/activities/session/clear") {
      const before = activities.length;
      activities = activities.filter((activity) => activity.sessionId !== "demo-session");
      return { cleared: before - activities.length };
    }

    throw new Error(`在线演示不支持此操作：${method} ${requestUrl.pathname}`);
  };
}
