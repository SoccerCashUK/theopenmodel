#!/usr/bin/env node
// Build-time football-data.org adapter — a drop-in replacement for
// scripts/fetch-api-football.mjs. Emits the identical portal.json schema
// (schemaVersion 1, fixtures[] + standings[]) so nothing downstream changes.
//
// Why this exists: API-Football (api-sports.io) can suspend an account; this
// model only needs fixtures, statuses, final scores and league tables, all of
// which football-data.org's free tier provides for the same five leagues.
//
// Key handling mirrors the original: read only in Node, sent in the provider
// header, never written into browser assets or logs. Failed refreshes are
// non-destructive — the previous snapshot stays in place.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

for (const envFile of [".env.local", ".env"]) {
  if (!existsSync(resolve(envFile))) continue;
  try { process.loadEnvFile(resolve(envFile)); }
  catch (error) { console.warn(`Warning: could not load ${envFile}: ${messageFor(error)}`); }
}

const API_ROOT = "https://api.football-data.org/v4";

// The five leagues this model forecasts, as football-data.org competition ids.
// PL Premier League, PD La Liga, SA Serie A, BL1 Bundesliga, FL1 Ligue 1.
const COMPETITIONS = [
  { id: 2021, code: "PL",  name: "Premier League" },
  { id: 2014, code: "PD",  name: "La Liga" },
  { id: 2019, code: "SA",  name: "Serie A" },
  { id: 2002, code: "BL1", name: "Bundesliga" },
  { id: 2015, code: "FL1", name: "Ligue 1" },
];

// Accept the football-data key, but fall back to the old var names so this can
// be dropped in without touching CI secrets immediately.
const KEY = (process.env.FOOTBALL_DATA_KEY
  || process.env.FOOTBALL_DATA_ORG_KEY
  || process.env.API_FOOTBALL_KEY
  || "").trim();

const DESTINATION = resolve(process.env.API_FOOTBALL_DESTINATION?.trim() || "data/portal.json");
const PUBLIC_DESTINATION = resolve(
  process.env.API_FOOTBALL_PUBLIC_DESTINATION?.trim() || "public/data/portal-live.json",
);
const FAIL_ON_ERROR = process.env.API_FOOTBALL_FAIL_ON_ERROR === "true";
const TIMEOUT_MS = integerEnv("API_FOOTBALL_TIMEOUT_MS", 15_000, 2_000, 60_000);
const LOOKAHEAD_DAYS = integerEnv("API_FOOTBALL_LOOKAHEAD_DAYS", 14, 0, 60);
const LOOKBEHIND_DAYS = integerEnv("API_FOOTBALL_LOOKBEHIND_DAYS", 5, 0, 60);
const RETRIES = integerEnv("API_FOOTBALL_RETRIES", 2, 0, 5);
const FETCH_STANDINGS = process.env.API_FOOTBALL_FETCH_STANDINGS !== "false";
// Free tier is 10 requests/minute. Space calls out so a scheduled build never
// trips the limiter; ~6.5s keeps well under it with headroom for retries.
const MIN_REQUEST_SPACING_MS = integerEnv("FOOTBALL_DATA_SPACING_MS", 6_500, 0, 30_000);
// football-data.org caps a single /matches date filter; chunk the window.
const MAX_WINDOW_DAYS = integerEnv("FOOTBALL_DATA_WINDOW_DAYS", 10, 1, 10);

const LEAGUE_IDS = new Set(
  (process.env.API_FOOTBALL_LEAGUE_IDS || "")
    .split(",").map((v) => v.trim()).filter(Boolean).map(Number).filter(Number.isFinite),
);

if (!KEY) {
  console.log("football-data.org: no key set (FOOTBALL_DATA_KEY); keeping the previous snapshot and fixture fallback.");
  process.exit(FAIL_ON_ERROR ? 1 : 0);
}

const startedAt = new Date();
const dateFrom = formatDate(addUtcDays(startedAt, -LOOKBEHIND_DAYS));
const dateTo = formatDate(addUtcDays(startedAt, LOOKAHEAD_DAYS));
let lastRequestAt = 0;

