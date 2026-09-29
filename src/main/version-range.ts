// Minecraft version ranges as mod jars declare them. Fabric and Quilt write
// npm-style predicates ("*", ">=1.20 <1.21", "~1.20", "1.20.x"); Forge and
// NeoForge write Maven ranges ("[1.20,1.21)", "[1.20.1]"). Versions are
// compared by their numbers only, so new schemes such as 26.3 work as well.
// null means the text could not be read; callers then let the mod through.

export type RangeSyntax = "semver" | "maven";

/** One dependency on Minecraft; any of the alternatives satisfies it. */
export interface MinecraftRequirement {
  syntax: RangeSyntax;
  alternatives: string[];
}

interface Version {
  numbers: number[];
  pre: string[];
}

// A bare trailing "-" (">=1.20-", as Fabric mods write it) is the lowest pre-release.
const VERSION = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]*)?$/;

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim());
  if (!match) return null;
  const numbers = match[1].split(".").map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part))) return null;
  return { numbers, pre: match[2] === undefined ? [] : match[2] ? match[2].split(".") : [""] };
}

/** 1.20 equals 1.20.0; a pre-release comes before its release. */
export function compareVersions(left: Version, right: Version): number {
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre.length === 0 || right.pre.length === 0) return Math.sign(right.pre.length - left.pre.length);
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const a = left.pre[index];
    const b = right.pre[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const numberA = /^\d+$/.test(a) ? Number(a) : null;
    const numberB = /^\d+$/.test(b) ? Number(b) : null;
    if (numberA !== null && numberB !== null) {
      if (numberA !== numberB) return Math.sign(numberA - numberB);
    } else if (numberA !== null || numberB !== null) {
      return numberA !== null ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/** Whether `version` fits the requirement: false only when every alternative clearly refuses it. */
export function acceptsMinecraft(requirement: MinecraftRequirement, version: string): boolean | null {
  const results = requirement.alternatives.map((range) =>
    requirement.syntax === "maven" ? mavenRangeAccepts(range, version) : semverRangeAccepts(range, version));
  if (results.length === 0 || results.includes(true)) return results.length === 0 ? null : true;
  return results.every((result) => result === false) ? false : null;
}

/** npm-style ranges as Fabric and Quilt read them; "||" and spaces combine predicates. */
export function semverRangeAccepts(range: string, versionText: string): boolean | null {
  const version = parseVersion(versionText);
  if (!version) return null;
  const alternatives = range.split("||").map((part) => part.trim());
  let unknown = false;
  for (const alternative of alternatives) {
    const result = allPredicates(alternative, version);
    if (result === true) return true;
    if (result === null) unknown = true;
  }
  return unknown ? null : false;
}

function allPredicates(text: string, version: Version): boolean | null {
  if (!text || text === "*") return true;
  const predicates = [...text.matchAll(/(>=|<=|>|<|=|~|\^)?\s*([^\s<>=~^]+)/g)];
  if (predicates.length === 0 || predicates.map((match) => match[0]).join("").replace(/\s/g, "") !== text.replace(/\s/g, "")) return null;
  let unknown = false;
  for (const [, operator = "", target] of predicates) {
    const result = predicate(operator, target, version);
    if (result === false) return false;
    if (result === null) unknown = true;
  }
  return unknown ? null : true;
}

function predicate(operator: string, target: string, version: Version): boolean | null {
  if (target === "*" || /^[xX*]$/.test(target)) return true;
  const parts = target.split(".");
  const wildcard = parts.findIndex((part) => /^[xX*]$/.test(part));
  if (wildcard >= 0) {
    // 1.20.x is every 1.20 release; with another operator the x counts as 0.
    const prefix = parts.slice(0, wildcard);
    if (prefix.length === 0 || prefix.some((part) => !/^\d+$/.test(part))) return null;
    const low = parseVersion(prefix.join("."));
    if (!low) return null;
    if (operator === "" || operator === "=") return between(version, low, bump(low.numbers, prefix.length - 1));
    return predicate(operator, [...prefix, ...parts.slice(wildcard).map(() => "0")].join("."), version);
  }
  const bound = parseVersion(target);
  if (!bound) return null;
  const order = compareWithoutPre(version, bound);
  switch (operator) {
    case "": case "=": return order === 0;
    case ">=": return order >= 0;
    case ">": return order > 0;
    case "<=": return order <= 0;
    case "<": return order < 0;
    // ~1.20.1 keeps 1.20.x; ~1 keeps 1.x.
    case "~": return between(version, bound, bump(bound.numbers, bound.numbers.length >= 2 ? 1 : 0));
    case "^": return between(version, bound, bump(bound.numbers, 0));
    default: return null;
  }
}

/**
 * Pre-release tags on the bound (1.21-alpha.1) only lower it; a release
 * server version is compared by numbers, which is how loaders treat ">=1.21-".
 */
function compareWithoutPre(version: Version, bound: Version): number {
  if (version.pre.length === 0 && bound.pre.length > 0) {
    const order = compareVersions(version, { numbers: bound.numbers, pre: [] });
    return order === 0 ? 1 : order;
  }
  return compareVersions(version, bound);
}

function between(version: Version, low: Version, high: Version): boolean {
  return compareWithoutPre(version, low) >= 0 && compareVersions({ numbers: version.numbers, pre: [] }, high) < 0;
}

function bump(numbers: number[], index: number): Version {
  const next = numbers.slice(0, index + 1);
  next[index] += 1;
  return { numbers: next, pre: [] };
}

/**
 * Maven ranges as Forge reads them. A bare version is only a recommendation
 * and accepts every version, as it does in Forge.
 */
export function mavenRangeAccepts(range: string, versionText: string): boolean | null {
  const version = parseVersion(versionText);
  const spec = range.trim();
  if (!version || !spec || spec.includes("${")) return null;
  if (!/^[[(]/.test(spec)) return parseVersion(spec) || spec === "*" ? true : null;
  let rest = spec;
  let unknown = false;
  let any = false;
  while (rest) {
    const match = /^([[(])([^\])]*)([\])])\s*(?:,\s*|$)/.exec(rest);
    if (!match) return null;
    rest = rest.slice(match[0].length).trim();
    const [, open, body, close] = match;
    const result = restriction(open === "[", body, close === "]", version);
    if (result === true) any = true;
    if (result === null) unknown = true;
  }
  return any ? true : unknown ? null : false;
}

function restriction(lowInclusive: boolean, body: string, highInclusive: boolean, version: Version): boolean | null {
  if (!body.includes(",")) {
    const exact = parseVersion(body);
    if (!exact || !lowInclusive || !highInclusive) return null;
    return compareVersions(version, exact) === 0;
  }
  const [lowText, highText, extra] = body.split(",").map((part) => part.trim());
  if (extra !== undefined) return null;
  const low = lowText ? parseVersion(lowText) : null;
  const high = highText ? parseVersion(highText) : null;
  if ((lowText && !low) || (highText && !high)) return null;
  if (low) {
    const order = compareVersions(version, low);
    if (order < 0 || (order === 0 && !lowInclusive)) return false;
  }
  if (high) {
    const order = compareVersions(version, high);
    if (order > 0 || (order === 0 && !highInclusive)) return false;
  }
  return true;
}
