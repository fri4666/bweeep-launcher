/** Resolve only the retired canonical origin, in memory, for packaged launchers. */
export function packagedAuthOrigin(url: string | undefined, isPackaged: boolean): string | undefined {
  if (isPackaged && (url === "https://tmwvrglzjfzauuygofpp.supabase.co" || url === "https://tmwvrglzjfzauuygofpp.supabase.co/")) {
    return "https://bweeep.fri4666.com";
  }
  return url;
}
