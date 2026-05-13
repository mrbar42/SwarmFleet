import { useCallback, useState, useEffect } from "react";
import { getProvidersStatusUrl, getRemoteControlStatusUrl } from "../../config/api";
import { usePoll } from "../../hooks/usePoll";
import type { Project, ProjectFeatureKey, ProjectFeatures } from "../../types";
import { useAppStore } from "../../stores/appStore";

const FEATURE_DEFS: {
  key: ProjectFeatureKey;
  label: string;
  description: string;
  supportsReset: boolean;
}[] = [
  {
    key: "preview",
    label: "Preview",
    description:
      "Enable the Preview tab for running dev servers and viewing rendered artifacts.",
    supportsReset: false,
  },
];

interface ProjectSettingsTabProps {
  currentProject: Project | null;
  features: ProjectFeatures;
}

export default function ProjectSettingsTab({
  currentProject,
  features,
}: ProjectSettingsTabProps) {
  const setProjectFeature = useAppStore((s) => s.setProjectFeature);
  const resetProjectFeature = useAppStore((s) => s.resetProjectFeature);
  const fetchProjects = useAppStore((s) => s.fetchProjects);

  const [featureError, setFeatureError] = useState<string | null>(null);
  const [busyFeature, setBusyFeature] = useState<ProjectFeatureKey | null>(null);
  const [busyPublish, setBusyPublish] = useState(false);
  const [resetConfirm, setResetConfirm] = useState<ProjectFeatureKey | null>(null);

  const handleToggleFeature = useCallback(
    async (feature: ProjectFeatureKey) => {
      if (!currentProject) return;
      setFeatureError(null);
      setBusyFeature(feature);
      try {
        await setProjectFeature(feature, !features[feature].enabled);
      } catch (err) {
        setFeatureError(err instanceof Error ? err.message : "Toggle failed");
      } finally {
        setBusyFeature(null);
      }
    },
    [currentProject, features, setProjectFeature],
  );

  const handleToggleHostPublish = useCallback(async () => {
    if (!currentProject || !features.preview.enabled) return;
    setFeatureError(null);
    setBusyPublish(true);
    try {
      await fetch("/api/preview/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: currentProject.path,
          command: features.preview.command ?? "auto",
          publishToHost: !features.preview.devServer?.publishToHost,
        }),
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Host publish toggle failed");
        }
      });
      await fetchProjects();
    } catch (err) {
      setFeatureError(err instanceof Error ? err.message : "Host publish toggle failed");
    } finally {
      setBusyPublish(false);
    }
  }, [currentProject, features.preview, fetchProjects]);

  const handleResetFeature = useCallback(
    async (feature: ProjectFeatureKey) => {
      if (!currentProject) return;
      if (resetConfirm !== feature) {
        setResetConfirm(feature);
        setTimeout(() => {
          setResetConfirm((current) => (current === feature ? null : current));
        }, 3000);
        return;
      }
      setFeatureError(null);
      setBusyFeature(feature);
      try {
        await resetProjectFeature(feature);
        setResetConfirm(null);
      } catch (err) {
        setFeatureError(err instanceof Error ? err.message : "Reset failed");
      } finally {
        setBusyFeature(null);
      }
    },
    [currentProject, resetConfirm, resetProjectFeature],
  );

  const [rcEnabled, setRcEnabled] = useState(false);
  const [rcRunning, setRcRunning] = useState(false);
  const [rcUrl, setRcUrl] = useState<string | null>(null);
  const [claudeAuth, setClaudeAuth] = useState<boolean | null>(null);

  // Check Claude auth status
  useEffect(() => {
    let cancelled = false;
    fetch(getProvidersStatusUrl())
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setClaudeAuth(data.providers?.claude?.authenticated ?? false);
      })
      .catch(() => { if (!cancelled) setClaudeAuth(false); });

    const onInvalidated = () => {
      fetch(getProvidersStatusUrl())
        .then((r) => r.json())
        .then((data) => { if (!cancelled) setClaudeAuth(data.providers?.claude?.authenticated ?? false); })
        .catch(() => {});
    };
    window.addEventListener("providers-invalidated", onInvalidated);
    return () => { cancelled = true; window.removeEventListener("providers-invalidated", onInvalidated); };
  }, []);

  const pollRemoteControlStatus = useCallback(
    async (signal: AbortSignal) => {
      if (!currentProject) return;
      try {
        const res = await fetch(
          `${getRemoteControlStatusUrl()}?project=${encodeURIComponent(currentProject.path)}`,
          { signal },
        );
        if (!res.ok || signal.aborted) return;
        const data = await res.json();
        if (!signal.aborted) {
          setRcEnabled(data.enabled ?? false);
          setRcRunning(data.running ?? false);
          setRcUrl(typeof data.url === "string" ? data.url : null);
        }
      } catch {
        /* ignore */
      }
    },
    [currentProject],
  );

  usePoll(pollRemoteControlStatus, 5000, {
    enabled: Boolean(currentProject),
  });

  useEffect(() => {
    if (!currentProject) {
      setRcEnabled(false);
      setRcRunning(false);
      setRcUrl(null);
    }
  }, [currentProject]);

  const toggleRemoteControl = useCallback(async () => {
    if (!currentProject || claudeAuth !== true) return;
    const newEnabled = !rcEnabled;
    setRcEnabled(newEnabled);
    try {
      await fetch("/api/remote-control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: currentProject.path, enabled: newEnabled }),
      });
    } catch {
      setRcEnabled(!newEnabled); // revert on error
    }
  }, [currentProject, claudeAuth, rcEnabled]);

  return (
    <div className="flex-1 overflow-y-auto bg-[#0d1117] p-4 md:p-6">
      <div className="max-w-lg mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-[#e6edf3]">Project</h2>
          {currentProject && (
            <p className="text-xs text-[#8b949e] mt-0.5">{currentProject.name}</p>
          )}
        </div>

        {/* Features — additive toggles, not exclusive modes. */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-[#c9d1d9]">Features</h3>
          <p className="text-xs text-[#8b949e]">
            Enable capabilities on this project. Disabling hides the feature UI but preserves session history.
          </p>
          <div className="space-y-1.5">
            {FEATURE_DEFS.map((f) => {
              const enabled = features[f.key].enabled;
              const isBusy = busyFeature === f.key;
              const isConfirming = resetConfirm === f.key;
              return (
                <div
                  key={f.key}
                  data-testid={`feature-row-${f.key}`}
                  className={`rounded-lg border px-3 py-2.5 ${
                    enabled
                      ? "border-[#58a6ff]/50 bg-[#58a6ff]/5"
                      : "border-[#30363d] bg-[#161b22]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[#e6edf3]">
                          {f.label}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#21262d] text-[#8b949e] uppercase">
                          {f.key}
                        </span>
                      </div>
                      <p className="text-xs text-[#8b949e] mt-0.5">
                        {f.description}
                      </p>
                    </div>
                    <button
                      onClick={() => handleToggleFeature(f.key)}
                      data-testid={`feature-toggle-${f.key}`}
                      data-state={enabled ? "on" : "off"}
                      disabled={!currentProject || isBusy}
                      aria-pressed={enabled}
                      className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
                        enabled ? "bg-[#3fb950]" : "bg-[#484f58]"
                      } ${!currentProject || isBusy ? "opacity-40 cursor-not-allowed" : ""}`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          enabled ? "translate-x-5" : ""
                        }`}
                      />
                    </button>
                  </div>
                  {f.supportsReset && enabled && (
                    <div className="mt-2 flex justify-end">
                      <button
                        onClick={() => handleResetFeature(f.key)}
                        data-testid={`feature-reset-${f.key}`}
                        disabled={isBusy}
                        className={`text-[10px] px-2 py-1 rounded transition-colors ${
                          isConfirming
                            ? "bg-[#3d1214] text-[#f85149] hover:text-[#ff7b72]"
                            : "text-[#8b949e] hover:text-[#f85149] hover:bg-[#3d1214]/30"
                        }`}
                      >
                        {isConfirming ? "Click again to confirm" : "Reset data"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {features.preview.enabled && (
            <div className="rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[#e6edf3]">
                    Publish dev server to host
                  </div>
                  <p className="text-xs text-[#8b949e] mt-0.5">
                    Reserve one of 10 stable ports for this project's preview server.
                  </p>
                  {features.preview.devServer?.publishToHost &&
                    features.preview.devServer.port && (
                      <a
                        href={`http://localhost:${features.preview.devServer.port}/`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="mt-1 block truncate text-xs text-[#58a6ff] hover:underline"
                      >
                        {`http://localhost:${features.preview.devServer.port}/`}
                      </a>
                    )}
                </div>
                <button
                  onClick={() => void handleToggleHostPublish()}
                  disabled={!currentProject || busyPublish}
                  aria-pressed={features.preview.devServer?.publishToHost === true}
                  className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
                    features.preview.devServer?.publishToHost
                      ? "bg-[#3fb950]"
                      : "bg-[#484f58]"
                  } ${!currentProject || busyPublish ? "opacity-40 cursor-not-allowed" : ""}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      features.preview.devServer?.publishToHost ? "translate-x-5" : ""
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
          {featureError && (
            <p className="text-xs text-[#f85149] px-1">{featureError}</p>
          )}
        </section>

        {/* Claude Remote Control */}
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-[#c9d1d9]">Claude Remote Control</h3>
          <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-[#30363d] bg-[#161b22]">
            <div>
              <span className="text-sm text-[#c9d1d9]">
                {rcEnabled ? "Enabled" : "Disabled"}
              </span>
              <p className="text-xs text-[#8b949e]">
                {rcEnabled
                  ? rcRunning
                    ? "Remote control is active for this project"
                    : "Remote control is restarting..."
                  : "Enable to allow remote Claude sessions"}
              </p>
            </div>
            <button
              onClick={toggleRemoteControl}
              disabled={claudeAuth !== true}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                rcEnabled ? "bg-[#3fb950]" : "bg-[#484f58]"
              } ${claudeAuth !== true ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  rcEnabled ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>
          {claudeAuth === false && (
            <p className="text-xs text-[#d29922] px-1">
              Claude must be signed in to enable remote control.
            </p>
          )}
          {rcEnabled && rcRunning && !rcUrl && (
            <p className="text-xs text-[#3fb950] px-1">
              Running — waiting for share URL…
            </p>
          )}
          {rcEnabled && rcUrl && (
            <div className="flex items-center gap-2 px-1">
              <a
                href={rcUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs text-[#58a6ff] hover:underline break-all flex-1 min-w-0 truncate"
                data-testid="remote-control-url"
              >
                {rcUrl}
              </a>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(rcUrl);
                }}
                className="text-[10px] text-[#8b949e] hover:text-[#c9d1d9] px-1.5 py-0.5 rounded border border-[#30363d] shrink-0"
                title="Copy URL"
              >
                Copy
              </button>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}
