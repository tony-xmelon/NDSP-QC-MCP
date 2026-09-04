import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ConnectionState, RuntimeStatus } from "@ndsp-qc/client";
import { chatCredentialStatus, type ChatQuota, type ChatSettings, type ChatUsage } from "./model-chat";

export type ConnectionEvent = { at: string; event: string; result: "pending" | "success" | "warning" | "failure" | "info"; detail: string };
export type MenuCommand =
  | "open-workspace" | "save-workspace" | "save-workspace-as" | "exit"
  | "undo" | "redo" | "copy-preset" | "paste-preset" | "copy-block-settings" | "paste-block-settings" | "settings"
  | "view-fit" | "view-actual" | "toggle-fullscreen" | "toggle-chat"
  | "open-preset-directory" | "save-preset-to-device" | "rename-current-preset" | "add-block" | "edit-routing" | "discard-changes"
  | "previous-preset" | "next-preset" | "set-tempo" | `select-mode-${0 | 1 | 2}` | "open-tuner" | "open-gig-view"
  | "export-preset-library" | "device-backup"
  | "connect" | "disconnect" | "reconnect" | "reset-session" | "refresh-state" | "device-info"
  | "user-guide" | "keyboard-reference" | "export-diagnostics" | "prepare-support-report"
  | "privacy" | "legal" | "notices" | "about";
export type MenuItem = { id: MenuCommand; label: string; disabled?: boolean; checked?: boolean; shortcut?: string } | { separator: true };
export type AppMenu = { name: string; items: MenuItem[] };

export const quotaResetLabel = (resetTime?: string) => {
  if (!resetTime) return undefined;
  const reset = new Date(resetTime);
  if (Number.isNaN(reset.getTime())) return undefined;
  return reset.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
};
export const divider = (): MenuItem => ({ separator: true });


