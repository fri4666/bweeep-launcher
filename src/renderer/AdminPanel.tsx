import { useEffect, useState } from "react";
import type { AdminDiagnostics, AdminNames, AdminRelease, NameHold, UuidReservation } from "../shared/admin-types.js";
import { type AdminNotice, type LauncherNotice, MAX_NOTICE_LENGTH, noticeProblem, tidyNoticeText } from "../shared/notice.js";
import { SERVER_LACKS_FEATURE_TEXT } from "../shared/server-errors.js";
import type { MemberSummary } from "../shared/types.js";
import { reasonLabel } from "./AuthFailureNotice.js";
import { ActionMark, errorText, FeedbackToast, useActionFeedback } from "./adminFeedback.js";
import "./admin.css";

type Tab = "members" | "notice" | "names" | "releases" | "diagnostics";
const tabs: Array<[Tab, string]> = [["members", "멤버"], ["notice", "공지"], ["names", "이름"], ["releases", "서버 팩"], ["diagnostics", "진단"]];
const noticeProblemText = { empty: "", long: `${MAX_NOTICE_LENGTH}자까지 쓸 수 있어요.`, lines: "두 줄까지 쓸 수 있어요." } as const;

export interface AdminConfirm {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
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

interface AdminPanelProps {
  selfId: string;
  onClose: () => void;
  confirm: (request: AdminConfirm) => void;
  /** How the main screen learns of a change made here: the notice this admin sees now. */
  onNoticeChange: (notice: LauncherNotice | null) => void;
}

/** Admins only: members, the notice, name holds and reservations, server pack versions and join problems. */
export function AdminPanel({ selfId, onClose, confirm, onNoticeChange }: AdminPanelProps) {
  const [tab, setTab] = useState<Tab>("members");
  const [noticeDraft, setNoticeDraft] = useState("");
  // Who the next notice is for: "all", or a member's id. The list holds every notice shown now.
  const [recipient, setRecipient] = useState("all");
  const [notices, setNotices] = useState<AdminNotice[] | null>(null);
  // False on a server that predates personal notices: only the notice everyone sees can be posted.
  const [listSupported, setListSupported] = useState(true);
  const [members, setMembers] = useState<MemberSummary[] | null>(null);
  const [names, setNames] = useState<AdminNames | null>(null);
  const [releases, setReleases] = useState<AdminRelease[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<AdminDiagnostics | null>(null);
  // Every request goes through `act`: busy while it runs, a green check when it worked, red text when it failed.
  const { busy, doneKey, feedback, run: act, fail, clear, stateClass } = useActionFeedback();
  const markOf = (key: string) => (busy === key ? "busy" : doneKey === key ? "done" : null);
  const now = Date.now();

  async function load(which: Tab) {
    try {
      if (which === "members") setMembers(await window.bweeep.listMembers());
      if (which === "notice") await loadNotices();
      if (which === "names") setNames(await window.bweeep.adminNames());
      if (which === "releases") setReleases(await window.bweeep.adminReleases());
      if (which === "diagnostics") setDiagnostics(await window.bweeep.adminDiagnostics());
    } catch (error) {
      fail(error, "관리 정보를 불러오지 못했어요.");
    }
  }

  async function loadNotices() {
    const own = await window.bweeep.notice();
    onNoticeChange(own);
    setMembers(await window.bweeep.listMembers());
    try {
      setNotices(await window.bweeep.adminNotices());
      setListSupported(true);
    } catch (error) {
      if (errorText(error, "") !== SERVER_LACKS_FEATURE_TEXT) throw error;
      // An older server: show the one notice everyone sees, and no recipient choice.
      setListSupported(false);
      setRecipient("all");
      setNotices(own && !own.personal ? [{ id: own.id, text: own.text, at: own.at, target: null }] : []);
    }
  }

  useEffect(() => {
    clear();
    void load(tab);
  }, [tab]);

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

  const draftProblem = noticeProblem(noticeDraft);

  const recipientMember = recipient === "all" ? null : members?.find((member) => member.userId === recipient) ?? null;
  const replacesShown = Boolean(notices?.some((notice) => (notice.target?.userId ?? "all") === recipient));

  /** What the list shows after a change, and the notice the admin's own main screen should now show. */
  async function afterNoticeChange(update: { notice: LauncherNotice | null; notices: AdminNotice[] }) {
    const own = await window.bweeep.notice().catch(() => null);
    return { own, notices: listSupported ? update.notices : update.notice && !update.notice.personal ? [{ id: update.notice.id, text: update.notice.text, at: update.notice.at, target: null }] : [] };
  }

  function postNotice() {
    const target = recipient === "all" || !listSupported ? undefined : recipient;
    void act("notice", async () => afterNoticeChange(await window.bweeep.setNotice(noticeDraft, target)), (result) => {
      onNoticeChange(result.own);
      setNotices(result.notices);
      setNoticeDraft("");
    }, target ? "개인 공지를 올렸어요" : "공지를 올렸어요", "공지를 올리지 못했어요.");
  }

  function takeNoticeDown(notice: AdminNotice) {
    void act(`notice:${notice.id}`, async () => afterNoticeChange(await window.bweeep.clearNotice(notice.target?.userId)), (result) => {
      onNoticeChange(result.own);
      setNotices(result.notices);
    }, notice.target ? "개인 공지를 내렸어요" : "공지를 내렸어요", "공지를 내리지 못했어요.");
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
          {tab === "members" && (
            <div className="adminList">
              {members === null && <p className="emptyText">불러오는 중…</p>}
              {members?.map((member) => {
                const self = member.userId === selfId;
                return (
                  <article className={`adminRow${stateClass(member.userId)}`} key={member.userId}>
                    <div className="adminRowText">
                      <strong>{member.name}{self ? " · 나" : ""}</strong>
                      <small>
                        {member.gameName ?? "이름 없음"}
                        {member.lastPlayedAt ? ` · ${formatAgo(member.lastPlayedAt, now)} 플레이` : ""}
                      </small>
                    </div>
                    <div className="adminRowActions">
                      <ActionMark state={markOf(member.userId)} />
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

          {tab === "notice" && (
            <>
              <section className={`panel adminPanelState${stateClass("notice")}`}>
                <div className="panelHeader">
                  <h3>지금 공지</h3>
                  <ActionMark state={markOf("notice")} />
                </div>
                {notices === null && <p className="emptyText">불러오는 중…</p>}
                {notices?.length === 0 && (
                  <div className="adminNoticeShown">
                    <p className="emptyText">올린 공지가 없어요.</p>
                  </div>
                )}
                {notices?.map((notice) => (
                  <div className={`adminNoticeShown adminNoticeItem${stateClass(`notice:${notice.id}`)}`} key={notice.id}>
                    <div className="adminNoticeBody">
                      <small className="adminNoticeTarget">
                        {notice.target ? `${notice.target.name}${notice.target.gameName ? ` · ${notice.target.gameName}` : ""}에게만` : "모두"}
                        {` · ${formatWhen(notice.at)}`}
                      </small>
                      <p>{notice.text}</p>
                    </div>
                    <div className="adminRowActions">
                      <ActionMark state={markOf(`notice:${notice.id}`)} />
                      <button className="textButton dangerText" disabled={busy !== null} onClick={() => takeNoticeDown(notice)}>내리기</button>
                    </div>
                  </div>
                ))}
              </section>
              <section className="panel">
                <div className="panelHeader">
                  <h3>새 공지</h3>
                  <span className={draftProblem === "long" ? "isOver" : undefined}>{[...tidyNoticeText(noticeDraft)].length}/{MAX_NOTICE_LENGTH}</span>
                </div>
                <div className="adminNoticeTo">
                  <label htmlFor="adminNoticeTo">받는 사람</label>
                  <select
                    id="adminNoticeTo"
                    className="adminSelect"
                    value={recipient}
                    disabled={!listSupported || busy !== null}
                    onChange={(event) => setRecipient(event.target.value)}
                  >
                    <option value="all">모두</option>
                    {members?.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.name}{member.gameName ? ` · ${member.gameName}` : ""}{member.userId === selfId ? " · 나" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  className="adminNoticeInput"
                  aria-label="공지 내용"
                  rows={2}
                  value={noticeDraft}
                  placeholder={recipientMember ? `${recipientMember.name}에게만 보여요` : "모든 멤버의 런처 첫 화면에 보여요"}
                  onChange={(event) => setNoticeDraft(event.target.value)}
                />
                <div className="adminNoticeActions">
                  <small>{draftProblem ? noticeProblemText[draftProblem] : replacesShown ? "지금 공지를 바꿔요." : ""}</small>
                  <div className="adminRowActions">
                    <ActionMark state={markOf("notice")} />
                    <button className="primaryButton" disabled={draftProblem !== null || busy !== null} onClick={postNotice}>올리기</button>
                  </div>
                </div>
              </section>
            </>
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
                    <article className={`adminRow${stateClass(`${hold.userId}:${hold.gameName}`)}`} key={`${hold.userId}:${hold.gameName}`}>
                      <div className="adminRowText">
                        <strong>{hold.gameName}</strong>
                        <small>{hold.owner}{hold.kind === "removed" ? " · 나간 멤버" : ""} · {formatLeft(hold.heldUntil, now)}</small>
                      </div>
                      <div className="adminRowActions">
                        <ActionMark state={markOf(`${hold.userId}:${hold.gameName}`)} />
                        <button className="secondaryButton" disabled={busy !== null} onClick={() => releaseHold(hold)}>지금 풀기</button>
                      </div>
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
                    <article className={`adminRow${stateClass(reservation.minecraftUuid)}`} key={reservation.minecraftUuid}>
                      <div className="adminRowText">
                        <strong>{reservation.gameName}</strong>
                        <small title={reservation.minecraftUuid}>{reservation.owner ?? "주인 없음"} · {reservation.minecraftUuid.slice(0, 8)}</small>
                      </div>
                      <div className="adminRowActions">
                        <ActionMark state={markOf(reservation.minecraftUuid)} />
                        <button className="textButton dangerText" disabled={busy !== null} onClick={() => deleteReservation(reservation)}>예약 해제</button>
                      </div>
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
                        <article className={`adminRow${release.active ? " isActive" : ""}${stateClass(release.id)}`} key={release.id}>
                          <div className="adminRowText">
                            <strong>{release.version}</strong>
                            <small>
                              {formatWhen(release.createdAt)}
                              {release.gameAuth === "yggdrasil" ? "" : " · 오프라인"}
                              {release.audience === "testers" ? " · 테섭" : ""}
                            </small>
                          </div>
                          {release.active ? (
                            <div className="adminRowActions">
                              <ActionMark state={markOf(release.id)} />
                              <span className="adminActive">사용 중</span>
                            </div>
                          ) : (
                            <div className="adminRowActions">
                              <ActionMark state={markOf(release.id)} />
                              <button
                                className="secondaryButton"
                                disabled={release.gameAuth !== "yggdrasil" || busy !== null}
                                title={release.gameAuth !== "yggdrasil" ? "붸에엡 계정 접속이 아닌 버전은 켤 수 없어요" : undefined}
                                onClick={() => activate(release, current)}
                              >
                                이 버전으로
                              </button>
                            </div>
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
                    <article className={`adminRow${stateClass(upload.id)}`} key={upload.id}>
                      <div className="adminRowText">
                        <strong>{upload.owner}</strong>
                        <small>{formatWhen(upload.at)} · {Math.max(1, Math.round(upload.sizeBytes / 1024))}KB</small>
                      </div>
                      <div className="adminRowActions">
                        <ActionMark state={markOf(upload.id)} />
                        <button className="secondaryButton" disabled={busy !== null} onClick={() => void act(upload.id, () => window.bweeep.openDiagnostics(upload.id), () => undefined, "브라우저에서 열었어요", "진단 정보를 열지 못했어요.")}>
                          열기
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
        <FeedbackToast feedback={feedback} onClose={clear} />
      </section>
    </div>
  );
}
