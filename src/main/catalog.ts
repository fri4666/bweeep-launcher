import type { ServerPreset } from "../shared/types.js";

export function getServerPresets(): ServerPreset[] {
  return [
    {
      id: "create-aeronautics",
      name: "Create Aeronautics",
      description: "Minecraft 1.21.1 + NeoForge + Create Aeronautics",
      packId: "create-aeronautics",
      server: { host: "server.fri4666.com", port: 25565 },
      minecraftVersion: "1.21.1",
      loader: { kind: "neoforge", version: "21.1.228" }
    }
  ];
}
