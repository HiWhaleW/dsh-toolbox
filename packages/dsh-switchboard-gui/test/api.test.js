import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DshAdapter } from "../../dsh-switchboard/index.js";
import { createSwitchboardApi } from "../server/api.js";

const BASE = "@deepseek-ai/dsh-base";
const EXAMPLE = "@example/research-bundle";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dsh-switchboard-gui-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const profileDir = join(home, "profiles", "toolbox");
  const bundleDir = join(profileDir, "node_modules", "@example", "research-bundle");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(profileDir, "package.json"), JSON.stringify({
    private: true,
    dependencies: { [EXAMPLE]: "1.2.3" },
    dsh: { profile: { bundles: [BASE] } },
  }, null, 2) + "\n");
  await writeFile(join(profileDir, "cordis.patch.yml"), "[]\n");
  await writeFile(join(bundleDir, "package.json"), JSON.stringify({
    name: EXAMPLE,
    version: "1.2.3",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }, null, 2) + "\n");
  await writeFile(join(bundleDir, "cordis.patch.yml"), "[]\n");

  const commandRunner = async ({ args }) => ({ ok: true, code: 0, stdout: args[0] === "--version" ? "0.1.1-rc.2\n" : "# valid\n", stderr: "" });
  const adapter = new DshAdapter({
    home,
    dataDir,
    commandRunner,
  });
  const api = createSwitchboardApi({ adapter, token: "test-session-token", sessionId: "current-test-session" });
  const server = createServer(api.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    adapter.close();
    await rm(root, { recursive: true, force: true });
  });
  return { origin, profileDir, home, dataDir, adapter, commandRunner };
}

async function json(response) {
  const body = await response.json();
  return { response, body };
}

function post(origin, path, body, token = "test-session-token") {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-dsh-switchboard-token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("GUI API keeps bundle changes plan-first, validates apply, and supports safe rollback", async (t) => {
  const setup = await fixture(t);
  const bootstrap = await json(await fetch(`${setup.origin}/api/bootstrap?profile=toolbox`));
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.body.runtime.version, "0.1.1-rc.2");
  assert.equal(bootstrap.body.selectedProfile.name, "toolbox");
  assert.equal(bootstrap.body.health.ok, true);
  assert.equal(bootstrap.body.localOnly, true);

  const refused = await json(await post(setup.origin, "/api/profiles/toolbox/plans", { nextBundles: [BASE, EXAMPLE] }, ""));
  assert.equal(refused.response.status, 403);
  assert.match(refused.body.error, /session token/i);

  const planned = await json(await post(setup.origin, "/api/profiles/toolbox/plans", { nextBundles: [BASE, EXAMPLE] }));
  assert.equal(planned.response.status, 201);
  assert.deepEqual(planned.body.plan.changes.additions, [EXAMPLE]);
  assert.deepEqual(JSON.parse(await readFile(join(setup.profileDir, "package.json"), "utf8")).dsh.profile.bundles, [BASE]);

  const applied = await json(await post(setup.origin, `/api/plans/${planned.body.plan.id}/apply`, { validateRuntime: true }));
  assert.equal(applied.response.status, 200);
  assert.equal(applied.body.transaction.status, "applied");
  assert.equal(applied.body.transaction.backupAvailable, true);
  assert.deepEqual(JSON.parse(await readFile(join(setup.profileDir, "package.json"), "utf8")).dsh.profile.bundles, [BASE, EXAMPLE]);

  const rolledBack = await json(await post(setup.origin, `/api/transactions/${applied.body.transaction.id}/rollback`, { validateRuntime: true }));
  assert.equal(rolledBack.response.status, 200);
  assert.equal(rolledBack.body.transaction.status, "rolled-back");
  assert.deepEqual(JSON.parse(await readFile(join(setup.profileDir, "package.json"), "utf8")).dsh.profile.bundles, [BASE]);
});

