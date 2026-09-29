import { useEffect, useRef, useState } from "react";
import type { InstallMoveCheck } from "../shared/types.js";

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "").trim();
  // File system errors come in English; the player only needs to know nothing changed.
  return /[가-힣]/.test(text) ? text : "옮기지 못했어요 · 원래 위치는 그대로예요";
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))}MB`;
}

/**
 * Asked when the install location changes: move the current files there, or
 * just switch and download again. With nothing installed yet it switches at once.
 */
export function InstallMoveDialog({ from, to, onSwitch, onClose }: {
  from: string;
  to: string;
  onSwitch: (root: string, moved: boolean) => void;
  onClose: () => void;
}) {
  const [check, setCheck] = useState<InstallMoveCheck | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const moving = percent !== null;

  useEffect(() => {
    let active = true;
    window.bweeep.checkInstallMove(from, to).then((result) => {
      if (!active) return;
      if (result.entries === 0) {
        onSwitch(to, false);
        onClose();
        return;
      }
      setCheck(result);
    }).catch((reason: unknown) => {
      if (active) setError(errorText(reason));
    });
    return () => {
      active = false;
    };
  }, [from, to]);

  useEffect(() => window.bweeep.onInstallMoveProgress(setPercent), []);
  useEffect(() => cancelRef.current?.focus(), [check]);

  // Escape closes this dialog only, never the settings under it, and not while moving.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      if (!moving) onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [moving, onClose]);

  async function move() {
    setError("");
    setPercent(0);
    try {
      const moveId = await window.bweeep.moveInstall(from, to);
      onSwitch(to, true);
      // The new location is saved; only now do the originals go.
      await window.bweeep.finishInstallMove(moveId).catch(() => undefined);
      onClose();
    } catch (reason) {
      setPercent(null);
      setError(errorText(reason));
    }
  }

  const problem = error || check?.problem;
  return (
    <div className="modalBackdrop confirmBackdrop" onClick={() => !moving && onClose()}>
      <section className="confirmDialog installMoveDialog" role="alertdialog" aria-modal="true" aria-label="설치 위치 바꾸기" onClick={(event) => event.stopPropagation()}>
        <h2>{moving ? "옮기는 중" : "설치 위치 바꾸기"}</h2>
        <p className="pathValue" title={to}>{to}</p>
        {moving ? (
          <div className="installMoveProgress" role="status" aria-label="옮기는 중">
            <progress className="launchProgressBar" max={100} value={percent} />
            <span>{percent}%</span>
          </div>
        ) : (
          <>
            {problem ? <p className="fieldError" role="alert">{problem}</p>
              : check ? <p>지금 파일 {formatSize(check.bytes)}를 새 위치로 옮길까요?</p>
              : <p>확인 중…</p>}
            <p className="fieldNote">새로 받기는 지금 파일을 그대로 두고 새 위치에서 다시 받아요.</p>
          </>
        )}
        {!moving && (
          <div className="confirmActions">
            <button ref={cancelRef} className="secondaryButton" onClick={onClose}>취소</button>
            <button className="secondaryButton" disabled={!check && !error} onClick={() => { onSwitch(to, false); onClose(); }}>새로 받기</button>
            <button className="primaryButton" disabled={!check || Boolean(check.problem)} onClick={() => void move()}>옮기기</button>
          </div>
        )}
      </section>
    </div>
  );
}
