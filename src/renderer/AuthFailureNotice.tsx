import { useState } from "react";
import type { AuthFailureReason } from "../shared/admin-types.js";
import "./admin.css";

/** What the player reads when the account API turned them away. */
// One short line in the narrow dock; starting the game again is the fix for most.
const playerText: Record<AuthFailureReason, string> = {
  token_expired: "접속 토큰이 만료됐어요",
  token_revoked: "다른 곳에서 게임을 켜서 막혔어요",
  unknown_token: "접속 토큰을 확인하지 못했어요",
  signed_out: "로그아웃돼서 막혔어요",
  not_member: "멤버가 아니라서 막혔어요",
  testers_only: "테스터 전용 서버예요",
  profile_mismatch: "게임 이름이 계정과 달라요",
  name_mismatch: "게임 이름이 계정과 달라요",
  no_join: "계정 확인에 실패했어요",
  unknown: "계정 확인에 실패했어요"
};

/** Short labels for the admin tab. */
export const reasonLabel: Record<AuthFailureReason, string> = {
  token_expired: "토큰 만료",
  token_revoked: "폐기된 토큰",
  unknown_token: "모르는 토큰",
  signed_out: "로그아웃됨",
  not_member: "멤버 아님",
  testers_only: "테스터 전용",
  profile_mismatch: "프로필 불일치",
  name_mismatch: "이름 불일치",
  no_join: "접속 기록 없음",
  unknown: "알 수 없음"
};

export function authFailureText(reason: string): string {
  return playerText[reason as AuthFailureReason] ?? playerText.unknown;
}

export function AuthFailureLine({ reason }: { reason: string }) {
  return (
    <p className="authFailureLine">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
      <span>{authFailureText(reason)}</span>
    </p>
  );
}

/** Sends the end of the game and launcher logs, tokens masked, for admins to look at. */
export function DiagnosticsButton() {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [error, setError] = useState("");
  async function send() {
    setState("sending");
    try {
      await window.bweeep.sendDiagnostics();
      setState("sent");
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason ?? "");
      setError(text.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "") || "진단 정보를 보내지 못했어요.");
      setState("failed");
    }
  }
  return (
    <>
      <button
        type="button"
        className={`diagnosticsButton is-${state}`}
        disabled={state === "sending" || state === "sent"}
        onClick={() => void send()}
      >
        {state === "sending" ? "보내는 중…" : state === "sent" ? "진단 정보 보냄" : state === "failed" ? "다시 보내기" : "진단 정보 보내기"}
      </button>
      {state === "failed" && <small className="diagnosticsError" role="alert">{error}</small>}
    </>
  );
}
