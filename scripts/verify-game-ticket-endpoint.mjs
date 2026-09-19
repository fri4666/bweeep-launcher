const endpoint = "https://tmwvrglzjfzauuygofpp.supabase.co/functions/v1/launcher-access";
const ticket = process.argv[2] ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const expectedRole = process.argv[3] ?? null;
const request = () => fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    action: "consumeGameTicket",
    ticket,
    gameName: "Probe_User"
  })
});
const response = await request();
const body = await response.json();
if (expectedRole) {
  if (response.status !== 200 || body.ok !== true || body.role !== expectedRole) {
    throw new Error(`Expected ${expectedRole} ticket acceptance, received ${response.status}`);
  }
  const replay = await request();
  if (replay.status !== 401) throw new Error(`Replayed ticket was not rejected: ${replay.status}`);
  console.log(`Game-ticket endpoint accepted ${expectedRole} once and rejected its replay.`);
} else if (response.status !== 401 || body.ok !== false) {
  throw new Error(`Unexpected game-ticket endpoint response: ${response.status}`);
} else {
  console.log("Game-ticket endpoint rejected an unknown ticket through the deployed handler.");
}
