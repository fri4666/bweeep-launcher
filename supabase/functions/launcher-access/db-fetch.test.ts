import { retryingFetch } from "./db-fetch.ts";

function scripted(responses: Array<() => Response>) {
  let calls = 0;
  const baseFetch = (() => Promise.resolve(responses[Math.min(calls++, responses.length - 1)]())) as typeof fetch;
  return { baseFetch, calls: () => calls };
}

const futureJwt = () => new Response(JSON.stringify({ code: "PGRST303", message: "JWT issued at future" }), { status: 401 });

Deno.test("a key refused as issued in the future is tried once more", async () => {
  const { baseFetch, calls } = scripted([futureJwt, () => new Response("[]", { status: 200 })]);
  const response = await retryingFetch(baseFetch, 1)("https://example.test/rest/v1/x");
  if (response.status !== 200 || calls() !== 2) throw new Error(`expected a retry, got ${response.status} after ${calls()} calls`);
});

Deno.test("other refusals are returned as they are", async () => {
  const { baseFetch, calls } = scripted([() => new Response(JSON.stringify({ code: "PGRST301" }), { status: 401 })]);
  const response = await retryingFetch(baseFetch, 1)("https://example.test/rest/v1/x");
  if (response.status !== 401 || calls() !== 1) throw new Error("a different 401 must not be retried");
});

Deno.test("a second clock refusal is not retried forever", async () => {
  const { baseFetch, calls } = scripted([futureJwt, futureJwt, futureJwt]);
  const response = await retryingFetch(baseFetch, 1)("https://example.test/rest/v1/x");
  if (response.status !== 401 || calls() !== 2) throw new Error("only one retry is allowed");
});
