import { useEffect, useRef, useState } from "react";
import type { ModrinthHit, ModTarget, PersonalMod, ServerPreset } from "../shared/types.js";

function message(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || fallback;
}

function formatDownloads(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

const loaderNames: Record<string, string> = { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", vanilla: "바닐라" };

/** Search Modrinth for client-only mods that fit the selected server and install them as personal mods. */
export function ModsPanel({ server, instanceRoot, onClose }: { server: ServerPreset; instanceRoot: string; onClose: () => void }) {
  const target: ModTarget = {
    instanceRoot,
    packId: server.packId,
    loader: server.loader.kind,
    minecraftVersion: server.minecraftVersion,
    blockedModrinthProjects: server.blockedModrinthProjects
  };
  const [tab, setTab] = useState<"search" | "installed">("search");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ModrinthHit[]>([]);
  const [total, setTotal] = useState(0);
  const [installed, setInstalled] = useState<PersonalMod[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const searchSeq = useRef(0);
  const moddable = server.loader.kind !== "vanilla";

  async function search(text: string, offset = 0) {
    if (!moddable) return;
    const seq = ++searchSeq.current;
    setLoading(true);
    try {
      const result = await window.bweeep.searchMods(target, text, offset);
      if (seq !== searchSeq.current) return;
      setHits((previous) => offset === 0 ? result.hits : [...previous, ...result.hits]);
      setTotal(result.total);
    } catch (error) {
      if (seq === searchSeq.current) setNotice({ text: message(error, "Modrinth 검색에 실패했어요."), error: true });
    } finally {
      if (seq === searchSeq.current) setLoading(false);
    }
  }

  async function refreshInstalled(checkUpdates: boolean) {
    try {
      setInstalled(await window.bweeep.personalMods(target, checkUpdates));
    } catch (error) {
      setNotice({ text: message(error, "설치한 모드 목록을 불러오지 못했어요."), error: true });
    }
  }

  useEffect(() => {
    void search("");
    void refreshInstalled(false);
  }, [server.packId, instanceRoot]);

  useEffect(() => {
    const timer = setTimeout(() => void search(query), 350);
    return () => clearTimeout(timer);
  }, [query]);

  async function act(projectId: string, action: () => Promise<PersonalMod[]>, done: string, fallback: string) {
    setBusyId(projectId);
    setNotice(null);
    try {
      setInstalled(await action());
      setNotice({ text: done, error: false });
      setHits((previous) => previous.map((hit) => hit.projectId === projectId && hit.status === "available" ? { ...hit, status: "installed" } : hit));
    } catch (error) {
      setNotice({ text: message(error, fallback), error: true });
    } finally {
      setBusyId(null);
    }
  }

  const installedIds = new Set(installed.map((mod) => mod.projectId));

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <section className="modal modsModal" role="dialog" aria-modal="true" aria-label="편의 모드" onClick={(event) => event.stopPropagation()}>
        <header className="modalHeader">
          <div>
            <p className="eyebrow">편의 모드</p>
            <h2>{server.name}</h2>
            <small>{loaderNames[server.loader.kind]} · Minecraft {server.minecraftVersion}용 · 서버 설치가 필요 없는 모드만 보여요</small>
          </div>
          <button className="closeButton" onClick={onClose}>닫기</button>
        </header>
        <div className="modalBody">
          {notice && <p className={`noticeBar${notice.error ? "" : " isInfo"}`} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
          {!moddable ? (
            <p className="emptyText">이 서버는 모드 없이 바닐라로 실행돼서 편의 모드를 넣을 수 없어요.</p>
          ) : (
            <>
              <div className="modsToolbar">
                <div className="segmented" role="tablist">
                  <button role="tab" aria-selected={tab === "search"} className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>찾기</button>
                  <button role="tab" aria-selected={tab === "installed"} className={tab === "installed" ? "active" : ""} onClick={() => { setTab("installed"); void refreshInstalled(true); }}>
                    설치됨 {installed.length > 0 ? installed.length : ""}
                  </button>
                </div>
                {tab === "search" && (
                  <input className="modsSearch" aria-label="모드 검색" value={query} placeholder="미니맵, 성능, 줌…" onChange={(event) => setQuery(event.target.value)} />
                )}
              </div>
              {tab === "search" ? (
                <div className="modList">
                  {hits.map((hit) => {
                    const status = installedIds.has(hit.projectId) ? "installed" : hit.status;
                    return (
                      <article className="modItem" key={hit.projectId}>
                        {hit.iconUrl ? <img src={hit.iconUrl} alt="" loading="lazy" /> : <span className="modIconFallback" aria-hidden="true">{hit.title.slice(0, 1)}</span>}
                        <div className="modText">
                          <strong>{hit.title}</strong>
                          <p>{hit.description}</p>
                          <small>다운로드 {formatDownloads(hit.downloads)}</small>
                        </div>
                        {status === "available" ? (
                          <button className="secondaryButton" disabled={busyId !== null} onClick={() => void act(hit.projectId, () => window.bweeep.installMod(target, hit.projectId), `${hit.title}을(를) 설치했어요. 다음 게임 시작부터 적용돼요.`, "모드를 설치하지 못했어요.")}>
                            {busyId === hit.projectId ? "설치 중…" : "설치"}
                          </button>
                        ) : (
                          <span className={`modStatus is-${status}`}>{status === "installed" ? "설치됨" : status === "inPack" ? "서버 팩에 포함" : "서버에서 막음"}</span>
                        )}
                      </article>
                    );
                  })}
                  {!loading && hits.length === 0 && <p className="emptyText">맞는 모드를 찾지 못했어요.</p>}
                  {loading && <p className="emptyText">불러오는 중…</p>}
                  {!loading && hits.length < total && (
                    <button className="secondaryButton modMore" onClick={() => void search(query, hits.length)}>더 보기</button>
                  )}
                </div>
              ) : (
                <div className="modList">
                  {installed.length === 0 && <p className="emptyText">아직 설치한 편의 모드가 없어요.</p>}
                  {installed.map((mod) => (
                    <article className="modItem" key={mod.projectId}>
                      <span className="modIconFallback" aria-hidden="true">{mod.title.slice(0, 1)}</span>
                      <div className="modText">
                        <strong>{mod.title}</strong>
                        <small>{mod.versionNumber}{mod.explicit ? "" : " · 다른 모드에 필요해서 함께 설치됨"}{mod.update ? ` · 새 버전 ${mod.update}` : ""}</small>
                      </div>
                      <div className="modActions">
                        {mod.update && (
                          <button className="secondaryButton" disabled={busyId !== null} onClick={() => void act(mod.projectId, () => window.bweeep.updateMod(target, mod.projectId), `${mod.title}을(를) 업데이트했어요.`, "모드를 업데이트하지 못했어요.")}>
                            업데이트
                          </button>
                        )}
                        {mod.explicit && (
                          <button className="textButton dangerText" disabled={busyId !== null} onClick={() => void act(mod.projectId, () => window.bweeep.removeMod(target, mod.projectId), `${mod.title}을(를) 지웠어요.`, "모드를 지우지 못했어요.")}>
                            삭제
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <p className="mutedText">설치한 모드는 게임을 시작할 때 함께 들어가요. 게임이 켜지지 않으면 최근에 넣은 모드를 지워 보세요.</p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
