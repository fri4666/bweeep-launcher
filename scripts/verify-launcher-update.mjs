import { isNewerLauncherVersion } from "../dist/src/main/version.js";

const cases = [
  ["0.1.29", "0.1.30", false],
  ["0.1.30", "0.1.30", false],
  ["0.1.31", "0.1.30", true],
  ["v0.1.31", "0.1.30", true],
  ["0.1.30-test.1", "0.1.30", false],
  ["0.1.30", "0.1.30-test.1", true],
  ["0.1.30-test.2", "0.1.30-test.1", true]
];

for (const [candidate, current, expected] of cases) {
  const actual = isNewerLauncherVersion(candidate, current);
  if (actual !== expected) {
    throw new Error(`expected ${candidate} newer than ${current} to be ${expected}, got ${actual}`);
  }
}

console.log("launcher-update-version-regressions=passed");
