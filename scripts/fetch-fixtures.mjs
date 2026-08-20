#!/usr/bin/env node
// Refresh data/fixtures-2026.json — the season schedule every page, match slug and
// locked prediction is built from. football-data.org edition.
//
// This replaces the API-Football fetcher. football-data.org uses its own club names
// ("Deportivo Alavés", "Manchester City FC"), but the whole site joins strength and
// slugs by the roster's canonical names ("Alaves", "Man City"). So every fetched team
// is remapped back to the roster in data/leagues-2026.json — canonical name AND apiId —
// which keeps this file byte-compatible with what API-Football produced. Any team that
// cannot be resolved to a roster club fails the run loudly rather than shipping a
// mismatch, because a schedule that looks synthetic once shipped wrong dates for weeks.
//
//   FOOTBALL_DATA_KEY=... node scripts/fetch-fixtures.mjs
//   DRY_RUN=1 ... node scripts/fetch-fixtures.mjs      # fetch + validate, write nothing
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Load .env.local / .env so a bare `node scripts/fetch-fixtures.mjs` picks up the token
// the same way the Next build does. Requires Node 20.6+ (process.loadEnvFile).
for (const envFile of [".env.local", ".env"]) {
  if (!existsSync(resolve(envFile))) continue;
  try { process.loadEnvFile(resolve(envFile)); }
  catch (error) { console.warn(`Warning: could not load ${envFile}: ${error?.message ?? error}`); }
}

const KEY = (process.env.FOOTBALL_DATA_KEY || process.env.API_FOOTBALL_KEY || "").trim();
const SEASON = Number(process.env.FIXTURES_SEASON ?? 2026);
const DRY = process.env.DRY_RUN === "1";
const BASE = "https://api.football-data.org/v4";
const DEST = join(process.cwd(), "data", "fixtures-2026.json");
const ROSTER = join(process.cwd(), "data", "leagues-2026.json");
// Free tier: 10 req/min. Five calls, spaced, stay well under it.
const SPACING_MS = Number(process.env.FOOTBALL_DATA_SPACING_MS ?? 6500);

// football-data.org competition codes for the five leagues in lib/data.ts.
const LEAGUES = [
  { slug: "premier-league", code: "PL" },
  { slug: "la-liga", code: "PD" },
  { slug: "serie-a", code: "SA" },
  { slug: "bundesliga", code: "BL1" },
  { slug: "ligue-1", code: "FL1" },
];

