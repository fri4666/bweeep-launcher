import { yggdrasilApiRoot } from "../dist/src/main/authlib-injector.js";
import { presetsFromManifests } from "../dist/src/main/catalog.js";

const url = "https://example.supabase.co";
if (yggdrasilApiRoot(url) !== `${url}/functions/v1/yggdrasil`) throw new Error("original server root changed");
if (yggdrasilApiRoot(url, "friend-a") !== `${url}/functions/v1/yggdrasil/groups/friend-a`) throw new Error("friend-a server root is wrong");
if (yggdrasilApiRoot(url, "friend-b", true) !== `${url}/functions/v1/yggdrasil/groups/friend-b/testers`) throw new Error("friend-b tester root is wrong");
if (presetsFromManifests([], () => {}).length !== 0) throw new Error("an unassigned group must have an empty server list");
console.log("Group-specific game authentication routes and empty catalogs passed.");
