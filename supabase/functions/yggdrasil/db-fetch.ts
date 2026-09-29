/**
 * Supabase's API gateway and database now and then disagree about the time by
 * a moment, and the database refuses a key the gateway just minted as "issued
 * in the future" (PGRST303). Asking again a second later gets through, so a
 * member does not see "권한 정보를 조회하지 못했습니다" for a clock hiccup.
 */
export function retryingFetch(baseFetch: typeof fetch = fetch, delayMs = 1000): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status !== 401) return response;
    const text = await response.clone().text();
    if (!text.includes("PGRST303")) return response;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return baseFetch(input, init);
  };
}
