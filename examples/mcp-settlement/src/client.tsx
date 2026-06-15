import "./styles.css";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Button,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  InfoIcon,
  MoonIcon,
  PlugIcon,
  SunIcon,
  WarningIcon
} from "@phosphor-icons/react";

const WORKSPACE = "alice";

type Snapshot = {
  serverId: string;
  url: string;
  state: string | null;
  error?: string;
} | null;

type Settlement = { type: string } | null;

type Banner = {
  serverId: string;
  state: string | null;
  error?: string;
  via: "poll-on-wake" | "live-push" | "none";
  settlement: string | null;
};

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function stateVariant(state: string | null): "success" | "warning" | "neutral" {
  if (state === "ready") return "success";
  if (state === "failed" || state === "authenticating") return "warning";
  return "neutral";
}

function StateRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Text size="xs" variant="secondary">
        {label}
      </Text>
      <code className="font-mono text-xs bg-kumo-elevated px-2 py-0.5 rounded text-kumo-default">
        {value}
      </code>
    </div>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(null);
  const [settlement, setSettlement] = useState<Settlement>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [snap, settle, ban] = await Promise.all([
        fetch("/owner/state").then((r) => r.json<Snapshot>()),
        fetch("/owner/settlement").then((r) => r.json<Settlement>()),
        fetch(`/workspace/${WORKSPACE}`).then((r) => r.json<Banner>())
      ]);
      setSnapshot(snap);
      setSettlement(settle);
      setBanner(ban);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const post = useCallback(
    async (path: string, label: string) => {
      setBusy(label);
      setError(null);
      try {
        await fetch(path, { method: "POST" });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              Durable MCP Settlement
            </h1>
            <Badge variant="secondary">
              <PlugIcon size={12} weight="bold" className="mr-1" />
              Cross-DO readiness
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowsClockwiseIcon size={14} />}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
            <ModeToggle />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          <Surface className="p-4 rounded-xl ring ring-kumo-line">
            <div className="flex gap-3">
              <InfoIcon
                size={20}
                weight="bold"
                className="text-kumo-accent shrink-0 mt-0.5"
              />
              <div>
                <Text size="sm" bold>
                  One DO owns an MCP connection; another consumes its readiness
                </Text>
                <span className="mt-1 block">
                  <Text size="xs" variant="secondary">
                    The <code className="font-mono">IdentityDO</code> connects
                    to a bundled MCP server and arms a durable{" "}
                    <code className="font-mono">watchMcpServerSettled</code>{" "}
                    watch. The <code className="font-mono">WorkspaceDO</code>{" "}
                    reconciles a status banner from the owner's level-triggered{" "}
                    <code className="font-mono">{`{ state }`}</code> snapshot on
                    its own wake, and takes live pushes while awake. Use
                    “Abandon OAuth” to watch a durable{" "}
                    <code className="font-mono">timeout</code> fire ~4s later
                    with no live transition.
                  </Text>
                </span>
              </div>
            </div>
          </Surface>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<PlugIcon size={14} weight="fill" />}
              loading={busy === "connect"}
              onClick={() => void post("/connect", "connect")}
            >
              Connect MCP
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<WarningIcon size={14} />}
              loading={busy === "abandon"}
              onClick={() => void post("/connect-abandoned-auth", "abandon")}
            >
              Abandon OAuth (timeout)
            </Button>
          </div>

          {error && (
            <Surface className="p-3 rounded-xl ring ring-kumo-line">
              <Text size="xs" variant="secondary">
                <span className="text-kumo-danger">Error:</span> {error}
              </Text>
            </Surface>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Surface className="p-4 rounded-xl ring ring-kumo-line space-y-3">
              <div className="flex items-center justify-between">
                <Text size="sm" bold>
                  Owner snapshot
                </Text>
                <Badge variant={stateVariant(snapshot?.state ?? null)}>
                  {snapshot?.state ?? "none"}
                </Badge>
              </div>
              <StateRow label="serverId" value={snapshot?.serverId ?? "—"} />
              <StateRow
                label="settlement"
                value={settlement?.type ?? "pending"}
              />
              {snapshot?.error && (
                <StateRow label="error" value={snapshot.error} />
              )}
            </Surface>

            <Surface className="p-4 rounded-xl ring ring-kumo-line space-y-3">
              <div className="flex items-center justify-between">
                <Text size="sm" bold>
                  Workspace banner ({WORKSPACE})
                </Text>
                <Badge variant={stateVariant(banner?.state ?? null)}>
                  {banner?.state ?? "none"}
                </Badge>
              </div>
              <StateRow label="via" value={banner?.via ?? "—"} />
              <StateRow
                label="settlement"
                value={banner?.settlement ?? "pending"}
              />
              {banner?.error && <StateRow label="error" value={banner.error} />}
            </Surface>
          </div>

          <Text size="xs" variant="secondary">
            The banner is a consumer reconciling on its own wake — it is not a
            live mirror. Refresh re-reads each DO over HTTP; in production the
            owner would relay live pushes to awake consumers (see the README).
          </Text>
        </div>
      </div>

      <footer className="border-t border-kumo-line bg-kumo-base">
        <div className="flex justify-center py-3">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
