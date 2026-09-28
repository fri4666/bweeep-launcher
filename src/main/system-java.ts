/** What `java -version` reported for one installed Java. */
export interface JavaProbe {
  java?: { path: string; majorVersion: number };
  stdout: string;
  stderr: string;
}

/**
 * A Java found on the PC is only a fallback for when the Mojang runtime cannot
 * be installed, and only when it has exactly the pack's major version and is
 * a 64-bit VM (a 32-bit Java cannot give the game its 6 GB heap).
 */
export function isUsableSystemJava(probe: JavaProbe, majorVersion: number): boolean {
  if (!probe.java || probe.java.majorVersion !== majorVersion) return false;
  return /64-Bit/i.test(`${probe.stdout}\n${probe.stderr}`);
}
