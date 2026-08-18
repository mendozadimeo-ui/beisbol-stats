// Corre periodicamente (GitHub Actions) y guarda un snapshot estatico en data/nfl.json.
// Mismo patron que fetch-odds.mjs (MLB) y fetch-nba.mjs. Fuente de stats: ESPN.
// A diferencia de NBA, la NFL ya estaba en pretemporada al escribir esto, asi que
// pudimos confirmar contra datos reales que odds-api.io mezcla los props en un
// bucket generico "Player Props" (label "Jugador (Tipo)") Y ademas mercados
// dedicados con nombre propio ("Passing Yards O/U", label "Jugador (numero) (linea)").
// Usamos solo los mercados dedicados (mas limpios de parsear) y descartamos el
// bucket generico y mercados de un solo tiro (Touchdown Scorers, Longest X).

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error("Falta la variable de entorno ODDS_API_KEY");
  process.exit(1);
}

const BOOKMAKERS = "Bovada,Bet365";
const ODDS_BASE = "https://api.odds-api.io/v3";
const ODDS_LEAGUE = "usa-nfl";
const ODDS_SPORT = "american-football";

const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";
const ESPN_STANDINGS = "https://site.web.api.espn.com/apis/v2/sports/football/nfl/standings";
const ESPN_SEARCH = "https://site.web.api.espn.com/apis/search/v2";

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mismo criterio de "value real" que fetch-odds.mjs y fetch-nba.mjs: edge positivo,
// probabilidad realista y cuota que deje ganancia. Sin techo de cuota maxima.
const MIN_REALISTIC_PROB = 0.55;
const MIN_PAYOUT_ODDS = 1.20;
function isRealValue(edge, ourProb, odds, edgeThreshold) {
  return edge >= edgeThreshold && ourProb >= MIN_REALISTIC_PROB && odds >= MIN_PAYOUT_ODDS;
}

// ---------- Cuotas de partido completo ----------
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
        result.spread[bookmaker] = { homeLine: o.hdp, homeOdds: o.home, awayOdds: o.away };
      }
    }
  }
  return result;
}

// ---------- Probabilidad de victoria propia (Log5) contra el moneyline real ----------
// La NFL no tiene stat de "ultimos 10" (temporada de 17 partidos), asi que el ajuste
// usa solo racha actual + localia.
async function fetchStandingsMap() {
  const data = await getJSON(ESPN_STANDINGS);
  const map = {};
  function walk(node) {
    for (const e of node.standings?.entries ?? []) {
      const stats = {};
      for (const s of e.stats ?? []) stats[s.name] = s;
      const streakDisplay = stats.streak?.displayValue ?? "";
      const streakVal = Math.abs(stats.streak?.value ?? 0);
      map[e.team.displayName] = {
        pct: stats.winPercent?.value ?? 0.5,
        streakSigned: streakDisplay.startsWith("L") ? -streakVal : streakVal,
        last10Diff: 0
      };
    }
    for (const child of node.children ?? []) walk(child);
  }
  walk(data);
  return map;
}

function estimateWinProb(teamName, oppName, standingsMap, isHome) {
  const t = standingsMap[teamName];
  const o = standingsMap[oppName];
  if (!t || !o) return null;
  const pa = Math.min(0.9, Math.max(0.1, t.pct));
  const pb = Math.min(0.9, Math.max(0.1, o.pct));
  let p = (pa - pa * pb) / (pa + pb - 2 * pa * pb);
  const streakAdj = (t.streakSigned - o.streakSigned) * 0.015;
  p += streakAdj + (isHome ? 0.02 : -0.02);
  return Math.max(0.05, Math.min(0.95, p));
}

// ---------- Props de jugador ----------
// Confirmado contra datos reales de pretemporada 2026: Bovada no publica props de
// NFL (solo ML/Spread/Totals, igual que en MLB); Bet365 si. Los mercados dedicados
// tienen el label "Jugador (numero de camiseta) (linea)" -- distinto del formato
// "Jugador (Tipo de stat)" del bucket generico "Player Props", que ignoramos.
const EXCLUDED_MARKETS = /player props|scorer|longest/i;
function classifyMarket(name) {
  const m = name.toLowerCase();
  if (m.includes(" and ")) return null; // combos (Passing+Rushing, etc), fuera de alcance
  if (m.includes("passing yards")) return "passYards";
  if (m.includes("passing touchdown")) return "passTDs";
  if (m.includes("interception")) return "interceptions";
  if (m.includes("rushing yards")) return "rushYards";
  if (m.includes("receiving yards")) return "recYards";
  if (m.includes("kick") && m.includes("point")) return "kickingPoints";
  return null;
}
function parsePlayerLabel(label) {
  const m = /^(.+?)\s*\(\d+\)\s*\([\d.]+\)$/.exec(label);
  return (m ? m[1] : label).trim();
}

