// Corre periodicamente (GitHub Actions) y guarda un snapshot estatico en data/odds.json.
// El sitio nunca llama a odds-api.io ni hace esta cantidad de llamadas a la MLB Stats API
// desde el navegador: todo el trabajo pesado (cuotas + proyeccion estadistica por jugador)
// se hace aca, una vez cada 2 horas, y el sitio solo lee el resultado ya calculado.

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error("Falta la variable de entorno ODDS_API_KEY");
  process.exit(1);
}

const BOOKMAKERS = "Bet365,DraftKings";
const ODDS_BASE = "https://api.odds-api.io/v3";
const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const SEASON = new Date().getFullYear();

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Cuotas de partido completo (nombres exactos confirmados contra la API real) ----------
function extractGameOdds(oddsResponse) {
  const result = { moneyline: {}, total: {} };
  for (const [bookmaker, markets] of Object.entries(oddsResponse.bookmakers ?? {})) {
    for (const market of markets) {
      const o = market.odds[0];
      if (!o) continue;
      if (market.name === "ML" && o.home != null && o.away != null) {
        result.moneyline[bookmaker] = { home: o.home, away: o.away };
      } else if (market.name === "Totals" && o.hdp != null) {
        result.total[bookmaker] = { line: o.hdp, over: o.over ?? null, under: o.under ?? null };
      }
    }
  }
  return result;
}

// ---------- Props de jugador ----------
const PROP_MARKETS = {
  "Hits O/U": { kind: "hitting" },
  "Home Runs O/U": { kind: "hitting" },
  "Total Bases O/U": { kind: "hitting" },
  "Pitcher Strikeouts O/U": { kind: "pitching" }
};

function extractProps(oddsResponse) {
  // player -> market -> { line, over, under, bookmaker }
  const props = [];
  const preferredOrder = ["Bet365", "DraftKings"];
  const seen = new Set();
  for (const bookmaker of preferredOrder) {
    const markets = oddsResponse.bookmakers?.[bookmaker];
    if (!markets) continue;
    for (const market of markets) {
      const cfg = PROP_MARKETS[market.name];
      if (!cfg) continue;
      for (const o of market.odds) {
        if (!o.label || o.hdp == null) continue;
        const dedupeKey = `${market.name}|${o.label}`;
        if (seen.has(dedupeKey)) continue; // ya lo tenemos de un libro con mas prioridad
        seen.add(dedupeKey);
        props.push({
          market: market.name,
          kind: cfg.kind,
          player: o.label,
          line: o.hdp,
          over: o.over ?? null,
          under: o.under ?? null,
          bookmaker
        });
      }
    }
  }
  return props;
}

// ---------- Poisson, para estimar probabilidad de superar una linea ----------
function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}
function poissonPMF(k, lambda) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}
function poissonProbOver(line, lambda) {
  // P(X > line), line suele ser X.5
  const k = Math.floor(line);
  let cdf = 0;
  for (let i = 0; i <= k; i++) cdf += poissonPMF(i, lambda);
  return Math.max(0, Math.min(1, 1 - cdf));
}
function binomialProbAtLeastOneHit(avg, atBatsPerGame) {
  const p0 = Math.pow(1 - avg, atBatsPerGame);
  return Math.max(0, Math.min(1, 1 - p0));
}
function decimalToImpliedProb(decimalOdds) {
  const d = parseFloat(decimalOdds);
  return d > 0 ? 1 / d : null;
}

// ---------- Busqueda y stats de jugador (cacheado por nombre dentro de esta corrida) ----------
const playerCache = new Map();

async function getPlayerProjection(name) {
  if (playerCache.has(name)) return playerCache.get(name);
  const projection = await fetchPlayerProjection(name);
  playerCache.set(name, projection);
  return projection;
}

