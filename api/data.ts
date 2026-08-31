/**
 * FPL League Standings + Gameweek Summary — Vercel serverless function.
 * Fetches classic league standings and a per-gameweek recap (top scorers,
 * averages, closest rivals, captain analysis) from FPL's public API.
 * No login required. TypeScript port of the original scraper.py.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const LEAGUE_ID = 644333;
const STANDINGS_URL = `https://fantasy.premierleague.com/api/leagues-classic/${LEAGUE_ID}/standings/`;
const BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const liveUrl = (gw: number) => `https://fantasy.premierleague.com/api/event/${gw}/live/`;
const picksUrl = (entryId: number, gw: number) =>
  `https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`;
const transfersUrl = (entryId: number) => `https://fantasy.premierleague.com/api/entry/${entryId}/transfers/`;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; FPL-Leaderboard-Bot/1.0)",
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return (await res.json()) as T;
}

interface BootstrapEvent {
  id: number;
  is_current: boolean;
  is_next: boolean;
}
interface BootstrapElement {
  id: number;
  web_name: string;
}
interface Bootstrap {
  events: BootstrapEvent[];
  elements: BootstrapElement[];
}
interface StandingsEntry {
  rank: number;
  last_rank: number;
  entry_name: string;
  player_name: string;
  entry: number;
  event_total: number;
  total: number;
}
interface StandingsRaw {
  league: { name: string };
  standings: { results: StandingsEntry[] };
}
interface LiveElement {
  id: number;
  stats?: { total_points?: number };
}
interface LiveRaw {
  elements: LiveElement[];
}
interface Pick {
  element: number;
  is_captain: boolean;
  position: number;
}
interface PicksRaw {
  picks: Pick[];
}
interface TransferRaw {
  element_in: number;
  element_out: number;
  event: number;
}

interface Player {
  rank: number | null;
  last_rank: number | null;
  team_name: string | null;
  manager_name: string | null;
  team_id: number | null;
  gw_points: number | null;
  total_points: number | null;
}

interface TopScorer {
  team_name: string | null;
  manager_name: string | null;
  points: number | null;
}

interface DerbyData {
  team_a: string | null;
  team_b: string | null;
  score_a: number | null;
  score_b: number | null;
  diff: number;
}

interface CaptainInfo {
  team_name: string | null;
  manager_name: string | null;
  captain_id: number;
  captain_name: string;
  captain_points: number;
}

interface BenchTotal {
  team_name: string | null;
  manager_name: string | null;
  bench_points: number;
}

interface TransferMove {
  player_in: string;
  player_out: string;
}

interface ManagerTransfers {
  team_name: string | null;
  manager_name: string | null;
  moves: TransferMove[];
}

interface GwSummary {
  gw: number;
  top_scorers: TopScorer[];
  average_score: number;
  highest_score: number | null;
  lowest_score: number | null;
  derby: DerbyData | null;
  bench_king: BenchTotal | null;
  worst_captain: CaptainInfo | null;
  best_differential_captain: CaptainInfo | null;
  transfers: ManagerTransfers[];
  next_gw: number | null;
  upcoming_transfers: ManagerTransfers[];
}

function fetchCurrentGw(bootstrap: Bootstrap): number | null {
  for (const event of bootstrap.events ?? []) {
    if (event.is_current) return event.id;
    if (event.is_next) return (event.id ?? 1) - 1;
  }
  return null;
}

function fetchNextGw(bootstrap: Bootstrap): number | null {
  for (const event of bootstrap.events ?? []) {
    if (event.is_next) return event.id;
  }
  return null;
}

function buildPlayerNameMap(bootstrap: Bootstrap): Map<number, string> {
  const map = new Map<number, string>();
  for (const p of bootstrap.elements ?? []) {
    map.set(p.id, p.web_name ?? "Unknown");
  }
  return map;
}

async function buildLivePointsMap(gw: number | null): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!gw) return map;
  try {
    const live = await fetchJson<LiveRaw>(liveUrl(gw));
    for (const el of live.elements ?? []) {
      map.set(el.id, el.stats?.total_points ?? 0);
    }
  } catch (e) {
    console.error(`Could not fetch live points for GW${gw}:`, e);
  }
  return map;
}

async function buildGwSummary(
  players: Player[],
  gw: number | null,
  nextGw: number | null,
  playerNames: Map<number, string>,
  livePoints: Map<number, number>
): Promise<GwSummary | null> {
  if (!gw || players.length === 0) return null;

  const scored = players.filter((p) => p.gw_points !== null && p.total_points !== null);
  if (scored.length === 0) return null;

  const byGw = [...scored].sort((a, b) => (b.gw_points as number) - (a.gw_points as number));
  const topScorers: TopScorer[] = byGw.slice(0, 3).map((p) => ({
    team_name: p.team_name,
    manager_name: p.manager_name,
    points: p.gw_points,
  }));
  const averageScore =
    Math.round((scored.reduce((sum, p) => sum + (p.gw_points as number), 0) / scored.length) * 10) / 10;
  const highestScore = byGw[0].gw_points;
  const lowestScore = byGw[byGw.length - 1].gw_points;

  // Derby of the week: closest two teams by total points.
  const byTotal = [...scored].sort((a, b) => (a.total_points as number) - (b.total_points as number));
  let derby: [Player, Player] | null = null;
  let smallestGap: number | null = null;
  for (let i = 0; i < byTotal.length - 1; i++) {
    const gap = Math.abs((byTotal[i + 1].total_points as number) - (byTotal[i].total_points as number));
    if (smallestGap === null || gap < smallestGap) {
      smallestGap = gap;
      derby = [byTotal[i], byTotal[i + 1]];
    }
  }
  const derbyData: DerbyData | null = derby
    ? {
        team_a: derby[0].team_name,
        team_b: derby[1].team_name,
        score_a: derby[0].total_points,
        score_b: derby[1].total_points,
        diff: smallestGap as number,
      }
    : null;

  // Captain analysis: one API call per manager for this gameweek (run in parallel).
  const picksResults = await Promise.all(
    scored.map(async (p) => {
      if (!p.team_id) return null;
      try {
        const picksData = await fetchJson<PicksRaw>(picksUrl(p.team_id, gw));
        return { player: p, picks: picksData.picks ?? [] };
      } catch (e) {
        console.error(`Could not fetch picks for entry ${p.team_id}:`, e);
        return null;
      }
    })
  );

  const captainCounts = new Map<number, number>();
  const managerCaptainInfo: CaptainInfo[] = [];
  const benchTotals: BenchTotal[] = [];

  for (const result of picksResults) {
    if (!result) continue;
    const { player: p, picks } = result;

    const captainPick = picks.find((pk) => pk.is_captain);
    if (captainPick) {
      const capId = captainPick.element;
      const capPts = livePoints.get(capId) ?? 0;
      captainCounts.set(capId, (captainCounts.get(capId) ?? 0) + 1);
      managerCaptainInfo.push({
        team_name: p.team_name,
        manager_name: p.manager_name,
        captain_id: capId,
        captain_name: playerNames.get(capId) ?? "Unknown",
        captain_points: capPts,
      });
    }

    const benchPicks = picks.filter((pk) => (pk.position ?? 0) > 11);
    const benchPts = benchPicks.reduce((sum, pk) => sum + (livePoints.get(pk.element) ?? 0), 0);
    benchTotals.push({ team_name: p.team_name, manager_name: p.manager_name, bench_points: benchPts });
  }

  const benchKing =
    benchTotals.length > 0
      ? benchTotals.reduce((max, b) => (b.bench_points > max.bench_points ? b : max))
      : null;

  let worstCaptain: CaptainInfo | null = null;
  let bestDifferential: CaptainInfo | null = null;
  if (managerCaptainInfo.length > 0) {
    worstCaptain = managerCaptainInfo.reduce((min, c) => (c.captain_points < min.captain_points ? c : min));
    const differentials = managerCaptainInfo.filter((c) => captainCounts.get(c.captain_id) === 1);
    if (differentials.length > 0) {
      bestDifferential = differentials.reduce((max, c) => (c.captain_points > max.captain_points ? c : max));
    }
  }

  // Transfers made this gameweek, and any already banked for the next deadline:
  // one API call per manager (run in parallel), split by event afterwards.
  const toMoves = (rows: TransferRaw[]): TransferMove[] =>
    rows.map((t) => ({
      player_in: playerNames.get(t.element_in) ?? "Unknown",
      player_out: playerNames.get(t.element_out) ?? "Unknown",
    }));

  const transfersResults = await Promise.all(
    scored.map(async (p) => {
      if (!p.team_id) return null;
      try {
        const allTransfers = await fetchJson<TransferRaw[]>(transfersUrl(p.team_id));
        return { player: p, allTransfers };
      } catch (e) {
        console.error(`Could not fetch transfers for entry ${p.team_id}:`, e);
        return null;
      }
    })
  );

  const transfers: ManagerTransfers[] = [];
  const upcomingTransfers: ManagerTransfers[] = [];
  for (const result of transfersResults) {
    if (!result) continue;
    const { player: p, allTransfers } = result;

    const thisGw = allTransfers.filter((t) => t.event === gw);
    if (thisGw.length > 0) {
      transfers.push({ team_name: p.team_name, manager_name: p.manager_name, moves: toMoves(thisGw) });
    }

    if (nextGw) {
      const forNextGw = allTransfers.filter((t) => t.event === nextGw);
      if (forNextGw.length > 0) {
        upcomingTransfers.push({ team_name: p.team_name, manager_name: p.manager_name, moves: toMoves(forNextGw) });
      }
    }
  }

  return {
    gw,
    top_scorers: topScorers,
    average_score: averageScore,
    highest_score: highestScore,
    lowest_score: lowestScore,
    derby: derbyData,
    bench_king: benchKing,
    worst_captain: worstCaptain,
    best_differential_captain: bestDifferential,
    transfers,
    next_gw: nextGw,
    upcoming_transfers: upcomingTransfers,
  };
}

async function fetchStandings() {
  const [standingsRaw, bootstrap] = await Promise.all([
    fetchJson<StandingsRaw>(STANDINGS_URL),
    fetchJson<Bootstrap>(BOOTSTRAP_URL),
  ]);

  const currentGw = fetchCurrentGw(bootstrap);
  const nextGw = fetchNextGw(bootstrap);
  const playerNames = buildPlayerNameMap(bootstrap);
  const livePoints = await buildLivePointsMap(currentGw);

  const leagueName = standingsRaw.league?.name ?? "FPL League";
  const results = standingsRaw.standings?.results ?? [];

  const players: Player[] = results.map((entry) => ({
    rank: entry.rank,
    last_rank: entry.last_rank,
    team_name: entry.entry_name,
    manager_name: entry.player_name,
    team_id: entry.entry,
    gw_points: entry.event_total,
    total_points: entry.total,
  }));

  players.sort((a, b) => (b.total_points ?? 0) - (a.total_points ?? 0));

  const gwSummary = await buildGwSummary(players, currentGw, nextGw, playerNames, livePoints);

  return {
    league_id: LEAGUE_ID,
    league_name: leagueName,
    current_gw: currentGw,
    last_updated: new Date().toISOString(),
    players,
    gw_summary: gwSummary,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const data = await fetchStandings();
    // CDN-cache the response so bursts of visitors don't each trigger a fresh
    // round of FPL API calls (this replaces the old 5-minute cron + committed data.json).
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=180");
    res.status(200).json(data);
  } catch (e) {
    console.error("Failed to build leaderboard data:", e);
    res.status(502).json({ error: "Failed to fetch FPL data" });
  }
}
