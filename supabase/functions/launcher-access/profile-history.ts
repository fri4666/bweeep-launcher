export function previousGameNames(currentName: string, rows: Array<{ game_name: string }>): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.game_name;
    if (name !== currentName && /^[A-Za-z0-9_]{3,16}$/.test(name)) names.add(name);
  }
  return Array.from(names);
}