try {
  if (DESTINATION === PUBLIC_DESTINATION) {
    throw new Error("Destination and public destination must be different files.");
  }
  const snapshot = await refreshFullSnapshot();
  atomicJsonWrites([
    { destination: DESTINATION, value: snapshot },
    { destination: PUBLIC_DESTINATION, value: publicSnapshot(snapshot) },
  ]);
  console.log(
    `football-data.org: wrote ${snapshot.fixtures.length} fixtures across ${snapshot.coverage.leagueCount} leagues and ${snapshot.coverage.standingTableCount} standing tables.`,
  );
} catch (error) {
  const previous = existingSnapshotDescription();
  console.warn(`football-data.org refresh skipped: ${messageFor(error)} ${previous}`);
  process.exitCode = FAIL_ON_ERROR ? 1 : 0;
}

async function refreshFullSnapshot() {
  const activeCompetitions = LEAGUE_IDS.size
    ? COMPETITIONS.filter((c) => LEAGUE_IDS.has(c.id))
    : COMPETITIONS;
  const competitionIds = activeCompetitions.map((c) => c.id).join(",");
  const warnings = [];

  // Fixtures: one call per <=MAX_WINDOW_DAYS slice, filtered to our leagues.
  const rawMatches = [];
  for (const [from, to] of dateWindows(dateFrom, dateTo, MAX_WINDOW_DAYS)) {
    try {
      const body = await fetchApi("/matches", { competitions: competitionIds, dateFrom: from, dateTo: to });
      rawMatches.push(...array(body?.matches));
    } catch (error) {
      warnings.push(`Matches ${from}..${to}: ${messageFor(error)}`);
    }
  }

  const byId = new Map();
  for (const match of rawMatches) {
    const id = numberOrNull(match?.id);
    if (id !== null) byId.set(String(id), match);
  }
  const fixtures = [...byId.values()]
    .map(normalizeFixture)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  // Standings: one table per competition.
  const standings = [];
  if (FETCH_STANDINGS) {
    for (const competition of activeCompetitions) {
      try {
        const body = await fetchApi(`/competitions/${competition.code}/standings`, {});
        const table = normalizeStandingTable(body, competition);
        if (table) standings.push(table);
      } catch (error) {
        warnings.push(`Standings ${competition.code}: ${messageFor(error)}`);
      }
    }
  }

  const updatedAt = new Date().toISOString();
  const liveFixtureCount = fixtures.filter((f) => f.status.isLive).length;
  const finishedFixtureCount = fixtures.filter((f) => f.status.isFinished).length;
  const leagueCount = new Set(fixtures.map((f) => f.league.id)).size;
  const successfulStandingTables = standings.filter((t) => t.rows.length > 0).length;

  return {
    schemaVersion: 1,
    provider: "football-data",
    asOf: updatedAt,
    updatedAt,
    coverage: {
      dateFrom,
      dateTo,
      fixtureCount: fixtures.length,
      liveFixtureCount,
      finishedFixtureCount,
      leagueCount,
      standingTableCount: successfulStandingTables,
      requestedIncludes: ["fixtures", "standings"],
      features: {
        fixtures: true,
        scores: true,
        statuses: true,
        events: false,   // not available on the free tier
        lineups: false,  // not available on the free tier
        injuries: false, // not available on the free tier
        standings: successfulStandingTables > 0,
      },
      rateLimit: { plan: "free", limitPerMinute: 10 },
      warnings,
    },
    fixtures,
    standings,
  };
}

// ── Normalisers (output shape matches fetch-api-football.mjs exactly) ─────────

