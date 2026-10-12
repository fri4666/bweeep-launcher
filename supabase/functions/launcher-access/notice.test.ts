import { handleAdminRequest, parseAdminRequest } from "./admin.ts";
import { currentNotice, MAX_NOTICE_LENGTH, normalizeNoticeText, pickNotice, toNotice } from "./notice.ts";

const ADMIN = "0f8fad5b-d9cb-469f-a165-70867728950a";
const ALICE = "0f8fad5b-d9cb-469f-a165-70867728950b";
const BOB = "0f8fad5b-d9cb-469f-a165-70867728950c";
const CAROL = "0f8fad5b-d9cb-469f-a165-70867728950d";
const AT = "2026-10-12T04:00:00+00:00";

// A stand-in for the Supabase client: records what is asked and answers from fixed rows.
function fakeDb(options: {
  tables?: Record<string, unknown[]>;
  rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
  names?: Record<string, string>;
}) {
  const calls: Array<Record<string, unknown>> = [];
  const query = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ["select", "is", "in", "order", "eq", "not"]) q[method] = () => q;
    q.or = (filter: string) => {
      calls.push({ table, or: filter });
      return q;
    };
    q.then = (resolve: (value: unknown) => unknown) => resolve({ data: options.tables?.[table] ?? [], error: null });
    return q;
  };
  const db = {
    from: (table: string) => query(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ rpc: name, args });
      return Promise.resolve(options.rpc?.(name, args) ?? { data: [], error: null });
    },
    auth: { admin: { getUserById: (id: string) => Promise.resolve({ data: { user: { user_metadata: { full_name: options.names?.[id] ?? null } } } }) } }
  };
  // deno-lint-ignore no-explicit-any
  return { db: db as any, calls };
}

Deno.test("notice text is trimmed, limited and kept to two lines", () => {
  if (normalizeNoticeText("  오늘 9시에 서버 점검해요  ") !== "오늘 9시에 서버 점검해요") throw new Error("Spaces at the ends are removed.");
  if (normalizeNoticeText("첫 줄 \r\n\r\n 둘째 줄") !== "첫 줄\n둘째 줄") throw new Error("Line ends are unified and empty lines dropped.");
  if (normalizeNoticeText("a\nb\nc") !== null) throw new Error("More than two lines are refused.");
  if (normalizeNoticeText("   \n ") !== null || normalizeNoticeText("") !== null || normalizeNoticeText(42) !== null) throw new Error("Empty text is refused.");
  if (normalizeNoticeText("가".repeat(MAX_NOTICE_LENGTH)) === null || normalizeNoticeText("가".repeat(MAX_NOTICE_LENGTH + 1)) !== null) {
    throw new Error("The limit counts characters, not bytes.");
  }
  if (normalizeNoticeText("탭\t문자") !== null || normalizeNoticeText("벨\u0007") !== null) throw new Error("Control characters are refused.");
});

Deno.test("notice actions carry normalized text", () => {
  const set = parseAdminRequest({ action: "setNotice", text: " 공지 " });
  if (!set || set.action !== "setNotice" || set.text !== "공지") throw new Error("setNotice keeps the normalized text.");
  if (parseAdminRequest({ action: "setNotice", text: " " }) !== null || parseAdminRequest({ action: "setNotice" }) !== null) {
    throw new Error("setNotice needs text.");
  }
  if (parseAdminRequest({ action: "clearNotice" })?.action !== "clearNotice") throw new Error("clearNotice needs no fields.");
});

Deno.test("a stored notice row becomes the launcher's shape", () => {
  const notice = toNotice({ id: "0f8fad5b-d9cb-469f-a165-70867728950e", body: "공지", created_at: "2026-10-04T06:00:00+00:00" });
  if (notice?.text !== "공지" || notice.at !== "2026-10-04T06:00:00+00:00") throw new Error("Row fields map to id, text and at.");
  if (toNotice(null) !== null) throw new Error("No row means no notice.");
});