async function fetchPlayerProjection(name) {
  try {
    const search = await getJSON(`${MLB_BASE}/people/search?names=${encodeURIComponent(name)}`);
    const person = (search.people ?? []).find(p => p.active) ?? search.people?.[0];
    if (!person) return null;
    const isPitcher = person.primaryPosition?.code === "1";
    const group = isPitcher ? "pitching" : "hitting";
    const statsData = await getJSON(
      `${MLB_BASE}/people/${person.id}/stats?stats=season&group=${group}&season=${SEASON}`
    );
    const split = statsData.stats?.[0]?.splits?.[0];
    const stat = split?.stat;
    if (!stat) return null;
    // /people/search no trae el equipo actual; el split de stats de temporada si.
    const team = split?.team?.name ?? null;

    if (isPitcher) {
      const starts = stat.gamesStarted || stat.gamesPlayed || 0;
      if (!starts) return null;
      return { isPitcher: true, team, kPerStart: stat.strikeOuts / starts, tbPerGame: null, hrPerGame: null, avg: null, abPerGame: null };
    }
    const gamesPlayed = stat.gamesPlayed || 0;
    if (!gamesPlayed) return null;
    return {
      isPitcher: false,
      team,
      avg: parseFloat(stat.avg) || 0,
      abPerGame: (stat.atBats || 0) / gamesPlayed,
      hrPerGame: (stat.homeRuns || 0) / gamesPlayed,
      tbPerGame: (stat.totalBases || 0) / gamesPlayed
    };
  } catch {
    return null;
  }
}

function pickSide(overOdds, underOdds, ourProbOver) {
  // Elegimos el lado (over/under) que tenga cuota disponible y mejor separacion vs nuestra probabilidad.
  const impliedOver = overOdds != null ? decimalToImpliedProb(overOdds) : null;
  const impliedUnder = underOdds != null ? decimalToImpliedProb(underOdds) : null;
  const edgeOver = impliedOver != null ? ourProbOver - impliedOver : -Infinity;
  const edgeUnder = impliedUnder != null ? (1 - ourProbOver) - impliedUnder : -Infinity;
  if (edgeOver >= edgeUnder) {
    return { side: "over", odds: overOdds, ourProb: ourProbOver, impliedProb: impliedOver, edge: edgeOver };
  }
  return { side: "under", odds: underOdds, ourProb: 1 - ourProbOver, impliedProb: impliedUnder, edge: edgeUnder };
}

async function evaluateProp(prop, awayTeam, homeTeam) {
  const proj = await getPlayerProjection(prop.player);
  if (!proj) return null;
  // odds-api.io a veces mezcla props de jugadores que no juegan este partido
  // (visto en vivo: un prop de Home Runs de un jugador de otro equipo colado
  // en el mercado de un partido distinto). Si no coincide con ninguno de los
  // dos equipos, lo descartamos aunque tengamos datos del jugador.
  if (proj.team && proj.team !== awayTeam && proj.team !== homeTeam) return null;

  let ourProbOver = null;
  if (prop.market === "Pitcher Strikeouts O/U" && proj.isPitcher && proj.kPerStart) {
    ourProbOver = poissonProbOver(prop.line, proj.kPerStart);
  } else if (prop.market === "Hits O/U" && !proj.isPitcher && proj.avg != null) {
    // Hits O/U casi siempre es linea 0.5 (al menos 1 hit)
    ourProbOver = prop.line < 1
      ? binomialProbAtLeastOneHit(proj.avg, proj.abPerGame || 4)
      : poissonProbOver(prop.line, proj.avg * (proj.abPerGame || 4));
  } else if (prop.market === "Home Runs O/U" && !proj.isPitcher && proj.hrPerGame != null) {
    ourProbOver = poissonProbOver(prop.line, proj.hrPerGame);
  } else if (prop.market === "Total Bases O/U" && !proj.isPitcher && proj.tbPerGame != null) {
    ourProbOver = poissonProbOver(prop.line, proj.tbPerGame);
  }
  if (ourProbOver == null || isNaN(ourProbOver)) return null;

  const pick = pickSide(prop.over, prop.under, ourProbOver);
  if (pick.odds == null || pick.impliedProb == null) return null;

  return {
    ...prop,
    side: pick.side,
    odds: pick.odds,
    ourProb: Math.round(pick.ourProb * 1000) / 1000,
    impliedProb: Math.round(pick.impliedProb * 1000) / 1000,
    edge: Math.round(pick.edge * 1000) / 1000,
    isValue: pick.edge >= 0.08
  };
}

// ---------- Parlays recomendados ----------
const BATTING_MARKETS = new Set(["Hits O/U", "Home Runs O/U", "Total Bases O/U"]);
const REUSE_EDGE_THRESHOLD = 0.20; // pick muy fuerte: se deja repetir en mas de un parlay igual

