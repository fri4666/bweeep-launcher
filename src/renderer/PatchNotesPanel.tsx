import { useEffect, useState } from "react";
import type { PatchNote, PatchNotes, ReleaseNoteSection } from "../shared/types.js";

function message(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || fallback;
}

function formatReleaseDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}

const sourceNotices: Record<PatchNotes["source"], string> = {
  live: "",
  cache: "오프라인 · 마지막으로 받은 내용이에요",
  bundled: "오프라인 · 이 버전 내용만 보여요"
};

/**
 * Grouped bullets (새 기능, 바뀐 점, 고친 문제, 알려진 문제, 다음 패치 예고), each
 * with its small "참고:" notes; a list with no headings stays one list.
 */
export function ReleaseNoteSections({ sections }: { sections: ReleaseNoteSection[] }) {
  return (
    <div className="releaseSections">
      {sections.map((section, index) => (
        <section className={`releaseSection is-${section.kind}`} key={`${section.kind}-${index}`}>
          {section.title && <h4>{section.title}</h4>}
          <ul className="whatsNewList">
            {section.items.map((item, itemIndex) => {
              const notes = section.details?.[itemIndex] ?? [];
              return (
                <li key={itemIndex}>
                  {item}
                  {notes.length > 0 && (
                    <ul className="releaseSubNotes">
                      {notes.map((note, noteIndex) => <li key={noteIndex}>{note}</li>)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The developer's greeting or sign-off, one paragraph per line. */
function Paragraphs({ className, text }: { className: string; text: string }) {
  return (
    <div className={className}>
      {text.split("\n").map((line, index) => <p key={index}>{line}</p>)}
    </div>
  );
}

function VersionBadges({ note, currentVersion }: { note: PatchNote; currentVersion: string }) {
  return (
    <>
      {note.version === currentVersion && <span className="patchBadge isCurrent">지금 버전</span>}
      {note.prerelease && <span className="patchBadge isBeta">테스트</span>}
    </>
  );
}

/** Release notes of recent versions, newest first, like a game's patch notes page. */
export function PatchNotesPanel({ onClose }: { onClose: () => void }) {
  const [patchNotes, setPatchNotes] = useState<PatchNotes | null>(null);
  const [error, setError] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.bweeep.patchNotes().then((result) => {
      if (!active) return;
      setPatchNotes(result);
      setSelectedVersion(result.notes[0]?.version ?? null);
    }).catch((reason: unknown) => {
      if (active) setError(message(reason, "패치노트를 불러오지 못했어요."));
    });
    return () => {
      active = false;
    };
  }, []);

  const selected = patchNotes?.notes.find((note) => note.version === selectedVersion) ?? null;
  const notice = patchNotes ? sourceNotices[patchNotes.source] : "";

  async function openDetails(url: string) {
    try {
      await window.bweeep.openReleasePage(url);
    } catch (reason) {
      setError(message(reason, "릴리스 페이지를 열지 못했어요."));
    }
  }

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <section className="modal patchNotesModal" role="dialog" aria-modal="true" aria-label="패치노트" onClick={(event) => event.stopPropagation()}>
        <header className="modalHeader">
          <div>
            <p className="eyebrow">패치노트</p>
            <h2>업데이트 소식</h2>
            {patchNotes && <small>지금 쓰는 버전 v{patchNotes.currentVersion}</small>}
          </div>
          <button className="closeButton" onClick={onClose}>닫기</button>
        </header>
        <div className="modalBody">
          {notice && <p className="noticeBar isInfo" role="status">{notice}</p>}
          {error && <p className="noticeBar" role="alert">{error}</p>}
          {!patchNotes && !error && <p className="emptyText">불러오는 중…</p>}
          {patchNotes && patchNotes.notes.length === 0 && <p className="emptyText">아직 없어요.</p>}
          {patchNotes && selected && (
            <div className="patchLayout">
              <nav className="patchVersions" aria-label="버전 목록">
                {patchNotes.notes.map((note) => (
                  <button
                    key={note.version}
                    type="button"
                    className={`patchVersion${note.version === selected.version ? " active" : ""}`}
                    aria-pressed={note.version === selected.version}
                    onClick={() => setSelectedVersion(note.version)}
                  >
                    <strong>v{note.version}</strong>
                    <small>{formatReleaseDate(note.publishedAt) || "날짜 없음"}</small>
                    <span className="patchBadges"><VersionBadges note={note} currentVersion={patchNotes.currentVersion} /></span>
                  </button>
                ))}
              </nav>
              <article className="patchDetail" aria-label={`v${selected.version} 패치노트`}>
                <p className="eyebrow">{formatReleaseDate(selected.publishedAt) || "패치노트"}</p>
                <h3>
                  v{selected.version}
                  <VersionBadges note={selected} currentVersion={patchNotes.currentVersion} />
                </h3>
                {selected.summary && <p className="patchSummary">{selected.summary}</p>}
                {selected.intro && <Paragraphs className="patchIntro" text={selected.intro} />}
                {selected.sections.length > 0
                  ? <ReleaseNoteSections sections={selected.sections} />
                  : <p className="emptyText">적힌 내용이 없어요.</p>}
                {selected.outro && <Paragraphs className="patchOutro" text={selected.outro} />}
                {selected.url && (
                  <button className="secondaryButton patchMore" onClick={() => void openDetails(selected.url!)}>자세히 보기</button>
                )}
              </article>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
