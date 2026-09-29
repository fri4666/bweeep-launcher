import { useEffect, useRef, useState } from "react";
import type { ServerPreset, ServerStatus } from "../shared/types.js";
import type { ServerStatuses } from "./useServerStatuses.js";
import "./play.css";

export type ServerState = "catalogError" | "loading" | "checking" | "online" | "offline";

export function serverState(catalogState: "loading" | "ready" | "error", server: ServerPreset | undefined, status: ServerStatus | undefined): ServerState {
  if (catalogState === "error") return "catalogError";
  if (catalogState === "loading" || !server) return "loading";
  if (!status) return "checking";
  return status.online ? "online" : "offline";
}

function playerCount(status: ServerStatus | undefined): string {
  if (!status) return "";
  if (!status.online) return "꺼짐";
  return status.players ? `${status.players.online}/${status.players.max}` : "켜짐";
}

/**
 * The selected server in the top bar: on/off, players and ping. With more
 * than one server it opens a short list to switch servers right there.
 */
export function ServerSwitcher({ servers, selected, statuses, catalogState, locked, onSelect, onReloadCatalog }: {
  servers: ServerPreset[];
  selected: ServerPreset | undefined;
  statuses: ServerStatuses;
  catalogState: "loading" | "ready" | "error";
  /** No switching while a game is starting or running. */
  locked: boolean;
  onSelect: (id: string) => void;
  onReloadCatalog: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const status = selected ? statuses.byId[selected.id] : undefined;
  const state = serverState(catalogState, selected, status);
  const canSwitch = servers.length > 1 && !locked;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!canSwitch) setOpen(false);
  }, [canSwitch]);

  const title = state === "catalogError" ? "서버 목록 오류" : state === "loading" ? "서버 불러오는 중" : selected?.name ?? "";
  const detail = state === "online" && status
    ? [status.players ? `${status.players.online}/${status.players.max}명` : null, `${status.latencyMs ?? "-"}ms`].filter(Boolean).join(" · ")
    : state === "offline" ? "꺼짐"
    : state === "checking" ? "확인 중"
    : state === "catalogError" ? "목록을 못 받았어요"
    : "잠시만요";
  const checkedTime = statuses.checkedAt ? new Date(statuses.checkedAt).toLocaleTimeString("ko-KR") : null;

  return (
    <div className="serverSwitcher" ref={rootRef}>
      <div className={`serverPill is-${state}`}>
        <button
          type="button"
          className="serverPillButton"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${title} · ${detail}`}
          title={[status?.version ? `Minecraft ${status.version}` : null, checkedTime ? `${checkedTime} 확인` : null].filter(Boolean).join(" · ") || undefined}
          disabled={!canSwitch}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="statusDot" />
          <div>
            <strong>{title}</strong>
            <small>{detail}</small>
          </div>
          {servers.length > 1 && (
            <svg className="serverPillCaret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg>
          )}
        </button>
        {(state === "offline" || state === "catalogError") && (
          <button
            className="pillAction"
            disabled={statuses.checking}
            onClick={() => state === "catalogError" ? onReloadCatalog() : statuses.refresh()}
          >
            {statuses.checking ? "확인 중" : "다시 확인"}
          </button>
        )}
      </div>
      {open && (
        <div className="serverMenu" role="listbox" aria-label="서버">
          {servers.map((server) => {
            const itemStatus = statuses.byId[server.id];
            return (
              <button
                key={server.id}
                type="button"
                role="option"
                aria-selected={server.id === selected?.id}
                className={`serverMenuItem is-${itemStatus ? itemStatus.online ? "online" : "offline" : "checking"}`}
                onClick={() => {
                  onSelect(server.id);
                  setOpen(false);
                }}
              >
                <span className="statusDot" />
                <span className="serverMenuName">
                  {server.name}
                  {server.environment === "test" && <small>테섭</small>}
                </span>
                <span className="serverMenuCount">{playerCount(itemStatus)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Shown on the launch button when the selected server is off. */
export function ServerOffIcon() {
  return (
    <svg className="launchOffIcon" viewBox="0 0 24 24" role="img" aria-label="서버 꺼짐">
      <rect x="4" y="4" width="16" height="6" rx="1.5" />
      <rect x="4" y="14" width="16" height="6" rx="1.5" />
      <path d="M3 3l18 18" />
    </svg>
  );
}