test("GUI API creates and restores a manual Profile backup", async (t) => {
  const setup = await fixture(t);
  const created = await json(await post(setup.origin, "/api/profiles/toolbox/backups", {}));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.transaction.action, "manual-backup");
  assert.equal(created.body.transaction.status, "available");

  const manifestPath = join(setup.profileDir, "package.json");
  const changed = JSON.parse(await readFile(manifestPath, "utf8"));
  changed.description = "changed after backup";
  await writeFile(manifestPath, JSON.stringify(changed, null, 2) + "\n");

  const restored = await json(await post(setup.origin, `/api/transactions/${created.body.transaction.id}/rollback`, { validateRuntime: true }));
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.transaction.status, "restored");
  assert.doesNotMatch(await readFile(manifestPath, "utf8"), /changed after backup/);
});

test("GUI API refuses cross-site writes and does not expose profile manifest contents", async (t) => {
  const setup = await fixture(t);
  const crossSite = await fetch(`${setup.origin}/api/profiles/toolbox/health`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "cross-site",
      "x-dsh-switchboard-token": "test-session-token",
    },
    body: "{}",
  });
  assert.equal(crossSite.status, 403);

  const bootstrap = await (await fetch(`${setup.origin}/api/bootstrap?profile=toolbox`)).json();
  assert.equal("manifest" in bootstrap.selectedProfile, false);
  assert.equal("dependencies" in bootstrap.selectedProfile, false);

  const clearWithoutToken = await post(setup.origin, "/api/activities/session/clear", {}, "");
  assert.equal(clearWithoutToken.status, 403);

  const crossSiteClear = await fetch(`${setup.origin}/api/activities/session/clear`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "cross-site",
      "x-dsh-switchboard-token": "test-session-token",
    },
    body: "{}",
  });
  assert.equal(crossSiteClear.status, 403);
});

test("activities persist in SQLite, support filters and cursors, and clear only the current session", async (t) => {
  const setup = await fixture(t);
  setup.adapter.addActivity({
    id: "historic-activity",
    sessionId: "previous-session",
    profile: "toolbox",
    kind: "report",
    status: "success",
    title: "历史报告已生成",
    detail: "来自上一次本地会话",
    createdAt: "2026-08-13T08:00:00.000Z",
  });

  const bootstrap = await (await fetch(`${setup.origin}/api/bootstrap?profile=toolbox`)).json();
  assert.equal(bootstrap.sessionId, "current-test-session");
  assert.equal(bootstrap.recentActivities[0].kind, "health");

  await post(setup.origin, "/api/profiles/toolbox/health", {});
  const firstPage = await json(await fetch(`${setup.origin}/api/activities?profile=toolbox&kind=health&status=success&limit=1`));
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.body.total, 2);
  assert.equal(firstPage.body.activities.length, 1);
  assert.ok(firstPage.body.nextCursor);

  const secondPage = await json(await fetch(`${setup.origin}/api/activities?profile=toolbox&kind=health&status=success&limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`));
  assert.equal(secondPage.response.status, 200);
  assert.equal(secondPage.body.activities.length, 1);
  assert.notEqual(secondPage.body.activities[0].id, firstPage.body.activities[0].id);

  const malformedCursor = await fetch(`${setup.origin}/api/activities?cursor=not-a-cursor`);
  assert.equal(malformedCursor.status, 400);

  const secondAdapter = new DshAdapter({
    home: setup.home,
    dataDir: setup.dataDir,
    commandRunner: setup.commandRunner,
  });
  const secondApi = createSwitchboardApi({ adapter: secondAdapter, token: "second-token", sessionId: "second-session" });
  const secondServer = createServer(secondApi.handler);
  await new Promise((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
  const secondOrigin = `http://127.0.0.1:${secondServer.address().port}`;
  const persisted = await (await fetch(`${secondOrigin}/api/activities?profile=toolbox`)).json();
  assert.ok(persisted.activities.some((activity) => activity.id === "historic-activity"));
  await new Promise((resolve) => secondServer.close(resolve));
  secondAdapter.close();

  const cleared = await json(await post(setup.origin, "/api/activities/session/clear", {}));
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.cleared, 2);

  const currentSession = await (await fetch(`${setup.origin}/api/activities?profile=toolbox&session=current`)).json();
  assert.equal(currentSession.total, 0);
  const remaining = await (await fetch(`${setup.origin}/api/activities?profile=toolbox`)).json();
  assert.equal(remaining.total, 1);
  assert.equal(remaining.activities[0].id, "historic-activity");
});
