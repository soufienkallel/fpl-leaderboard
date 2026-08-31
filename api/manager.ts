/**
 * Per-manager profile — Vercel serverless function.
 * Fetches a single FPL manager's season history (gameweek-by-gameweek points,
 * rank, bench points) and past-season summaries from FPL's public API.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const entryUrl = (id: number) => `https://fantasy.premierleague.com/api/entry/${id}/`;
const historyUrl = (id: number) => `https://fantasy.premierleague.com/api/entry/${id}/history/`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://fantasy.premierleague.com/",
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return (await res.json()) as T;
}

interface EntryInfo {
  name: string;
  player_first_name: string;
  player_last_name: string;
  summary_overall_points: number;
  summary_overall_rank: number;
  years_active: number;
}

interface HistoryEvent {
  event: number;
  points: number;
  total_points: number;
  overall_rank: number;
  points_on_bench: number;
  event_transfers: number;
  event_transfers_cost: number;
}

interface PastSeason {
  season_name: string;
  total_points: number;
  rank: number;
}

interface Chip {
  name: string;
  event: number;
}

interface HistoryRaw {
  current: HistoryEvent[];
  past: PastSeason[];
  chips: Chip[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const idParam = req.query.id;
  const entryId = Number(Array.isArray(idParam) ? idParam[0] : idParam);

  if (!entryId || !Number.isInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: "Missing or invalid id" });
    return;
  }

  try {
    const [entry, history] = await Promise.all([
      fetchJson<EntryInfo>(entryUrl(entryId)),
      fetchJson<HistoryRaw>(historyUrl(entryId)),
    ]);

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({
      team_name: entry.name,
      manager_name: `${entry.player_first_name} ${entry.player_last_name}`,
      overall_points: entry.summary_overall_points,
      overall_rank: entry.summary_overall_rank,
      years_active: entry.years_active,
      season_history: (history.current ?? []).map((e) => ({
        event: e.event,
        points: e.points,
        total_points: e.total_points,
        overall_rank: e.overall_rank,
        points_on_bench: e.points_on_bench,
        transfers: e.event_transfers,
        transfer_cost: e.event_transfers_cost,
      })),
      past_seasons: (history.past ?? []).map((p) => ({
        season_name: p.season_name,
        total_points: p.total_points,
        rank: p.rank,
      })),
      chips: (history.chips ?? []).map((c) => ({ name: c.name, event: c.event })),
    });
  } catch (e) {
    console.error(`Failed to fetch manager history for ${entryId}:`, e);
    res.status(502).json({ error: "Failed to fetch manager data" });
  }
}
