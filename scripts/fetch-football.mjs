// Corre periodicamente (GitHub Actions) y guarda un snapshot estatico en data/football.json.
// Fixtures/tabla vienen de Big Balls Sports Data (BBS). Cuotas vienen de odds-api.io
// (misma cuenta que usamos para beisbol). El sitio nunca llama a ninguna de las dos
// APIs directamente: todo el trabajo se hace aca cada 2 horas.

const BBS_API_KEY = process.env.BBS_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
if (!BBS_API_KEY) {
  console.error("Falta la variable de entorno BBS_API_KEY");
  process.exit(1);
}

const BBS_BASE = "https://api.bigballsdata.com/v1";
const ODDS_BASE = "https://api.odds-api.io/v3";

// Ligas que mostramos, y su equivalente de liga en odds-api.io (si todavia no
// arranco la temporada esa liga no tiene eventos ahi, y se maneja como "sin cuotas").
const LEAGUES = {
  epl: { name: "Premier League", oddsLeague: "england-premier-league" },
  laliga: { name: "La Liga", oddsLeague: "spain-la-liga" },
  seriea: { name: "Serie A", oddsLeague: "italy-serie-a" },
  bundesliga: { name: "Bundesliga", oddsLeague: "germany-bundesliga" },
  ligue1: { name: "Ligue 1", oddsLeague: "france-ligue-1" },
  ucl: { name: "Champions League", oddsLeague: "international-clubs-uefa-champions-league" }
};
const BOOKMAKERS = "Bovada,Bet365";
const BOOKMAKER_ORDER = ["Bovada", "Bet365"];

async function getJSON(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function bbsGet(path) {
  return getJSON(`${BBS_BASE}${path}`, { Authorization: `Bearer ${BBS_API_KEY}` });
}

// Los dos proveedores no escriben los nombres de club igual ("Arsenal" vs "Arsenal FC").
// Normalizamos sacando sufijos comunes para poder cruzarlos.
function normalizeTeam(name) {
  return (name || "")
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|cd|ac)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// ---------- Cuotas (odds-api.io) ----------
async function fetchOddsForLeague(oddsLeagueSlug) {
  const oddsByMatch = {}; // key: normAway|normHome -> {moneyline, total}
  try {
    const events = await getJSON(
      `${ODDS_BASE}/events?apiKey=${ODDS_API_KEY}&sport=football&league=${oddsLeagueSlug}&status=pending&limit=40`
    );
    const cutoff = Date.now() + 5 * 24 * 60 * 60 * 1000; // solo los proximos 5 dias, para no gastar cuota en fixtures lejanos
    const soon = events.filter(ev => new Date(ev.date).getTime() <= cutoff);
    for (const ev of soon) {
      await sleep(300);
      try {
        const odds = await getJSON(`${ODDS_BASE}/odds?apiKey=${ODDS_API_KEY}&eventId=${ev.id}&bookmakers=${BOOKMAKERS}`);
        const parsed = extractFootballOdds(odds);
        const key = `${normalizeTeam(ev.away)}|${normalizeTeam(ev.home)}`;
        oddsByMatch[key] = parsed;
      } catch (e) {
        console.error(`  odds error evento ${ev.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error(`Odds no disponibles para ${oddsLeagueSlug}:`, e.message);
  }
  return oddsByMatch;
}

function extractFootballOdds(oddsResponse) {
  const result = { moneyline: {}, total: {} };
  const bookmakers = oddsResponse.bookmakers ?? {};
  const orderedNames = [...BOOKMAKER_ORDER, ...Object.keys(bookmakers).filter(b => !BOOKMAKER_ORDER.includes(b))];
  for (const bookmaker of orderedNames) {
    const markets = bookmakers[bookmaker];
    if (!markets) continue;
    for (const market of markets) {
      if (market.name === "ML" && market.odds[0]?.home != null) {
        const o = market.odds[0];
        result.moneyline[bookmaker] = { home: o.home, draw: o.draw ?? null, away: o.away };
      } else if (market.name === "Totals" && market.odds?.length) {
        // Bet365 suele mandar varias lineas alternativas; nos quedamos con la mas
        // cercana a 2.5 goles, que es la linea estandar de futbol.
        const closest = market.odds.reduce((best, o) =>
          Math.abs(o.hdp - 2.5) < Math.abs(best.hdp - 2.5) ? o : best
        );
        result.total[bookmaker] = { line: closest.hdp, over: closest.over ?? null, under: closest.under ?? null };
      }
    }
  }
  return result;
}

// ---------- Fixtures y tabla (BBS) ----------
async function fetchLeagueData(leagueKey) {
  const [matchesRes, standingsRes] = await Promise.all([
    bbsGet(`/matches?sport=football&league=${leagueKey}`).catch(() => ({ data: [] })),
    bbsGet(`/standings?sport=football&league=${leagueKey}`).catch(() => ({ data: null }))
  ]);
  return { matches: matchesRes.data ?? [], standings: standingsRes.data ?? null };
}

async function main() {
  const output = { updatedAt: new Date().toISOString(), leagues: {}, matches: {}, standings: {} };

  for (const [key, cfg] of Object.entries(LEAGUES)) {
    output.leagues[key] = cfg.name;
    console.log(`Trayendo ${cfg.name}...`);
    const { matches, standings } = await fetchLeagueData(key);
    output.standings[key] = standings;

    let oddsByMatch = {};
    if (ODDS_API_KEY && cfg.oddsLeague) {
      oddsByMatch = await fetchOddsForLeague(cfg.oddsLeague);
    }

    output.matches[key] = matches.map(m => {
      const oddsKey = `${normalizeTeam(m.away.name)}|${normalizeTeam(m.home.name)}`;
      const odds = oddsByMatch[oddsKey] ?? null;
      return {
        id: m.id,
        home: m.home.name, homeLogo: m.home.logo_url,
        away: m.away.name, awayLogo: m.away.logo_url,
        kickoff: m.kickoff_utc, status: m.status, score: m.score,
        odds
      };
    });
  }

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/football.json", JSON.stringify(output, null, 2));

  const totalMatches = Object.values(output.matches).reduce((a, arr) => a + arr.length, 0);
  const withOdds = Object.values(output.matches).reduce((a, arr) => a + arr.filter(m => m.odds).length, 0);
  console.log(`Listo: ${Object.keys(LEAGUES).length} ligas, ${totalMatches} partidos, ${withOdds} con cuotas.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
