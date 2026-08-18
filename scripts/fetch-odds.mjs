// Corre periodicamente (GitHub Actions) y guarda un snapshot estatico en data/odds.json.
// El sitio nunca llama a odds-api.io ni hace esta cantidad de llamadas a la MLB Stats API
// desde el navegador: todo el trabajo pesado (cuotas + proyeccion estadistica por jugador)
// se hace aca, una vez cada 2 horas, y el sitio solo lee el resultado ya calculado.

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error("Falta la variable de entorno ODDS_API_KEY");
  process.exit(1);
}

const BOOKMAKERS = "Bovada,Bet365";
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
const BOOKMAKER_ORDER = ["Bovada", "Bet365"];

function extractGameOdds(oddsResponse) {
  const result = { moneyline: {}, total: {}, spread: {} };
  const bookmakers = oddsResponse.bookmakers ?? {};
  const orderedNames = [...BOOKMAKER_ORDER, ...Object.keys(bookmakers).filter(b => !BOOKMAKER_ORDER.includes(b))];
  for (const bookmaker of orderedNames) {
    const markets = bookmakers[bookmaker];
    if (!markets) continue;
    for (const market of markets) {
      const o = market.odds[0];
      if (!o) continue;
      if (market.name === "ML" && o.home != null && o.away != null) {
        result.moneyline[bookmaker] = { home: o.home, away: o.away };
      } else if (market.name === "Totals" && o.hdp != null) {
        result.total[bookmaker] = { line: o.hdp, over: o.over ?? null, under: o.under ?? null };
      } else if (market.name === "Spread" && o.hdp != null && o.home != null && o.away != null) {
        // hdp es la linea del local (ej -1.5); el visitante corre +1.5
        result.spread[bookmaker] = { homeLine: o.hdp, homeOdds: o.home, awayOdds: o.away };
      }
    }
  }
  return result;
}

// ---------- Probabilidad de victoria propia (Log5) para comparar contra el moneyline real ----------
async function fetchStandingsMap() {
  // El endpoint de standings devuelve nombres cortos ("Dodgers"), pero el resto
  // del pipeline (odds-api.io, schedule, etc.) usa nombres completos ("Los Angeles
  // Dodgers"). Cruzamos por team.id, que es consistente en toda la API de MLB.
  const [standingsData, teamsData] = await Promise.all([
    getJSON(`${MLB_BASE}/standings?leagueId=103,104&season=${SEASON}&standingsTypes=regularSeason`),
    getJSON(`${MLB_BASE}/teams?sportId=1`)
  ]);
  const byId = {};
  for (const division of standingsData.records ?? []) {
    for (const r of division.teamRecords ?? []) {
      const last10 = r.records?.splitRecords?.find(s => s.type === "lastTen");
      const streakNum = r.streak?.streakNumber ?? 0;
      byId[r.team.id] = {
        pct: parseFloat(r.leagueRecord.pct) || 0.5,
        streakSigned: r.streak?.streakType === "wins" ? streakNum : -streakNum,
        last10Diff: last10 ? last10.wins - last10.losses : 0
      };
    }
  }
  const map = {};
  for (const t of teamsData.teams ?? []) {
    if (byId[t.id]) map[t.name] = byId[t.id];
  }
  return map;
}

