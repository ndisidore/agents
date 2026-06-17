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
      deadlineSeconds: 60
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
      { deadlineSeconds: 60 }
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
      deadlineSeconds: 60
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
      { deadlineSeconds: 60 }
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
      // The timeout result reports the deadline in seconds.
      expect(typeof results[0].deadlineSeconds).toBe("number");
    }

    rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("timeout");
  });

  it("rejects a watch with no deadline (deadlineSeconds is required)", async () => {
    const stub = await settlementAgent("require-deadline");

    await stub.seedMcpServer(
      "rd-server",
      "https://mcp.example.com/rd",
      MCPConnectionState.CONNECTED
    );

    const message =
      await stub.createSettlementWatchWithoutDeadlineForTest("rd-server");
    expect(message).toContain("deadlineSeconds");

    // No intent row is persisted when registration is rejected.
    const rows = await stub.getSettlementIntentRows();
    expect(rows).toHaveLength(0);
  });

  it("settles as timeout (not settled) when a target state is reached after the deadline", async () => {
    const stub = await settlementAgent("deadline-authoritative");

    await stub.seedMcpServer(
      "da-server",
      "https://mcp.example.com/da",
      MCPConnectionState.CONNECTED
    );
    const watch = await stub.createSettlementWatchByServerId("da-server", {
      deadlineSeconds: 60
    });

    // The deadline elapses while the server is still merely CONNECTED (not yet
    // a watched target state).
    await stub.expireSettlementDeadline(watch.intentId);

    // The server now reaches READY — but the deadline already passed, so the
    // authoritative outcome is `timeout`, never a late `settled`.
    await stub.makeServerReadyThroughDiscovery("da-server");
    const row = await waitForSettlementSchedule(stub, watch.intentId);
    expect(row.status).toBe("timeout");
    expect(row.deadline_schedule_id).toBeNull();

    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("timeout");
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
      { deadlineSeconds: 60 }
    );
    await stub.cancelSettlementWatchForTest(explicit.intentId);

    let row = await waitForSettlementSchedule(stub, explicit.intentId);
    expect(row.status).toBe("cancelled");
    expect(row.deadline_schedule_id).toBeNull();

    const removal = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/cancel",
      { deadlineSeconds: 60 }
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

  it("isolates a corrupt server on restore so recovery still runs", async () => {
    // A corrupt row (unparseable `server_options`) must be isolated per-server
    // inside restore so it does not skip the post-restore recovery hook — the
    // durable backstop for settlement watches.
    const stub = await settlementAgent("recover-despite-restore-throw");

    // A healthy READY server with a live watch that recovery should settle...
    await stub.seedMcpServer(
      "rdr-ready",
      "https://mcp.example.com/rdr",
      MCPConnectionState.READY
    );
    await stub.insertLiveSettlementIntentForTest("rdr-live", "rdr-ready");

    // ...alongside a corrupt config row that makes restore throw for that server.
    await stub.seedCorruptServerOptionsForTest(
      "rdr-corrupt",
      "https://mcp.example.com/rdr-corrupt"
    );

    // Wake with restore actually re-running (so it hits the corrupt row).
    await stub.recoverWithRestoreRerunForTest();

    // Recovery still settled the healthy server's live watch despite the throw.
    await waitForSettlementSchedule(stub, "rdr-live");
    await runDurableObjectAlarm(stub);
    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
    expect(
      (await stub.getSettlementIntentRows()).find((r) => r.id === "rdr-live")
        ?.status
    ).toBe("settled");
  });

  it("creates independent intents for concurrent watches with different keys", async () => {
    const stub = await settlementAgent("concurrent-keys");

    await stub.seedMcpServer(
      "ck-server",
      "https://mcp.example.com/ck",
      MCPConnectionState.CONNECTING
    );

    const [a, b] = await Promise.all([
      stub.createSettlementWatchByServerId("ck-server", {
        deadlineSeconds: 60,
        idempotencyKey: "key-a"
      }),
      stub.createSettlementWatchByServerId("ck-server", {
        deadlineSeconds: 60,
        idempotencyKey: "key-b"
      })
    ]);

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.intentId).not.toBe(b.intentId);

    const rows = await stub.getSettlementIntentRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.idempotency_key))).toEqual(
      new Set(["key-a", "key-b"])
    );
  });

  it("fires timeout for a 1s deadline (small-deadline flooring path)", async () => {
    const stub = await settlementAgent("one-second-deadline");

    const watch = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/1s",
      { deadlineSeconds: 1 }
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
      // (`expireSettlementDeadline` backdates `deadline_at`, so the reported
      // `deadlineSeconds` reflects that floor rather than the original 1.)
      expect(typeof results[0].deadlineSeconds).toBe("number");
    }

    rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("timeout");
  });

  it("resolves a URL-targeted watch against duplicate server URLs", async () => {
    const stub = await settlementAgent("duplicate-urls");

    // Two servers share the same URL (distinct ids). A URL-targeted watch must
    // resolve to a match and settle rather than throw or hang.
    await stub.seedMcpServer(
      "dup-a",
      "https://mcp.example.com/dup",
      MCPConnectionState.READY
    );
    await stub.seedMcpServer(
      "dup-b",
      "https://mcp.example.com/dup",
      MCPConnectionState.READY
    );

    const watch = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/dup"
    );

    await waitForSettlementSchedule(stub, watch.intentId);
    const rows = await stub.getSettlementIntentRows();
    expect(rows.find((r) => r.id === watch.intentId)?.status).toBe("settled");
  });

  it("rejects deadlineSeconds beyond the 30-day cap", async () => {
    const stub = await settlementAgent("deadline-cap");

    const thirtyDaysPlusOne = 30 * 24 * 60 * 60 + 1;
    const message = await stub.tryCreateSettlementWatchByUrl(
      "https://mcp.example.com/cap",
      { deadlineSeconds: thirtyDaysPlusOne }
    );
    expect(message).toContain("30 days");

    // No intent row was created for the rejected watch.
    expect(await stub.getSettlementIntentRows()).toHaveLength(0);
  });

  it("re-arms a deadline that fires early with a fresh future-dated schedule", async () => {
    const stub = await settlementAgent("deadline-early");

    await stub.createSettlementWatchByUrl("https://mcp.example.com/early", {
      deadlineSeconds: 60
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

  it("reports the latest state via getServerStateChange after a ready transition", async () => {
    const stub = await settlementAgent("state-change-read");

    await stub.seedMcpServer(
      "ps-server",
      "https://mcp.example.com/ps",
      MCPConnectionState.CONNECTED
    );

    await stub.makeServerReadyThroughDiscovery("ps-server");

    // The live state-change payload reports the latest resolved state.
    const change = await stub.getServerStateChangeForTest("ps-server");
    expect(change!.state).toBe(MCPConnectionState.READY);
  });

  it("fires onServerStateChanged on a close downgrade so live subscribers refresh", async () => {
    // A downgrade to no-live-connection (close) must EMIT, not just update the
    // snapshot — otherwise awake subscribers (broadcastMcpServers / a consumer
    // DO's publish) never re-run and keep showing a stale `ready`.
    const stub = await settlementAgent("close-emits");
    await stub.seedMcpServer(
      "ce-server",
      "https://mcp.example.com/ce",
      MCPConnectionState.CONNECTED
    );
    await stub.makeServerReadyThroughDiscovery("ce-server");

    await stub.clearRecordedStateChanges();
    await stub.closeMcpConnectionForTest("ce-server");

    const changes = await stub.getRecordedStateChanges();
    const ceChanges = changes.filter((c) => c.serverId === "ce-server");
    expect(ceChanges.length).toBeGreaterThan(0);
    // The downgrade carries a non-ready (null) state.
    expect(ceChanges.at(-1)!.state).not.toBe(MCPConnectionState.READY);
  });

  it("emits a non-ready state even when connection.close() rejects", async () => {
    const stub = await settlementAgent("close-rejects");
    await stub.seedMcpServer(
      "crj-server",
      "https://mcp.example.com/crj",
      MCPConnectionState.CONNECTED
    );
    await stub.makeServerReadyThroughDiscovery("crj-server");
    expect((await stub.getServerStateChangeForTest("crj-server"))?.state).toBe(
      MCPConnectionState.READY
    );

    // close() rejects, but the in-memory connection is still torn down in the
    // finally — so the resolved state must no longer be `ready` there too.
    const { threw } =
      await stub.closeMcpConnectionExpectingThrowForTest("crj-server");
    expect(threw).toBe(true);

    const change = await stub.getServerStateChangeForTest("crj-server");
    expect(change).not.toBeNull();
    expect(change!.state).not.toBe(MCPConnectionState.READY);
  });

  it("arms the deadline before settling a matching intent on recovery (bridge)", async () => {
    // P1: a registration that crashed after inserting the live intent but before
    // recording deadline_schedule_id leaves a live intent with no armed alarm.
    // Recovery must arm the deadline BEFORE re-deriving/settling, so that if the
    // server already matches and recovery is then evicted before scheduling the
    // delivery, an armed deadline alarm still bridges the gap and wakes
    // redelivery.
    const stub = await settlementAgent("recovery-arm-before-settle");
    await stub.seedMcpServer(
      "rab-server",
      "https://mcp.example.com/rab",
      MCPConnectionState.READY
    );
    await stub.insertLiveServerDeadlineIntentWithoutScheduleForTest(
      "rab-live",
      "rab-server",
      60_000
    );

    // Arm-then-rederive, but stop before scheduling the delivery (the eviction
    // window). With the fix, the now-terminal intent carries an armed deadline.
    await stub.recoverArmThenRederiveWithoutDeliveryForTest();

    const rows = await stub.getSettlementIntentRows();
    const row = rows.find((r) => r.id === "rab-live")!;
    expect(row.status).toBe("settled");
    expect(row.delivery_schedule_id).toBeNull(); // delivery not scheduled yet
    expect(row.deadline_schedule_id).toBeTruthy(); // …but a bridging alarm IS armed
    const deadlineSchedules = (await stub.getSettlementScheduleRows()).filter(
      (s) => s.callback === "_cf_checkMcpSettlementIntentDeadline"
    );
    expect(deadlineSchedules).toHaveLength(1);

    // A full recovery then redelivers exactly once and cancels the deadline.
    await stub.recoverSettlementIntentsForTest();
    await waitForSettlementSchedule(stub, "rab-live");
    await runDurableObjectAlarm(stub);
    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
  });

  it("resolves AUTHENTICATING from auth_url when no live connection exists", async () => {
    const stub = await settlementAgent("authenticating");

    await stub.seedAuthPendingServer(
      "auth-server",
      "https://mcp.example.com/auth"
    );

    // The shared resolver (which feeds the live event) reports AUTHENTICATING
    // from auth_url even with no connection.
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

  it("keeps an armed deadline bridging an immediate settle so recovery can redeliver", async () => {
    // P1: when the target already matches at registration, the terminal row is
    // written synchronously and the delivery is scheduled across an await. If
    // the DO is evicted in that gap there must STILL be an armed alarm (the
    // deadline) so recovery is guaranteed a wake — otherwise the callback is
    // stranded until an unrelated activation.
    const stub = await settlementAgent("immediate-settle-bridge");
    await stub.seedMcpServer(
      "isb-server",
      "https://mcp.example.com/isb",
      MCPConnectionState.READY
    );

    // Register an already-matching watch but stop right after the terminal
    // write (simulating eviction before the delivery schedule lands).
    const { intentId, settled } =
      await stub.armSettleWithoutDeliveryForTest("isb-server");
    expect(settled).toBe(true);

    // Terminal row, no delivery scheduled yet…
    const rows = await stub.getSettlementIntentRows();
    const row = rows.find((r) => r.id === intentId)!;
    expect(row.status).toBe("settled");
    expect(row.delivery_schedule_id).toBeNull();
    // …but a deadline alarm is still armed — the bridge guaranteeing a wake.
    expect(row.deadline_schedule_id).toBeTruthy();
    const deadlineSchedules = (await stub.getSettlementScheduleRows()).filter(
      (s) => s.callback === "_cf_checkMcpSettlementIntentDeadline"
    );
    expect(deadlineSchedules).toHaveLength(1);

    // Recovery (what that alarm triggers on wake) redelivers exactly once and
    // cancels the now-stale deadline.
    await stub.recoverSettlementIntentsForTest();
    await waitForSettlementSchedule(stub, intentId);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
  });

  it("settles ready via post-reconnect re-derivation instead of timing out", async () => {
    // P1: recovery runs while a restored connection is still CONNECTING (the
    // background reconnect is not awaited). On a wake that only ran recovery,
    // nothing keeps the DO alive for the reconnect, so the watch would fall
    // through to its deadline. The bounded waitForConnections → re-derive that
    // recovery anchors must settle the watch once the reconnect reaches READY.
    const stub = await settlementAgent("post-reconnect-rederive");
    await stub.seedMcpServer(
      "prr-server",
      "https://mcp.example.com/prr",
      MCPConnectionState.CONNECTED
    );
    const watch = await stub.createSettlementWatchByServerId("prr-server");

    // In-flight reconnect on wake: the connection sits CONNECTING.
    await stub.evictConnectionsForTest();
    await stub.recoverSettlementIntentsForTest();
    const rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("live"); // not settled, not timed out

    // Background reconnect completes to READY but emits NO in-memory event (the
    // wake-only-for-recovery case). The post-reconnect re-derivation must
    // settle it.
    await stub.setConnectionStateForTest(
      "prr-server",
      MCPConnectionState.READY
    );
    await stub.rederiveDerivedDeliveriesForTest();

    await waitForSettlementSchedule(stub, watch.intentId);
    await runDurableObjectAlarm(stub);
    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
  });

  it("settles a duplicate-URL watch against the server that reached a target state", async () => {
    // P2: two servers share a URL. The second reaches ready while the first is
    // still connecting — the watch must settle (against the ready one), not
    // re-resolve to the first stored server and stay live.
    const stub = await settlementAgent("dup-url-settle");
    await stub.seedMcpServer(
      "dus-a",
      "https://mcp.example.com/dus",
      MCPConnectionState.CONNECTING
    );
    await stub.seedMcpServer(
      "dus-b",
      "https://mcp.example.com/dus",
      MCPConnectionState.CONNECTING
    );

    const watch = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/dus"
    );
    const rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("live"); // neither ready yet

    await stub.makeServerReadyThroughDiscovery("dus-b");
    await waitForSettlementSchedule(stub, watch.intentId);
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");
    if (results[0].type === "settled") {
      expect(results[0].serverId).toBe("dus-b");
    }
  });

  it("keeps a duplicate-URL watch live until the last matching server is removed", async () => {
    // P2: removing ONE of several servers sharing a URL must not cancel a
    // URL-targeted watch that another server still satisfies.
    const stub = await settlementAgent("dup-url-cancel");
    await stub.seedMcpServer(
      "duc-a",
      "https://mcp.example.com/duc",
      MCPConnectionState.CONNECTING
    );
    await stub.seedMcpServer(
      "duc-b",
      "https://mcp.example.com/duc",
      MCPConnectionState.CONNECTING
    );
    const watch = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/duc"
    );

    // Remove one duplicate — another server still serves the URL → stay live.
    await stub.removeMcpServerForSettlementTest("duc-a");
    const rows = await stub.getSettlementIntentRows();
    expect(rows.find((r) => r.id === watch.intentId)?.status).toBe("live");
    expect(await stub.getSettlementResults()).toHaveLength(0);

    // Remove the last matching server → now the watch cancels.
    await stub.removeMcpServerForSettlementTest("duc-b");
    await waitForSettlementSchedule(stub, watch.intentId);
    await runDurableObjectAlarm(stub);
    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("cancelled");
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
  // the resolved state must report AUTHENTICATING, not CONNECTING.
  it("reports authenticating for a registerServer({ authUrl }) with a live connection", async () => {
    const stub = await settlementAgent("authurl-register");

    await stub.seedServerWithAuthUrl(
      "authurl-server",
      "https://mcp.example.com/authurl"
    );

    const change = await stub.getServerStateChangeForTest("authurl-server");
    expect(change!.state).toBe(MCPConnectionState.AUTHENTICATING);
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
      { deadlineSeconds: 60, idempotencyKey: "retry-key" }
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
      { deadlineSeconds: 60 }
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

  // Prune coverage.
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

  // Removal re-emits a terminal `onServerStateChanged` (state: "removed") so a
  // subscriber that only watches state changes still observes the deletion.
  it('re-emits a terminal onServerStateChanged with state "removed" on removal', async () => {
    const stub = await settlementAgent("removed-state-change");

    await stub.seedMcpServer(
      "gone",
      "https://mcp.example.com/gone",
      MCPConnectionState.READY
    );
    await stub.clearRecordedStateChanges();

    await stub.removeMcpServerForSettlementTest("gone");

    const removed = (await stub.getRecordedStateChanges()).filter(
      (change) => change.state === "removed"
    );
    expect(removed).toHaveLength(1);
    expect(removed[0].serverId).toBe("gone");
    expect(removed[0].url).toBe("https://mcp.example.com/gone");
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
      deadlineSeconds: 60
    });

    await stub.removeMcpServerForSettlementTest("watched");
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("cancelled");
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

  it("arms a crash-window intent before settling it on a restore-time transition", async () => {
    // A live intent persisted before its deadline alarm was recorded
    // (registration evicted mid-arm) has no bridging alarm. On wake a restore
    // transition can reach a target state BEFORE recovery re-arms — the awake
    // fast-path must NOT settle it unbridged. It is armed on the durable repair
    // path first, then settled, so a bridging alarm always exists.
    const stub = await settlementAgent("c1-unarmed-awake");

    await stub.seedMcpServer(
      "c1-server",
      "https://mcp.example.com/c1",
      MCPConnectionState.CONNECTED
    );
    await stub.insertLiveServerDeadlineIntentWithoutScheduleForTest(
      "c1-intent",
      "c1-server",
      60_000
    );

    let rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("live");
    expect(rows[0].deadline_schedule_id).toBeNull(); // unarmed

    // A real READY transition fires onServerStateChanged. The synchronous match
    // skips the unarmed intent; the durable repair (ctx.waitUntil) arms it then
    // settles it.
    await stub.makeServerReadyThroughDiscovery("c1-server");

    const settledRow = await waitForSettlementSchedule(stub, "c1-intent");
    expect(settledRow.status).toBe("settled");
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("settled");

    rows = await stub.getSettlementIntentRows();
    expect(rows[0].status).toBe("settled");
  });

  it("bounds the recovery reconnect-wait by the soonest live deadline", async () => {
    const stub = await settlementAgent("reconnect-wait-bound");

    // No live intents → no wait.
    expect(await stub.reconnectSettleWaitMsForTest()).toBe(0);

    await stub.seedMcpServer(
      "rw-short",
      "https://mcp.example.com/rw-short",
      MCPConnectionState.CONNECTING
    );
    // A 30s deadline: longer than the historical fixed window, shorter than the
    // cap. The wait must track the deadline (so a slow reconnect isn't cut short
    // into a spurious timeout), not a fixed sub-deadline value.
    await stub.createSettlementWatchByServerId("rw-short", {
      deadlineSeconds: 30
    });
    let wait = await stub.reconnectSettleWaitMsForTest();
    expect(wait).toBeGreaterThan(10_000);
    expect(wait).toBeLessThanOrEqual(30_000);

    // Add a 5-minute-deadline watch: the cap bounds the wait so a long deadline
    // can't pin the DO, and the soonest deadline (30s) still governs.
    await stub.seedMcpServer(
      "rw-long",
      "https://mcp.example.com/rw-long",
      MCPConnectionState.CONNECTING
    );
    await stub.createSettlementWatchByServerId("rw-long", {
      deadlineSeconds: 300
    });
    wait = await stub.reconnectSettleWaitMsForTest();
    expect(wait).toBeLessThanOrEqual(30_000); // bounded by the soonest deadline
  });

  it("keeps a fresh armed deadline bridging a timeout settle so recovery can redeliver", async () => {
    // The deadline handler records the terminal timeout, then schedules the
    // delivery across an await. If that delivery schedule is lost (eviction /
    // a throwing schedule write), a bridging alarm must still exist — otherwise
    // the timeout is stranded with nothing to wake redelivery. The handler arms
    // a FRESH deadline before settling for exactly this reason.
    const stub = await settlementAgent("m3-timeout-bridge");

    const watch = await stub.createSettlementWatchByUrl(
      "https://mcp.example.com/m3",
      { deadlineSeconds: 60 }
    );
    await stub.expireSettlementDeadline(watch.intentId);

    // Run the handler's settle but stop before the delivery schedule lands.
    const { settled } = await stub.runDeadlineTimeoutWithoutDeliveryForTest(
      watch.intentId
    );
    expect(settled).toBe(true);

    const rows = await stub.getSettlementIntentRows();
    const row = rows.find((r) => r.id === watch.intentId)!;
    expect(row.status).toBe("timeout");
    expect(row.delivery_schedule_id).toBeNull(); // delivery not scheduled yet…
    expect(row.deadline_schedule_id).toBeTruthy(); // …but a bridging alarm is armed

    // Recovery (what that alarm triggers on wake) redelivers exactly once.
    await stub.recoverSettlementIntentsForTest();
    await waitForSettlementSchedule(stub, watch.intentId);
    await runDurableObjectAlarm(stub);

    const results = await stub.getSettlementResults();
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("timeout");
  });

  it("rejects a fractional deadlineSeconds (whole seconds required)", async () => {
    const stub = await settlementAgent("fractional-deadline");

    await stub.seedMcpServer(
      "frac-server",
      "https://mcp.example.com/frac",
      MCPConnectionState.CONNECTING
    );

    const message = await stub.tryCreateSettlementWatchByUrl(
      "https://mcp.example.com/frac",
      { deadlineSeconds: 1.5 }
    );
    expect(message).toContain("integer");

    // A whole-second deadline still works.
    const ok = await stub.tryCreateSettlementWatchByUrl(
      "https://mcp.example.com/frac",
      { deadlineSeconds: 2 }
    );
    expect(ok).toBe("created");
  });

  it("dedupes concurrent same-key registrations within one turn", async () => {
    const stub = await settlementAgent("concurrent-same-key");

    await stub.seedMcpServer(
      "csk-server",
      "https://mcp.example.com/csk",
      MCPConnectionState.CONNECTING
    );

    const { a, b } = await stub.createTwoConcurrentSameKeyWatchesForTest(
      "csk-server",
      "shared-key"
    );

    // Exactly one created the live intent; the other reused it.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(a.intentId).toBe(b.intentId);

    const live = (await stub.getSettlementIntentRows()).filter(
      (r) => r.status === "live"
    );
    expect(live).toHaveLength(1);
    expect(live[0].idempotency_key).toBe("shared-key");
  });
});
