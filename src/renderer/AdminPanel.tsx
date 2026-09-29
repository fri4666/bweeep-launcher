import { useEffect, useState } from "react";
import type { AdminDiagnostics, AdminNames, AdminRelease, NameHold, UuidReservation } from "../shared/admin-types.js";
import type { MemberSummary } from "../shared/types.js";
import { reasonLabel } from "./AuthFailureNotice.js";
import "./admin.css";

type Tab = "members" | "names" | "releases" | "diagnostics";
const tabs: Array<[Tab, string]> = [["members", "멤버"], ["names", "이름"], ["releases", "서버 팩"], ["diagnostics", "진단"]];

export interface AdminConfirm {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

function message(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "") || fallback;
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatAgo(value: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (minutes < 60) return minutes < 1 ? "방금" : `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / (24 * 60))}일 전`;
}

function formatLeft(value: string, now: number): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(value) - now) / 60_000));
  return minutes < 60 ? `${minutes}분 남음` : `${Math.ceil(minutes / 60)}시간 남음`;
}

/** Admins only: members, name holds and reservations, server pack versions and join problems. */
export function AdminPanel({ selfId, onClose, confirm }: { selfId: string; onClose: () => void; confirm: (request: AdminConfirm) => void }) {
  const [tab, setTab] = useState<Tab>("members");
  const [members, setMembers] = useState<MemberSummary[] | null>(null);
  const [names, setNames] = useState<AdminNames | null>(null);
  const [releases, setReleases] = useState<AdminRelease[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<AdminDiagnostics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const now = Date.now();

  async function load(which: Tab) {
    try {
      if (which === "members") setMembers(await window.bweeep.listMembers());
      if (which === "names") setNames(await window.bweeep.adminNames());
      if (which === "releases") setReleases(await window.bweeep.adminReleases());
      if (which === "diagnostics") setDiagnostics(await window.bweeep.adminDiagnostics());
    } catch (error) {
      setNotice({ text: message(error, "관리 정보를 불러오지 못했어요."), error: true });
    }
  }

  useEffect(() => {
    setNotice(null);
    void load(tab);
  }, [tab]);

  async function act<T>(key: string, action: () => Promise<T>, apply: (value: T) => void, done: string, fallback: string) {
    setBusy(key);
    setNotice(null);
    try {
      apply(await action());
      setNotice({ text: done, error: false });
    } catch (error) {
      setNotice({ text: message(error, fallback), error: true });
    } finally {
      setBusy(null);
    }
  }

  function toggleTester(member: MemberSummary) {
    void act(member.userId, () => window.bweeep.setTester(member.userId, !member.tester), setMembers,
      member.tester ? `${member.name} 테스터 해제` : `${member.name} 테스터 지정`, "테스터 지정을 저장하지 못했어요.");
  }

  function changeRole(member: MemberSummary) {
    const role = member.role === "admin" ? "member" : "admin";
    confirm({
      title: role === "admin" ? `${member.name}을(를) 관리자로` : `${member.name}의 관리자 해제`,
      body: role === "admin" ? "멤버 관리, 이름·예약, 서버 팩 버전을 모두 바꿀 수 있게 돼요." : "관리 탭을 더 이상 쓸 수 없어요.",
      confirmLabel: role === "admin" ? "관리자로" : "해제",
      danger: role === "member",
      onConfirm: () => void act(member.userId, () => window.bweeep.setMemberRole(member.userId, role), setMembers,
        role === "admin" ? `${member.name} 관리자 지정` : `${member.name} 관리자 해제`, "역할을 바꾸지 못했어요.")
    });
  }

  function removeMember(member: MemberSummary) {
    confirm({
      title: `${member.name} 내보내기`,
      body: "런처와 모든 서버에 바로 못 들어와요. 게임 이름은 하루 뒤에 풀리고, 캐릭터는 남아요. 다시 들어오려면 새 초대 코드가 필요해요.",
      confirmLabel: "내보내기",
      danger: true,
      onConfirm: () => void act(member.userId, () => window.bweeep.removeMember(member.userId), setMembers, `${member.name} 내보냄`, "멤버를 내보내지 못했어요.")
    });
  }

  function releaseHold(hold: NameHold) {
    confirm({
      title: `'${hold.gameName}' 보호 풀기`,
      body: hold.kind === "removed"
        ? `나간 멤버 ${hold.owner}의 이름이 모두 풀려요. 다른 멤버가 바로 쓸 수 있어요.`
        : `${hold.owner}이(가) 전에 쓰던 이름이에요. 풀면 다른 멤버가 바로 쓸 수 있어요.`,
      confirmLabel: "지금 풀기",
      onConfirm: () => void act(`${hold.userId}:${hold.gameName}`, () => window.bweeep.releaseName(hold.userId, hold.gameName), setNames,
        `'${hold.gameName}' 보호 풂`, "이름 보호를 풀지 못했어요.")
    });
  }

  function deleteReservation(reservation: UuidReservation) {
    confirm({
      title: `'${reservation.gameName}' 예약 해제`,
      body: "이 UUID에 저장된 캐릭터(인벤토리, 위치, OP)를 지키던 보호가 없어져요. 이 UUID로 처음 들어오는 사람이 그 캐릭터를 받을 수 있어요. 되돌릴 수 없어요.",
      confirmLabel: "예약 해제",
      danger: true,
      onConfirm: () => void act(reservation.minecraftUuid, () => window.bweeep.deleteReservation(reservation.minecraftUuid), setNames,
        `'${reservation.gameName}' 예약 해제됨`, "예약을 해제하지 못했어요.")
    });
  }

  function activate(release: AdminRelease, current: AdminRelease | undefined) {
    confirm({
      title: `${release.name} 버전 바꾸기`,
      body: `${current ? `${current.version} → ` : ""}${release.version}. 다음 게임 시작부터 모두 이 버전을 받아요.`,
      confirmLabel: "바꾸기",
      onConfirm: () => void act(release.id, () => window.bweeep.activateRelease(release.id), setReleases,
        `${release.name} ${release.version} 사용 중`, "버전을 바꾸지 못했어요.")
    });
  }

  const packs = new Map<string, AdminRelease[]>();
  for (const release of releases ?? []) packs.set(release.packId, [...(packs.get(release.packId) ?? []), release]);

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <section className="modal adminModal" role="dialog" aria-modal="true" aria-label="관리" onClick={(event) => event.stopPropagation()}>
        <header className="modalHeader">
          <div>
            <p className="eyebrow">관리자 전용</p>
            <h2>관리</h2>
          </div>
          <button className="closeButton" onClick={onClose}>닫기</button>
        </header>
        <div className="modalBody">
          <div className="segmented adminTabs" role="tablist" aria-label="관리 항목">
            {tabs.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          {notice && <p className={`noticeBar${notice.error ? "" : " isInfo"}`} role={notice.error ? "alert" : "status"}>{notice.text}</p>}

          {tab === "members" && (
            <div className="adminList">
              {members === null && <p className="emptyText">불러오는 중…</p>}
              {members?.map((member) => {
                const self = member.userId === selfId;
                return (
                  <article className="adminRow" key={member.userId}>
                    <div className="adminRowText">
                      <strong>{member.name}{self ? " · 나" : ""}</strong>
                      <small>
                        {member.gameName ?? "이름 없음"}
                        {member.lastPlayedAt ? ` · ${formatAgo(member.lastPlayedAt, now)} 플레이` : ""}
                      </small>
                    </div>
                    <div className="adminRowActions">
                      <button
                        className={`adminToggle${member.tester ? " isOn" : ""}`}
                        aria-pressed={member.tester}
                        title={member.role === "admin" ? "관리자는 항상 테스터" : undefined}
                        disabled={member.role === "admin" || busy !== null}
                        onClick={() => toggleTester(member)}
                      >
                        테스터
                      </button>
                      <button
                        className={`adminToggle${member.role === "admin" ? " isOn" : ""}`}
                        aria-pressed={member.role === "admin"}
                        disabled={self || busy !== null}
                        onClick={() => changeRole(member)}
                      >
                        관리자
                      </button>
                      <button className="textButton dangerText" disabled={self || busy !== null} onClick={() => removeMember(member)}>내보내기</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {tab === "names" && (
            <>
              <section className="panel">
                <div className="panelHeader">
                  <h3>이름 보호</h3>
                  <span>하루 동안</span>
                </div>
                <div className="adminList">
                  {names === null && <p className="emptyText">불러오는 중…</p>}
                  {names?.holds.length === 0 && <p className="emptyText">보호 중인 이름이 없어요.</p>}
                  {names?.holds.map((hold) => (
                    <article className="adminRow" key={`${hold.userId}:${hold.gameName}`}>
                      <div className="adminRowText">
                        <strong>{hold.gameName}</strong>
                        <small>{hold.owner}{hold.kind === "removed" ? " · 나간 멤버" : ""} · {formatLeft(hold.heldUntil, now)}</small>
                      </div>
                      <button className="secondaryButton" disabled={busy !== null} onClick={() => releaseHold(hold)}>지금 풀기</button>
                    </article>
                  ))}
                </div>
              </section>
              <section className="panel">
                <div className="panelHeader">
                  <h3>UUID 예약</h3>
                  <span>캐릭터 보호</span>
                </div>
                <div className="adminList">
                  {names?.reservations.length === 0 && <p className="emptyText">예약이 없어요.</p>}
                  {names?.reservations.map((reservation) => (
                    <article className="adminRow" key={reservation.minecraftUuid}>
                      <div className="adminRowText">
                        <strong>{reservation.gameName}</strong>
                        <small title={reservation.minecraftUuid}>{reservation.owner ?? "주인 없음"} · {reservation.minecraftUuid.slice(0, 8)}</small>
                      </div>
                      <button className="textButton dangerText" disabled={busy !== null} onClick={() => deleteReservation(reservation)}>예약 해제</button>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}

          {tab === "releases" && (
            <>
              {releases === null && <p className="emptyText">불러오는 중…</p>}
              {releases?.length === 0 && <p className="emptyText">서버 팩이 없어요.</p>}
              {[...packs].map(([packId, list]) => {
                const current = list.find((release) => release.active);
                return (
                  <section className="panel" key={packId}>
                    <div className="panelHeader">
                      <h3>{current?.name ?? list[0].name}</h3>
                      <span>{packId}</span>
                    </div>
                    <div className="adminList">
                      {list.map((release) => (
                        <article className={`adminRow${release.active ? " isActive" : ""}`} key={release.id}>
                          <div className="adminRowText">
                            <strong>{release.version}</strong>
                            <small>
                              {formatWhen(release.createdAt)}
                              {release.gameAuth === "yggdrasil" ? "" : " · 오프라인"}
                              {release.audience === "testers" ? " · 테섭" : ""}
                            </small>
                          </div>
                          {release.active ? (
                            <span className="adminActive">사용 중</span>
                          ) : (
                            <button
                              className="secondaryButton"
                              disabled={release.gameAuth !== "yggdrasil" || busy !== null}
                              title={release.gameAuth !== "yggdrasil" ? "붸에엡 계정 접속이 아닌 버전은 켤 수 없어요" : undefined}
                              onClick={() => activate(release, current)}
                            >
                              이 버전으로
                            </button>
                          )}
                        </article>
                      ))}
                    </div>
                  </section>
                );
              })}
            </>
          )}

          {tab === "diagnostics" && (
            <>
              <section className="panel">
                <div className="panelHeader">
                  <h3>접속 실패</h3>
                  <span>7일</span>
                </div>
                <div className="adminList">
                  {diagnostics === null && <p className="emptyText">불러오는 중…</p>}
                  {diagnostics?.failures.length === 0 && <p className="emptyText">접속 실패가 없어요.</p>}
                  {diagnostics?.failures.map((failure) => (
                    <article className="adminRow" key={failure.id}>
                      <div className="adminRowText">
                        <strong>{failure.owner ?? failure.gameName ?? "알 수 없음"}</strong>
                        <small>
                          {reasonLabel[failure.reason] ?? failure.reason}
                          {failure.owner && failure.gameName ? ` · ${failure.gameName}` : ""}
                          {failure.audience === "testers" ? " · 테섭" : ""}
                        </small>
                      </div>
                      <small className="adminTime">{formatWhen(failure.at)}</small>
                    </article>
                  ))}
                </div>
              </section>
              <section className="panel">
                <div className="panelHeader">
                  <h3>받은 진단 정보</h3>
                  <span>7일</span>
                </div>
                <div className="adminList">
                  {diagnostics?.uploads.length === 0 && <p className="emptyText">받은 진단 정보가 없어요.</p>}
                  {diagnostics?.uploads.map((upload) => (
                    <article className="adminRow" key={upload.id}>
                      <div className="adminRowText">
                        <strong>{upload.owner}</strong>
                        <small>{formatWhen(upload.at)} · {Math.max(1, Math.round(upload.sizeBytes / 1024))}KB</small>
                      </div>
                      <button className="secondaryButton" disabled={busy !== null} onClick={() => void act(upload.id, () => window.bweeep.openDiagnostics(upload.id), () => undefined, "브라우저에서 열었어요", "진단 정보를 열지 못했어요.")}>
                        열기
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