function normalizeFixture(input) {
  const competition = object(input?.competition) || {};
  const season = object(input?.season) || {};
  const score = object(input?.score) || {};
  const fullTime = object(score.fullTime) || {};
  const halfTime = object(score.halfTime) || {};
  const home = normalizeParticipant(input?.homeTeam, "home", score.winner === "HOME_TEAM");
  const away = normalizeParticipant(input?.awayTeam, "away", score.winner === "AWAY_TEAM");
  const rawStatus = stringOrNull(input?.status) || "SCHEDULED";
  const isLive = ["IN_PLAY", "PAUSED", "LIVE"].includes(rawStatus);
  const isFinished = ["FINISHED", "AWARDED"].includes(rawStatus);
  const currentHome = numberOrNull(fullTime.home);
  const currentAway = numberOrNull(fullTime.away);
  const halfTimeHome = numberOrNull(halfTime.home);
  const halfTimeAway = numberOrNull(halfTime.away);
  const scores = [
    normalizeScore(home.id, "home", "CURRENT", currentHome),
    normalizeScore(away.id, "away", "CURRENT", currentAway),
    normalizeScore(home.id, "home", "1ST_HALF", halfTimeHome),
    normalizeScore(away.id, "away", "1ST_HALF", halfTimeAway),
  ].filter((entry) => entry.goals !== null);
  const matchday = numberOrNull(input?.matchday);
  const roundName = stringOrNull(input?.stage) || (matchday !== null ? `Matchday ${matchday}` : null);

  return {
    id: `football-data:${input?.id}`,
    providerId: numberOrNull(input?.id),
    name: `${home.name} vs ${away.name}`,
    startTime: isoDate(input?.utcDate, null),
    resultInfo: isFinished && currentHome !== null && currentAway !== null
      ? `${currentHome}-${currentAway}`
      : null,
    seasonId: numberOrNull(season.id),
    stageId: null,
    roundId: null,
    hasOdds: false,
    lastProcessedAt: stringOrNull(input?.lastUpdated),
    status: {
      id: null,
      name: prettyStatus(rawStatus),
      shortName: rawStatus,
      developerName: rawStatus,
      isLive,
      isFinished,
    },
    league: {
      id: numberOrNull(competition.id),
      name: stringOrNull(competition.name),
      shortCode: stringOrNull(competition.code),
      imageUrl: safeHttpUrl(competition.emblem),
    },
    round: {
      id: null,
      name: roundName,
      shortCode: null,
      imageUrl: null,
    },
    venue: normalizeVenue(input?.venue),
    participants: [home, away],
    score: {
      home: currentHome,
      away: currentAway,
      halfTimeHome,
      halfTimeAway,
    },
    scores,
    events: [],
    lineups: [],
    injuries: [],
  };
}

function normalizeParticipant(input, role = null, winner = false) {
  const team = object(input) || {};
  return {
    id: numberOrNull(team.id),
    name: stringOrNull(team.name) || stringOrNull(team.shortName) || "Unknown team",
    shortCode: stringOrNull(team.tla),
    imageUrl: safeHttpUrl(team.crest),
    role,
    position: null,
    winner: typeof winner === "boolean" ? winner : null,
  };
}

function normalizeScore(participantId, participant, description, goals) {
  return { id: null, typeId: null, participantId: numberOrNull(participantId), description, participant, goals };
}

function normalizeVenue(input) {
  const name = stringOrNull(input);
  if (!name) return { id: null, name: null, city: null, capacity: null, imageUrl: null };
  return { id: null, name, city: null, capacity: null, imageUrl: null };
}

function normalizeStandingTable(body, competition) {
  const season = object(body?.season) || {};
  const seasonId = numberOrNull(season.id);
  const leagueId = numberOrNull(object(body?.competition)?.id) ?? competition.id;
  if (seasonId === null) return null;
  const total = array(body?.standings).find((s) => stringOrNull(s?.type) === "TOTAL")
    || array(body?.standings)[0]
    || {};
  const rows = array(total.table)
    .map((row) => normalizeStandingRow(row, leagueId, seasonId))
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
  return { seasonId, leagueId, rows };
}

function normalizeStandingRow(input, leagueId, seasonId) {
  const team = object(input?.team) || {};
  const position = numberOrNull(input?.position);
  const form = stringOrNull(input?.form) || ""; // e.g. "W,W,D,L,W"
  return {
    id: null,
    participantId: numberOrNull(team.id),
    position,
    points: numberOrNull(input?.points),
    result: null,
    leagueId,
    seasonId,
    stageId: null,
    groupId: null,
    roundId: null,
    participant: {
      id: numberOrNull(team.id),
      name: stringOrNull(team.name) || stringOrNull(team.shortName) || "Unknown team",
      shortCode: stringOrNull(team.tla),
      imageUrl: safeHttpUrl(team.crest),
      role: null,
      position,
      winner: null,
    },
    details: [
      standingDetail("Played", input?.playedGames),
      standingDetail("Won", input?.won),
      standingDetail("Drawn", input?.draw),
      standingDetail("Lost", input?.lost),
      standingDetail("Goals for", input?.goalsFor),
      standingDetail("Goals against", input?.goalsAgainst),
      standingDetail("Goal difference", input?.goalDifference),
    ].filter((detail) => detail.value !== null),
    form: form.split(",").map((v) => v.trim()).filter(Boolean).map((value) => ({ fixtureId: null, form: value })),
  };
}

