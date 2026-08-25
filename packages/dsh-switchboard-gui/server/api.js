import { randomBytes } from "node:crypto";
import { DshAdapter, assertProfileName } from "../../dsh-switchboard/index.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PENDING_PLANS = 20;

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request) {
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Write requests must use application/json"), { statusCode: 415 });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
    return value;
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON request: ${error.message}`), { statusCode: 400 });
  }
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    name: profile.name,
    dir: profile.dir,
    bundles: profile.bundles,
    bundleDetails: profile.bundleDetails.map((bundle) => ({
      packageName: bundle.packageName,
      position: bundle.position,
      resolved: bundle.resolved,
      source: bundle.source,
      version: bundle.version,
      hasPatch: Boolean(bundle.patch),
    })),
    inactiveBundleDependencies: profile.inactiveBundleDependencies.map((bundle) => ({
      packageName: bundle.packageName,
      version: bundle.version,
    })),
    stateHash: profile.stateHash,
  };
}

function publicHealth(health) {
  if (!health) return null;
  return {
    profile: health.profile,
    ok: Boolean(health.ok),
    static: {
      ok: Boolean(health.static?.ok),
      findings: Array.isArray(health.static?.findings) ? health.static.findings : [],
      error: health.static?.error ?? null,
    },
    runtime: health.runtime ? {
      ok: Boolean(health.runtime.ok),
      code: health.runtime.code,
      outputBytes: health.runtime.outputBytes,
      diagnostic: health.runtime.diagnostic ?? null,
      notFound: Boolean(health.runtime.notFound),
    } : null,
  };
}

function publicTransaction(transaction) {
  return {
    id: transaction.id,
    profile: transaction.profile,
    action: transaction.action,
    status: transaction.status,
    changes: transaction.plan?.changes ?? { additions: [], removals: [], moved: [] },
    previousBundles: transaction.plan?.previousBundles ?? [],
    nextBundles: transaction.plan?.nextBundles ?? [],
    runtime: transaction.result?.runtime ?? null,
    backupAvailable: Boolean(transaction.backupDir),
    error: transaction.error ?? null,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  };
}

function publicPlan(plan) {
  return {
    id: plan.id,
    profile: plan.profile,
    previousBundles: plan.previousBundles,
    nextBundles: plan.nextBundles,
    changes: plan.changes,
    warnings: plan.warnings,
    reason: plan.reason,
    createdAt: plan.createdAt,
  };
}

function publicActivity(activity) {
  return {
    id: activity.id,
    profile: activity.profile,
    kind: activity.kind,
    status: activity.status,
    title: activity.title,
    detail: activity.detail,
    createdAt: activity.createdAt,
  };
}

function encodeActivityCursor(activity) {
  return Buffer.from(JSON.stringify({ createdAt: activity.createdAt, id: activity.id }), "utf8").toString("base64url");
}

function decodeActivityCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!cursor?.createdAt || !cursor?.id) throw new Error("missing cursor fields");
    return { createdAt: String(cursor.createdAt), id: String(cursor.id) };
  } catch {
    throw Object.assign(new Error("Activity cursor is invalid"), { statusCode: 400 });
  }
}

function activityFilter(value, name) {
  if (value == null || value === "") return undefined;
  const normalized = String(value);
  if (!/^[a-z][a-z0-9-]{0,31}$/i.test(normalized)) {
    throw Object.assign(new Error(`${name} filter is invalid`), { statusCode: 400 });
  }
  return normalized;
}

function errorStatus(error) {
  if (error.statusCode) return error.statusCode;
  if (/unknown (plan|transaction)/i.test(error.message)) return 404;
  if (/stale|changed after|another switchboard change/i.test(error.message)) return 409;
  if (/invalid|required|must |does not exist|not an installed|duplicates|cannot be rolled back/i.test(error.message)) return 400;
  return 500;
}

export function createSwitchboardApi(config = {}) {
  const ownsAdapter = !config.adapter;
  const adapter = config.adapter ?? new DshAdapter({
    home: config.home ?? process.env.DSH_HOME,
    dataDir: config.dataDir ?? process.env.DSH_SWITCHBOARD_DATA_DIR,
    command: config.command ?? process.env.DSH_COMMAND,
  });
  const token = config.token ?? randomBytes(24).toString("base64url");
  const sessionId = config.sessionId ?? randomBytes(12).toString("hex");
  const plans = new Map();
  const healthEvents = new Set();
  let closed = false;

  function addEvent(event) {
    return adapter.addActivity({
      id: randomBytes(12).toString("hex"),
      sessionId,
      createdAt: new Date().toISOString(),
      ...event,
    });
  }

  function listActivities(options = {}) {
    const limit = Math.trunc(Number(options.limit ?? 50));
    if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
      throw Object.assign(new Error("limit must be between 1 and 200"), { statusCode: 400 });
    }
    const result = adapter.activities({ ...options, limit: Math.min(200, limit + 1) });
    const hasMore = result.activities.length > limit;
    const activities = result.activities.slice(0, limit);
    return {
      activities: activities.map(publicActivity),
      total: result.total,
      nextCursor: hasMore && activities.length ? encodeActivityCursor(activities.at(-1)) : null,
    };
  }

  function activitiesFromUrl(url, defaults = {}) {
    const rawProfile = url.searchParams.get("profile");
    const profile = rawProfile ? assertProfileName(rawProfile) : defaults.profile;
    return listActivities({
      profile,
      kind: activityFilter(url.searchParams.get("kind"), "kind"),
      status: activityFilter(url.searchParams.get("status"), "status"),
      sessionId: url.searchParams.get("session") === "current" ? sessionId : undefined,
      limit: url.searchParams.get("limit") ?? defaults.limit ?? 50,
      cursor: decodeActivityCursor(url.searchParams.get("cursor")),
    });
  }

  function requireWriteAccess(request) {
    const fetchSite = String(request.headers["sec-fetch-site"] ?? "");
    if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
      throw Object.assign(new Error("Cross-site write request refused"), { statusCode: 403 });
    }
    if (request.headers["x-dsh-switchboard-token"] !== token) {
      throw Object.assign(new Error("Missing or invalid Switchboard session token"), { statusCode: 403 });
    }
  }

  async function bootstrap(url) {
    const [runtime, discovery] = await Promise.all([adapter.detect(), adapter.discoverProfiles()]);
    const requested = url.searchParams.get("profile");
    const selectedName = requested
      ? assertProfileName(requested)
      : discovery.profiles.find((profile) => !profile.error)?.name ?? null;
    let profile = null;
    let health = null;
    let profileError = null;
    if (selectedName) {
      try {
        profile = await adapter.readProfile(selectedName);
        health = await adapter.healthCheck(selectedName);
        const healthEventKey = `${sessionId}:${selectedName}`;
        if (!healthEvents.has(healthEventKey)) {
          addEvent({
            profile: selectedName,
            kind: "health",
            status: health.ok ? "success" : "warning",
            title: health.ok ? "DSH 配置验证通过" : "DSH 健康检查需要处理",
            detail: health.ok ? `dsh --profile ${selectedName} --dump-config 验证通过` : (health.runtime?.diagnostic ?? health.static?.error ?? "检查未通过"),
          });
          healthEvents.add(healthEventKey);
        }
      } catch (error) {
        profileError = error.message;
      }
    }
    const transactions = adapter.history({ limit: 20 }).transactions.map(publicTransaction);
    const recent = listActivities({ profile: selectedName ?? undefined, limit: 8 });
    return {
      token,
      sessionId,
      runtime,
      dshHome: discovery.home,
      dataDir: adapter.dataDir,
      profiles: discovery.profiles,
      skippedProfiles: discovery.skipped,
      selectedProfile: publicProfile(profile),
      profileError,
      health: publicHealth(health),
      pendingPlans: [...plans.values()].filter((plan) => !selectedName || plan.profile === selectedName).map(publicPlan),
      transactions,
      recentActivities: recent.activities,
      events: recent.activities,
      localOnly: true,
      nodeVersion: process.versions.node,
    };
  }

  async function route(request, response, next) {
    const url = new URL(request.url ?? "/", "http://dsh-switchboard.local");
    if (!url.pathname.startsWith("/api/")) {
      if (next) next();
      return false;
    }
    try {
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        writeJson(response, 200, await bootstrap(url));
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/activities") {
        writeJson(response, 200, { sessionId, ...activitiesFromUrl(url) });
        return true;
      }
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "Method not allowed" });
        return true;
      }
      requireWriteAccess(request);
      const body = await readJson(request);

      if (url.pathname === "/api/activities/session/clear") {
        const cleared = adapter.clearActivitiesForSession(sessionId);
        writeJson(response, 200, { sessionId, cleared });
        return true;
      }

      let match = url.pathname.match(/^\/api\/profiles\/([^/]+)\/health$/);
      if (match) {
        const profileName = assertProfileName(decodeURIComponent(match[1]));
        const health = await adapter.healthCheck(profileName);
        addEvent({
          profile: profileName,
          kind: "health",
          status: health.ok ? "success" : "warning",
          title: health.ok ? "DSH 配置验证通过" : "DSH 健康检查需要处理",
          detail: health.ok ? `dsh --profile ${profileName} --dump-config 验证通过` : (health.runtime?.diagnostic ?? health.static?.error ?? "检查未通过"),
        });
        writeJson(response, 200, { health: publicHealth(health), activity: publicActivity(adapter.activities({ sessionId, limit: 1 }).activities[0]) });
        return true;
      }

      match = url.pathname.match(/^\/api\/profiles\/([^/]+)\/backups$/);
      if (match) {
        const profileName = assertProfileName(decodeURIComponent(match[1]));
        const transaction = await adapter.backup(profileName, { reason: "DSH Switchboard GUI manual backup" });
        addEvent({ profile: profileName, kind: "backup", status: "success", title: "Profile 手动备份已创建", detail: "当前 Profile 快照已保存到 Switchboard 私有本地数据目录。" });
        writeJson(response, 201, { transaction: publicTransaction(transaction) });
        return true;
      }

      match = url.pathname.match(/^\/api\/profiles\/([^/]+)\/plans$/);
      if (match) {
        const profileName = assertProfileName(decodeURIComponent(match[1]));
        if (!Array.isArray(body.nextBundles)) throw Object.assign(new Error("nextBundles must be an array"), { statusCode: 400 });
        const plan = await adapter.planBundleChange(profileName, body.nextBundles, { reason: "DSH Switchboard GUI" });
        plans.set(plan.id, plan);
        while (plans.size > MAX_PENDING_PLANS) plans.delete(plans.keys().next().value);
        addEvent({ profile: profileName, kind: "plan", status: "info", title: "Bundle 变更计划已生成", detail: "尚未修改 Profile，等待审阅。" });
        writeJson(response, 201, { plan: publicPlan(plan) });
        return true;
      }

      match = url.pathname.match(/^\/api\/plans\/([^/]+)\/apply$/);
      if (match) {
        const planId = decodeURIComponent(match[1]);
        const plan = plans.get(planId);
        if (!plan) throw Object.assign(new Error(`Unknown plan: ${planId}`), { statusCode: 404 });
        const transaction = await adapter.apply(plan, { validateRuntime: body.validateRuntime !== false });
        plans.delete(planId);
        addEvent({ profile: transaction.profile, kind: "apply", status: "success", title: "Bundle 变更已应用", detail: "Profile 已备份并通过 DSH 运行时验证。" });
        writeJson(response, 200, { transaction: publicTransaction(transaction) });
        return true;
      }

      match = url.pathname.match(/^\/api\/transactions\/([^/]+)\/rollback$/);
      if (match) {
        const transactionId = decodeURIComponent(match[1]);
        const before = adapter.history({ limit: 200 }).transactions.find((item) => item.id === transactionId);
        const transaction = await adapter.rollback(transactionId, { force: false, validateRuntime: body.validateRuntime !== false });
        const manual = before?.action === "manual-backup";
        addEvent({ profile: transaction.profile, kind: "rollback", status: "success", title: manual ? "Profile 手动备份已恢复" : "Profile 已回滚", detail: manual ? "恢复前已自动保存恢复点，所选快照已恢复并通过 DSH 运行时验证。" : "备份已恢复并通过 DSH 运行时验证。" });
        writeJson(response, 200, { transaction: publicTransaction(transaction) });
        return true;
      }

      match = url.pathname.match(/^\/api\/profiles\/([^/]+)\/report$/);
      if (match) {
        const profileName = assertProfileName(decodeURIComponent(match[1]));
        const result = await adapter.writeProfileReport(profileName, { audit: false });
        addEvent({ profile: profileName, kind: "report", status: "success", title: "本地报告已生成", detail: "Markdown 和 HTML 报告已保存到私有数据目录。" });
        writeJson(response, 201, result);
        return true;
      }

      writeJson(response, 404, { error: "API route not found" });
      return true;
    } catch (error) {
      writeJson(response, errorStatus(error), { error: error.message, transactionId: error.transactionId ?? null });
      return true;
    }
  }

  return {
    token,
    handler(request, response, next) {
      route(request, response, next).catch((error) => {
        if (!response.headersSent) writeJson(response, 500, { error: error.message });
        else response.destroy(error);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (ownsAdapter) adapter.close();
    },
  };
}
