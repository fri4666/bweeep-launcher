import { useEffect, useState } from "react";
import { memoryChoicesMb, resolveGameMemory } from "../shared/game-memory.js";
import type { ServerPreset } from "../shared/types.js";
import "./play.css";

const storageKey = (packId: string) => `bweeep.memory.${packId}`;

/** The heap chosen for a server in settings, or undefined for automatic. */
export function savedMemoryMb(packId: string): number | undefined {
  try {
    const value = Number(window.localStorage.getItem(storageKey(packId)));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function saveMemoryMb(packId: string, value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(storageKey(packId));
    else window.localStorage.setItem(storageKey(packId), String(value));
  } catch {
    // Storage is only a convenience; the game then gets the automatic amount.
  }
}

function formatGb(mb: number): string {
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)}GB`;
}

/** Settings: game memory per server, automatic unless the player moves the slider. */
export function MemoryPanel({ servers }: { servers: ServerPreset[] }) {
  const [totalMb, setTotalMb] = useState<number | null>(null);
  // The choice lives in storage; this only re-renders after a change.
  const [, setChanges] = useState(0);

  useEffect(() => {
    void window.bweeep.systemMemory().then((memory) => setTotalMb(memory.totalMb)).catch(() => setTotalMb(null));
  }, []);

  if (!totalMb || servers.length === 0) return null;
  const choices = memoryChoicesMb(totalMb);

  function choose(server: ServerPreset, value: number | null) {
    saveMemoryMb(server.packId, value);
    setChanges((count) => count + 1);
  }

  return (
    <article className="panel">
      <div className="panelHeader">
        <h3>게임 메모리</h3>
        <span>PC {formatGb(totalMb)}</span>
      </div>
      <div className="memoryList">
        {servers.map((server) => {
          // The same calculation the launch uses, so what is shown is what the game gets.
          const { maxMb: value, auto } = resolveGameMemory({ recommendedMb: server.recommendedMemoryMb, totalMb, requestedMb: savedMemoryMb(server.packId) });
          const low = value < server.recommendedMemoryMb;
          return (
            <div className="memoryRow" key={server.id}>
              <strong>{server.name}</strong>
              <input
                type="range"
                aria-label={`${server.name} 메모리`}
                min={choices[0]}
                max={choices[choices.length - 1]}
                step={1024}
                value={value}
                disabled={choices.length < 2}
                onChange={(event) => choose(server, Number(event.target.value))}
              />
              <span className={`memoryValue${low ? " isLow" : ""}`}>
                {low && (
                  <svg viewBox="0 0 24 24" role="img" aria-label={`권장 ${formatGb(server.recommendedMemoryMb)}보다 적어요`}>
                    <title>{`권장 ${formatGb(server.recommendedMemoryMb)}보다 적어요`}</title>
                    <path d="M12 4l9 16H3z" />
                    <path d="M12 10v4M12 17.5v.01" />
                  </svg>
                )}
                {auto ? `자동 ${formatGb(value)}` : formatGb(value)}
              </span>
              <button className="textButton" disabled={auto} onClick={() => choose(server, null)}>자동</button>
            </div>
          );
        })}
      </div>
    </article>
  );
}