const unmatchedMarkets = new Set();
function extractProps(oddsResponse) {
  const props = [];
  const preferredOrder = ["Bovada", "Bet365"];
  const seen = new Set();
  for (const bookmaker of preferredOrder) {
    const markets = oddsResponse.bookmakers?.[bookmaker];
    if (!markets) continue;
    for (const market of markets) {
      if (["ML", "Spread", "Totals", "Alternative Spread", "Alternative Totals"].includes(market.name)) continue;
      if (EXCLUDED_MARKETS.test(market.name)) continue;
      const statKey = classifyMarket(market.name);
      if (!statKey) { unmatchedMarkets.add(market.name); continue; }
      for (const o of market.odds ?? []) {
        if (!o.label || o.hdp == null) continue;
        const player = parsePlayerLabel(o.label);
        const dedupeKey = `${statKey}|${player}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        props.push({
          market: DISPLAY_MARKET[statKey], statKey, rawMarket: market.name,
          player, line: o.hdp,
          over: o.over ?? null, under: o.under ?? null, bookmaker
        });
      }
    }
  }
  return props;
}
const DISPLAY_MARKET = {
  passYards: "Yardas de Pase O/U", passTDs: "Touchdowns de Pase O/U", interceptions: "Intercepciones O/U",
  rushYards: "Yardas de Carrera O/U", recYards: "Yardas de Recepcion O/U", kickingPoints: "Puntos de Pateo O/U"
};

// ---------- Distribucion normal, para estimar probabilidad de superar una linea ----------
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalProbOver(line, mean, std) {
  const s = std && std > 0 ? std : 1;
  const z = (line - mean) / (s * Math.SQRT2);
  return Math.max(0, Math.min(1, 1 - 0.5 * (1 + erf(z))));
}
function decimalToImpliedProb(decimalOdds) {
  const d = parseFloat(decimalOdds);
  return d > 0 ? 1 / d : null;
}

// ---------- Busqueda y stats de jugador (cacheado por nombre dentro de esta corrida) ----------
const GAMELOG_FIELD = {
  passYards: "passingYards", passTDs: "passingTouchdowns", interceptions: "interceptions",
  rushYards: "rushingYards", recYards: "receivingYards", kickingPoints: "totalKickingPoints"
};
const MIN_STD = { passYards: 15, passTDs: 0.6, interceptions: 0.6, rushYards: 15, recYards: 15, kickingPoints: 2 };

const playerCache = new Map();
async function getPlayerProjection(name) {
  if (playerCache.has(name)) return playerCache.get(name);
  const projection = await fetchPlayerProjection(name);
  playerCache.set(name, projection);
  return projection;
}

function meanStd(values, minStd) {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.max(minStd, Math.sqrt(variance)) };
}

async function fetchPlayerProjection(name) {
  try {
    const search = await getJSON(`${ESPN_SEARCH}?query=${encodeURIComponent(name)}&limit=5`);
    const group = (search.results ?? []).find(r => r.type === "player");
    const candidates = group?.contents ?? [];
    const match = candidates.find(c => c.sport === "football" && c.defaultLeagueSlug === "nfl") ?? candidates[0];
    if (!match) return null;
    const idMatch = /a:(\d+)/.exec(match.uid || "");
    const id = idMatch?.[1];
    if (!id) return null;

    const gamelog = await getJSON(`${ESPN_WEB}/athletes/${id}/gamelog`);
    const names = gamelog.names ?? [];
    const fieldIdx = {};
    for (const [key, field] of Object.entries(GAMELOG_FIELD)) fieldIdx[key] = names.indexOf(field);

    const regSeason = (gamelog.seasonTypes ?? []).find(st => /regular season/i.test(st.displayName ?? ""));
    if (!regSeason) return null;
    const meta = gamelog.events ?? {};
    // Temporada corta (17 partidos): usamos hasta los ultimos 10 en vez de 15 como NBA.
    const games = (regSeason.categories ?? [])
      .flatMap(c => c.events ?? [])
      .map(ev => ({ stats: ev.stats, date: meta[ev.eventId]?.gameDate }))
      .filter(g => g.date)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10);
    if (games.length < 2) return null;

    const projection = { id, team: match.subtitle ?? null, games: games.length };
    for (const key of Object.keys(GAMELOG_FIELD)) {
      const i = fieldIdx[key];
      if (i == null || i < 0) { projection[key] = null; continue; }
      const vals = games.map(g => parseFloat(g.stats[i])).filter(v => !isNaN(v));
      projection[key] = meanStd(vals, MIN_STD[key]);
    }
    return projection;
  } catch {
    return null;
  }
}

function pickSide(overOdds, underOdds, ourProbOver) {
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
  if (proj.team && proj.team !== awayTeam && proj.team !== homeTeam) return null;

  const distro = proj[prop.statKey];
  if (!distro) return null;

  const pick = pickSide(prop.over, prop.under, normalProbOver(prop.line, distro.mean, distro.std));
  if (pick.odds == null || pick.impliedProb == null) return null;

  return {
    ...prop,
    playerId: proj.id,
    side: pick.side,
    odds: pick.odds,
    ourProb: Math.round(pick.ourProb * 1000) / 1000,
    impliedProb: Math.round(pick.impliedProb * 1000) / 1000,
    edge: Math.round(pick.edge * 1000) / 1000,
    isValue: isRealValue(pick.edge, pick.ourProb, pick.odds, 0.08)
  };
}

// ---------- Moneyline de valor, evaluado SOLO contra la cuota de Bovada ----------
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
      edge, isValue: isRealValue(edge, awayProb, ml.away, 0.06)
    });
  }
  if (homeImplied != null) {
    const edge = Math.round((homeProb - homeImplied) * 1000) / 1000;
    legs.push({
      market: "Moneyline", kind: "moneyline", player: ev.home, line: null, side: "gana",
      odds: ml.home, bookmaker: "Bovada",
      ourProb: Math.round(homeProb * 1000) / 1000, impliedProb: Math.round(homeImplied * 1000) / 1000,
      edge, isValue: isRealValue(edge, homeProb, ml.home, 0.06)
    });
  }
  return legs;
}

// ---------- Parlays recomendados ----------
const REUSE_EDGE_THRESHOLD = 0.20;
function buildParlays(allEvaluatedProps) {
  const valuePicks = allEvaluatedProps.filter(p => p.isValue).sort((a, b) => b.edge - a.edge);
  const passingPicks = valuePicks.filter(p => ["passYards", "passTDs", "interceptions"].includes(p.statKey));
  const otherPropPicks = valuePicks.filter(p => ["rushYards", "recYards", "kickingPoints"].includes(p.statKey));
  const moneylinePicks = valuePicks.filter(p => p.market === "Moneyline");

  function toParlay(legs, label, category) {
    if (legs.length < 2) return null;
    const bookmaker = legs[0].bookmaker;
    if (!legs.every(l => l.bookmaker === bookmaker)) return null;
    const combinedOdds = legs.reduce((acc, l) => acc * parseFloat(l.odds), 1);
    const combinedProb = legs.reduce((acc, l) => acc * l.ourProb, 1);
    return {
      label, category, bookmaker,
      legs: legs.map(l => ({ player: l.player, market: l.market, side: l.side, line: l.line, odds: l.odds, ourProb: l.ourProb, game: l.game })),
      combinedOdds: Math.round(combinedOdds * 100) / 100,
      combinedProb: Math.round(combinedProb * 1000) / 1000
    };
  }

  const globalUsed = new Set();
  function pickLegs(pool, count) {
    const counts = {};
    for (const p of pool) counts[p.bookmaker] = (counts[p.bookmaker] || 0) + 1;
    const bestBookmaker = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const filtered = bestBookmaker ? pool.filter(p => p.bookmaker === bestBookmaker) : pool;

    const legs = [];
    const localUsed = new Set();
    for (const p of filtered) {
      if (legs.length >= count) break;
      if (localUsed.has(p.player)) continue;
      if (globalUsed.has(p.player) && p.edge < REUSE_EDGE_THRESHOLD) continue;
      legs.push(p);
      localUsed.add(p.player);
    }
    if (legs.length < count) {
      for (const p of filtered) {
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
  add(passingPicks, 2, "Pase (2 picks)", "pase");
  add(otherPropPicks, 2, "Carrera y recepcion (2 picks)", "carrera_recepcion");
  add(valuePicks.filter(p => p.market !== "Moneyline"), 3, "Mixto (3 picks)", "mixto");
  add(valuePicks.filter(p => p.market !== "Moneyline"), 4, "Mixto (4 picks)", "mixto");
  return parlays;
}

// ---------- Registro y calificacion de picks (aciertos/fallos historicos) ----------
const HISTORY_PATH = "data/nfl-history.json";
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

const scoreboardCache = new Map();
async function getScoreboardMap(dateISO) {
  const key = dateISO.replace(/-/g, "");
  if (scoreboardCache.has(key)) return scoreboardCache.get(key);
  let map = {};
  for (const seasontype of [2, 3, 1]) {
    try {
      const data = await getJSON(`${ESPN_SITE}/scoreboard?dates=${key}&seasontype=${seasontype}`);
      if (data.events?.length) {
        for (const ev of data.events) {
          const comp = ev.competitions?.[0];
          const home = comp?.competitors?.find(c => c.homeAway === "home");
          const away = comp?.competitors?.find(c => c.homeAway === "away");
          if (!home || !away) continue;
          map[home.team.displayName] = {
            id: ev.id, away: away.team.displayName,
            homeScore: home.score, awayScore: away.score,
            completed: !!comp.status?.type?.completed
          };
        }
        break;
      }
    } catch { /* probamos el siguiente seasontype */ }
  }
  scoreboardCache.set(key, map);
  return map;
}

function pickHistoryId(pick) {
  return `${pick.date}|${pick.eventId}|${pick.market}|${pick.player}|${pick.line ?? ""}|${pick.side}`;
}

async function recordPicks(games, history) {
  const known = new Set([...history.pending, ...history.graded].map(pickHistoryId));
  for (const game of Object.values(games)) {
    const dateISO = game.date.slice(0, 10);
    const scoreboard = await getScoreboardMap(dateISO);
    const info = scoreboard[game.home];
    if (!info) continue;
    const candidates = [...(game.props ?? []), ...(game.moneylinePicks ?? [])].filter(p => p.isValue);
    for (const p of candidates) {
      const record = {
        date: dateISO, eventId: info.id, game: `${game.away} @ ${game.home}`,
        home: game.home, away: game.away,
        market: p.market, statKey: p.statKey ?? null, player: p.player, playerId: p.playerId ?? null,
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

async function gradeMoneylinePick(pick, info) {
  if (!info.completed || info.homeScore == null || info.awayScore == null) return null;
  const hs = Number(info.homeScore), as = Number(info.awayScore);
  if (isNaN(hs) || isNaN(as) || hs === as) return null;
  const homeWon = hs > as;
  const pickedHome = pick.player === pick.home;
  const won = pickedHome ? homeWon : !homeWon;
  return { result: won ? "win" : "loss", actual: `${pick.away} ${as} - ${pick.home} ${hs}` };
}

// Box score de NFL viene agrupado por categoria (passing/rushing/receiving/kicking),
// cada una con sus propias columnas -- distinto a NBA/MLB que tienen una sola tabla.
const STAT_GROUP = {
  passYards: { group: "passing", label: "YDS" }, passTDs: { group: "passing", label: "TD" },
  interceptions: { group: "passing", label: "INT" }, rushYards: { group: "rushing", label: "YDS" },
  recYards: { group: "receiving", label: "YDS" }, kickingPoints: { group: "kicking", label: "PTS" }
};
async function gradePropPick(pick, info) {
  if (!pick.playerId || !pick.statKey) return null;
  const cfg = STAT_GROUP[pick.statKey];
  if (!cfg) return null;
  const data = await getJSON(`${ESPN_SITE}/summary?event=${info.id}`);
  const teamsBox = data.boxscore?.players ?? [];
  for (const team of teamsBox) {
    const grp = team.statistics?.find(g => g.name === cfg.group);
    if (!grp) continue;
    const entry = grp.athletes?.find(a => String(a.athlete?.id) === String(pick.playerId));
    if (!entry) continue;
    const colIdx = (grp.labels ?? []).indexOf(cfg.label);
    if (colIdx < 0) return null;
    const statValue = parseFloat(entry.stats[colIdx]);
    if (isNaN(statValue)) return null;
    const over = statValue > pick.line;
    const won = pick.side === "over" ? over : !over;
    return { result: won ? "win" : "loss", actual: statValue };
  }
  return null;
}

async function gradePendingPicks(history) {
  const stillPending = [];
  for (const pick of history.pending) {
    try {
      const daysOld = (Date.now() - new Date(pick.recordedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld > 9) continue; // partidos de NFL son semanales, damos mas margen que NBA/MLB
      const scoreboard = await getScoreboardMap(pick.date);
      const info = scoreboard[pick.home];
      if (!info || !info.completed) { stillPending.push(pick); continue; }
      const graded = pick.market === "Moneyline" ? await gradeMoneylinePick(pick, info) : await gradePropPick(pick, info);
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
    allEvents = await getJSON(`${ODDS_BASE}/events?apiKey=${API_KEY}&sport=${ODDS_SPORT}&league=${ODDS_LEAGUE}&status=pending&limit=60`);
  } catch (e) {
    if (String(e.message).includes("429")) {
      console.log("Cuota horaria agotada, se reintenta en la proxima corrida programada. Sin cambios.");
      return;
    }
    throw e;
  }

  // Partidos de NFL son semanales: ventana mas amplia que MLB/NBA (2 dias) para que
  // no quede vacio toda la semana. 6 dias cubre de martes a la semana siguiente.
  const cutoff = Date.now() + 30 * 24 * 60 * 60 * 1000; // TEMP debug, revertir a 6 dias
  const events = allEvents.filter(ev => new Date(ev.date).getTime() <= cutoff);

  const standingsMap = await fetchStandingsMap().catch(() => ({}));

  const oddsById = {};
  for (let i = 0; i < events.length; i += 10) {
    const batch = events.slice(i, i + 10);
    await sleep(300);
    try {
      const eventIds = batch.map(ev => ev.id).join(",");
      const list = await getJSON(`${ODDS_BASE}/odds/multi?apiKey=${API_KEY}&eventIds=${eventIds}&bookmakers=${BOOKMAKERS}`);
      for (const item of list) oddsById[item.eventId] = item;
    } catch (e) {
      console.error(`Error en batch de odds (${batch.map(ev => ev.id).join(",")}):`, e.message);
    }
  }

  const games = {};
  const allEvaluatedProps = [];
  let withOdds = 0;

  for (const ev of events) {
    try {
      const odds = oddsById[ev.id];
      if (!odds) continue;
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

      const moneylineLegs = evaluateMoneylineLegs(ev, gameOdds, standingsMap);
      moneylineLegs.forEach(leg => allEvaluatedProps.push({ ...leg, game: `${ev.away} @ ${ev.home}` }));

      const hasData = Object.keys(gameOdds.moneyline).length || Object.keys(gameOdds.total).length;
      if (hasData) withOdds++;

      games[`${ev.away}@${ev.home}@${ev.date.slice(0, 10)}`] = {
        home: ev.home, away: ev.away, date: ev.date,
        ...gameOdds, props: evaluatedProps, moneylinePicks: moneylineLegs
      };
    } catch (e) {
      console.error(`Error en evento ${ev.id}:`, e.message);
    }
  }

  const parlays = buildParlays(allEvaluatedProps);
  const output = { updatedAt: new Date().toISOString(), games, parlays };

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/nfl.json", JSON.stringify(output, null, 2));

  const history = await loadHistory();
  await recordPicks(games, history);
  await gradePendingPicks(history);
  await saveHistory(history);

  const wins = history.graded.filter(p => p.result === "win").length;
  const losses = history.graded.filter(p => p.result === "loss").length;
  console.log(
    `${Object.keys(games).length} partidos, ${withOdds} con cuotas, ` +
    `${allEvaluatedProps.length} picks evaluados, ${allEvaluatedProps.filter(p => p.isValue).length} value picks, ` +
    `historial ${wins}-${losses}.`
  );
  if (unmatchedMarkets.size) {
    console.log("Mercados de odds-api.io sin clasificar (revisar classifyMarket):", [...unmatchedMarkets]);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
