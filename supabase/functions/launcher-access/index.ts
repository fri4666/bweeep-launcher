import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { getBearerToken, getLauncherVersion, getSessionId, isLauncherAtLeast, MIN_YGGDRASIL_LAUNCHER } from "./authorization.ts";
import { isModpackManifest, type ModpackManifest, selectCatalog, usesBweeepAccounts } from "./catalog.ts";
import { retryingFetch } from "./db-fetch.ts";
import { gameNameTakenMessage, isGameNameTaken, OFFLINE_SERVER } from "./game-name.ts";
import { previousGameNames } from "./profile-history.ts";
import {
  createDisplaySessionToken,
  isDisplaySessionToken,
  normalizeDisplayName
} from "./display-name.ts";
import { createGameTicket, isGameName, isGameTicket, ticketNameProblem } from "./game-ticket.ts";
import { decideInvite, invitePolicy, isInviteOpen, type InviteRole } from "./invite-policy.ts";
import { launchGameName } from "./launch-name.ts";
import { decodeBase64, isSkinModel, MAX_SKIN_BYTES, type SkinModel, validateSkinPng } from "./skin-image.ts";

type RequestBody =
  | { action: "listMembers" }
  | { action: "setTester"; userId: string; tester: boolean }
  | { action: "gameAuth" }
  | { action: "revokeGameAuth" }
  | { action: "skin" }
  | { action: "setSkin"; png: string; model: SkinModel }
  | { action: "clearSkin" }
  | { action: "status" }
  | { action: "redeem"; code: string }
  | { action: "createInvite"; maxUses?: number }
  | { action: "listInvites" }
  | { action: "revokeInvite"; inviteId: string }
  | { action: "catalog" }
  | { action: "manifest"; packId: string }
  | { action: "setGameProfile"; gameName: string }
  | { action: "gameTicket"; gameName: string }
  | { action: "consumeGameTicket"; ticket: string; gameName: string }
  | { action: "setDisplayName"; sessionToken: string; displayName: string };

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Game tokens only matter when joining, so half a day covers any session. */
const GAME_TOKEN_HOURS = 12;
const SKIN_CHANGE_INTERVAL_MS = 5_000;
const OUTDATED_LAUNCHER = {
  code: "LAUNCHER_OUTDATED",
  message: "서버 접속 방식이 바뀌어서 런처를 업데이트해야 해요. 런처를 껐다 켜면 자동으로 업데이트돼요."
};