export function MenuBar({ menus, onSelect, connection, syncProgress, busy, runtime, deviceName, presetLabel, events, chatOpen, chatStatus, chatSettings, chatQuota, chatUsage, assistantPending, modelWarming, remoteChatAllowed, onConnect, onDisconnect, onReset, onRefresh, onClearEvents, onExportDiagnostics, onOpenDeviceInfo, onOpenChatSettings, onTestChat, onRefreshChatQuota, onCancelChat, onOpenChange }: {
  menus: AppMenu[];
  onSelect: (item: MenuCommand) => void;
  connection: ConnectionState;
  syncProgress: number | null;
  busy: boolean;
  runtime?: RuntimeStatus;
  deviceName: string;
  presetLabel: string;
  events: ConnectionEvent[];
  chatOpen: boolean;
  chatStatus: "checking" | "online" | "offline" | "error";
  chatSettings?: ChatSettings;
  chatQuota?: ChatQuota;
  chatUsage?: ChatUsage;
  assistantPending: boolean;
  modelWarming: boolean;
  remoteChatAllowed: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onReset: () => void;
  onRefresh: () => void;
  onClearEvents: () => void;
  onExportDiagnostics: () => void;
  onOpenDeviceInfo: () => void;
  onOpenChatSettings: () => void;
  onTestChat: () => void;
  onRefreshChatQuota: () => void;
  onCancelChat: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [statusPanelOpen, setStatusPanelOpen] = useState<"device" | "chat" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const deviceStatusRoot = useRef<HTMLDivElement>(null);
  const chatStatusRoot = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const itemRefs = useRef(new Map<string, HTMLButtonElement[]>());

  const closeMenu = useCallback((restoreFocus = false) => {
    const previous = openMenu;
    setOpenMenu(null);
    onOpenChange(statusPanelOpen !== null);
    if (restoreFocus && previous) requestAnimationFrame(() => triggerRefs.current.get(previous)?.focus());
  }, [onOpenChange, openMenu, statusPanelOpen]);

  const open = useCallback((name: string, focus: "first" | "last" | null = null) => {
    setStatusPanelOpen(null);
    setOpenMenu(name);
    onOpenChange(true);
    if (focus) requestAnimationFrame(() => {
      const candidates = itemRefs.current.get(name)?.filter((item) => !item.disabled) ?? [];
      candidates[focus === "first" ? 0 : candidates.length - 1]?.focus();
    });
  }, [onOpenChange]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) closeMenu(false);
      if (!deviceStatusRoot.current?.contains(event.target as Node) && !chatStatusRoot.current?.contains(event.target as Node)) {
        setStatusPanelOpen(null);
        if (!root.current?.contains(event.target as Node)) onOpenChange(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (openMenu || statusPanelOpen)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (openMenu) closeMenu(true);
        if (statusPanelOpen) {
          setStatusPanelOpen(null);
          onOpenChange(false);
        }
      }
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape, true);
    };
  }, [closeMenu, onOpenChange, openMenu, statusPanelOpen]);

  const moveFocus = (menuName: string, event: ReactKeyboardEvent, itemIndex: number) => {
    const candidates = itemRefs.current.get(menuName)?.filter((item) => !item.disabled) ?? [];
    const current = candidates.indexOf(event.currentTarget as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const target = event.key === "Home" ? 0 : event.key === "End" ? candidates.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length;
      candidates[target]?.focus();
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const menuIndex = menus.findIndex((menu) => menu.name === menuName);
      const next = menus[(menuIndex + (event.key === "ArrowRight" ? 1 : -1) + menus.length) % menus.length];
      open(next.name, "first");
    } else if (event.key === "Escape") closeMenu(true);
    void itemIndex;
  };

  const chatActivity = assistantPending ? "MODEL THINKING" : modelWarming ? "MODEL WARMING" : chatStatus === "online" ? "MODEL READY" : chatStatus === "checking" ? "CHECKING MODEL" : chatStatus === "error" ? "MODEL ERROR" : "MODEL OFFLINE";
  const toggleStatusPanel = (panel: "device" | "chat") => {
    const next = statusPanelOpen === panel ? null : panel;
    closeMenu(false);
    setStatusPanelOpen(next);
    onOpenChange(next !== null);
  };

  return <nav className={`menu-bar${chatOpen ? "" : " chat-closed"}`} aria-label="Application menu">
    <div className="menubar-device-side">
    <div className="menus" role="menubar" ref={root}>
      {menus.map((menu, menuIndex) => <div key={menu.name} className={`menu${openMenu === menu.name ? " is-open" : ""}`}>
        <button
          className="menu-trigger"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={openMenu === menu.name}
          ref={(node) => { if (node) triggerRefs.current.set(menu.name, node); }}
          onClick={() => openMenu === menu.name ? closeMenu(false) : open(menu.name)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); open(menu.name, "first"); }
            else if (event.key === "ArrowUp") { event.preventDefault(); open(menu.name, "last"); }
            else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              const next = menus[(menuIndex + (event.key === "ArrowRight" ? 1 : -1) + menus.length) % menus.length];
              triggerRefs.current.get(next.name)?.focus();
              if (openMenu) open(next.name);
            }
          }}
        >{menu.name}</button>
        {openMenu === menu.name && <div className="menu-popover" role="menu" aria-label={`${menu.name} menu`}>
          {menu.items.map((item, index) => "separator" in item
            ? <div className="menu-separator" role="separator" key={`separator-${index}`} />
            : <button
                key={item.id}
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.checked}
                disabled={item.disabled}
                ref={(node) => {
                  if (!node) return;
                  const refs = itemRefs.current.get(menu.name) ?? [];
                  refs[index] = node;
                  itemRefs.current.set(menu.name, refs);
                }}
                onKeyDown={(event) => moveFocus(menu.name, event, index)}
                onClick={() => { closeMenu(false); onSelect(item.id); }}
              ><span className="menu-check" aria-hidden="true">{item.checked ? "✓" : ""}</span><span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>
          )}
        </div>}
      </div>)}
    </div>
    <div className="menubar-actions" ref={deviceStatusRoot}>
      <ConnectionBadge connection={connection} syncProgress={syncProgress} expanded={statusPanelOpen === "device"} onClick={() => toggleStatusPanel("device")} />
      {statusPanelOpen === "device" && <section className="connection-panel" role="dialog" aria-modal="false" aria-label="Connection details">
        <header><div><span className={`connection-panel-light panel-phase-${syncProgress !== null ? "syncing" : connection.phase}`} /><strong>{connection.demo ? "Demo connection" : deviceName}</strong></div><span>{connection.phase.replaceAll("-", " ")}</span></header>
        <p>{connection.detail}</p>
        <dl>
          <div><dt>Desktop runtime</dt><dd>{runtime?.platform ?? "Starting…"}</dd></div>
          <div><dt>Device gateway</dt><dd>{runtime?.gatewayAvailable ? "Available" : "Unavailable"}{runtime?.message ? ` · ${runtime.message}` : ""}</dd></div>
          <div><dt>Current preset</dt><dd>{connection.demo ? "Demo data" : presetLabel}</dd></div>
          <div><dt>Last synchronized</dt><dd>{connection.lastSync ? new Date(connection.lastSync).toLocaleString() : "Not yet synchronized"}</dd></div>
        </dl>
        <div className="connection-panel-actions">
          <button className="primary" disabled={busy} onClick={onConnect}>{connection.phase === "ready" && !connection.demo ? "Reconnect" : "Connect"}</button>
          <button disabled={busy || connection.demo || connection.phase !== "ready"} onClick={onRefresh}>Refresh state</button>
          <button disabled={busy} onClick={onReset}>Reset session</button>
          <button disabled={busy || connection.demo || connection.phase !== "ready"} onClick={onDisconnect}>Disconnect</button>
        </div>
        <div className="connection-panel-log-heading"><strong>Connection steps</strong><span>{events.length} events</span></div>
        <div className="connection-panel-log">
          {[...events].reverse().map((entry, index) => <div className={`result-${entry.result}`} key={`${entry.at}-${events.length - index}`}><time>{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><i aria-hidden="true" /><div><strong>{entry.event.replaceAll("-", " ")}</strong><small>{entry.detail}</small></div><span>{entry.result}</span></div>)}
        </div>
        <footer><button onClick={() => { setStatusPanelOpen(null); onOpenChange(false); onOpenDeviceInfo(); }}>Device info…</button><button onClick={onClearEvents}>Clear history</button><button onClick={onExportDiagnostics}>Export diagnostics…</button></footer>
      </section>}
    </div>
    </div>
    <div className="menubar-chat-side" ref={chatStatusRoot}>
      <ChatStatusBadge status={chatStatus} activity={chatActivity} thinking={assistantPending || modelWarming} expanded={statusPanelOpen === "chat"} onClick={() => toggleStatusPanel("chat")} />
      {statusPanelOpen === "chat" && <section className="connection-panel chat-status-panel" role="dialog" aria-modal="false" aria-label="Chat model details">
        <header><div><span className={`connection-panel-light chat-panel-phase-${assistantPending || modelWarming ? "thinking" : chatStatus}`} /><strong>Conversational model</strong></div><span>{chatActivity}</span></header>
        <p>{chatSettings?.detail ?? "Conversational model settings are still loading."}</p>
        <dl>
          <div><dt>Provider</dt><dd>{chatSettings?.providerName ?? "Not configured"}</dd></div>
          <div><dt>Model</dt><dd>{chatSettings?.model ?? "Unavailable"}</dd></div>
          <div><dt>Credential</dt><dd>{chatCredentialStatus(chatSettings)}</dd></div>
          <div><dt>Online sharing</dt><dd>{remoteChatAllowed ? "Enabled" : "Disabled in General settings"}</dd></div>
          <div><dt>Tokens used</dt><dd>{chatUsage ? chatUsage.totalTokens.toLocaleString() : "Available after the first response"}</dd></div>
          <div><dt>Quota</dt><dd>{chatQuota?.available && chatQuota.remainingFraction !== undefined ? `${Math.round(chatQuota.remainingFraction * 100)}% · ${chatQuota.label}` : "Provider quota unavailable"}</dd></div>
          <div><dt>Quota reset</dt><dd>{quotaResetLabel(chatQuota?.resetTime) ?? "Not reported by provider"}</dd></div>
        </dl>
        <div className="chat-panel-actions">
          <button className="primary" disabled={busy || assistantPending} onClick={onTestChat}>Test model</button>
          <button disabled={busy} onClick={onRefreshChatQuota}>Refresh quota</button>
          <button onClick={() => { setStatusPanelOpen(null); onOpenChange(false); onOpenChatSettings(); }}>AI settings</button>
          <button disabled={!assistantPending} onClick={onCancelChat}>Stop response</button>
        </div>
      </section>}
    </div>
  </nav>;
}

