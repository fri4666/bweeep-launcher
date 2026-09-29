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

/** Who writes the notes; shown in the article's meta line. */
const AUTHOR = "월급루팡 클로드";

/**
 * Plain section headings (새 기능, 바뀐 점, 고친 문제, 알려진 문제, 다음 패치 예고)
 * with plain bullets and each item's nested "참고:" notes, like a patch notes
 * article. A list with no headings stays one list.
 */
export function ReleaseNoteSections({ sections }: { sections: ReleaseNoteSection[] }) {
  return (
    <div className="releaseSections">
      {sections.map((section, index) => (
        <section className={`releaseSection is-${section.kind}`} key={`${section.kind}-${index}`}>
          {section.title && <h3>{section.title}</h3>}
          <ul className="releaseList">
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

/** "런처 업데이트 | 월급루팡 클로드 | 날짜" under the title. */
export function ReleaseMeta({ date }: { date?: string }) {
  return (
    <p className="releaseMeta">
      <span className="releaseCategory">런처 업데이트</span>
      <span>{AUTHOR}</span>
      {date && <span>{date}</span>}
    </p>
  );
}

export function releaseTitle(version: string): string {
  return `붸에엡 런처 ${version} 패치 노트`;
}

/** The developer's greeting or sign-off, one paragraph per line. */
function Paragraphs({ className, text }: { className: string; text: string }) {
  return (
    <div className={className}>
      {text.split("\n").map((line, index) => <p key={index}>{line}</p>)}
    </div>
  );
}

function VersionTags({ note, currentVersion }: { note: PatchNote; currentVersion: string }) {
  return (
    <>
      {note.version === currentVersion && <span className="patchTag isCurrent">지금 버전</span>}
      {note.prerelease && <span className="patchTag isBeta">테스트</span>}
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
                    <VersionTags note={note} currentVersion={patchNotes.currentVersion} />
                  </button>
                ))}
              </nav>
              <article className="patchDetail" aria-label={`v${selected.version} 패치노트`}>
                <header className="patchHead">
                  <h2 className="releaseTitle">{releaseTitle(selected.version)}</h2>
                  <p className="patchSubtitle">
                    {selected.prerelease ? "테스터가 먼저 받아 보는 버전입니다." : "이번 업데이트에서 달라진 점을 정리했습니다."}
                  </p>
                </header>
                <ReleaseMeta date={formatReleaseDate(selected.publishedAt)} />
                {selected.summary && <p className="releaseSummary">요약: {selected.summary}</p>}
                {selected.intro && <Paragraphs className="patchIntro" text={selected.intro} />}
                {selected.sections.length > 0
                  ? <ReleaseNoteSections sections={selected.sections} />
                  : <p className="emptyText">적힌 내용이 없어요.</p>}
                {selected.outro && <Paragraphs className="patchOutro" text={selected.outro} />}
                {selected.url && (
                  <button className="textButton patchMore" onClick={() => void openDetails(selected.url!)}>GitHub에서 자세히 보기</button>
                )}
              </article>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
