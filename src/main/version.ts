export function isNewerLauncherVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const base = parseVersion(current);
  if (!next || !base) return candidate !== current;

  for (let index = 0; index < Math.max(next.core.length, base.core.length); index += 1) {
    const left = next.core[index] ?? 0;
    const right = base.core[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }

  if (!next.prerelease && base.prerelease) return true;
  if (next.prerelease && !base.prerelease) return false;
  if (next.prerelease && base.prerelease) return comparePrerelease(next.prerelease, base.prerelease) > 0;
  return false;
}

function parseVersion(version: string): { core: number[]; prerelease: string[] | null } | null {
  const normalized = version.trim().replace(/^v/i, "");
  const match = /^(\d+(?:\.\d+){0,2})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(normalized);
  if (!match) return null;
  return {
    core: match[1].split(".").map((part) => Number(part)),
    prerelease: match[2] ? match[2].split(".") : null
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a) ? Number(a) : null;
    const bNumber = /^\d+$/.test(b) ? Number(b) : null;
    if (aNumber !== null && bNumber !== null) return aNumber - bNumber;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return a.localeCompare(b);
  }
  return 0;
}
