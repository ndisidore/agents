import "./styles.css";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import {
  Badge,
  Button,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  InfoIcon,
  LockKeyIcon,
  MoonIcon,
  MoonStarsIcon,
  PlugIcon,
  SunIcon,
  WarningIcon
} from "@phosphor-icons/react";
import type { Banner, OwnerStatus } from "./shared";
import { WORKSPACES } from "./shared";

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

function ConnectionIndicator({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`inline-block w-2 h-2 rounded-full ${
          connected ? "bg-kumo-success" : "bg-kumo-line"
        }`}
      />
      <Text size="xs" variant="secondary">
        {connected ? "connected" : "connecting…"}
      </Text>
    </div>
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

// Holds one workspace's live WebSocket (via useAgent). Rendered only while the
// panel is "awake": unmounting it closes the browser→workspace socket, which
// makes the WorkspaceDO drop its socket TO the owner (onClose) and lets it
// hibernate — the "asleep" half of the demo. Remounting reconnects, so the
// workspace runs onConnect → reopen owner socket + reconcile (poll-on-wake).
function WorkspaceConnection({
  name,
  onBanner,
  onConnected
}: {
  name: string;
  onBanner: (banner: Banner) => void;
  onConnected: (connected: boolean) => void;
}) {
  useAgent<{ banner: Banner }>({
    agent: "WorkspaceDO",
    name,
    onOpen: () => onConnected(true),
    onClose: () => onConnected(false),
    onStateUpdate: (state) => onBanner(state.banner)
  });
  return null;
}

// One consumer panel. Owns its own banner + connection + paused state, so each
// workspace hibernates/wakes independently. While paused it keeps showing the
// last-known banner (muted) and a Resume button.
function WorkspacePanel({ name, label }: { name: string; label: string }) {
  const [banner, setBanner] = useState<Banner | null>(null);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);

  const togglePaused = useCallback(() => {
    setPaused((p) => {
      if (!p) setConnected(false); // pausing → unmounts the socket
      return !p;
    });
  }, []);

  const authPrompt = banner?.state === "authenticating";

  return (
    <Surface className="p-4 rounded-xl ring ring-kumo-line space-y-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Text size="sm" bold>
            {label}
          </Text>
          <span className="shrink-0">
            <Badge variant={stateVariant(banner?.state ?? null)}>
              {banner?.state ?? "none"}
            </Badge>
          </span>
        </div>
        {paused ? (
          <div className="flex items-center gap-1.5">
            <MoonStarsIcon size={14} weight="fill" className="text-kumo-line" />
            <Text size="xs" variant="secondary">
              asleep
            </Text>
          </div>
        ) : (
          <ConnectionIndicator connected={connected} />
        )}
      </div>

      <StateRow label="settlement" value={banner?.settlement ?? "pending"} />
      <StateRow label="via" value={banner?.via ?? "—"} />
      {banner?.error && <StateRow label="error" value={banner.error} />}

      <Button
        variant="ghost"
        size="sm"
        icon={paused ? <SunIcon size={14} /> : <MoonStarsIcon size={14} />}
        onClick={togglePaused}
      >
        {paused ? "Resume (wake)" : "Pause (sleep)"}
      </Button>

      {authPrompt && (
        <div className="mt-1 rounded-lg bg-kumo-elevated p-3 ring ring-kumo-line">
          <div className="flex items-start gap-2">
            <LockKeyIcon
              size={16}
              weight="bold"
              className="text-kumo-accent shrink-0 mt-0.5"
            />
            <div className="flex-1">
              <Text size="xs" bold>
                Authentication required
              </Text>
              <span className="mt-0.5 block">
                <Text size="xs" variant="secondary">
                  The owner reports this connection needs re-auth — use “Connect
                  MCP” above.
                </Text>
              </span>
            </div>
          </div>
        </div>
      )}

      {!paused && (
        <WorkspaceConnection
          name={name}
          onBanner={setBanner}
          onConnected={setConnected}
        />
      )}
    </Surface>
  );
}

function App() {
  const [owner, setOwner] = useState<OwnerStatus | null>(null);
  const [ownerConnected, setOwnerConnected] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // We view the owner (IdentityDO) that holds the MCP connection + settlement
  // watch, plus each workspace (WorkspaceDO) that mirrors the owner's
  // readiness. The owner updates instantly (native state sync); each workspace
  // updates live while awake (the owner pushes over a socket the workspace
  // opened) and reconciles on its own wake otherwise.
  const ownerAgent = useAgent<OwnerStatus>({
    agent: "IdentityDO",
    name: "identity",
    onOpen: () => setOwnerConnected(true),
    onClose: () => setOwnerConnected(false),
    onStateUpdate: (state) => setOwner(state)
  });

  // Owner actions (browser → owner; the owner never calls a workspace).
  const runOwner = useCallback(
    async (
      method: "connectMcp" | "armAbandonedAuthWatch" | "disconnectAuth",
      label: string
    ) => {
      setBusy(label);
      setError(null);
      try {
        await ownerAgent.call(method);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [ownerAgent]
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
          <ModeToggle />
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
                    mirrors it: live while you're viewing (the owner pushes over
                    a socket the workspace opened), and by reconciling from the
                    owner's durable status on its own wake. Watch the owner
                    panel update instantly and the workspace track it.
                    “Disconnect Auth” forces re-auth; “Abandon OAuth” fires a
                    durable <code className="font-mono">timeout</code> ~4s later
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
              onClick={() => void runOwner("connectMcp", "connect")}
            >
              Connect MCP
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<LockKeyIcon size={14} />}
              loading={busy === "disconnect-auth"}
              onClick={() => void runOwner("disconnectAuth", "disconnect-auth")}
            >
              Disconnect Auth
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<WarningIcon size={14} />}
              loading={busy === "abandon"}
              onClick={() => void runOwner("armAbandonedAuthWatch", "abandon")}
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

          <Surface className="p-4 rounded-xl ring ring-kumo-line space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Text size="sm" bold>
                  Owner (IdentityDO)
                </Text>
                <ConnectionIndicator connected={ownerConnected} />
              </div>
              <Badge variant={stateVariant(owner?.state ?? null)}>
                {owner?.state ?? "none"}
              </Badge>
            </div>
            <StateRow
              label="settlement"
              value={owner?.settlement ?? "pending"}
            />
            <StateRow label="updates" value="live (native state sync)" />
            {owner?.error && <StateRow label="error" value={owner.error} />}
          </Surface>

          <div className="grid gap-4 sm:grid-cols-3">
            {WORKSPACES.map((ws) => (
              <WorkspacePanel key={ws.name} name={ws.name} label={ws.label} />
            ))}
          </div>

          <Text size="xs" variant="secondary">
            The owner panel is its own live Agent state. Each workspace is a
            separate DO mirroring the owner — all three reflect the same state
            once it settles. A workspace updates live while you view it (the
            owner pushes over a socket the workspace opened), and via
            poll-on-wake on its own wake. Try “Pause (sleep)” on one workspace,
            change the owner, then “Resume (wake)”: it catches up via
            poll-on-wake while the awake ones updated via live-push. The owner
            never force-wakes a hibernating workspace.
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
