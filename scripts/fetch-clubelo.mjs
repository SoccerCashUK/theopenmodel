#!/usr/bin/env node
// Refresh data/clubelo-latest.csv from api.clubelo.com (free, daily).
// ClubElo drops clubs whose rating period has lapsed (off-season gap between
// "To" and the next period) — so we merge in a fallback snapshot from a few
// weeks back to backfill anyone missing (e.g. Bayern vanished 2026-07-04).
import { writeFileSync, existsSync, readFileSync } from "node:fs";

const DEST = new URL("../data/clubelo-latest.csv", import.meta.url);
// ClubElo can answer in under a second or take several minutes on a bad afternoon, so
// the timeout is generous and overridable. Failure is non-fatal: a refresh that cannot
// reach ClubElo keeps the previous committed CSV and lets check-data-freshness.mjs be the
// single place that decides when a stale file is actually a problem (its 10-day gate).
const TIMEOUT_MS = Number(process.env.CLUBELO_TIMEOUT_MS ?? 120_000);

// ClubElo is a free single-maintainer service and goes unresponsive for stretches — it
// answered fine this morning and timed out entirely this afternoon. Without retries a
// single bad minute leaves the ratings unrefreshed for a day, which is how they silently
// fell a month behind in the first place.
async function snapshot(date, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000 * i));
    try {
      const res = await fetch(`http://api.clubelo.com/${date}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`clubelo ${date} → ${res.status}`);
      const csv = await res.text();
      if (!csv.startsWith("Rank,Club")) throw new Error(`unexpected payload for ${date}`);
      return csv.trim().split("\n");
    } catch (e) {
      lastError = e;
      console.warn(`  clubelo ${date}: attempt ${i + 1}/${attempts} failed (${e.message})`);
    }
  }
  throw lastError;
}

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const fallbackDate = new Date(today.getTime() - 21 * 86400_000);

try {
  const [current, fallback] = await Promise.all([snapshot(iso(today)), snapshot(iso(fallbackDate))]);
  const have = new Set(current.slice(1).map((l) => l.split(",")[1]));
  const added = [];
  for (const line of fallback.slice(1)) {
    const club = line.split(",")[1];
    if (!have.has(club)) { current.push(line); added.push(club); }
  }

  writeFileSync(DEST, current.join("\n") + "\n");
  console.log(
    `✓ clubelo snapshot ${iso(today)}: ${current.length - 1} clubs` +
    (added.length ? ` (+${added.length} backfilled: ${added.slice(0, 6).join(", ")}${added.length > 6 ? "…" : ""})` : ""),
  );
} catch (error) {
  // Non-fatal by design. Refusing to overwrite a good file with nothing is safer than
  // failing the build: the previous ratings stay in place and the freshness check will
  // flag them loudly once they cross its age threshold.
  const message = error?.message ?? String(error);
  if (existsSync(DEST)) {
    let age = "unknown age";
    try {
      const froms = readFileSync(DEST, "utf8").trim().split("\n").slice(1)
        .map((l) => l.split(",")[5]).filter(Boolean).sort();
      const newest = froms[froms.length - 1];
      if (newest) age = `${((Date.now() - new Date(newest).getTime()) / 86400_000).toFixed(1)}d old`;
    } catch { /* ignore */ }
    console.warn(`⚠ clubelo refresh failed (${message}); keeping existing data/clubelo-latest.csv (${age}). The freshness check will flag it if it goes stale.`);
    process.exit(0);
  }
  console.error(`✗ clubelo refresh failed (${message}) and no previous data/clubelo-latest.csv exists to fall back on.`);
  process.exit(1);
}