function buildParlays(allEvaluatedProps) {
  const valuePicks = allEvaluatedProps
    .filter(p => p.isValue)
    .sort((a, b) => b.edge - a.edge);
  const battingPicks = valuePicks.filter(p => BATTING_MARKETS.has(p.market));
  const pitchingPicks = valuePicks.filter(p => p.market === "Pitcher Strikeouts O/U");

  function toParlay(legs, label, category) {
    if (legs.length < 2) return null;
    const combinedOdds = legs.reduce((acc, l) => acc * parseFloat(l.odds), 1);
    const combinedProb = legs.reduce((acc, l) => acc * l.ourProb, 1);
    return {
      label,
      category,
      legs: legs.map(l => ({
        player: l.player, market: l.market, side: l.side, line: l.line,
        odds: l.odds, ourProb: l.ourProb, game: l.game
      })),
      combinedOdds: Math.round(combinedOdds * 100) / 100,
      combinedProb: Math.round(combinedProb * 1000) / 1000
    };
  }

  // globalUsed se comparte entre todos los parlays que armamos en esta corrida, para no
  // repetir siempre los mismos 2-3 jugadores de mayor edge en todas las combinaciones.
  // Si un pick es muy fuerte (edge alto) lo dejamos repetir igual, total nunca esta de mas
  // avisar de un pick asi.
  const globalUsed = new Set();
  function pickLegs(pool, count) {
    const legs = [];
    const localUsed = new Set();
    for (const p of pool) {
      if (legs.length >= count) break;
      if (localUsed.has(p.player)) continue;
      if (globalUsed.has(p.player) && p.edge < REUSE_EDGE_THRESHOLD) continue;
      legs.push(p);
      localUsed.add(p.player);
    }
    if (legs.length < count) {
      for (const p of pool) {
        if (legs.length >= count) break;
        if (localUsed.has(p.player)) continue;
        legs.push(p);
        localUsed.add(p.player);
      }
    }
    legs.forEach(p => globalUsed.add(p.player));
    return legs;
  }

  const parlays = [];
  function add(pool, count, label, category) {
    const parlay = toParlay(pickLegs(pool, count), label, category);
    if (parlay) parlays.push(parlay);
  }

  add(battingPicks, 2, "Solo bateo (2 picks)", "bateo");
  add(battingPicks, 3, "Solo bateo (3 picks)", "bateo");
  add(pitchingPicks, 2, "Solo pitcheo (2 picks)", "pitcheo");
  add(valuePicks, 3, "Mixto (3 picks)", "mixto");
  add(valuePicks, 4, "Mixto (4 picks)", "mixto");
  add(valuePicks, 5, "Alto pago (5 picks)", "mixto");

  return parlays;
}

async function main() {
  let allEvents;
  try {
    allEvents = await getJSON(
      `${ODDS_BASE}/events?apiKey=${API_KEY}&sport=baseball&league=usa-mlb&status=pending&limit=60`
    );
  } catch (e) {
    if (String(e.message).includes("429")) {
      console.log("Cuota horaria agotada, se reintenta en la proxima corrida programada. Sin cambios.");
      return;
    }
    throw e;
  }

  const cutoff = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const events = allEvents.filter(ev => new Date(ev.date).getTime() <= cutoff);

  const games = {};
  const allEvaluatedProps = [];
  let withOdds = 0;

  for (const ev of events) {
    try {
      await sleep(300);
      const odds = await getJSON(`${ODDS_BASE}/odds?apiKey=${API_KEY}&eventId=${ev.id}&bookmakers=${BOOKMAKERS}`);
      const gameOdds = extractGameOdds(odds);
      const rawProps = extractProps(odds);

      const evaluatedProps = [];
      for (const prop of rawProps) {
        const evaluated = await evaluateProp(prop, ev.away, ev.home);
        if (evaluated) {
          evaluatedProps.push(evaluated);
          allEvaluatedProps.push({ ...evaluated, game: `${ev.away} @ ${ev.home}` });
        }
      }

      const hasData = Object.keys(gameOdds.moneyline).length || Object.keys(gameOdds.total).length;
      if (hasData) withOdds++;

      games[`${ev.away}@${ev.home}@${ev.date.slice(0, 10)}`] = {
        home: ev.home,
        away: ev.away,
        date: ev.date,
        ...gameOdds,
        props: evaluatedProps
      };
    } catch (e) {
      console.error(`Error en evento ${ev.id}:`, e.message);
    }
  }

  const parlays = buildParlays(allEvaluatedProps);

  const output = {
    updatedAt: new Date().toISOString(),
    games,
    parlays
  };

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/odds.json", JSON.stringify(output, null, 2));
  console.log(
    `Listo: ${Object.keys(games).length} partidos, ${withOdds} con moneyline/total, ` +
    `${allEvaluatedProps.length} props evaluadas, ${allEvaluatedProps.filter(p => p.isValue).length} value picks, ${parlays.length} parlays.`
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
