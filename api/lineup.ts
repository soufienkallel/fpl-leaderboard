/**
 * Manager lineup for a gameweek — Vercel serverless function.
 * Fetches one manager's picks for a gameweek and enriches them with player
 * photos, positions, and this gameweek's fixture (opponent + home/away),
 * for rendering a pitch-view lineup.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const picksUrl = (entryId: number, gw: number) =>
  `https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`;
const BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const fixturesUrl = (gw: number) => `https://fantasy.premierleague.com/api/fixtures/?event=${gw}`;
const liveUrl = (gw: number) => `https://fantasy.premierleague.com/api/event/${gw}/live/`;
const photoUrl = (code: number) => `https://resources.premierleague.com/premierleague/photos/players/110x140/p${code}.png`;

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

interface BootstrapEvent {
  id: number;
  is_current: boolean;
  is_next: boolean;
}
interface BootstrapElement {
  id: number;
  code: number;
  web_name: string;
  element_type: number;
  team: number;
}
interface BootstrapTeam {
  id: number;
  short_name: string;
}
interface Bootstrap {
  events: BootstrapEvent[];
  elements: BootstrapElement[];
  teams: BootstrapTeam[];
}
interface Fixture {
  team_h: number;
  team_a: number;
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
  position: number;
  is_captain: boolean;
  is_vice_captain: boolean;
}
interface PicksRaw {
  picks: Pick[];
}

function fetchCurrentGw(bootstrap: Bootstrap): number | null {
  for (const event of bootstrap.events ?? []) {
    if (event.is_current) return event.id;
    if (event.is_next) return (event.id ?? 1) - 1;
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const idParam = req.query.id;
  const entryId = Number(Array.isArray(idParam) ? idParam[0] : idParam);
  if (!entryId || !Number.isInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: "Missing or invalid id" });
    return;
  }

  try {
    const bootstrap = await fetchJson<Bootstrap>(BOOTSTRAP_URL);

    const gwParam = req.query.gw;
    const gw = gwParam ? Number(Array.isArray(gwParam) ? gwParam[0] : gwParam) : fetchCurrentGw(bootstrap);
    if (!gw) {
      res.status(404).json({ error: "No current gameweek found" });
      return;
    }

    const [picksData, fixtures, live] = await Promise.all([
      fetchJson<PicksRaw>(picksUrl(entryId, gw)),
      fetchJson<Fixture[]>(fixturesUrl(gw)).catch(() => [] as Fixture[]),
      fetchJson<LiveRaw>(liveUrl(gw)).catch(() => ({ elements: [] }) as LiveRaw),
    ]);

    const elementsById = new Map(bootstrap.elements.map((e) => [e.id, e]));
    const teamsById = new Map(bootstrap.teams.map((t) => [t.id, t]));
    const livePointsById = new Map(live.elements.map((e) => [e.id, e.stats?.total_points ?? 0]));

    const opponentByTeam = new Map<number, { opponent: string; is_home: boolean }>();
    for (const f of fixtures) {
      const homeTeam = teamsById.get(f.team_h);
      const awayTeam = teamsById.get(f.team_a);
      if (homeTeam && awayTeam) {
        if (!opponentByTeam.has(f.team_h)) {
          opponentByTeam.set(f.team_h, { opponent: awayTeam.short_name, is_home: true });
        }
        if (!opponentByTeam.has(f.team_a)) {
          opponentByTeam.set(f.team_a, { opponent: homeTeam.short_name, is_home: false });
        }
      }
    }

    const players = (picksData.picks ?? []).map((pk) => {
      const el = elementsById.get(pk.element);
      const opp = el ? opponentByTeam.get(el.team) : undefined;
      return {
        element_id: pk.element,
        name: el?.web_name ?? "Unknown",
        position_type: el?.element_type ?? 0,
        photo_url: el ? photoUrl(el.code) : null,
        is_captain: pk.is_captain,
        is_vice_captain: pk.is_vice_captain,
        on_bench: pk.position > 11,
        bench_order: pk.position > 11 ? pk.position : null,
        opponent: opp?.opponent ?? null,
        is_home: opp?.is_home ?? null,
        live_points: livePointsById.get(pk.element) ?? 0,
      };
    });

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=180");
    res.status(200).json({ gw, players });
  } catch (e) {
    console.error(`Failed to fetch lineup for entry ${entryId}:`, e);
    res.status(502).json({ error: "Failed to fetch lineup" });
  }
}
