export interface AuthCallback {
  code: string;
  flowId: string | null;
}

export class AuthCallbackError extends Error {
  constructor(
    message: string,
    readonly flowId: string | null,
    readonly category: "provider_code_expired" | "provider_error" | "invalid_callback",
    readonly diagnostics: {
      providerError: string | null;
      providerErrorCode: string | null;
      providerDescriptionFingerprint: string | null;
      stateFingerprint: string | null;
    }
  ) {
    super(message);
    this.name = "AuthCallbackError";
  }
}

const inviteCodePattern = /^BWEEP-[A-F0-9]{12}-[A-F0-9]{12}$/;

export function parseAuthCallback(rawUrl: string, scheme = "bwe-e-ep"): AuthCallback {
  const url = new URL(rawUrl);
  if (url.protocol !== `${scheme}:` || url.hostname !== "auth" || url.pathname !== "/callback") {
    throw new AuthCallbackError("허용되지 않은 로그인 콜백 주소입니다.", null, "invalid_callback", emptyDiagnostics());
  }

  const flowId = url.searchParams.get("sb_flow_id");

  const authError = url.searchParams.get("error");
  if (authError) {
    const description = url.searchParams.get("error_description") ?? "로그인이 취소되었습니다.";
    const diagnostics = {
      providerError: authError,
      providerErrorCode: url.searchParams.get("error_code"),
      providerDescriptionFingerprint: fingerprint(description),
      stateFingerprint: fingerprint(url.searchParams.get("state"))
    };
    if (/code.+expired|code.+not valid/i.test(description)) {
      throw new AuthCallbackError(
        "로그인 시간이 만료되었습니다. 런처에서 Discord 로그인을 다시 눌러 새 로그인을 시작해 주세요.",
        flowId,
        "provider_code_expired",
        diagnostics
      );
    }
    throw new AuthCallbackError(description, flowId, "provider_error", diagnostics);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new AuthCallbackError("로그인 인증 코드를 받지 못했습니다.", flowId, "invalid_callback", {
      ...emptyDiagnostics(),
      stateFingerprint: fingerprint(url.searchParams.get("state"))
    });
  }
  return { code, flowId };
}

function emptyDiagnostics(): AuthCallbackError["diagnostics"] {
  return {
    providerError: null,
    providerErrorCode: null,
    providerDescriptionFingerprint: null,
    stateFingerprint: null
  };
}

function fingerprint(value: string | null): string | null {
  if (!value) return null;
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return `len:${value.length}:h:${(hash >>> 0).toString(16)}`;
}

export function parseInviteLink(rawUrl: string, scheme = "bwe-e-ep"): string {
  const url = new URL(rawUrl);
  if (url.protocol !== `${scheme}:` || url.hostname !== "invite") {
    throw new Error("허용되지 않은 초대 링크입니다.");
  }

  const code = decodeURIComponent(url.pathname.replace(/^\//, "")).trim().toUpperCase();
  if (!inviteCodePattern.test(code)) {
    throw new Error("초대 링크 형식이 올바르지 않습니다.");
  }
  return code;
}
