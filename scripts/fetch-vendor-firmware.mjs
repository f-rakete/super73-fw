#!/usr/bin/env node
// Fetch the original/stock firmware images the Comodule backend serves for THIS bike.
//
// This mirrors exactly what the companion app (com.comodule.super) does: POST the bike's
// current versions to the firmware endpoint and read the per-MCU download URLs out of the
// response (FirmwareUpdateResponseDto). Nothing here talks to the bike or sends anything to
// it; it only reads the vendor's own images for a device the operator owns.
//
// What the app actually sends (recovered from the APK):
//   - BLE API base:  https://analytics.comodule.com/bleapi/v2/
//   - auth:          apiKey as a QUERY PARAM (?apiKey=<const>), injected by OkHttp interceptor
//                    t8 -> j9.f15468a <- ua.a.f30403v  (a build constant, not user-specific).
//                    The Firebase Bearer token is used by the *vehicle* SSE API (cn/d.java),
//                    not this bleapi path — so it is OPTIONAL here, tried only if the server
//                    demands it.
//   - The app logs in with Firebase email/password; see --signin to mint a Bearer if needed.
//
// Credentials/overrides never live in git. The apiKey default below is the public app
// constant; a per-user Bearer, if required, comes from env or an untracked file:
//   - env:   COMODULE_TOKEN   (firebase id token; 'Bearer ' optional)
//            COMODULE_API_KEY (overrides the baked-in query-param key)
//   - file:  work/firmware/vendor/auth.json  ->  { "authorization": "...", "apiKey": "..." }
//
// Request body defaults to this S2's installed versions; override via
// work/firmware/vendor/request.json (merged over defaults) or --request-all (claim v0 so the
// server returns the current image even when the bike is already on it).
//
// Usage:
//   node scripts/fetch-vendor-firmware.mjs                      # query with installed versions
//   node scripts/fetch-vendor-firmware.mjs --request-all        # claim v0 to force full images
//   node scripts/fetch-vendor-firmware.mjs --dry-run            # print request, send nothing
//   node scripts/fetch-vendor-firmware.mjs --no-download        # query only, save response
//   node scripts/fetch-vendor-firmware.mjs --signin EMAIL PASS  # mint a Bearer, store it, exit
//
// Exit codes: 0 ok, 2 bad input, 3 HTTP/transport, 4 download/checksum problem.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "work", "firmware", "vendor");
// Real routes (Retrofit interface defpackage/a.java):
//   @o("module/{moduleId}/update")  @Body FirmwareUpdateRequestDto -> FirmwareUpdateResponseDto
//   @f("module/{moduleId}/config")  ?stmVersion&bleVersion&type    -> ConfigDto (register schema)
const API_BASE = "https://analytics.comodule.com/bleapi/v2";

// Recovered app constants (public client-side values shipped in com.comodule.super).
const DEFAULT_API_KEY = "6od0h50da2ub3pdjl0o3s998n0";                 // ua.a.f30403v (?apiKey=)
const FIREBASE_WEB_KEY = "AIzaSyAIM7QEIQh05cQUp5RB953puBCXg6xFViw";  // google_api_key

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const DRY = has("--dry-run");
const NO_DL = has("--no-download");
const REQUEST_ALL = has("--request-all");
const CONFIG = has("--config");            // hit module/{id}/config instead of /update

function fail(code, msg) { console.error(`ERROR: ${msg}`); process.exit(code); }
function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { fail(2, `${p}: ${e.message}`); } }

