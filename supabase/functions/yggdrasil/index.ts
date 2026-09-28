import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { retryingFetch } from "./db-fetch.ts";
import {
  apiMetadata,
  generateSigningKeyPair,
  importSigningKey,
  isGameName,
  isUnsignedUuid,
  MAX_BATCH_NAMES,
  parseRoute,
  type ProfileRow,
  routeAudience,
  serializeProfile,
  tokenHash,
  toSignedUuid,
  yggdrasilError
} from "./protocol.ts";

interface SigningKeys {
  signingKey: CryptoKey;
  publicKey: string;
}

let cachedKeys: Promise<SigningKeys> | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleRequest(request);
    } catch (error) {
      console.error("yggdrasil unhandled error", error);
      return yggdrasilError(500, "InternalServerError", "Bweeep authentication server error.");
    }
  }
};

async function handleRequest(request: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Supabase function environment is missing required credentials.");
    return yggdrasilError(500, "InternalServerError", "Bweeep authentication server is not configured.");
  }
  // Inside the local stack SUPABASE_URL is a container address, so texture
  // URLs need the address players can reach.
  const publicUrl = Deno.env.get("BWEEP_PUBLIC_SUPABASE_URL") ?? supabaseUrl;
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch() }
  });
  const url = new URL(request.url);
  const route = parseRoute(request.method, url.pathname);

  switch (route.kind) {
    case "metadata": {
      const { publicKey } = await signingKeys(admin);
      return Response.json(apiMetadata(publicKey, publicUrl));
    }

    case "join": {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      const accessToken = body?.accessToken;
      const selectedProfile = body?.selectedProfile;
      const serverId = body?.serverId;
      if (
        typeof accessToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(accessToken)
        || !isUnsignedUuid(selectedProfile)
        || typeof serverId !== "string" || serverId.length < 1 || serverId.length > 128
      ) {
        return yggdrasilError(403, "ForbiddenOperationException", "Invalid token.");
      }
      // The client address is not stored: the game server may see a LAN or
      // proxy address that differs from the one this function sees.
      const { data, error } = await admin.rpc("launcher_yggdrasil_join", {
        p_token_hash: await tokenHash(accessToken),
        p_profile_id: toSignedUuid(selectedProfile),
        p_server_id: serverId,
        p_ip: null
      });
      if (error) {
        console.error("yggdrasil join failed", error);
        return yggdrasilError(500, "InternalServerError", "Could not record the join.");
      }
      if (data !== true) return yggdrasilError(403, "ForbiddenOperationException", "Invalid token.");
      return new Response(null, { status: 204 });
    }

    case "hasJoined": {
      const username = url.searchParams.get("username");
      const serverId = url.searchParams.get("serverId");
      if (!isGameName(username) || !serverId || serverId.length > 128) return new Response(null, { status: 204 });
      const { data, error } = await admin.rpc("launcher_yggdrasil_has_joined", {
        p_game_name: username,
        p_server_id: serverId,
        p_ip: null,
        p_testers_only: routeAudience(url.pathname) === "testers"
      });
      if (error) {
        console.error("yggdrasil hasJoined failed", error);
        return yggdrasilError(500, "InternalServerError", "Could not verify the join.");
      }
      const row = (data as ProfileRow[] | null)?.[0];
      if (!row) return new Response(null, { status: 204 });
      const { signingKey } = await signingKeys(admin);
      return Response.json(await serializeProfile(row, { publicUrl, signingKey, withProperties: true }));
    }

    case "profile": {
      if (!isUnsignedUuid(route.id)) return new Response(null, { status: 204 });
      const rows = await lookupProfiles(admin, [toSignedUuid(route.id)], []);
      const row = rows[0];
      if (!row) return new Response(null, { status: 204 });
      const signed = url.searchParams.get("unsigned") === "false";
      const signingKey = signed ? (await signingKeys(admin)).signingKey : null;
      return Response.json(await serializeProfile(row, { publicUrl, signingKey, withProperties: true }));
    }

    case "profilesByName": {
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body)) return yggdrasilError(400, "IllegalArgumentException", "A list of names is required.");
      const names = [...new Set(body.filter(isGameName))].slice(0, MAX_BATCH_NAMES);
      const rows = names.length > 0 ? await lookupProfiles(admin, [], names) : [];
      return Response.json(await Promise.all(rows.map((row) =>
        serializeProfile(row, { publicUrl, signingKey: null, withProperties: false })
      )));
    }

    case "profileByName": {
      if (!isGameName(route.name)) return new Response(null, { status: 204 });
      const row = (await lookupProfiles(admin, [], [route.name]))[0];
      if (!row) return new Response(null, { status: 204 });
      return Response.json(await serializeProfile(row, { publicUrl, signingKey: null, withProperties: false }));
    }

    case "notFound":
      return yggdrasilError(404, "NotFoundException", "Not found.");
  }
}

async function lookupProfiles(admin: SupabaseClient, ids: string[], names: string[]): Promise<ProfileRow[]> {
  const { data, error } = await admin.rpc("launcher_yggdrasil_profiles", { p_ids: ids, p_names: names });
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  return (data as ProfileRow[] | null) ?? [];
}

function signingKeys(admin: SupabaseClient): Promise<SigningKeys> {
  cachedKeys ??= loadSigningKeys(admin).catch((error) => {
    cachedKeys = null;
    throw error;
  });
  return cachedKeys;
}

async function loadSigningKeys(admin: SupabaseClient): Promise<SigningKeys> {
  let stored = await readStoredKeys(admin);
  if (!stored) {
    const generated = await generateSigningKeyPair();
    // Concurrent first calls may race; the insert keeps whichever key landed first.
    const { error } = await admin.from("launcher_yggdrasil_keys").upsert(
      { id: 1, private_key: generated.privateKey, public_key: generated.publicKey },
      { onConflict: "id", ignoreDuplicates: true }
    );
    if (error) throw new Error(`signing key creation failed: ${error.message}`);
    stored = await readStoredKeys(admin);
    if (!stored) throw new Error("signing key was not stored");
  }
  return { signingKey: await importSigningKey(stored.private_key), publicKey: stored.public_key };
}

async function readStoredKeys(admin: SupabaseClient): Promise<{ private_key: string; public_key: string } | null> {
  const { data, error } = await admin.from("launcher_yggdrasil_keys").select("private_key, public_key").eq("id", 1).maybeSingle();
  if (error) throw new Error(`signing key lookup failed: ${error.message}`);
  return data;
}
