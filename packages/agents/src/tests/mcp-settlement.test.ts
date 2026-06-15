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

  it("schedules the delivery before cancelling the deadline, delivering once across a restart", async () => {
    // Guards the awake-settle ordering: the callback schedule must be inserted
    // (and recorded) BEFORE the deadline alarm is cancelled, so an eviction at
    // an await boundary can never leave the intent terminal-but-undelivered
    // with no alarm to wake recovery. After the settle there is exactly one
    // schedule — the delivery, not the deadline — and a cold restore delivers
    // exactly once (no orphaned row, no double).
    const stub = await settlementAgent("deliver-before-cancel");

    await stub.seedMcpServer(
      "dbc-server",
      "https://mcp.example.com/dbc",
      MCPConnectionState.CONNECTED
    );
    const watch = await stub.createSettlementWatchByServerId("dbc-server", {
      deadlineMs: 60_000
    });
    expect(
      (await stub.getSettlementIntentRows())[0].deadline_schedule_id
    ).toBeTruthy();

    // Awake path settles via a ready transition.
    await stub.makeServerReadyThroughDiscovery("dbc-server");
    const settledRow = await waitForSettlementSchedule(stub, watch.intentId);

    // Delivery recorded BEFORE the deadline was cancelled: the durable
    // `delivery_schedule_id` is set (so an eviction here would replay it, never
    // orphan it) and the deadline is cleared.
    expect(settledRow.status).toBe("settled");
    expect(settledRow.delivery_schedule_id).toBeTruthy();
    expect(settledRow.deadline_schedule_id).toBeNull();

    // No deadline alarm remains armed (it was cancelled after the delivery
    // schedule landed).
    const schedules = await stub.getSettlementScheduleRows();
    expect(
      schedules.some(
        (schedule) =>
          schedule.callback === "_cf_checkMcpSettlementIntentDeadline"
      )
    ).toBe(false);

    // Deliver, then cold-restore (re-running recovery): still exactly once.
    await runDurableObjectAlarm(stub);
    await stub.recoverSettlementIntentsForTest();
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

  it("isolates a corrupt server on restore: recovery runs and the stale snapshot is downgraded", async () => {
    // A corrupt row (unparseable `server_options`) must be isolated per-server
    // inside restore so it neither (a) skips the post-restore recovery hook —
    // the durable backstop for settlement watches — nor (b) leaves its own stale
    // `ready` snapshot readable by cross-DO consumers after a wake where no
    // connection was restored.
    const stub = await settlementAgent("recover-despite-restore-throw");

    // A healthy READY server with a live watch that recovery should settle...
    await stub.seedMcpServer(
      "rdr-ready",
      "https://mcp.example.com/rdr",
      MCPConnectionState.READY
    );
    await stub.insertLiveSettlementIntentForTest("rdr-live", "rdr-ready");

    // ...alongside a corrupt config row that was `ready` before hibernation.
    await stub.seedCorruptServerOptionsForTest(
      "rdr-corrupt",
      "https://mcp.example.com/rdr-corrupt"
    );
    await stub.seedReadySnapshotRowForTest("rdr-corrupt");
    expect(
      (await stub.getPersistedServerStateForTest("rdr-corrupt"))?.state
    ).toBe(MCPConnectionState.READY);

    // Wake with restore actually re-running (so it hits the corrupt row).
    await stub.recoverWithRestoreRerunForTest();

    // (a) Recovery still settled the healthy server's live watch.
    await waitForSettlementSchedule(stub, "rdr-live");
    await runDurableObjectAlarm(stub);
    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
    expect(
      (await stub.getSettlementIntentRows()).find((r) => r.id === "rdr-live")
        ?.status
    ).toBe("settled");

    // (b) The corrupt server's stale `ready` snapshot was downgraded — a
    // cross-DO consumer no longer reads a connection that was never restored.
    expect(
      (await stub.getPersistedServerStateForTest("rdr-corrupt"))?.state
    ).not.toBe(MCPConnectionState.READY);
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

  it("persists per-server state (level-triggered poll-on-wake enabler)", async () => {
    const stub = await settlementAgent("persisted-state");

    await stub.seedMcpServer(
      "ps-server",
      "https://mcp.example.com/ps",
      MCPConnectionState.CONNECTED
    );

    // registerServer drove one transition → a snapshot row exists.
    const afterRegister =
      await stub.getPersistedServerStateForTest("ps-server");
    expect(afterRegister).not.toBeNull();
    expect(afterRegister!.state).toBeTruthy();

    await stub.makeServerReadyThroughDiscovery("ps-server");
    const afterReady = await stub.getPersistedServerStateForTest("ps-server");
    expect(afterReady!.state).toBe(MCPConnectionState.READY);

    // The live state-change payload reports the same latest state.
    const change = await stub.getServerStateChangeForTest("ps-server");
    expect(change!.state).toBe(MCPConnectionState.READY);

    // No-op re-notify (same ready state) must not churn the snapshot row.
    const rowsBefore = await stub.getServerStateRowsForTest();
    await stub.makeServerReadyThroughDiscovery("ps-server");
    const afterNoop = await stub.getPersistedServerStateForTest("ps-server");
    expect(afterNoop!.state).toBe(MCPConnectionState.READY);
    expect(await stub.getServerStateRowsForTest()).toEqual(rowsBefore);

    // Removal deletes the durable snapshot row.
    await stub.removeMcpServerForSettlementTest("ps-server");
    expect(await stub.getPersistedServerStateForTest("ps-server")).toBeNull();
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
  // downgraded to the transitional state synchronously during restore.
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

    // Fresh post-hibernation instance: connections gone, restore re-runs. The
    // returned snapshot is captured synchronously right after restore, so it
    // reflects the transitional state restore persisted (not the eventual
    // background-reconnect outcome).
    const afterWake = await stub.simulateColdRestoreForTest("stale-server");
    expect(afterWake.state).not.toBe(MCPConnectionState.READY);
    expect(afterWake.state).toBe(MCPConnectionState.CONNECTING);
  });

  // Migrating onto a previously-used id: the snapshot is level-triggered, so the
  // new id's snapshot reflects current live state and the old id's row is gone.
  it("reflects current state on the new id after migrating onto a recycled id", async () => {
    const stub = await settlementAgent("migrate-recycled");

    // Drive "new-id" to ready, then remove it (snapshot row deleted).
    await stub.seedMcpServer(
      "new-id",
      "https://mcp.example.com/new",
      MCPConnectionState.CONNECTED
    );
    await stub.makeServerReadyThroughDiscovery("new-id");
    await stub.removeMcpServerForSettlementTest("new-id");
    expect(await stub.getPersistedServerStateForTest("new-id")).toBeNull();

    // A fresh "old-id" connects.
    await stub.seedMcpServer(
      "old-id",
      "https://mcp.example.com/old",
      MCPConnectionState.CONNECTED
    );

    // Migrate old-id → new-id. The new id's snapshot reflects old-id's live
    // state; the old id's row is gone.
    await stub.migrateServerIdForTest("old-id", "new-id");

    const after = await stub.getPersistedServerStateForTest("new-id");
    expect(after).not.toBeNull();
    expect(after!.state).toBe(MCPConnectionState.CONNECTED);
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

  // Defence-in-depth for the crash window: a same-key retry must repair an
  // unarmed deadline in-session, not rely solely on the next wake — load-bearing
  // for abandoned-OAuth, where the deadline alarm is the only wake source.
  it("re-arms an unarmed deadline on a same-key retry without waiting for a wake", async () => {
    const stub = await settlementAgent("retry-rearm");

    // Crash window: a live keyed intent with a deadline but no armed schedule.
    await stub.insertKeyedUnarmedDeadlineIntentForTest(
      "retry-intent",
      "https://mcp.example.com/retry",
      60_000,
      "retry-key"
    );
    let rows = await stub.getSettlementIntentRows();
    expect(rows[0].deadline_schedule_id).toBeNull();

    // Retry with the SAME idempotencyKey (created: false) must arm the deadline.
    const result = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/retry",
      { deadlineMs: 60_000, idempotencyKey: "retry-key" }
    );
    expect(result.created).toBe(false);
    expect(result.intentId).toBe("retry-intent");

    rows = await stub.getSettlementIntentRows();
    const deadlineScheduleId = rows[0].deadline_schedule_id;
    expect(deadlineScheduleId).toBeTruthy();

    // The repaired deadline fires a timeout with no watcher and no prior wake.
    await stub.expireSettlementDeadline("retry-intent");
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
    expect(await stub.getPersistedServerStateForTest("gone")).not.toBeNull();
    await stub.clearRecordedStateChanges();

    await stub.removeMcpServerForSettlementTest("gone");

    const removed = (await stub.getRecordedStateChanges()).filter(
      (change) => change.state === "removed"
    );
    expect(removed).toHaveLength(1);
    expect(removed[0].serverId).toBe("gone");
    expect(removed[0].url).toBe("https://mcp.example.com/gone");
    // Removal deletes the snapshot row outright (no tombstone).
    expect(await stub.getPersistedServerStateForTest("gone")).toBeNull();
    expect(
      (await stub.getServerStateRowsForTest()).find(
        (r) => r.server_id === "gone"
      )
    ).toBeUndefined();
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
    // No snapshot row was ever written — the state is derived from the pending
    // OAuth auth_url, not read from a row.
    expect(snapshot!.state).toBe(MCPConnectionState.AUTHENTICATING);
    expect(
      (await stub.getServerStateRowsForTest()).find(
        (r) => r.server_id === "upgraded"
      )
    ).toBeUndefined();

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
});
