import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "..";
import { MCPConnectionState } from "../mcp/client-connection";

let testId = 0;

async function settlementAgent(name: string) {
  testId++;
  const stub = await getAgentByName(
    env.TestMcpSettlementAgent,
    `mcp-settlement-${testId}-${name}`
  );
  await stub.clearSettlementTestState();
  return stub;
}

type SettlementAgentStub = Awaited<ReturnType<typeof settlementAgent>>;

async function waitForSettlementSchedule(
  stub: SettlementAgentStub,
  intentId: string
) {
  // The awake-path delivery is scheduled fire-and-forget, so poll for it. Budget
  // ~2s (100 × 20ms) to stay non-flaky under CI load in vitest-pool-workers.
  for (let i = 0; i < 100; i++) {
    const rows = await stub.getSettlementIntentRows();
    const row = rows.find((item) => item.id === intentId);
    if (row?.delivery_schedule_id) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Settlement delivery was not scheduled for ${intentId}`);
}

describe("durable MCP settlement watches", () => {
  it("fires immediately through schedule when the server already matches", async () => {
    const stub = await settlementAgent("already-ready");

    await stub.seedMcpServer(
      "ready-server",
      "https://mcp.example.com/ready",
      MCPConnectionState.READY
    );

    const watch = await stub.createSettlementWatchByServerId("ready-server", {
      deadlineMs: 60_000
    });
    expect(watch.created).toBe(true);

    const rows = await stub.getSettlementIntentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("settled");
    expect(rows[0].deadline_schedule_id).toBeNull();
    expect(rows[0].delivery_schedule_id).toBeTruthy();

    const schedules = await stub.getSettlementScheduleRows();
    expect(
      schedules.some(
        (schedule) =>
          schedule.callback === "_cf_checkMcpSettlementIntentDeadline"
      )
    ).toBe(false);

    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
    if (results[0].type === "settled") {
      expect(results[0].serverId).toBe("ready-server");
      expect(results[0].state).toBe(MCPConnectionState.READY);
    }
  });

  it("settles on a ready transition and cancels the pending deadline alarm", async () => {
    const stub = await settlementAgent("transition-ready");

    await stub.seedMcpServer(
      "transition-server",
      "https://mcp.example.com/transition",
      MCPConnectionState.CONNECTED
    );
    const watch = await stub.createSettlementWatchByServerId(
      "transition-server",
      { deadlineMs: 60_000 }
    );

    let rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("live");
    expect(rows[0].deadline_schedule_id).toBeTruthy();

    await stub.makeServerReadyThroughDiscovery("transition-server");
    const settledRow = await waitForSettlementSchedule(stub, watch.intentId);
    expect(settledRow.status).toBe("settled");
    expect(settledRow.deadline_schedule_id).toBeNull();

    const schedules = await stub.getSettlementScheduleRows();
    expect(
      schedules.some(
        (schedule) =>
          schedule.callback === "_cf_checkMcpSettlementIntentDeadline"
      )
    ).toBe(false);

    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
  });

  it("fires timeout through the guarded deadline callback", async () => {
    const stub = await settlementAgent("timeout");

    const watch = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/timeout",
      { deadlineMs: 60_000 }
    );
    let rows = await stub.getSettlementIntentRows();
    const deadlineScheduleId = rows[0].deadline_schedule_id;
    expect(deadlineScheduleId).toBeTruthy();

    await stub.expireSettlementDeadline(watch.intentId);
    await stub.backdateSchedule(deadlineScheduleId!, 1);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("timeout");
    if (results[0].type === "timeout") {
      expect(results[0].targetStates).toEqual([
        MCPConnectionState.READY,
        MCPConnectionState.FAILED
      ]);
    }

    rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("timeout");
  });

  it("cancels explicit watches and server-removal watches durably", async () => {
    const stub = await settlementAgent("cancel");

    await stub.seedMcpServer(
      "cancel-server",
      "https://mcp.example.com/cancel",
      MCPConnectionState.CONNECTED
    );
    const explicit = await stub.createSettlementWatchByServerId(
      "cancel-server",
      { deadlineMs: 60_000 }
    );
    await stub.cancelSettlementWatchForTest(explicit.intentId);

    let row = await waitForSettlementSchedule(stub, explicit.intentId);
    expect(row.status).toBe("cancelled");
    expect(row.deadline_schedule_id).toBeNull();

    const removal = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/cancel",
      { deadlineMs: 60_000 }
    );
    await stub.removeMcpServerForSettlementTest("cancel-server");

    row = await waitForSettlementSchedule(stub, removal.intentId);
    expect(row.status).toBe("cancelled");
    expect(row.server_id).toBeNull();

    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.type === "cancelled")).toBe(true);
  });

  it("recovers on wake even when onStart omits super (no in-memory events)", async () => {
    const stub = await settlementAgent("recover");

    await stub.seedMcpServer(
      "recover-ready",
      "https://mcp.example.com/recover",
      MCPConnectionState.READY
    );
    await stub.insertLiveSettlementIntentForTest(
      "live-recover",
      "recover-ready"
    );
    await stub.insertTerminalUndeliveredSettlementForTest("terminal-recover");

    // recoverSettlementIntentsForTest() re-runs the framework onStart wrapper,
    // whose wake handler runs recovery. The test agent's onStart override does
    // NOT call super — proving recovery survives a forgotten super.onStart().
    await stub.recoverSettlementIntentsForTest();
    expect(await stub.didOnStartRunWithoutSuper()).toBe(true);

    await waitForSettlementSchedule(stub, "live-recover");
    await waitForSettlementSchedule(stub, "terminal-recover");
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results.map((result) => result.type).sort()).toEqual([
      "cancelled",
      "settled"
    ]);

    const rows = await stub.getSettlementIntentRows();
    expect(rows.find((row) => row.id === "live-recover")?.status).toBe(
      "settled"
    );
    expect(
      rows.find((row) => row.id === "terminal-recover")?.delivery_schedule_id
    ).toBeTruthy();
  });

  it("re-arms a deadline that fires early with a fresh future-dated schedule", async () => {
    const stub = await settlementAgent("deadline-early");

    await stub.createSettlementWatchByUrl("https://mcp.example.com/early", {
      deadlineMs: 60_000
    });
    let rows = await stub.getSettlementIntentRows();
    const firstScheduleId = rows[0].deadline_schedule_id;
    expect(firstScheduleId).toBeTruthy();

    // Make the deadline alarm due *without* expiring deadline_at — simulates
    // schedule()'s sub-second flooring firing the alarm early.
    await stub.backdateSchedule(firstScheduleId!, 5);
    await runDurableObjectAlarm(stub);

    // Must NOT have settled, and must have re-armed with a *fresh* future-dated
    // row (not the deleted firing row — the idempotent-dedupe trap, where an
    // idempotent re-schedule would resolve to the row the alarm loop is about
    // to delete).
    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(0);
    rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("live");
    const newScheduleId = rows[0].deadline_schedule_id;
    expect(newScheduleId).toBeTruthy();
    expect(newScheduleId).not.toBe(firstScheduleId);

    const deadlineSchedules = (await stub.getSettlementScheduleRows()).filter(
      (s) => s.callback === "_cf_checkMcpSettlementIntentDeadline"
    );
    expect(deadlineSchedules).toHaveLength(1);
    expect(deadlineSchedules[0].id).toBe(newScheduleId);
    expect(deadlineSchedules[0].time! * 1000).toBeGreaterThan(Date.now());
  });

  it("settles on a custom target state", async () => {
    const stub = await settlementAgent("custom-states");

    await stub.seedMcpServer(
      "custom-server",
      "https://mcp.example.com/custom",
      MCPConnectionState.CONNECTED
    );
    const watch = await stub.createSettlementWatchByServerId("custom-server", {
      states: [MCPConnectionState.CONNECTED]
    });

    await waitForSettlementSchedule(stub, watch.intentId);
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
    if (results[0].type === "settled") {
      expect(results[0].state).toBe(MCPConnectionState.CONNECTED);
    }
  });

  it("matches URL targets after normalization (default port)", async () => {
    const stub = await settlementAgent("url-norm");

    await stub.seedMcpServer(
      "norm-server",
      "https://mcp.example.com/norm",
      MCPConnectionState.READY
    );
    // Explicit :443 should normalize to the same server.
    const watch = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com:443/norm"
    );

    await waitForSettlementSchedule(stub, watch.intentId);
    const rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("settled");
  });

  it("cancelling twice does not double-deliver", async () => {
    const stub = await settlementAgent("double-cancel");

    await stub.seedMcpServer(
      "dc-server",
      "https://mcp.example.com/dc",
      MCPConnectionState.CONNECTED
    );
    const watch = await stub.createSettlementWatchByServerId("dc-server");

    expect(await stub.cancelSettlementWatchForTest(watch.intentId)).toBe(true);
    // Second cancel of an already-terminal intent is a no-op.
    expect(await stub.cancelSettlementWatchForTest(watch.intentId)).toBe(false);

    await runDurableObjectAlarm(stub);
    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("cancelled");
  });

  it("persists per-server state with a monotonic version (poll-on-wake enabler)", async () => {
    const stub = await settlementAgent("persisted-state");

    await stub.seedMcpServer(
      "ps-server",
      "https://mcp.example.com/ps",
      MCPConnectionState.CONNECTED
    );

    // registerServer drove one transition → version >= 1.
    const afterRegister =
      await stub.getPersistedServerStateForTest("ps-server");
    expect(afterRegister).not.toBeNull();
    const v1 = afterRegister!.version;
    expect(v1).toBeGreaterThanOrEqual(1);

    await stub.makeServerReadyThroughDiscovery("ps-server");
    const afterReady = await stub.getPersistedServerStateForTest("ps-server");
    expect(afterReady!.state).toBe(MCPConnectionState.READY);
    expect(afterReady!.version).toBeGreaterThan(v1);

    // The live state-change payload shares the same version cursor.
    const change = await stub.getServerStateChangeForTest("ps-server");
    expect(change!.version).toBe(afterReady!.version);

    // No-op re-notify (same ready state) must NOT bump the version.
    await stub.makeServerReadyThroughDiscovery("ps-server");
    const afterNoop = await stub.getPersistedServerStateForTest("ps-server");
    expect(afterNoop!.version).toBe(afterReady!.version);

    // Removal clears the durable snapshot.
    await stub.removeMcpServerForSettlementTest("ps-server");
    expect(await stub.getPersistedServerStateForTest("ps-server")).toBeNull();
  });

  it("keeps version monotonic across remove + re-add of a stable id", async () => {
    const stub = await settlementAgent("version-readd");

    await stub.seedMcpServer(
      "stable-id",
      "https://mcp.example.com/stable",
      MCPConnectionState.CONNECTED
    );
    await stub.makeServerReadyThroughDiscovery("stable-id");
    const before = await stub.getPersistedServerStateForTest("stable-id");
    const versionBeforeRemove = before!.version;

    await stub.removeMcpServerForSettlementTest("stable-id");

    // Re-add under the SAME stable id — version must continue, not reset to 1,
    // so a `version > lastSeen` consumer cursor doesn't go backwards and stall.
    await stub.seedMcpServer(
      "stable-id",
      "https://mcp.example.com/stable",
      MCPConnectionState.CONNECTED
    );
    const after = await stub.getPersistedServerStateForTest("stable-id");
    expect(after!.version).toBeGreaterThan(versionBeforeRemove);
  });

  it("resolves AUTHENTICATING from auth_url when no live connection exists", async () => {
    const stub = await settlementAgent("authenticating");

    await stub.seedAuthPendingServer(
      "auth-server",
      "https://mcp.example.com/auth"
    );

    // The shared resolver (which feeds both the live event and the persisted
    // snapshot) reports AUTHENTICATING from auth_url even with no connection.
    const change = await stub.getServerStateChangeForTest("auth-server");
    expect(change!.state).toBe(MCPConnectionState.AUTHENTICATING);
  });

  it("allows a fresh watch under a reused idempotencyKey after the prior one settled", async () => {
    const stub = await settlementAgent("idem-after-terminal");

    const first = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/reuse",
      { idempotencyKey: "reuse-key" }
    );
    // Take the first watch terminal.
    await stub.cancelSettlementWatchForTest(first.intentId);

    // Same key is now free (partial unique index only covers live rows).
    const second = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/reuse",
      { idempotencyKey: "reuse-key" }
    );
    expect(second.created).toBe(true);
    expect(second.intentId).not.toBe(first.intentId);
  });

  it("uses compatible idempotency semantics and real SQLite constraints", async () => {
    const stub = await settlementAgent("constraints");

    const first = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/key",
      { idempotencyKey: "same-key" }
    );
    const second = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/key",
      { idempotencyKey: "same-key" }
    );
    expect(second).toEqual({ created: false, intentId: first.intentId });

    const incompatibleMessage = await stub.tryCreateSettlementWatchByUrl(
      "https://mcp.example.com/key",
      {
        callbackName: "onOtherMcpSettlement",
        idempotencyKey: "same-key"
      }
    );
    expect(incompatibleMessage).toContain("different options");

    const duplicateMessage =
      await stub.tryInsertDuplicateLiveIdempotencyKeyForTest("same-key");
    expect(duplicateMessage).not.toBe("inserted");
    expect(duplicateMessage).toMatch(/constraint/i);

    const invalidStatusMessage =
      await stub.tryInsertInvalidSettlementStatusForTest();
    expect(invalidStatusMessage).not.toBe("inserted");
    expect(invalidStatusMessage).toMatch(/constraint/i);
  });

  it("treats target states as an unordered set under one idempotency key", async () => {
    const stub = await settlementAgent("states-order");

    const first = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/order",
      {
        idempotencyKey: "order-key",
        states: [MCPConnectionState.READY, MCPConnectionState.FAILED]
      }
    );
    // Same set, reversed order — must dedupe, not throw "different options".
    const second = await stub.tryCreateSettlementWatchByUrl(
      "https://mcp.example.com/order",
      {
        idempotencyKey: "order-key",
        states: [MCPConnectionState.FAILED, MCPConnectionState.READY]
      }
    );
    expect(second).toBe("created");
    const rows = await stub.getSettlementIntentRows();
    expect(rows.filter((r) => r.idempotency_key === "order-key")).toHaveLength(
      1
    );
    expect(first.created).toBe(true);
  });

  // The real hibernation path. Unlike the "recovers on wake" test (which keeps
  // a READY connection so rederive settles synchronously), here the connection
  // is mid-reconnect (CONNECTING) when recovery runs — reproducing the post-wake
  // window where restoreConnectionsFromStorage has kicked off a background
  // reconnect that has not yet reached ready/failed. The intent must stay live
  // through rederive (CONNECTING ∉ target states) and only settle on the later
  // real transition.
  it("does not settle on wake while reconnecting, then settles on the real transition", async () => {
    const stub = await settlementAgent("evict-recover");

    await stub.seedMcpServer(
      "evict-server",
      "https://mcp.example.com/evict",
      MCPConnectionState.CONNECTED
    );
    const watch = await stub.createSettlementWatchByServerId("evict-server");

    let rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("live");

    // Simulate the in-flight reconnect: the connection sits in CONNECTING,
    // durable rows intact.
    await stub.evictConnectionsForTest();

    // Wake: rederive runs against the genuine CONNECTING state (not a target)
    // → the intent must stay live (NOT settle prematurely).
    await stub.recoverSettlementIntentsForTest();

    rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("live");
    expect(await stub.getSettlementResults()).toHaveLength(0);

    // Reconnect, then drive a real READY transition (which notifies) — the
    // awake path now settles the still-live intent.
    await stub.seedMcpServer(
      "evict-server",
      "https://mcp.example.com/evict",
      MCPConnectionState.CONNECTED
    );
    await stub.makeServerReadyThroughDiscovery("evict-server");
    await waitForSettlementSchedule(stub, watch.intentId);
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
  });

  // At-least-once must not become more-than-once. After the awake path settles
  // and schedules delivery, repeated wakes + alarms must never re-deliver: the
  // terminal row already carries a delivery_schedule_id so rederive skips it,
  // and even a re-schedule would dedupe on the persisted schedule row. Exactly
  // one callback must fire across the whole sequence.
  it("delivers exactly once across the awake settle and later wakes", async () => {
    const stub = await settlementAgent("exactly-once");

    await stub.seedMcpServer(
      "eo-server",
      "https://mcp.example.com/eo",
      MCPConnectionState.CONNECTED
    );
    const watch = await stub.createSettlementWatchByServerId("eo-server");

    // Awake path settles + schedules the delivery.
    await stub.makeServerReadyThroughDiscovery("eo-server");
    await waitForSettlementSchedule(stub, watch.intentId);
    await runDurableObjectAlarm(stub);

    // Wake twice (each runs rederive) with an alarm drain in between — neither
    // may produce a second delivery.
    await stub.recoverSettlementIntentsForTest();
    await runDurableObjectAlarm(stub);
    await stub.recoverSettlementIntentsForTest();
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");

    const row = (await stub.getSettlementIntentRows()).find(
      (r) => r.id === watch.intentId
    );
    expect(row?.status).toBe("settled");
  });

  // registerServer({ authUrl }) keeps a live (default CONNECTING) connection;
  // the first snapshot must report AUTHENTICATING, not CONNECTING.
  it("reports authenticating for a registerServer({ authUrl }) with a live connection", async () => {
    const stub = await settlementAgent("authurl-register");

    await stub.seedServerWithAuthUrl(
      "authurl-server",
      "https://mcp.example.com/authurl"
    );

    const change = await stub.getServerStateChangeForTest("authurl-server");
    expect(change!.state).toBe(MCPConnectionState.AUTHENTICATING);

    const snapshot =
      await stub.getPersistedServerStateForTest("authurl-server");
    expect(snapshot!.state).toBe(MCPConnectionState.AUTHENTICATING);
  });

  // The durable cross-DO snapshot must not serve a stale `ready` after the
  // owner wakes: a server that was `ready` before hibernation is being
  // re-established on wake (its auth may no longer be valid), so the snapshot is
  // downgraded to the transitional state synchronously during restore — with an
  // advanced version so a version-deduping consumer actually observes it.
  it("does not serve a stale ready snapshot after wake while reconnecting", async () => {
    const stub = await settlementAgent("stale-ready");

    await stub.seedMcpServer(
      "stale-server",
      "https://mcp.example.com/stale",
      MCPConnectionState.CONNECTED
    );
    await stub.makeServerReadyThroughDiscovery("stale-server");

    const ready = await stub.getPersistedServerStateForTest("stale-server");
    expect(ready!.state).toBe(MCPConnectionState.READY);
    const readyVersion = ready!.version;

    // Fresh post-hibernation instance: connections gone, restore re-runs. The
    // returned snapshot is captured synchronously right after restore, so it
    // reflects the transitional state restore persisted (not the eventual
    // background-reconnect outcome).
    const afterWake = await stub.simulateColdRestoreForTest("stale-server");
    expect(afterWake.state).not.toBe(MCPConnectionState.READY);
    expect(afterWake.state).toBe(MCPConnectionState.CONNECTING);
    expect(afterWake.version).toBeGreaterThan(readyVersion);
  });

  // Migrating onto a previously-used (tombstoned) id must not move the version
  // cursor backwards.
  it("keeps version monotonic when migrating onto a recycled id", async () => {
    const stub = await settlementAgent("migrate-monotonic");

    // Drive "new-id" to a high version, then remove it (tombstone bumps again).
    await stub.seedMcpServer(
      "new-id",
      "https://mcp.example.com/new",
      MCPConnectionState.CONNECTED
    );
    await stub.makeServerReadyThroughDiscovery("new-id");
    await stub.removeMcpServerForSettlementTest("new-id");

    // A fresh "old-id" starts at a low version.
    await stub.seedMcpServer(
      "old-id",
      "https://mcp.example.com/old",
      MCPConnectionState.CONNECTED
    );

    // Migrate old-id → new-id. The merged version must exceed the tombstone's,
    // so a consumer holding new-id's higher cursor still observes the re-add.
    await stub.migrateServerIdForTest("old-id", "new-id");

    const after = await stub.getPersistedServerStateForTest("new-id");
    expect(after).not.toBeNull();
    // The tombstone reached version 3 (register=1, ready=2, remove=3); the
    // migrated row must land strictly above it.
    expect(after!.version).toBeGreaterThan(3);
    expect(await stub.getPersistedServerStateForTest("old-id")).toBeNull();
  });

  // A serverId-targeted watch must follow an id migration (rename) rather than
  // hanging. migrateServerId fires onServerIdMigrated; the store re-targets the
  // live intent old → new, and the subsequent transition settles it against the
  // new id.
  it("re-targets a serverId watch across an id migration", async () => {
    const stub = await settlementAgent("migrate-retarget");

    await stub.seedMcpServer(
      "old-conn",
      "https://mcp.example.com/old-conn",
      MCPConnectionState.CONNECTED
    );
    const watch = await stub.createSettlementWatchByServerId("old-conn");

    // Migrate before the server is ready: the intent must re-target, not settle.
    await stub.migrateServerIdForTest("old-conn", "new-conn");

    let rows = await stub.getSettlementIntentRows();
    const row = rows.find((r) => r.id === watch.intentId);
    expect(row?.status).toBe("live");
    expect(row?.server_id).toBe("new-conn");
    expect(await stub.getSettlementResults()).toHaveLength(0);

    // The real transition on the new id settles the re-targeted watch.
    await stub.makeServerReadyThroughDiscovery("new-conn");
    await waitForSettlementSchedule(stub, watch.intentId);
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
    if (results[0].type === "settled") {
      expect(results[0].serverId).toBe("new-conn");
    }
  });

  // The registration crash window: an intent persisted with a deadline but no
  // deadline_schedule_id (crash between the two INSERTs). Recovery is the sole
  // armer of the only timeout driver — it must re-arm, and the timeout must
  // then fire with no watcher. This is the load-bearing G2 guarantee, and the
  // reason wake recovery is an *awaited* hook, not a fire-and-forget event.
  it("re-arms the deadline on wake when registration crashed before arming it", async () => {
    const stub = await settlementAgent("crash-window");

    await stub.insertLiveDeadlineIntentWithoutScheduleForTest(
      "crash-intent",
      "https://mcp.example.com/crash",
      60_000
    );

    let rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("live");
    expect(rows[0].deadline_schedule_id).toBeNull();

    // Wake: recovery must arm the missing deadline schedule.
    await stub.recoverSettlementIntentsForTest();

    rows = await stub.getSettlementIntentRows();
    const deadlineScheduleId = rows[0].deadline_schedule_id;
    expect(deadlineScheduleId).toBeTruthy();

    // Expire + fire it: the timeout fires with no watcher present.
    await stub.expireSettlementDeadline("crash-intent");
    await stub.backdateSchedule(deadlineScheduleId!, 1);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("timeout");
  });

  // A timeout produced by wake re-derivation (deadline already elapsed while
  // hibernating) must cancel the still-armed registration-time deadline alarm,
  // or it fires a spurious wake later — violating the "no idle wakes" guarantee.
  it("cancels the stale deadline alarm when a timeout is settled via rederive", async () => {
    const stub = await settlementAgent("rederive-timeout");

    const watch = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/rederive-timeout",
      { deadlineMs: 60_000 }
    );
    let rows = await stub.getSettlementIntentRows();
    const armedDeadlineId = rows[0].deadline_schedule_id;
    expect(armedDeadlineId).toBeTruthy();

    // The deadline elapses while "hibernating" — expire deadline_at WITHOUT
    // firing the alarm, so rederive (not the firing handler) settles it.
    await stub.expireSettlementDeadline(watch.intentId);
    await stub.recoverSettlementIntentsForTest();
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("timeout");

    rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("timeout");
    expect(rows[0].deadline_schedule_id).toBeNull();

    // No deadline alarm may remain armed (it would be a spurious future wake).
    const deadlineSchedules = (await stub.getSettlementScheduleRows()).filter(
      (s) => s.callback === "_cf_checkMcpSettlementIntentDeadline"
    );
    expect(deadlineSchedules).toHaveLength(0);
  });

  // Per-row isolation: one corrupt live intent must not abort recovery of the
  // others. A row with unparseable target_states is skipped; a healthy live
  // intent alongside it still settles.
  it("isolates a corrupt intent during recovery so healthy intents still settle", async () => {
    const stub = await settlementAgent("row-isolation");

    await stub.seedMcpServer(
      "healthy-server",
      "https://mcp.example.com/healthy",
      MCPConnectionState.READY
    );
    await stub.insertCorruptLiveSettlementIntentForTest("corrupt-intent");
    await stub.insertLiveSettlementIntentForTest(
      "healthy-intent",
      "healthy-server"
    );

    await stub.recoverSettlementIntentsForTest();
    await waitForSettlementSchedule(stub, "healthy-intent");
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");

    const rows = await stub.getSettlementIntentRows();
    expect(rows.find((r) => r.id === "healthy-intent")?.status).toBe("settled");
    // The corrupt row was skipped, not settled, and did not break recovery.
    expect(rows.find((r) => r.id === "corrupt-intent")?.status).toBe("live");
  });

  // Prune + snapshot listing coverage.
  it("prunes aged terminal intents on registration and on wake", async () => {
    const stub = await settlementAgent("prune");

    // An aged terminal row (older than the 24h TTL) should be reclaimed.
    await stub.insertOldTerminalSettlementForTest(
      "old-terminal",
      25 * 60 * 60 * 1000
    );
    let rows = await stub.getSettlementIntentRows();
    expect(rows.some((r) => r.id === "old-terminal")).toBe(true);

    // Registering a new watch triggers the opportunistic prune.
    await stub.createSettlementWatchByUrl("https://mcp.example.com/prune");

    rows = await stub.getSettlementIntentRows();
    expect(rows.some((r) => r.id === "old-terminal")).toBe(false);

    // Wake prune also reclaims aged terminal rows.
    await stub.insertOldTerminalSettlementForTest(
      "old-terminal-2",
      25 * 60 * 60 * 1000
    );
    await stub.recoverSettlementIntentsForTest();
    rows = await stub.getSettlementIntentRows();
    expect(rows.some((r) => r.id === "old-terminal-2")).toBe(false);
  });

  it("lists durable snapshots for every known server", async () => {
    const stub = await settlementAgent("list-snapshots");

    await stub.seedMcpServer(
      "snap-a",
      "https://mcp.example.com/a",
      MCPConnectionState.CONNECTED
    );
    // Drive a notified READY transition so the durable snapshot advances past
    // the register-time state.
    await stub.makeServerReadyThroughDiscovery("snap-a");
    await stub.seedMcpServer(
      "snap-b",
      "https://mcp.example.com/b",
      MCPConnectionState.CONNECTED
    );

    const snapshots = await stub.listPersistedServerStatesForTest();
    const byId = Object.fromEntries(snapshots.map((s) => [s.serverId, s]));
    expect(byId["snap-a"].state).toBe(MCPConnectionState.READY);
    // snap-b's persisted snapshot reflects the register-time transition until a
    // notified change advances it.
    expect(byId["snap-b"].state).toBeTruthy();
    expect(byId["snap-a"].version).toBeGreaterThanOrEqual(1);
    expect(byId["snap-b"].version).toBeGreaterThanOrEqual(1);
  });

  // Removal re-emits a terminal `onServerStateChanged` (state: "removed") so a
  // subscriber that only watches state changes still observes the deletion.
  it('re-emits a terminal onServerStateChanged with state "removed" on removal', async () => {
    const stub = await settlementAgent("removed-state-change");

    await stub.seedMcpServer(
      "gone",
      "https://mcp.example.com/gone",
      MCPConnectionState.READY
    );
    const before = await stub.getPersistedServerStateForTest("gone");
    await stub.clearRecordedStateChanges();

    await stub.removeMcpServerForSettlementTest("gone");

    const removed = (await stub.getRecordedStateChanges()).filter(
      (change) => change.state === "removed"
    );
    expect(removed).toHaveLength(1);
    expect(removed[0].serverId).toBe("gone");
    expect(removed[0].url).toBe("https://mcp.example.com/gone");
    // Tombstone bump keeps `version` strictly monotonic past the last snapshot.
    expect(removed[0].version).toBeGreaterThan(before!.version);
  });

  // The terminal "removed" state-change must not produce a second settlement on
  // top of the cancellation driven by onServerRemoved.
  it("cancels a live watch exactly once on removal", async () => {
    const stub = await settlementAgent("removed-single-settle");

    await stub.seedMcpServer(
      "watched",
      "https://mcp.example.com/watched",
      MCPConnectionState.CONNECTED
    );
    await stub.createSettlementWatchByServerId("watched", {
      deadlineMs: 60_000
    });

    await stub.removeMcpServerForSettlementTest("watched");
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("cancelled");
  });

  // Upgrade path: an existing server with a pending OAuth `auth_url` but no
  // snapshot row must derive AUTHENTICATING, not return a misleading `null`.
  it("derives AUTHENTICATING for an upgraded server with no snapshot row", async () => {
    const stub = await settlementAgent("backfill-auth");

    await stub.seedUpgradedAuthPendingServer(
      "upgraded",
      "https://mcp.example.com/upgraded"
    );

    const snapshot = await stub.getPersistedServerStateForTest("upgraded");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.state).toBe(MCPConnectionState.AUTHENTICATING);
    // No row was ever written, so the version cursor starts at 0.
    expect(snapshot!.version).toBe(0);

    const entry = (await stub.listPersistedServerStatesForTest()).find(
      (s) => s.serverId === "upgraded"
    );
    expect(entry?.state).toBe(MCPConnectionState.AUTHENTICATING);
  });

  // Removal must cancel a serverId-targeted watch even when the last-known url
  // can't be recovered (server never persisted / double-remove).
  it("cancels a serverId-targeted watch on removal even with no stored url", async () => {
    const stub = await settlementAgent("removed-no-url");

    await stub.insertLiveSettlementIntentForTest("orphan-intent", "ghost");
    let rows = await stub.getSettlementIntentRows();
    expect(rows.find((r) => r.id === "orphan-intent")?.status).toBe("live");

    await stub.removeMcpServerForSettlementTest("ghost");

    rows = await stub.getSettlementIntentRows();
    expect(rows.find((r) => r.id === "orphan-intent")?.status).toBe(
      "cancelled"
    );
  });

  // Orphan tombstones (removed-and-not-re-added) are reclaimed once aged past
  // the retention window; live rows and recent tombstones are preserved.
  it("prunes aged orphan server-state tombstones but keeps live and recent rows", async () => {
    const stub = await settlementAgent("prune-tombstones");

    await stub.seedMcpServer(
      "old-orphan",
      "https://mcp.example.com/old-orphan",
      MCPConnectionState.READY
    );
    await stub.removeMcpServerForSettlementTest("old-orphan");

    await stub.seedMcpServer(
      "recent-orphan",
      "https://mcp.example.com/recent-orphan",
      MCPConnectionState.READY
    );
    await stub.removeMcpServerForSettlementTest("recent-orphan");

    await stub.seedMcpServer(
      "live-server",
      "https://mcp.example.com/live",
      MCPConnectionState.READY
    );

    // Age the first tombstone beyond the 24h retention window.
    await stub.backdateServerStateRow("old-orphan", 25 * 60 * 60 * 1000);

    await stub.pruneServerStateTombstonesForTest();

    const ids = (await stub.getServerStateRowsForTest()).map(
      (r) => r.server_id
    );
    expect(ids).not.toContain("old-orphan");
    expect(ids).toContain("recent-orphan");
    expect(ids).toContain("live-server");
  });
});