/** Skin files are named by content hash and may be shared, so only unreferenced ones are deleted. */
async function removeUnusedSkinFile(
  supabase: ReturnType<typeof createClient<any, "public">>,
  textureHash: string
): Promise<void> {
  const { count, error } = await supabase
    .from("launcher_skins")
    .select("user_id", { count: "exact", head: true })
    .eq("texture_hash", textureHash);
  if (error || count !== 0) return;
  const { error: removeError } = await supabase.storage.from("launcher-skins").remove([`${textureHash}.png`]);
  if (removeError) console.error("unused skin file removal failed", removeError);
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleRequest(request);
    } catch (error) {
      console.error("launcher-access unhandled error", error);
      return json({ code: "INTERNAL_ERROR", message: "서버에서 권한 확인 중 오류가 발생했습니다." }, 500);
    }
  }
};

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json({ message: "POST 요청만 지원합니다." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Supabase function environment is missing required credentials.");
    return json({ message: "서버 인증 설정을 확인하지 못했습니다." }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch() }
  });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ message: "JSON 요청 본문이 필요합니다." }, 400);
  }
  if (!isRequestBody(body)) {
    return json({ message: "지원하지 않는 요청입니다." }, 400);
  }

  if (body.action === "consumeGameTicket") {
    const { data, error } = await supabaseAdmin.rpc("consume_launcher_game_ticket", {
      p_ticket_hash: await sha256(body.ticket),
      p_game_name: body.gameName
    });
    const consumed = data?.[0];
    if (error) {
      console.error("game ticket consumption failed", error);
      return json({ message: "게임 서버 인증을 확인하지 못했습니다." }, 500);
    }
    if (!consumed) return json({ ok: false, message: "만료되었거나 이미 사용한 인증표입니다." }, 401);
    const { data: nameHistory, error: nameHistoryError } = await supabaseAdmin
      .from("launcher_game_name_history")
      .select("game_name")
      .eq("user_id", consumed.user_id)
      .order("created_at", { ascending: false })
      .limit(1024);
    if (nameHistoryError) {
      console.error("game name history lookup failed", nameHistoryError);
      return json({ message: "기존 게임 이름을 확인하지 못했습니다." }, 500);
    }
    const displaySessionToken = createDisplaySessionToken();
    const now = new Date();
    const displaySessionExpiresAt = new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
    await supabaseAdmin.from("launcher_game_sessions").delete().lt("expires_at", now.toISOString());
    const { error: sessionError } = await supabaseAdmin.from("launcher_game_sessions").insert({
      session_hash: await sha256(displaySessionToken),
      user_id: consumed.user_id,
      expires_at: displaySessionExpiresAt
    });
    if (sessionError) {
      console.error("display session creation failed", sessionError);
      return json({ message: "이름 설정 세션을 만들지 못했습니다." }, 500);
    }
    const { data: savedName, error: savedNameError } = await supabaseAdmin
      .from("launcher_display_names")
      .select("display_name")
      .eq("user_id", consumed.user_id)
      .maybeSingle();
    if (savedNameError) {
      console.error("display name lookup failed", savedNameError);
      return json({ message: "저장된 서버 이름을 확인하지 못했습니다." }, 500);
    }
    return json({
      ok: true,
      userId: consumed.user_id,
      discordId: consumed.discord_id,
      role: consumed.member_role,
      previousGameNames: previousGameNames(body.gameName, nameHistory ?? []),
      displaySessionToken,
      displaySessionExpiresAt,
      displayName: savedName?.display_name ?? null
    });
  }

  if (body.action === "setDisplayName") {
    const displayName = normalizeDisplayName(body.displayName);
    if (!displayName) {
      return json({ ok: false, message: "이름은 한글·영문·숫자·공백·밑줄로 2~16자여야 합니다." }, 400);
    }
    const { data, error } = await supabaseAdmin.rpc("set_launcher_display_name_once", {
      p_session_hash: await sha256(body.sessionToken),
      p_display_name: displayName
    });
    if (error) {
      console.error("display name save failed", error);
      return json({ ok: false, message: "서버 이름을 저장하지 못했습니다." }, 500);
    }
    const result = data?.[0];
    if (!result) {
      return json({ ok: false, message: "이름 설정 시간이 만료되었습니다. 다시 접속해주세요." }, 401);
    }
    return json({
      ok: Boolean(result.ok),
      displayName: result.saved_name,
      alreadySet: Boolean(result.already_set)
    });
  }

  const accessToken = getBearerToken(request);
  if (!accessToken) return json({ code: "MISSING_BEARER_TOKEN", message: "로그인 토큰이 필요합니다." }, 401);
  // The gateway JWT check is disabled for current asymmetric keys, so the
  // function validates the user token explicitly before any member operation.
  const { data: authData, error: authError } = await supabaseAdmin.auth.getClaims(accessToken);
  const userId = typeof authData?.claims?.sub === "string" ? authData.claims.sub : null;
  const sessionId = getSessionId(authData?.claims);
  if (authError || !userId || !sessionId) {
    return json({ code: "INVALID_BEARER_TOKEN", message: "로그인 세션을 확인할 수 없습니다." }, 401);
  }

    // getClaims cannot see a sign-out, so the session row is checked alongside membership.
    const [
      { data: sessionActive, error: sessionError },
      { data: membership, error: membershipError }
    ] = await Promise.all([
      supabaseAdmin.rpc("launcher_auth_session_active", { p_session_id: sessionId, p_user_id: userId }),
      supabaseAdmin.from("launcher_members").select("role").eq("user_id", userId).maybeSingle()
    ]);

    if (sessionError) {
      console.error("launcher auth session query failed", sessionError);
      return json({ message: "로그인 세션을 확인하지 못했습니다." }, 500);
    }
    if (sessionActive !== true) {
      return json({ code: "INVALID_BEARER_TOKEN", message: "로그아웃된 세션입니다. 다시 로그인해 주세요." }, 401);
    }

    if (membershipError) {
      console.error("launcher membership query failed", membershipError);
      return json({ message: "권한 정보를 조회하지 못했습니다." }, 500);
    }

    const { data: testAccess, error: testAccessError } = await supabaseAdmin
      .from("launcher_environment_access")
      .select("environment")
      .eq("user_id", userId)
      .eq("environment", "test")
      .maybeSingle();
    if (testAccessError) {
      console.error("launcher test access query failed", testAccessError);
      return json({ message: "테스트 서버 권한을 조회하지 못했습니다." }, 500);
    }
    const testAllowed = membership?.role === "admin" || Boolean(testAccess);
    const supportsYggdrasil = isLauncherAtLeast(getLauncherVersion(request), MIN_YGGDRASIL_LAUNCHER);

    if (body.action === "status") {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from("launcher_profiles")
        .select("game_name")
        .eq("user_id", userId)
        .maybeSingle();
      if (profileError) {
        console.error("launcher profile query failed", profileError);
        return json({ message: "게임 프로필을 조회하지 못했습니다." }, 500);
      }
      return json({
        allowed: Boolean(membership),
        isAdmin: membership?.role === "admin",
        testAllowed,
        reason: membership ? "런처 사용 권한이 있습니다." : "초대 코드가 필요합니다.",
        gameName: profile?.game_name ?? null
      });
    }

    if (body.action === "redeem") {
      const code = normalizeCode(body.code);
      if (!code) return json({ message: "초대 코드 형식이 올바르지 않습니다." }, 400);
      const { data, error } = await supabaseAdmin.rpc("redeem_launcher_invite", {
        p_code_hash: await sha256(code),
        p_user_id: userId
      });
      if (error) return json({ message: "초대 코드를 사용하는 중 오류가 발생했습니다." }, 500);
      const outcome = data?.[0];
      return json({
        ok: Boolean(outcome?.ok),
        message: outcome?.message ?? "초대 결과를 확인하지 못했습니다.",
        allowed: Boolean(outcome?.ok),
        isAdmin: outcome?.member_role === "admin"
      }, outcome?.ok ? 200 : 400);
    }

    if (!membership) {
      return json({ message: "초대 코드가 필요합니다." }, 403);
    }

    if (body.action === "setGameProfile") {
      if (!isGameName(body.gameName)) {
        return json({ message: "인게임 이름은 영문·숫자·밑줄 3~16자로 입력해 주세요." }, 400);
      }
      // Another member's current name, or one they played under in the last
      // day, is refused. Saving alone does not reserve the name for later.
      const { error } = await supabaseAdmin.rpc("launcher_save_game_profile", {
        p_user_id: userId,
        p_game_name: body.gameName
      });
      if (isGameNameTaken(error)) return json({ code: "GAME_NAME_TAKEN", message: gameNameTakenMessage(body.gameName) }, 409);
      if (error) {
        console.error("launcher profile save failed", error);
        return json({ message: "인게임 이름을 저장하지 못했습니다." }, 500);
      }
      return json({ ok: true, gameName: body.gameName });
    }

    if (body.action === "listMembers" || body.action === "setTester") {
      if (membership.role !== "admin") return json({ message: "관리자만 테스터를 지정할 수 있습니다." }, 403);
      if (body.action === "setTester") {
        const { data: target } = await supabaseAdmin.from("launcher_members").select("user_id").eq("user_id", body.userId).maybeSingle();
        if (!target) return json({ message: "멤버를 찾지 못했습니다." }, 404);
        const { error } = body.tester
          ? await supabaseAdmin.from("launcher_environment_access").upsert(
            { user_id: body.userId, environment: "test", granted_by: userId },
            { onConflict: "user_id,environment", ignoreDuplicates: true }
          )
          : await supabaseAdmin.from("launcher_environment_access").delete().eq("user_id", body.userId).eq("environment", "test");
        if (error) {
          console.error("tester update failed", error);
          return json({ message: "테스터 지정을 저장하지 못했습니다." }, 500);
        }
      }
      const [{ data: members, error: membersError }, { data: testers, error: testersError }, { data: profiles, error: profilesError }] = await Promise.all([
        supabaseAdmin.from("launcher_members").select("user_id, role, invited_at").order("invited_at"),
        supabaseAdmin.from("launcher_environment_access").select("user_id").eq("environment", "test"),
        supabaseAdmin.from("launcher_profiles").select("user_id, game_name")
      ]);
      if (membersError || testersError || profilesError) {
        console.error("member list failed", membersError ?? testersError ?? profilesError);
        return json({ message: "멤버 목록을 불러오지 못했습니다." }, 500);
      }
      const testerIds = new Set((testers ?? []).map((row) => row.user_id));
      const gameNames = new Map((profiles ?? []).map((row) => [row.user_id, row.game_name]));
      const list = await Promise.all((members ?? []).map(async (member) => {
        const { data } = await supabaseAdmin.auth.admin.getUserById(member.user_id);
        const metadata = data.user?.user_metadata ?? {};
        const name = [metadata.full_name, metadata.name, metadata.user_name].find((value) => typeof value === "string" && value.trim());
        return {
          userId: member.user_id,
          name: typeof name === "string" ? name : "이름 없음",
          gameName: gameNames.get(member.user_id) ?? null,
          role: member.role,
          tester: member.role === "admin" || testerIds.has(member.user_id)
        };
      }));
      return json({ members: list });
    }

    if (body.action === "gameAuth") {
      const [{ data: userData, error: userError }, { data: profile, error: profileError }] = await Promise.all([
        supabaseAdmin.auth.admin.getUserById(userId),
        supabaseAdmin.from("launcher_profiles").select("game_name").eq("user_id", userId).maybeSingle()
      ]);
      if (userError || !userData.user || profileError) {
        console.error("game auth profile lookup failed", userError ?? profileError);
        return json({ message: "게임 프로필을 확인하지 못했습니다." }, 500);
      }
      const gameName = await launchGameName(userData.user, profile?.game_name ?? null);
      const { data: account, error: accountError } = await supabaseAdmin.rpc("launcher_claim_minecraft_account", {
        p_user_id: userId,
        p_game_name: gameName
      });
      if (isGameNameTaken(accountError)) {
        return json({ code: "GAME_NAME_TAKEN", message: `${gameNameTakenMessage(gameName)} 이름을 바꿔 주세요.` }, 409);
      }
      const claimed = account?.[0];
      if (accountError || !claimed) {
        console.error("minecraft account claim failed", accountError);
        return json({ message: "게임 계정을 준비하지 못했습니다." }, 500);
      }

      // Minecraft passes this token to the Bweeep Yggdrasil API when it joins a
      // server. A launcher sign-out invalidates it through the session check.
      // Only the newest token works: starting the game again retires the old
      // one, and the launcher revokes it when the game exits.
      const accessToken = createGameAccessToken();
      const expiresAt = new Date(Date.now() + GAME_TOKEN_HOURS * 60 * 60_000).toISOString();
      await supabaseAdmin.from("launcher_game_auth_tokens").delete().lt("expires_at", new Date().toISOString());
      const { error: retireError } = await supabaseAdmin.from("launcher_game_auth_tokens").delete().eq("user_id", userId);
      if (retireError) {
        console.error("game auth token retirement failed", retireError);
        return json({ message: "이전 게임 접속 토큰을 정리하지 못했습니다." }, 500);
      }
      const { error: tokenError } = await supabaseAdmin.from("launcher_game_auth_tokens").insert({
        token_hash: await sha256(accessToken),
        user_id: userId,
        auth_session_id: sessionId,
        expires_at: expiresAt
      });
      if (tokenError) {
        console.error("game auth token creation failed", tokenError);
        return json({ message: "게임 접속 토큰을 만들지 못했습니다." }, 500);
      }
      return json({
        accessToken,
        expiresAt,
        profile: { id: String(claimed.minecraft_uuid).replaceAll("-", ""), name: claimed.game_name }
      });
    }

    if (body.action === "revokeGameAuth") {
      const { error } = await supabaseAdmin.from("launcher_game_auth_tokens").delete().eq("user_id", userId);
      if (error) {
        console.error("game auth token revocation failed", error);
        return json({ message: "게임 접속 토큰을 폐기하지 못했습니다." }, 500);
      }
      return json({ ok: true });
    }

    if (body.action === "skin" || body.action === "clearSkin" || body.action === "setSkin") {
      const { data: current, error: currentError } = await supabaseAdmin
        .from("launcher_skins")
        .select("texture_hash, model, updated_at")
        .eq("user_id", userId)
        .maybeSingle();
      if (currentError) return json({ message: "스킨 정보를 불러오지 못했습니다." }, 500);
      if (body.action === "skin") {
        return json({ skin: current ? { hash: current.texture_hash, model: current.model } : null });
      }
      if (current && Date.now() - Date.parse(current.updated_at) < SKIN_CHANGE_INTERVAL_MS) {
        return json({ message: "스킨은 몇 초에 한 번만 바꿀 수 있어요. 잠시 뒤 다시 시도해 주세요." }, 429);
      }

      if (body.action === "clearSkin") {
        const { error } = await supabaseAdmin.from("launcher_skins").delete().eq("user_id", userId);
        if (error) return json({ message: "스킨을 기본으로 되돌리지 못했습니다." }, 500);
        if (current) await removeUnusedSkinFile(supabaseAdmin, current.texture_hash);
        return json({ skin: null });
      }

      const bytes = decodeBase64(body.png);
      const invalid = bytes ? await validateSkinPng(bytes) : "PNG 이미지가 아닙니다.";
      if (!bytes || invalid) return json({ message: invalid }, 400);
      // Files are named by content hash, as Minecraft caches textures by that name.
      const hash = (await sha256Bytes(bytes)).toLowerCase();
      const { error: uploadError } = await supabaseAdmin.storage
        .from("launcher-skins")
        .upload(`${hash}.png`, bytes, { contentType: "image/png", upsert: true, cacheControl: "31536000" });
      if (uploadError) {
        console.error("skin upload failed", uploadError);
        return json({ message: "스킨 파일을 올리지 못했습니다." }, 500);
      }
      const { error } = await supabaseAdmin.from("launcher_skins").upsert(
        { user_id: userId, texture_hash: hash, model: body.model, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
      if (error) {
        console.error("skin save failed", error);
        return json({ message: "스킨을 저장하지 못했습니다." }, 500);
      }
      if (current && current.texture_hash !== hash) await removeUnusedSkinFile(supabaseAdmin, current.texture_hash);
      return json({ skin: { hash, model: body.model } });
    }

    if (body.action === "gameTicket") {
      const [{ data: userData, error: userError }, { data: profile, error: profileError }] = await Promise.all([
        supabaseAdmin.auth.admin.getUserById(userId),
        supabaseAdmin.from("launcher_profiles").select("game_name").eq("user_id", userId).maybeSingle()
      ]);
      const discordIdentity = userData.user?.identities?.find((identity) => identity.provider === "discord");
      const discordId = discordIdentity?.id;
      if (userError || !userData.user || !discordId || !/^\d{15,22}$/.test(discordId)) {
        return json({ message: "Discord 계정 연결을 확인하지 못했습니다." }, 403);
      }
      if (profileError) {
        console.error("game ticket profile lookup failed", profileError);
        return json({ message: "게임 프로필을 확인하지 못했습니다." }, 500);
      }
      const expectedName = await launchGameName(userData.user, profile?.game_name ?? null);
      const { data: nameAvailable, error: nameError } = await supabaseAdmin.rpc("launcher_game_name_available", {
        p_user_id: userId,
        p_game_name: expectedName
      });
      if (nameError) {
        console.error("game ticket name check failed", nameError);
        return json({ message: "인게임 이름을 확인하지 못했습니다." }, 500);
      }
      const nameProblem = ticketNameProblem(body.gameName, expectedName, nameAvailable === true);
      if (nameProblem) return json(nameProblem, 409);

      const ticket = createGameTicket();
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      await supabaseAdmin.from("launcher_game_tickets").delete().lt("expires_at", new Date().toISOString());
      // One live ticket per member: a new launch retires the previous one.
      await supabaseAdmin.from("launcher_game_tickets").delete().eq("user_id", userId);
      const { error: insertError } = await supabaseAdmin.from("launcher_game_tickets").insert({
        ticket_hash: await sha256(ticket),
        user_id: userId,
        discord_id: discordId,
        role: membership.role === "admin" ? "admin" : "member",
        game_name: body.gameName,
        expires_at: expiresAt
      });
      if (insertError) {
        console.error("game ticket creation failed", insertError);
        return json({ message: "게임 서버 인증표를 만들지 못했습니다." }, 500);
      }
      return json({ ticket, expiresAt });
    }

    if (body.action === "manifest") {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(body.packId)) {
        return json({ message: "모드팩 ID 형식이 올바르지 않습니다." }, 400);
      }

      const { data, error } = await supabaseAdmin
        .from("launcher_releases")
        .select("manifest, version")
        .eq("pack_id", body.packId)
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        return json({ message: "모드팩 정보를 조회하지 못했습니다." }, 500);
      }
      if (!data) {
        return json({ message: "활성 모드팩 release를 찾지 못했습니다." }, 404);
      }

      if (!isModpackManifest(data.manifest)) {
        return json({ message: "모드팩 정보 형식이 올바르지 않습니다." }, 500);
      }
      if (data.manifest.audience === "testers" && !testAllowed) {
        return json({ message: "테스트 서버는 지정된 테스터만 접속할 수 있습니다." }, 403);
      }
      if (!usesBweeepAccounts(data.manifest)) return json(OFFLINE_SERVER, 409);
      if (!supportsYggdrasil) return json(OUTDATED_LAUNCHER, 426);
      const manifest = await resolveManifestDownloads(supabaseAdmin, data.manifest);
      return json({ manifest, version: data.version });
    }

    if (body.action === "catalog") {
      const { data, error } = await supabaseAdmin
        .from("launcher_releases")
        .select("pack_id, manifest, version, created_at")
        .eq("active", true)
        .order("created_at", { ascending: false });
      if (error) return json({ message: "서버 모드팩 목록을 조회하지 못했습니다." }, 500);

      // Releases are append-only. Keep the most recent active manifest for
      // each pack, so a pack update needs no launcher release. A broken or
      // offline-mode release is left out instead of hiding every server.
      const { entries: visible, skipped } = selectCatalog(data ?? [], { testAllowed });
      for (const release of skipped) console.error("catalog release skipped", release);
      // Older launchers ignore gameAuth and would be turned away by the server
      // with no explanation, so they are asked to update first.
      if (!supportsYggdrasil && visible.length > 0) {
        return json(OUTDATED_LAUNCHER, 426);
      }
      return json({ manifests: visible });
    }

    const role: InviteRole = membership.role === "admin" ? "admin" : "member";
    const { data: ownInvites, error: ownInvitesError } = await supabaseAdmin
      .from("launcher_invites")
      .select("id, expires_at, max_uses, uses, revoked_at, created_at")
      .eq("created_by", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (ownInvitesError) {
      console.error("launcher invite query failed", ownInvitesError);
      return json({ message: "초대 코드 목록을 조회하지 못했습니다." }, 500);
    }
    const openInvites = (ownInvites ?? []).filter((invite) => isInviteOpen(invite));

    if (body.action === "listInvites") {
      const policy = invitePolicy(role);
      return json({
        role,
        maxUsesLimit: policy.maxUsesLimit,
        activeLimit: policy.activeLimit,
        invites: openInvites.map((invite) => ({
          id: invite.id,
          expiresAt: invite.expires_at,
          maxUses: invite.max_uses,
          uses: invite.uses,
          createdAt: invite.created_at
        }))
      });
    }

    if (body.action === "revokeInvite") {
      if (!openInvites.some((invite) => invite.id === body.inviteId)) {
        return json({ message: "취소할 수 있는 초대 코드를 찾지 못했습니다." }, 404);
      }
      const { error } = await supabaseAdmin
        .from("launcher_invites")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", body.inviteId)
        .eq("created_by", userId);
      if (error) return json({ message: "초대 코드를 취소하지 못했습니다." }, 500);
      return json({ ok: true });
    }

    const decision = decideInvite(role, body.maxUses, openInvites.length);
    if (!decision.ok) return json({ message: decision.message }, 409);
    const code = createInviteCode();
    const expiresAt = new Date(Date.now() + decision.expiresInDays * 86_400_000).toISOString();
    const { data: inserted, error } = await supabaseAdmin.from("launcher_invites").insert({
      code_hash: await sha256(code),
      created_by: userId,
      expires_at: expiresAt,
      max_uses: decision.maxUses
    }).select("id").single();
    if (error) return json({ message: "초대 코드를 만들지 못했습니다." }, 500);
    return json({ id: inserted.id, code, expiresAt, maxUses: decision.maxUses });
}

function normalizeCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^BWEEP-[A-F0-9]{12}-[A-F0-9]{12}$/.test(code) ? code : null;
}

function isRequestBody(value: unknown): value is RequestBody {
  if (!value || typeof value !== "object" || !("action" in value)) return false;
  const body = value as Record<string, unknown>;
  if (body.action === "status") return true;
  if (["gameAuth", "revokeGameAuth", "skin", "clearSkin", "listMembers"].includes(String(body.action))) return true;
  if (body.action === "setTester") {
    return typeof body.userId === "string" && /^[0-9a-f-]{36}$/i.test(body.userId) && typeof body.tester === "boolean";
  }
  if (body.action === "setSkin") {
    return typeof body.png === "string" && body.png.length <= Math.ceil(MAX_SKIN_BYTES / 3) * 4 && isSkinModel(body.model);
  }
  if (body.action === "redeem") return typeof body.code === "string";
  if (body.action === "catalog") return true;
  if (body.action === "manifest") return typeof body.packId === "string";
  if (body.action === "setGameProfile") return isGameName(body.gameName);
  if (body.action === "gameTicket") return isGameName(body.gameName);
  if (body.action === "consumeGameTicket") return isGameTicket(body.ticket) && isGameName(body.gameName);
  if (body.action === "setDisplayName") {
    return isDisplaySessionToken(body.sessionToken) && typeof body.displayName === "string";
  }
  if (body.action === "listInvites") return true;
  if (body.action === "revokeInvite") return typeof body.inviteId === "string" && /^[0-9a-f-]{36}$/i.test(body.inviteId);
  return body.action === "createInvite";
}

function createInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `BWEEP-${toHex(bytes.slice(0, 6))}-${toHex(bytes.slice(6))}`;
}

function createGameAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function resolveManifestDownloads(
  supabase: Pick<ReturnType<typeof createClient<any, "public">>, "storage">,
  rawManifest: unknown
): Promise<ModpackManifest> {
  if (!isModpackManifest(rawManifest)) {
    throw new Error("Stored launcher manifest has an invalid shape.");
  }

  const files = await Promise.all(rawManifest.files.map(async (file) => {
    const storageObject = parseStorageObjectUrl(file.url);
    if (!storageObject) return file;

    const { data, error } = await supabase.storage
      .from(storageObject.bucket)
      .createSignedUrl(storageObject.path, 15 * 60);
    if (error || !data?.signedUrl) {
      throw new Error(`Unable to sign modpack file ${file.path}.`);
    }
    return { ...file, url: data.signedUrl };
  }));

  return { ...rawManifest, files };
}

function parseStorageObjectUrl(value: string): { bucket: string; path: string } | null {
  if (!value.startsWith("storage://")) return null;
  const url = new URL(value);
  const bucket = url.hostname;
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/i.test(bucket) || !path || path.includes("..")) {
    throw new Error("Stored launcher manifest contains an invalid storage object URL.");
  }
  return { bucket, path };
}