// ---- firebase sign-in helper (mint a Bearer from email/password) ----------
async function signin() {
  const i = args.indexOf("--signin");
  const email = args[i + 1], password = args[i + 2];
  if (!email || !password) fail(2, "usage: --signin EMAIL PASSWORD");
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(3, `sign-in failed: HTTP ${res.status} ${JSON.stringify(data.error || data)}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const authFile = join(OUT_DIR, "auth.json");
  const existing = existsSync(authFile) ? readJson(authFile) : {};
  writeFileSync(authFile, JSON.stringify({ ...existing, authorization: `Bearer ${data.idToken}` }, null, 2));
  console.log(`signed in as ${email} (localId ${data.localId}).`);
  console.log(`idToken stored in work/firmware/vendor/auth.json (expires in ${data.expiresIn}s).`);
  console.log(`refreshToken: ${data.refreshToken ? data.refreshToken.slice(0, 12) + "…" : "(none)"}`);
}

// ---- auth loading ---------------------------------------------------------
function loadAuth() {
  const authFile = join(OUT_DIR, "auth.json");
  const f = existsSync(authFile) ? readJson(authFile) : {};
  let authorization = (process.env.COMODULE_TOKEN || process.env.COMODULE_AUTH || f.authorization || f.token || "").trim();
  if (authorization && !/^bearer /i.test(authorization)) authorization = `Bearer ${authorization}`;
  const apiKey = (process.env.COMODULE_API_KEY || f.apiKey || f["api-key"] || DEFAULT_API_KEY).trim();
  const moduleId = (valOf("--module") || process.env.COMODULE_MODULE_ID || f.moduleId || "").trim();
  return { authorization, apiKey, moduleId };
}

// ---- request body ---------------------------------------------------------
const DEFAULT_BODY = {
  firmwareType: 0,
  bleName: "SUPER73",
  bleVersion: "221122",
  stmVersion: 410,
  bleBootloaderVersion: null,
  nrfBlVersion: null,
  ext1Version: null,
  ext2Version: null,
};

function buildBody() {
  let body = { ...DEFAULT_BODY };
  const reqFile = join(OUT_DIR, "request.json");
  if (existsSync(reqFile)) body = { ...body, ...readJson(reqFile) };
  // CLI overrides (read the firmware type off the app's Bike Passport while connected to the bike)
  const ft = valOf("--firmware-type") ?? process.env.COMODULE_FW_TYPE;
  if (ft !== undefined) body.firmwareType = parseInt(ft, 10);
  const stm = valOf("--stm"); if (stm !== undefined) body.stmVersion = parseInt(stm, 10);
  const ble = valOf("--ble") ?? valOf("--nrf"); if (ble !== undefined) body.bleVersion = String(ble);
  // EXT units (ext1 = GD32 motor controller, ext2 = BMS). The server only offers an ext update when
  // you report a *recognized* current version (e.g. controller 410/420), never 0 — see FINDINGS.
  const e1 = valOf("--ext1"); if (e1 !== undefined) body.ext1Version = parseInt(e1, 10);
  const e2 = valOf("--ext2"); if (e2 !== undefined) body.ext2Version = parseInt(e2, 10);
  if (REQUEST_ALL) {
    body.bleVersion = "0";
    for (const k of ["stmVersion", "bleBootloaderVersion", "nrfBlVersion", "ext1Version", "ext2Version"]) body[k] = 0;
  }
  return body;
}

// ---- download + checksum --------------------------------------------------
const URL_FIELDS = [
  ["bleUpdateUrl", "ble", "bleChecksum"],
  ["nrfBlUpdateUrl", "nrfbl", "nrfBlChecksum"],
  ["stmUpdateUrl", "stm", "stmChecksum"],
  ["ext1UpdateUrl", "ext1", "ext1Checksum"],
  ["ext2UpdateUrl", "ext2", "ext2Checksum"],
];

function checksumNote(buf, declared) {
  const sha = createHash("sha256").update(buf).digest("hex");
  let c = ~0 >>> 0;
  for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  const crc32 = (~c >>> 0).toString(16).padStart(8, "0");
  let s = `bytes=${buf.length} sha256=${sha} crc32=${crc32}`;
  if (declared != null) s += `  declared=${JSON.stringify(declared)}`;
  return s;
}

async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outPath, buf);
  return buf;
}

// ---- main -----------------------------------------------------------------
(async () => {
  if (has("--signin")) return signin();

  mkdirSync(OUT_DIR, { recursive: true });
  const { authorization, apiKey, moduleId } = loadAuth();
  if (!moduleId) fail(2, "no moduleId. Pass --module <id>, set COMODULE_MODULE_ID, or add \"moduleId\" to auth.json.\n" +
    "Find it on the app's Vehicle Passport / Settings screen, or the Comodule module's own label.");
  const body = buildBody();

  const q = `apiKey=${encodeURIComponent(apiKey)}`;
  const headers = { Accept: "application/json" };
  if (authorization) headers.Authorization = authorization;
  const method = CONFIG ? "GET" : "POST";
  let url;
  if (CONFIG) {
    const cq = `stmVersion=${body.stmVersion}&bleVersion=${encodeURIComponent(body.bleVersion)}`;
    url = `${API_BASE}/module/${encodeURIComponent(moduleId)}/config?${cq}&${q}`;
  } else {
    url = `${API_BASE}/module/${encodeURIComponent(moduleId)}/update?${q}`;
    headers["Content-Type"] = "application/json";
  }

  console.log(`endpoint : ${method} ${API_BASE}/module/${moduleId}/${CONFIG ? "config" : "update"}?apiKey=${apiKey.slice(0, 4)}…`);
  if (!CONFIG) console.log(`request  : ${JSON.stringify(body)}`);
  console.log(`auth     : ${authorization ? `Bearer …(${authorization.length} chars)` : "no Bearer (apiKey query param only)"}`);

  if (DRY) { console.log("\n--dry-run: not sending."); return; }

  let res, text;
  try {
    res = await fetch(url, { method, headers, body: CONFIG ? undefined : JSON.stringify(body) });
    text = await res.text();
  } catch (e) { fail(3, `transport: ${e.message}`); }

  console.log(`\nHTTP ${res.status} ${res.statusText}`);
  if (res.status === 401 || res.status === 403) {
    writeFileSync(join(OUT_DIR, "firmware-response.err.txt"), text);
    fail(3, `auth required/!accepted. If a user token is needed, run:\n` +
      `  node scripts/fetch-vendor-firmware.mjs --signin <email> <password>\n` +
      `then re-run. Server said:\n${text.slice(0, 400)}`);
  }
  if (!res.ok) {
    writeFileSync(join(OUT_DIR, "firmware-response.err.txt"), text);
    fail(3, `server error. Body in work/firmware/vendor/firmware-response.err.txt\n${text.slice(0, 600)}`);
  }

  let data = null;
  try { data = JSON.parse(text); } catch {}
  const outName = CONFIG ? "config.json" : "firmware-response.json";
  writeFileSync(join(OUT_DIR, outName), data ? JSON.stringify(data, null, 2) : text);
  console.log(`saved    : work/firmware/vendor/${outName}`);
  if (!data) { console.log("(non-JSON response — inspect the saved file)"); return; }
  if (CONFIG) {
    const n = Array.isArray(data?.properties) ? data.properties.length : (Array.isArray(data) ? data.length : "?");
    console.log(`config/register schema retrieved (${n} properties).`);
    return;
  }
  if (data.updateOrder) console.log(`updateOrder: ${JSON.stringify(data.updateOrder)}`);

  const present = URL_FIELDS.filter(([k]) => data[k]);
  if (present.length === 0) {
    console.log("\nNo *UpdateUrl in the response — nothing newer than the versions sent.");
    console.log("Re-run with --request-all to have the server serve the current images.");
    return;
  }
  if (NO_DL) { console.log(`\n--no-download: ${present.length} URL(s) present; not fetching.`); return; }

  let problems = false;
  for (const [urlKey, tag, sumKey] of present) {
    // Prefer the real object name from the GCS URL (…/o/<name>?…), else <tag>.bin
    const obj = decodeURIComponent((data[urlKey].match(/\/o\/([^?]+)/) || [])[1] || "").split("/").pop();
    const fname = obj || `${tag}.bin`;
    const outPath = join(OUT_DIR, fname);
    console.log(`\n${urlKey} -> ${fname}\n  ${data[urlKey].split("?")[0]}`);
    try { console.log(`  ${checksumNote(await download(data[urlKey], outPath), data[sumKey])}`); }
    catch (e) { console.error(`  download failed: ${e.message}`); problems = true; }
  }
  console.log(`\nDone. Images in ${OUT_DIR}`);
  if (problems) process.exit(4);
})();
