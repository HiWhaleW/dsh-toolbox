import assert from "node:assert/strict";
import test from "node:test";
import { createDemoApi, detectDemoMode } from "../src/demo-api.js";

test("detects hosted demo domains without treating localhost as a demo", () => {
  assert.equal(detectDemoMode({ hostname: "dsh-toolbox.chatgpt.site" }), true);
  assert.equal(detectDemoMode({ hostname: "127.0.0.1" }), false);
});

test("demo API supports bootstrap, plan, apply, activities, and reset-on-reload semantics", async () => {
  const api = createDemoApi();
  const bootstrap = await api("/api/bootstrap");
  assert.equal(bootstrap.demo, true);
  assert.equal(bootstrap.selectedProfile.name, "toolbox-final");

  const nextBundles = bootstrap.selectedProfile.bundles.filter((name) => name !== "@dsh-toolbox/context-switchboard");
  const { plan } = await api("/api/profiles/toolbox-final/plans", {
    method: "POST",
    body: JSON.stringify({ nextBundles }),
  });
  assert.deepEqual(plan.changes.removals, ["@dsh-toolbox/context-switchboard"]);

  await api(`/api/plans/${plan.id}/apply`, { method: "POST", body: "{}" });
  const changed = await api("/api/bootstrap?profile=toolbox-final");
  assert.equal(changed.selectedProfile.bundles.includes("@dsh-toolbox/context-switchboard"), false);

  const activities = await api("/api/activities?profile=toolbox-final&limit=20");
  assert.ok(activities.activities.some((activity) => activity.kind === "apply"));

  const { transaction: backup } = await api("/api/profiles/toolbox-final/backups", { method: "POST", body: "{}" });
  assert.equal(backup.status, "available");
  const { transaction: restored } = await api(`/api/transactions/${backup.id}/rollback`, { method: "POST", body: "{}" });
  assert.equal(restored.status, "restored");
  const afterRestore = await api("/api/bootstrap?profile=toolbox-final");
  assert.ok(afterRestore.transactions.some((transaction) => transaction.id.startsWith("demo-recovery-") && transaction.status === "available"));

  const freshApi = createDemoApi();
  const fresh = await freshApi("/api/bootstrap");
  assert.equal(fresh.selectedProfile.bundles.includes("@dsh-toolbox/context-switchboard"), true);
});