function ConnectionBadge({ connection, syncProgress, expanded, onClick }: { connection: ConnectionState; syncProgress: number | null; expanded: boolean; onClick: () => void }) {
  const syncing = syncProgress !== null;
  const label = syncing ? `SYNCING ${syncProgress}%` : connection.demo ? "DEMO" : connection.phase === "ready" ? "QC READY" : connection.phase.replace("-", " ").toUpperCase();
  return <button type="button" className={`connection-badge phase-${syncing ? "syncing" : connection.phase}`} aria-expanded={expanded} aria-haspopup="dialog" aria-label={syncing ? `Synchronizing device, ${syncProgress}% complete; open connection details` : `${label}; open connection details`} title={connection.detail} onClick={onClick}>
    <span className="status-light" />
    <span>{label}</span>
    <span className="connection-chevron" aria-hidden="true" />
    {syncing && <span className="connection-progress" aria-hidden="true"><span style={{ width: `${syncProgress}%` }} /></span>}
  </button>;
}

function ChatStatusBadge({ status, activity, thinking, expanded, onClick }: { status: "checking" | "online" | "offline" | "error"; activity: string; thinking: boolean; expanded: boolean; onClick: () => void }) {
  return <button type="button" className={`chat-status-badge status-${status}${thinking ? " is-thinking" : ""}`} aria-expanded={expanded} aria-haspopup="dialog" aria-label={`${activity}; open model details`} onClick={onClick}>
    <span className="status-light" />
    <span>{activity}</span>
    <span className="connection-chevron" aria-hidden="true" />
  </button>;
}

