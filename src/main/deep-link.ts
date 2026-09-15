export interface AuthCallback {
  code: string;
}

export function parseAuthCallback(rawUrl: string): AuthCallback {
  const url = new URL(rawUrl);
  if (url.protocol !== "bwe-e-ep:" || url.hostname !== "auth" || url.pathname !== "/callback") {
    throw new Error("허용되지 않은 로그인 콜백 주소입니다.");
  }

  const authError = url.searchParams.get("error");
  if (authError) {
    throw new Error(url.searchParams.get("error_description") ?? "Discord 로그인이 취소되었습니다.");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("로그인 인증 코드를 받지 못했습니다.");
  }
  return { code };
}
