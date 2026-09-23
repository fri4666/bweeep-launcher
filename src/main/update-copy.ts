/** Turns release metadata into short Korean copy suitable for the launcher UI. */
export function koreanReleaseNotes(releaseNotes: string[]): string[] {
  const normalized = releaseNotes
    .map((note) => decodeEntities(stripHtml(note)).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (normalized.length === 0) return ["새 버전을 준비했습니다."];
  return normalized.map(toKoreanCopy);
}

function toKoreanCopy(note: string): string {
  if (/[가-힣]/.test(note)) return note;
  const vanilla = note.match(/^vanilla minecraft ([\w.-]+) survival client\.?$/i);
  if (vanilla) return `Minecraft ${vanilla[1]} 생존 서버용 클라이언트 업데이트`;
  if (/\b(fix|bug|repair|patch)\b/i.test(note)) return "여러 오류를 수정했습니다.";
  if (/\b(feature|add|new)\b/i.test(note)) return "새 기능을 추가했습니다.";
  if (/\b(security|security fix)\b/i.test(note)) return "보안과 안정성을 개선했습니다.";
  return "안정성과 사용성을 개선했습니다.";
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}