// Explicit football-data.org → roster aliases, keyed by roster canonical name. Only the
// clubs whose names do not survive normalisation to an exact roster match need listing;
// everything else (Villarreal, Valencia, Getafe, Sevilla…) matches on normalised name.
const ALIASES = {
  // Premier League
  "Man City": ["Manchester City FC"],
  "Man United": ["Manchester United FC"],
  "Aston Villa": ["Aston Villa FC"],
  "Newcastle": ["Newcastle United FC"],
  "Forest": ["Nottingham Forest FC"],
  "Tottenham": ["Tottenham Hotspur FC"],
  "Brighton": ["Brighton & Hove Albion FC"],
  "Brentford": ["Brentford FC"],
  "Bournemouth": ["AFC Bournemouth"],
  "Crystal Palace": ["Crystal Palace FC"],
  "Leeds": ["Leeds United FC"],
  "Sunderland": ["Sunderland AFC"],
  "Hull": ["Hull City AFC"],
  "Ipswich": ["Ipswich Town FC"],
  "Coventry": ["Coventry City FC"],
  // La Liga
  "Barcelona": ["FC Barcelona"],
  "Atletico": ["Club Atlético de Madrid", "Atlético de Madrid"],
  "Betis": ["Real Betis Balompié"],
  "Celta": ["RC Celta de Vigo", "Celta de Vigo"],
  "Bilbao": ["Athletic Club"],
  "Sociedad": ["Real Sociedad de Fútbol", "Real Sociedad"],
  "Osasuna": ["CA Osasuna"],
  "Alaves": ["Deportivo Alavés"],
  "Levante": ["Levante UD"],
  "Rayo Vallecano": ["Rayo Vallecano de Madrid"],
  "Espanyol": ["RCD Espanyol de Barcelona", "RCD Espanyol"],
  "Santander": ["Real Racing Club", "Racing de Santander", "Real Racing Club de Santander"],
  "Depor": ["RC Deportivo de La Coruña", "Deportivo de La Coruña", "RC Deportivo La Coruña"],
  // Serie A
  "Inter": ["FC Internazionale Milano"],
  "Roma": ["AS Roma"],
  "Napoli": ["SSC Napoli"],
  "Juventus": ["Juventus FC"],
  "Atalanta": ["Atalanta BC"],
  "Como": ["Como 1907"],
  "Milan": ["AC Milan"],
  "Lazio": ["SS Lazio"],
  "Bologna": ["Bologna FC 1909"],
  "Fiorentina": ["ACF Fiorentina"],
  "Udinese": ["Udinese Calcio"],
  "Torino": ["Torino FC"],
  "Sassuolo": ["US Sassuolo Calcio"],
  "Genoa": ["Genoa CFC"],
  "Parma": ["Parma Calcio 1913"],
  "Venezia": ["Venezia FC"],
  "Cagliari": ["Cagliari Calcio"],
  "Lecce": ["US Lecce"],
  "Frosinone": ["Frosinone Calcio"],
  "Monza": ["AC Monza"],
  // Bundesliga
  "Bayern": ["FC Bayern München"],
  "Dortmund": ["Borussia Dortmund"],
  "Leverkusen": ["Bayer 04 Leverkusen"],
  "Stuttgart": ["VfB Stuttgart"],
  "RB Leipzig": ["RB Leipzig"],
  "Freiburg": ["SC Freiburg"],
  "Hoffenheim": ["TSG 1899 Hoffenheim"],
  "Mainz": ["1. FSV Mainz 05"],
  "Frankfurt": ["Eintracht Frankfurt"],
  "Gladbach": ["Borussia Mönchengladbach"],
  "Augsburg": ["FC Augsburg"],
  "Union Berlin": ["1. FC Union Berlin"],
  "Werder": ["SV Werder Bremen"],
  "Hamburg": ["Hamburger SV"],
  "Koeln": ["1. FC Köln"],
  "Paderborn": ["SC Paderborn 07"],
  "Elversberg": ["SV 07 Elversberg"],
  "Schalke": ["FC Schalke 04"],
  // Ligue 1
  "Paris SG": ["Paris Saint-Germain FC"],
  "Lens": ["RC Lens", "Racing Club de Lens"],
  "Lille": ["LOSC Lille", "Lille OSC"],
  "Lyon": ["Olympique Lyonnais"],
  "Monaco": ["AS Monaco FC"],
  "Marseille": ["Olympique de Marseille"],
  "Rennes": ["Stade Rennais FC 1901"],
  "Strasbourg": ["RC Strasbourg Alsace"],
  "Toulouse": ["Toulouse FC"],
  "Lorient": ["FC Lorient"],
  "Paris FC": ["Paris FC"],
  "Auxerre": ["AJ Auxerre"],
  "Brest": ["Stade Brestois 29"],
  "Nice": ["OGC Nice"],
  "Le Havre": ["Le Havre AC"],
  "Angers": ["Angers SCO"],
  "Troyes": ["ESTAC Troyes", "ES Troyes AC"],
  "Le Mans": ["Le Mans FC"],
};

if (!KEY) { console.error("✗ FOOTBALL_DATA_KEY (or API_FOOTBALL_KEY) is not set."); process.exit(1); }
if (!existsSync(ROSTER)) { console.error(`✗ ${ROSTER} is missing — cannot map team names.`); process.exit(1); }

// ── build the name resolver from the roster ───────────────────────────────────
const norm = (s) => (s ?? "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")            // strip accents
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/\b(fc|cf|afc|sc|ac|acf|ss|ssc|as|us|rc|rcd|cfc|bc|sv|vfb|vfl|tsg|ca|cd|sad|club|calcio|sco|estac|losc|ogc|aj|1\.?|07|29|1901|1907|1909|1913|1899|05|04)\b/g, " ")
  .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

const roster = JSON.parse(readFileSync(ROSTER, "utf8"));
const canonical = new Map();  // normalised key -> { club, apiId }
for (const clubs of Object.values(roster)) {
  for (const c of clubs) canonical.set(norm(c.club), { club: c.club, apiId: c.apiId });
}
const aliasIndex = new Map(); // normalised alias -> roster canonical name
for (const [rosterName, aliases] of Object.entries(ALIASES)) {
  for (const a of aliases) aliasIndex.set(norm(a), rosterName);
}

const unresolved = new Set();
function resolveTeam(fdName) {
  const n = norm(fdName);
  if (canonical.has(n)) return canonical.get(n);
  if (aliasIndex.has(n)) {
    const rosterName = aliasIndex.get(n);
    return canonical.get(norm(rosterName)) ?? null;
  }
  unresolved.add(fdName);
  return null;
}

