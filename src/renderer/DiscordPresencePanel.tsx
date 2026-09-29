import { useEffect, useState } from "react";
import type { DiscordPresenceSetting } from "../shared/types.js";

/** Settings panel: show the server being played on Discord, on by default. */
export function DiscordPresencePanel() {
  const [setting, setSetting] = useState<DiscordPresenceSetting | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.bweeep.discordPresence().then(setSetting).catch(() => setSetting(null));
  }, []);

  if (!setting?.available) return null;

  async function toggle(enabled: boolean) {
    setSaving(true);
    setSetting((current) => current && { ...current, enabled });
    try {
      setSetting(await window.bweeep.setDiscordPresence(enabled));
    } catch {
      setSetting((current) => current && { ...current, enabled: !enabled });
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="panel">
      <div className="panelHeader">
        <h3>디스코드</h3>
        <span>게임하는 동안만 보여요.</span>
      </div>
      <label className="settingToggle">
        <input type="checkbox" checked={setting.enabled} disabled={saving} onChange={(event) => void toggle(event.target.checked)} />
        <span>디스코드에 플레이 중 표시</span>
      </label>
    </article>
  );
}