// Metodo Log5 (Bill James): probabilidad de que el equipo A le gane a B a partir
// de sus porcentajes de victoria en la temporada, mas un ajuste chico por racha y localia.
function estimateWinProb(teamName, oppName, standingsMap, isHome) {
  const t = standingsMap[teamName];
  const o = standingsMap[oppName];
  if (!t || !o) return null;
  const pa = Math.min(0.9, Math.max(0.1, t.pct));
  const pb = Math.min(0.9, Math.max(0.1, o.pct));
  let p = (pa - pa * pb) / (pa + pb - 2 * pa * pb);
  const streakAdj = (t.streakSigned - o.streakSigned) * 0.01 + (t.last10Diff - o.last10Diff) * 0.008;
  p += streakAdj + (isHome ? 0.02 : -0.02);
  return Math.max(0.05, Math.min(0.95, p));
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
  const preferredOrder = ["Bovada", "Bet365"];
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
      return { isPitcher: true, id: person.id, team, kPerStart: stat.strikeOuts / starts, tbPerGame: null, hrPerGame: null, avg: null, abPerGame: null };
    }
    const gamesPlayed = stat.gamesPlayed || 0;
    if (!gamesPlayed) return null;
    return {
      isPitcher: false,
      id: person.id,
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

// ---------- Historial bateador vs abridor rival (carrera completa) ----------
const matchupCache = new Map();
async function getMatchup(batterId, pitcherId) {
  const key = `${batterId}-${pitcherId}`;
  if (matchupCache.has(key)) return matchupCache.get(key);
  const result = await fetchMatchup(batterId, pitcherId);
  matchupCache.set(key, result);
  return result;
}
async function fetchMatchup(batterId, pitcherId) {
  try {
    const data = await getJSON(
      `${MLB_BASE}/people/${batterId}/stats?stats=vsPlayerTotal&opposingPlayerId=${pitcherId}&group=hitting`
    );
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stat || !stat.atBats) return null;
    return {
      ab: stat.atBats, hits: stat.hits, hr: stat.homeRuns, so: stat.strikeOuts,
      bb: stat.baseOnBalls, avg: stat.avg, ops: stat.ops
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
    playerId: proj.id,
    side: pick.side,
    odds: pick.odds,
    ourProb: Math.round(pick.ourProb * 1000) / 1000,
    impliedProb: Math.round(pick.impliedProb * 1000) / 1000,
    edge: Math.round(pick.edge * 1000) / 1000,
    isValue: pick.edge >= 0.08
  };
}

// ---------- Moneyline de valor, evaluado SOLO contra la cuota de Bovada ----------
// (para que un pick recomendado siempre sea jugable en la casa que el usuario realmente usa)
function evaluateMoneylineLegs(ev, gameOdds, standingsMap) {
  const ml = gameOdds.moneyline?.Bovada;
  if (!ml) return [];
  const awayProb = estimateWinProb(ev.away, ev.home, standingsMap, false);
  if (awayProb == null) return [];
  const homeProb = 1 - awayProb;

  const legs = [];
  const awayImplied = decimalToImpliedProb(ml.away);
  const homeImplied = decimalToImpliedProb(ml.home);
  if (awayImplied != null) {
    const edge = Math.round((awayProb - awayImplied) * 1000) / 1000;
    legs.push({
      market: "Moneyline", kind: "moneyline", player: ev.away, line: null, side: "gana",
      odds: ml.away, bookmaker: "Bovada",
      ourProb: Math.round(awayProb * 1000) / 1000, impliedProb: Math.round(awayImplied * 1000) / 1000,
      edge, isValue: edge >= 0.06
    });
  }
  if (homeImplied != null) {
    const edge = Math.round((homeProb - homeImplied) * 1000) / 1000;
    legs.push({
      market: "Moneyline", kind: "moneyline", player: ev.home, line: null, side: "gana",
      odds: ml.home, bookmaker: "Bovada",
      ourProb: Math.round(homeProb * 1000) / 1000, impliedProb: Math.round(homeImplied * 1000) / 1000,
      edge, isValue: edge >= 0.06
    });
  }
  return legs;
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
  const moneylinePicks = valuePicks.filter(p => p.market === "Moneyline");

  function toParlay(legs, label, category) {
    if (legs.length < 2) return null;
    const combinedOdds = legs.reduce((acc, l) => acc * parseFloat(l.odds), 1);
    const combinedProb = legs.reduce((acc, l) => acc * l.ourProb, 1);
    // Los props (bateo/pitcheo) solo existen en Bet365; el moneyline lo evaluamos
    // exclusivamente contra Bovada, asi que un parlay siempre es 100% de una sola casa.
    const bookmaker = category === "moneyline" ? "Bovada" : "Bet365";
    return {
      label,
      category,
      bookmaker,
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

  add(moneylinePicks, 2, "Moneyline (2 picks)", "moneyline");
  add(moneylinePicks, 3, "Moneyline (3 picks)", "moneyline");
  add(battingPicks, 2, "Solo bateo (2 picks)", "bateo");
  add(battingPicks, 3, "Solo bateo (3 picks)", "bateo");
  add(pitchingPicks, 2, "Solo pitcheo (2 picks)", "pitcheo");
  add(valuePicks.filter(p => p.market !== "Moneyline"), 3, "Mixto (3 picks)", "mixto");
  add(valuePicks.filter(p => p.market !== "Moneyline"), 4, "Mixto (4 picks)", "mixto");

  return parlays;
}

// ---------- Registro y calificacion de picks (aciertos/fallos historicos) ----------
const HISTORY_PATH = "data/history.json";

async function loadHistory() {
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(HISTORY_PATH, "utf8");
    const data = JSON.parse(raw);
    return { pending: data.pending ?? [], graded: data.graded ?? [] };
  } catch {
    return { pending: [], graded: [] };
  }
}

async function saveHistory(history) {
  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
}

const scheduleByDateCache = new Map();
async function getGamePk(homeTeam, dateISO) {
  if (!scheduleByDateCache.has(dateISO)) {
    try {
      const data = await getJSON(`${MLB_BASE}/schedule?sportId=1&date=${dateISO}`);
      const map = {};
      (data.dates?.[0]?.games ?? []).forEach(g => { map[g.teams.home.team.name] = g.gamePk; });
      scheduleByDateCache.set(dateISO, map);
    } catch {
      scheduleByDateCache.set(dateISO, {});
    }
  }
  return scheduleByDateCache.get(dateISO)[homeTeam] ?? null;
}

function pickHistoryId(pick) {
  return `${pick.date}|${pick.gamePk}|${pick.market}|${pick.player}|${pick.line ?? ""}|${pick.side}`;
}

// Guarda cada value pick recomendado hoy (si todavia no estaba registrado) como "pendiente".
async function recordPicks(games, history) {
  const known = new Set([...history.pending, ...history.graded].map(pickHistoryId));
  for (const [key, game] of Object.entries(games)) {
    const dateISO = game.date.slice(0, 10);
    const gamePk = await getGamePk(game.home, dateISO);
    if (!gamePk) continue;
    const candidates = [...(game.props ?? []), ...(game.moneylinePicks ?? [])].filter(p => p.isValue);
    for (const p of candidates) {
      const record = {
        date: dateISO, gamePk, game: `${game.away} @ ${game.home}`,
        market: p.market, player: p.player, playerId: p.playerId ?? null,
        line: p.line ?? null, side: p.side, odds: p.odds, bookmaker: p.bookmaker,
        ourProb: p.ourProb, edge: p.edge
      };
      const id = pickHistoryId(record);
      if (known.has(id)) continue;
      known.add(id);
      history.pending.push({ id, ...record, recordedAt: new Date().toISOString() });
    }
  }
}

function gradeMoneyline(pick, game) {
  const homeScore = game.teams.home.score, awayScore = game.teams.away.score;
  if (homeScore == null || awayScore == null || homeScore === awayScore) return null;
  const homeWon = homeScore > awayScore;
  const pickedHome = pick.player === game.teams.home.team.name;
  const won = pickedHome ? homeWon : !homeWon;
  return {
    result: won ? "win" : "loss",
    actual: `${game.teams.away.team.name} ${awayScore} - ${game.teams.home.team.name} ${homeScore}`
  };
}

async function gradeProp(pick, game) {
  if (!pick.playerId) return null;
  const box = await getJSON(`${MLB_BASE}/game/${pick.gamePk}/boxscore`);
  const sides = [box.teams?.home, box.teams?.away];
  let playerBox = null;
  for (const side of sides) {
    const found = side?.players?.[`ID${pick.playerId}`];
    if (found) { playerBox = found; break; }
  }
  if (!playerBox) return null;
  const statMap = {
    "Hits O/U": playerBox.stats?.batting?.hits,
    "Home Runs O/U": playerBox.stats?.batting?.homeRuns,
    "Total Bases O/U": playerBox.stats?.batting?.totalBases,
    "Pitcher Strikeouts O/U": playerBox.stats?.pitching?.strikeOuts
  };
  const statValue = statMap[pick.market];
  if (statValue == null) return null; // no jugo / no lanzo (ej. lo sacaron del lineup)
  const over = statValue > pick.line;
  const won = pick.side === "over" ? over : !over;
  return { result: won ? "win" : "loss", actual: statValue };
}

async function gradePendingPicks(history) {
  const stillPending = [];
  for (const pick of history.pending) {
    try {
      const daysOld = (Date.now() - new Date(pick.recordedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld > 6) continue; // partido cancelado/suspendido, no lo arrastramos para siempre

      const scheduleData = await getJSON(`${MLB_BASE}/schedule?sportId=1&gamePk=${pick.gamePk}`);
      const game = scheduleData.dates?.[0]?.games?.[0];
      if (!game || game.status.abstractGameState !== "Final") {
        stillPending.push(pick);
        continue;
      }
      const graded = pick.market === "Moneyline" ? gradeMoneyline(pick, game) : await gradeProp(pick, game);
      if (!graded) { stillPending.push(pick); continue; }
      history.graded.unshift({ ...pick, ...graded, gradedAt: new Date().toISOString() });
    } catch {
      stillPending.push(pick);
    }
  }
  history.pending = stillPending;
  history.graded = history.graded.slice(0, 400);
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

  const standingsMap = await fetchStandingsMap().catch(() => ({}));

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

      // Historial bateador vs abridor rival, para los bateadores con props en este partido.
      const pitchersByTeam = {};
      for (const prop of evaluatedProps) {
        if (prop.market !== "Pitcher Strikeouts O/U") continue;
        const proj = await getPlayerProjection(prop.player);
        if (proj?.id && proj.team) pitchersByTeam[proj.team] = { id: proj.id, name: prop.player };
      }
      for (const prop of evaluatedProps) {
        if (!BATTING_MARKETS.has(prop.market)) continue;
        const proj = await getPlayerProjection(prop.player);
        if (!proj?.id || !proj.team) continue;
        const opposingTeam = proj.team === ev.home ? ev.away : ev.home;
        const pitcher = pitchersByTeam[opposingTeam];
        if (!pitcher) continue;
        const matchup = await getMatchup(proj.id, pitcher.id);
        if (matchup) prop.matchup = { pitcher: pitcher.name, ...matchup };
      }

      // Moneyline de valor, evaluado solo contra Bovada (asi siempre es jugable ahi).
      const moneylineLegs = evaluateMoneylineLegs(ev, gameOdds, standingsMap);
      moneylineLegs.forEach(leg => allEvaluatedProps.push({ ...leg, game: `${ev.away} @ ${ev.home}` }));

      const hasData = Object.keys(gameOdds.moneyline).length || Object.keys(gameOdds.total).length;
      if (hasData) withOdds++;

      games[`${ev.away}@${ev.home}@${ev.date.slice(0, 10)}`] = {
        home: ev.home,
        away: ev.away,
        date: ev.date,
        ...gameOdds,
        props: evaluatedProps,
        moneylinePicks: moneylineLegs
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

  // Registramos los picks de hoy como pendientes, y calificamos los de dias
  // anteriores cuyo partido ya termino (compara contra el resultado real).
  const history = await loadHistory();
  await recordPicks(games, history);
  await gradePendingPicks(history);
  await saveHistory(history);
  const wins = history.graded.filter(p => p.result === "win").length;
  const losses = history.graded.filter(p => p.result === "loss").length;

  const matchupCount = Object.values(games).reduce((acc, g) => acc + g.props.filter(p => p.matchup).length, 0);
  console.log(
    `Listo: ${Object.keys(games).length} partidos, ${withOdds} con moneyline/total, ` +
    `${allEvaluatedProps.length} picks evaluados (props + moneyline), ${allEvaluatedProps.filter(p => p.isValue).length} value picks, ` +
    `${matchupCount} matchups bateador-vs-abridor, ${parlays.length} parlays. ` +
    `Historial: ${wins}-${losses} (${history.pending.length} pendientes).`
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