// ── fetch ─────────────────────────────────────────────────────────────────────
let lastReq = 0;
async function api(path) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    const since = Date.now() - lastReq;
    if (lastReq && since < SPACING_MS) await wait(SPACING_MS - since);
    lastReq = Date.now();
    let res;
    try { res = await fetch(`${BASE}${path}`, { headers: { "X-Auth-Token": KEY } }); }
    catch (e) { if (attempt === 2) throw e; await wait(1000 * (attempt + 1)); continue; }
    const body = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(body?.matches)) return body.matches;
    const msg = body?.message || body?.error || res.statusText;
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await wait(Math.max(SPACING_MS, 2000 * (attempt + 1))); continue; }
    throw new Error(`football-data.org ${res.status}: ${msg}`);
  }
  return [];
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const out = {};
for (const league of LEAGUES) {
  const matches = await api(`/competitions/${league.code}/matches?season=${SEASON}`);
  out[league.slug] = matches
    .map((m) => {
      const home = resolveTeam(m.homeTeam?.name);
      const away = resolveTeam(m.awayTeam?.name);
      const md = Number.isFinite(m.matchday) ? m.matchday : null;
      // Rebuild the round string in API-Football's format so any downstream parsing
      // (e.g. the matchday-1 sanity check) keeps working unchanged.
      const round = m.stage && m.stage !== "REGULAR_SEASON"
        ? m.stage.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
        : (md != null ? `Regular Season - ${md}` : null);
      return {
        id: m.id,
        date: m.utcDate,
        round,
        venue: m.venue ?? null,
        city: null,
        homeId: home?.apiId ?? null,
        awayId: away?.apiId ?? null,
        home: home?.club ?? null,
        away: away?.club ?? null,
      };
    })
    .filter((f) => f.id && f.date && f.home && f.away)
    .sort((a, b) => a.date.localeCompare(b.date));
  console.log(`  ${league.slug.padEnd(16)} ${out[league.slug].length} fixtures`);
}

// ── name resolution must be complete ──────────────────────────────────────────
if (unresolved.size) {
  console.error("\n✗ these football-data.org clubs did not map to any roster club in data/leagues-2026.json:");
  for (const name of [...unresolved].sort()) console.error(`  · ${name}  (normalised: "${norm(name)}")`);
  console.error("\nAdd each to the ALIASES table (keyed by its roster canonical name) or update the roster, then re-run.");
  process.exit(1);
}

// ── sanity checks (unchanged in spirit from the original) ─────────────────────
const problems = [];
for (const [slug, fixtures] of Object.entries(out)) {
  if (!fixtures.length) { problems.push(`${slug}: no fixtures returned`); continue; }
  if (fixtures.length < 180) problems.push(`${slug}: only ${fixtures.length} fixtures (expected 300+)`);
  const slots = new Set(fixtures.map((f) => f.date.slice(11, 16)));
  if (slots.size < 4) problems.push(`${slug}: only ${slots.size} distinct kickoff time(s) across ${fixtures.length} fixtures — looks like placeholder times`);
  const round1 = fixtures.filter((f) => /(-|\s)1$/.test(f.round ?? ""));
  if (round1.length > 4 && new Set(round1.map((f) => f.date)).size === 1) {
    problems.push(`${slug}: all ${round1.length} opening fixtures share one kickoff instant (${round1[0].date})`);
  }
}
if (problems.length) {
  console.error("\n✗ schedule failed validation — refusing to write:");
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

const total = Object.values(out).reduce((n, a) => n + a.length, 0);
if (DRY) {
  console.log(`\n◦ dry run — validated ${total} fixtures, wrote nothing.`);
  for (const [slug, f] of Object.entries(out)) {
    const opener = f[0];
    console.log(`  ${slug}: opens ${opener.date} ${opener.home} v ${opener.away}`);
  }
  process.exit(0);
}

try {
  const prev = JSON.parse(readFileSync(DEST, "utf8"));
  for (const slug of Object.keys(out)) {
    const before = prev[slug]?.[0]?.date;
    const after = out[slug][0]?.date;
    if (before && after && before !== after) console.log(`  ${slug}: opener moves ${before} → ${after}`);
  }
} catch { /* first write */ }

const tmp = `${DEST}.tmp`;
writeFileSync(tmp, JSON.stringify(out, null, 1));
renameSync(tmp, DEST);
console.log(`\n✓ wrote ${total} fixtures to data/fixtures-2026.json`);
