import { createOfflineLaunchIdentity } from "../dist/src/main/launch-identity.js";

const preferredDisplayName = createOfflineLaunchIdentity(
  "00000000-0000-4000-8000-000000000001",
  "seos_py",
  "seos_py0"
);
if (preferredDisplayName.name !== "seos_py") {
  throw new Error(`Expected seos_py, received ${preferredDisplayName.name}`);
}

const invalidDisplayNameFallsBack = createOfflineLaunchIdentity(
  "00000000-0000-4000-8000-000000000002",
  "한글 표시 이름",
  "valid_user"
);
if (invalidDisplayNameFallsBack.name !== "valid_user") {
  throw new Error(`Expected valid_user fallback, received ${invalidDisplayNameFallsBack.name}`);
}

const sameAccountDifferentName = createOfflineLaunchIdentity(
  "00000000-0000-4000-8000-000000000001",
  "another_name"
);
if (sameAccountDifferentName.id !== preferredDisplayName.id) {
  throw new Error("Changing the visible name changed the stable offline UUID.");
}

console.log("Launch identity prefers seos_py, falls back safely, and keeps a stable UUID.");