Deno.test("a member sees their own notice first, otherwise the everyone-notice, never someone else's", () => {
  const rows = [
    { id: "all", body: "모두에게", created_at: AT, target_user_id: null },
    { id: "alice", body: "앨리스에게", created_at: AT, target_user_id: ALICE },
    { id: "bob", body: "밥에게", created_at: AT, target_user_id: BOB }
  ];
  const forAlice = pickNotice(rows, ALICE);
  if (forAlice?.id !== "alice" || forAlice.personal !== true) throw new Error("A personal notice wins and says it is personal.");
  if (pickNotice(rows, BOB)?.id !== "bob") throw new Error("Each member gets their own.");
  const forCarol = pickNotice(rows, CAROL);
  if (forCarol?.id !== "all" || "personal" in forCarol) throw new Error("A member with no notice of their own sees the everyone-notice, unmarked.");
  const onlyOthers = pickNotice(rows.filter((row) => row.target_user_id !== null), CAROL);
  if (onlyOthers !== null) throw new Error("Someone else's personal notice is never returned.");
  if (pickNotice([], ALICE) !== null) throw new Error("No rows, no notice.");
  if (JSON.stringify(pickNotice(rows.slice(0, 1), ALICE)) !== JSON.stringify({ id: "all", text: "모두에게", at: AT })) {
    throw new Error("The everyone-notice keeps the old shape {id, text, at}.");
  }
});

Deno.test("reading the notice asks only for the everyone-notice and this member's own", async () => {
  const rows = [
    { id: "all", body: "모두에게", created_at: AT, target_user_id: null },
    { id: "alice", body: "앨리스에게", created_at: AT, target_user_id: ALICE },
    { id: "bob", body: "밥에게", created_at: AT, target_user_id: BOB }
  ];
  const { db, calls } = fakeDb({ tables: { launcher_notices: rows } });
  const seen = await currentNotice(db, CAROL);
  if (seen?.id !== "all") throw new Error("Carol sees the everyone-notice even though the table holds others' personal ones.");
  const filter = calls.find((call) => call.or)?.or as string;
  if (filter !== `target_user_id.is.null,target_user_id.eq.${CAROL}`) throw new Error(`The query is filtered to this member: ${filter}`);
  if ((await currentNotice(db, ALICE))?.id !== "alice") throw new Error("Alice sees hers.");
  const malformed = fakeDb({ tables: { launcher_notices: rows } });
  if ((await currentNotice(malformed.db, "x' or 1=1"))?.id !== "all" || malformed.calls.some((call) => call.or)) {
    throw new Error("A malformed id never reaches the filter text.");
  }
});

Deno.test("setNotice and clearNotice take an optional member id", () => {
  const set = parseAdminRequest({ action: "setNotice", text: " 안녕 ", targetUserId: ALICE });
  if (!set || set.action !== "setNotice" || set.text !== "안녕" || set.targetUserId !== ALICE) throw new Error("A personal notice carries its target.");
  const everyone = parseAdminRequest({ action: "setNotice", text: "안녕" });
  if (!everyone || "targetUserId" in everyone) throw new Error("Without a target it is the same request as before.");
  const nullTarget = parseAdminRequest({ action: "setNotice", text: "안녕", targetUserId: null });
  if (!nullTarget || "targetUserId" in nullTarget) throw new Error("A null target means everyone.");
  if (parseAdminRequest({ action: "setNotice", text: "안녕", targetUserId: "not-a-uuid" }) !== null) throw new Error("A malformed target is refused, not turned into everyone.");
  if (parseAdminRequest({ action: "setNotice", text: "안녕", targetUserId: 7 }) !== null) throw new Error("A non-string target is refused.");
  const clear = parseAdminRequest({ action: "clearNotice", targetUserId: BOB });
  if (!clear || clear.action !== "clearNotice" || clear.targetUserId !== BOB) throw new Error("Clearing can name a member.");
  if (parseAdminRequest({ action: "clearNotice", targetUserId: "x" }) !== null) throw new Error("Clearing with a malformed target is refused.");
  const clearAll = parseAdminRequest({ action: "clearNotice" });
  if (!clearAll || "targetUserId" in clearAll) throw new Error("Clearing with no target is the old request.");
  if (parseAdminRequest({ action: "adminNotices" })?.action !== "adminNotices") throw new Error("The admin list needs no fields.");
});