function standingDetail(description, value) {
  return { typeId: null, value: scalarOrNull(value), description };
}

function prettyStatus(raw) {
  const map = {
    SCHEDULED: "Not Started",
    TIMED: "Not Started",
    IN_PLAY: "In Play",
    PAUSED: "Half Time",
    FINISHED: "Match Finished",
    SUSPENDED: "Match Suspended",
    POSTPONED: "Match Postponed",
    CANCELLED: "Match Cancelled",
    AWARDED: "Match Awarded",
  };
  return map[raw] || raw;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchApi(path, params) {
  const url = new URL(`${API_ROOT}${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, value);
  }

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    await respectRateLimit();
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Auth-Token": KEY,
          "User-Agent": "theopenmodel.com portal snapshot",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < RETRIES) { await wait(backoffMs(attempt)); continue; }
      throw new Error(`football-data.org request timed out or failed: ${messageFor(error)}`);
    }

    const bodyText = await response.text();
    let body;
    try { body = bodyText ? JSON.parse(bodyText) : {}; }
    catch { body = {}; }

    if (response.ok) return body;

    const detail = stringOrNull(body?.message) || stringOrNull(body?.error) || response.statusText || "request rejected";
    const retryable = response.status === 429 || response.status >= 500 || /rate.?limit|too many|temporar/i.test(detail);
    if (retryable && attempt < RETRIES) {
      const retryAfter = numberOrNull(response.headers.get("retry-after"));
      const delay = retryAfter !== null ? Math.min(retryAfter * 1_000, 60_000) : Math.max(backoffMs(attempt), MIN_REQUEST_SPACING_MS);
      await wait(delay);
      continue;
    }
    throw new ApiError(response.status, `football-data.org HTTP ${response.status}: ${detail}`);
  }
  throw new Error("football-data.org request exhausted its retry budget.");
}

async function respectRateLimit() {
  const since = Date.now() - lastRequestAt;
  if (lastRequestAt && since < MIN_REQUEST_SPACING_MS) await wait(MIN_REQUEST_SPACING_MS - since);
  lastRequestAt = Date.now();
}

// ── Snapshot write helpers (mirrors the original, non-destructive) ───────────

function publicSnapshot(snapshot) {
  // The public copy is what the browser fetches; keep it identical in shape.
  return snapshot;
}

function atomicJsonWrites(writes) {
  const written = [];
  try {
    for (const { destination, value } of writes) {
      mkdirSync(dirname(destination), { recursive: true });
      const tmp = `${destination}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
      renameSync(tmp, destination);
      written.push(destination);
    }
  } catch (error) {
    throw new Error(`Failed writing snapshot (${written.join(", ") || "none"}): ${messageFor(error)}`);
  }
}

function readExistingSnapshot() {
  try {
    if (!existsSync(DESTINATION)) return null;
    return JSON.parse(readFileSync(DESTINATION, "utf8"));
  } catch { return null; }
}

function existingSnapshotDescription() {
  const existing = readExistingSnapshot();
  if (!existing) return "No previous snapshot exists; the fixture fallback will be used.";
  const count = Array.isArray(existing.fixtures) ? existing.fixtures.length : 0;
  return `Keeping the previous snapshot (${count} fixtures, provider ${existing.provider ?? "unknown"}).`;
}

// ── Small utilities ──────────────────────────────────────────────────────────

function dateWindows(from, to, maxDays) {
  const windows = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    const sliceEnd = new Date(cursor);
    sliceEnd.setUTCDate(sliceEnd.getUTCDate() + (maxDays - 1));
    const clamped = sliceEnd > end ? end : sliceEnd;
    windows.push([formatDate(cursor), formatDate(clamped)]);
    cursor = new Date(clamped);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}

function integerEnv(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function isoDate(value, _timestamp) {
  const str = stringOrNull(value);
  if (str) { const d = new Date(str); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  return new Date().toISOString();
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function array(value) { return Array.isArray(value) ? value : []; }
function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function stringOrNull(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function scalarOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}
function safeHttpUrl(value) {
  const str = stringOrNull(value);
  if (!str) return null;
  try { const u = new URL(str); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; }
  catch { return null; }
}
function backoffMs(attempt) { return Math.min(1_000 * 2 ** attempt, 15_000); }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function messageFor(error) { return error instanceof Error ? error.message : String(error); }
