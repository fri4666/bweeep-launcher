export interface AuthCallback {
  code: string;
  flowId: string | null;
}

export class AuthCallbackError extends Error {
  constructor(
    message: string,
    readonly flowId: string | null,
    readonly category: "provider_code_expired" | "provider_error" | "invalid_callback"
  ) {
    super(message);
    this.name = "AuthCallbackError";
  }
}

const inviteCodePattern = /^BWEEP-[A-F0-9]{12}-[A-F0-9]{12}$/;

export function parseAuthCallback(rawUrl: string): AuthCallback {
  const url = new URL(rawUrl);
  if (url.protocol !== "bwe-e-ep:" || url.hostname !== "auth" || url.pathname !== "/callback") {
    throw new AuthCallbackError("허용되지 않은 로그인 콜백 주소입니다.", null, "invalid_callback");
  }

  const flowId = url.searchParams.get("sb_flow_id");

  const authError = url.searchParams.get("error");
  if (authError) {
    const description = url.searchParams.get("error_description") ?? "로그인이 취소되었습니다.";
    if (/AADSTS70000|code.+expired|code.+not valid/i.test(description)) {
      throw new AuthCallbackError(
        "Microsoft 로그인 시간이 만료되었습니다. 런처에서 Microsoft 로그인을 다시 눌러 새 로그인을 시작해 주세요.",
        flowId,
        "provider_code_expired"
      );
    }
    throw new AuthCallbackError(description, flowId, "provider_error");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new AuthCallbackError("로그인 인증 코드를 받지 못했습니다.", flowId, "invalid_callback");
  }
  return { code, flowId };
}

export function parseInviteLink(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "bwe-e-ep:" || url.hostname !== "invite") {
    throw new Error("허용되지 않은 초대 링크입니다.");
  }

  const code = decodeURIComponent(url.pathname.replace(/^\//, "")).trim().toUpperCase();
  if (!inviteCodePattern.test(code)) {
    throw new Error("초대 링크 형식이 올바르지 않습니다.");
  }
  return code;
}