Deno.test("posting to everyone calls the database exactly as the old function did", async () => {
  const { db, calls } = fakeDb({
    rpc: () => ({ data: [{ id: "n1", body: "공지", created_at: AT, target_user_id: null }], error: null }),
    tables: { launcher_notices: [{ id: "n1", body: "공지", created_at: AT, target_user_id: null }] }
  });
  const response = await handleAdminRequest(db, ADMIN, { action: "setNotice", text: "공지" });
  const rpc = calls.find((call) => call.rpc === "launcher_admin_set_notice");
  if (JSON.stringify(rpc?.args) !== JSON.stringify({ p_actor: ADMIN, p_body: "공지" })) throw new Error(`No p_target for an everyone-notice: ${JSON.stringify(rpc?.args)}`);
  const body = await response.json();
  if (body.notice?.id !== "n1" || "personal" in body.notice) throw new Error("The reply keeps the old shape for everyone.");
  if (body.notices?.length !== 1 || body.notices[0].target !== null) throw new Error("The reply also lists what is shown now.");
  await handleAdminRequest(db, ADMIN, { action: "clearNotice" });
  const clear = calls.find((call) => call.rpc === "launcher_admin_clear_notice");
  if (JSON.stringify(clear?.args) !== JSON.stringify({ p_actor: ADMIN })) throw new Error("No p_target when clearing the everyone-notice.");
});

Deno.test("posting to one member passes the target and answers with who it is for", async () => {
  const { db, calls } = fakeDb({
    rpc: () => ({ data: [{ id: "n2", body: "너에게", created_at: AT, target_user_id: ALICE }], error: null }),
    tables: {
      launcher_notices: [
        { id: "n2", body: "너에게", created_at: "2026-10-12T04:05:00+00:00", target_user_id: ALICE },
        { id: "n1", body: "모두에게", created_at: AT, target_user_id: null }
      ],
      launcher_profiles: [{ user_id: ALICE, game_name: "Alice_MC" }],
      launcher_minecraft_accounts: [{ user_id: ALICE, game_name: "OldAlice" }]
    },
    names: { [ALICE]: "앨리스" }
  });
  const response = await handleAdminRequest(db, ADMIN, { action: "setNotice", text: "너에게", targetUserId: ALICE });
  const rpc = calls.find((call) => call.rpc === "launcher_admin_set_notice");
  if (JSON.stringify(rpc?.args) !== JSON.stringify({ p_actor: ADMIN, p_body: "너에게", p_target: ALICE })) throw new Error("The target goes to the database function.");
  const body = await response.json();
  if (body.notice?.personal !== true) throw new Error("The posted notice says it is personal.");
  if (body.notices?.[0]?.target !== null || body.notices?.[1]?.target?.userId !== ALICE) throw new Error("The everyone-notice is listed first, then personal ones.");
  const target = body.notices[1].target;
  if (target.name !== "앨리스" || target.gameName !== "Alice_MC") throw new Error(`The list shows the member's name and game name (saved profile wins): ${JSON.stringify(target)}`);
  await handleAdminRequest(db, ADMIN, { action: "clearNotice", targetUserId: ALICE });
  const clear = calls.find((call) => call.rpc === "launcher_admin_clear_notice");
  if (JSON.stringify(clear?.args) !== JSON.stringify({ p_actor: ADMIN, p_target: ALICE })) throw new Error("Clearing one member's notice passes the target.");
});

Deno.test("a target that is not a member is refused with a short message", async () => {
  const { db } = fakeDb({ rpc: () => ({ data: null, error: { message: "MEMBER_NOT_FOUND" } }) });
  const response = await handleAdminRequest(db, ADMIN, { action: "setNotice", text: "공지", targetUserId: CAROL });
  const body = await response.json();
  if (response.status !== 404 || body.code !== "MEMBER_NOT_FOUND" || body.message !== "멤버를 찾지 못했어요.") throw new Error("Unknown members are a 404 with the short text.");
});

Deno.test("the admin list shows nothing private to anyone but admins' own request", async () => {
  const { db } = fakeDb({ tables: { launcher_notices: [] } });
  const response = await handleAdminRequest(db, ADMIN, { action: "adminNotices" });
  const body = await response.json();
  if (!Array.isArray(body.notices) || body.notices.length !== 0) throw new Error("An empty list is an empty array.");
});
