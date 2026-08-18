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
function extractStandingsMap(data) {
  const map = {};
  let maxGames = 0;
  function walk(node) {
    for (const e of node.standings?.entries ?? []) {
      const stats = {};
      for (const s of e.stats ?? []) stats[s.name] = s;
      const streakDisplay = stats.streak?.displayValue ?? "";
      const streakVal = Math.abs(stats.streak?.value ?? 0);
      const games = (stats.wins?.value ?? 0) + (stats.losses?.value ?? 0);
      maxGames = Math.max(maxGames, games);
      map[e.team.displayName] = {
        pct: stats.winPercent?.value ?? 0.5,
        streakSigned: streakDisplay.startsWith("L") ? -streakVal : streakVal,
        last10Diff: 0
      };
    }
    for (const child of node.children ?? []) walk(child);
  }
  walk(data);
  return { map, maxGames };
}

async function applyInjuryCounts(map) {
  try {
    const { countByTeamName } = await fetchNflInjuries();
    for (const [team, entry] of Object.entries(map)) entry.injuryCount = countByTeamName[team] || 0;
  } catch { /* seguimos sin ajuste de lesionados si falla */ }
  return map;
}

async function fetchStandingsMap() {
  const data = await getJSON(ESPN_STANDINGS);
  const { map, maxGames } = extractStandingsMap(data);
  // Recien arranca la pretemporada: los equipos tienen 0-1 partidos jugados en la
  // temporada "actual", lo que da pct de 0 o 1 exacto y probabilidades absurdas
  // (95% de favoritismo a un equipo con un solo partido de pretemporada jugado).
  // Si la muestra es muy chica, usamos la temporada regular completa anterior
  // en su lugar -- mucho mas representativa que 1 partido de pretemporada.
  if (maxGames < 3) {
    const lastYear = (data.season?.year ?? new Date().getFullYear()) - 1;
    try {
      const fallback = await getJSON(`${ESPN_STANDINGS}?season=${lastYear}`);
      return applyInjuryCounts(extractStandingsMap(fallback).map);
    } catch {
      return applyInjuryCounts(map);
    }
  }
  return applyInjuryCounts(map);
}

// El ajuste por lesionados es deliberadamente chico y crudo: contamos jugadores
// en status Out/IR/Doubtful/Suspension por equipo, sin distinguir si es un
// titular clave (ej. el quarterback) o un suplente -- no tenemos esa distincion
// con precision, asi que reflejamos solo "este equipo tiene mas bajas", no
// fingimos saber cuanto vale cada ausencia especifica.
function estimateWinProb(teamName, oppName, standingsMap, isHome) {
  const t = standingsMap[teamName];
  const o = standingsMap[oppName];
  if (!t || !o) return null;
  const pa = Math.min(0.9, Math.max(0.1, t.pct));
  const pb = Math.min(0.9, Math.max(0.1, o.pct));
  let p = (pa - pa * pb) / (pa + pb - 2 * pa * pb);
  const streakAdj = (t.streakSigned - o.streakSigned) * 0.015;
  const injuryDiff = (t.injuryCount ?? 0) - (o.injuryCount ?? 0);
  const injuryAdj = Math.max(-0.03, Math.min(0.03, -injuryDiff * 0.008));
  p += streakAdj + injuryAdj + (isHome ? 0.02 : -0.02);
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

// ---------- Clima real (Open-Meteo), para ajustar props sensibles al viento ----------
// A diferencia de MLB, en NFL el viento pesa mucho mas que la temperatura --
// afecta directamente la precision del pase y del pateo. Estadios con techo
// (domo o retractil, casi siempre cerrado) quedan fuera del ajuste.
const NFL_VENUES = {
  "Arizona Cardinals": { lat: 33.5276, lon: -112.2626, roofed: true },
  "Atlanta Falcons": { lat: 33.7554, lon: -84.4008, roofed: true },
  "Baltimore Ravens": { lat: 39.2780, lon: -76.6227, roofed: false },
  "Buffalo Bills": { lat: 42.7738, lon: -78.7870, roofed: false },
  "Carolina Panthers": { lat: 35.2258, lon: -80.8528, roofed: false },
  "Chicago Bears": { lat: 41.8623, lon: -87.6167, roofed: false },
  "Cincinnati Bengals": { lat: 39.0954, lon: -84.5160, roofed: false },
  "Cleveland Browns": { lat: 41.5061, lon: -81.6995, roofed: false },
  "Dallas Cowboys": { lat: 32.7473, lon: -97.0945, roofed: true },
  "Denver Broncos": { lat: 39.7439, lon: -105.0201, roofed: false },
  "Detroit Lions": { lat: 42.3400, lon: -83.0456, roofed: true },
  "Green Bay Packers": { lat: 44.5013, lon: -88.0622, roofed: false },
  "Houston Texans": { lat: 29.6847, lon: -95.4107, roofed: true },
  "Indianapolis Colts": { lat: 39.7601, lon: -86.1639, roofed: true },
  "Jacksonville Jaguars": { lat: 30.3239, lon: -81.6373, roofed: false },
  "Kansas City Chiefs": { lat: 39.0489, lon: -94.4839, roofed: false },
  "Las Vegas Raiders": { lat: 36.0909, lon: -115.1833, roofed: true },
  "Los Angeles Chargers": { lat: 33.9535, lon: -118.3392, roofed: true },
  "Los Angeles Rams": { lat: 33.9535, lon: -118.3392, roofed: true },
  "Miami Dolphins": { lat: 25.9580, lon: -80.2389, roofed: false },
  "Minnesota Vikings": { lat: 44.9735, lon: -93.2575, roofed: true },
  "New England Patriots": { lat: 42.0909, lon: -71.2643, roofed: false },
  "New Orleans Saints": { lat: 29.9511, lon: -90.0812, roofed: true },
  "New York Giants": { lat: 40.8135, lon: -74.0745, roofed: false },
  "New York Jets": { lat: 40.8135, lon: -74.0745, roofed: false },
  "Philadelphia Eagles": { lat: 39.9008, lon: -75.1675, roofed: false },
  "Pittsburgh Steelers": { lat: 40.4468, lon: -80.0158, roofed: false },
  "San Francisco 49ers": { lat: 37.4033, lon: -121.9694, roofed: false },
  "Seattle Seahawks": { lat: 47.5952, lon: -122.3316, roofed: false },
  "Tampa Bay Buccaneers": { lat: 27.9759, lon: -82.5033, roofed: false },
  "Tennessee Titans": { lat: 36.1665, lon: -86.7713, roofed: false },
  "Washington Commanders": { lat: 38.9076, lon: -76.8645, roofed: false }
};

const weatherCache = new Map();
async function fetchWeather(venue, gameDateISO) {
  if (!venue || venue.roofed) return null;
  const dateStr = gameDateISO.slice(0, 10);
  const hourStr = gameDateISO.slice(0, 13);
  const key = `${venue.lat},${venue.lon},${hourStr}`;
  if (weatherCache.has(key)) return weatherCache.get(key);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${venue.lat}&longitude=${venue.lon}&hourly=temperature_2m,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&start_date=${dateStr}&end_date=${dateStr}`;
    const data = await getJSON(url);
    const idx = data.hourly?.time?.findIndex(t => t.startsWith(hourStr));
    const result = idx != null && idx >= 0
      ? { temp: data.hourly.temperature_2m[idx], windSpeed: data.hourly.wind_speed_10m[idx] }
      : null;
    weatherCache.set(key, result);
    return result;
  } catch {
    weatherCache.set(key, null);
    return null;
  }
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// El viento es lo que mas pesa (pase y pateo pierden precision), el frio
// extremo suma un poco menos. Acotado para no disparar a un extremo.
function weatherAdjustment(statKey, weather) {
  if (!weather) return { mult: 1, note: null };
  let mult = 1;
  let note = null;
  const wind = weather.windSpeed ?? 0;
  const temp = weather.temp;

  if (["passYards", "recYards", "passTDs"].includes(statKey)) {
    if (wind >= 20) { mult *= 0.82; note = `viento fuerte (${Math.round(wind)}mph), afecta la precisión del pase`; }
    else if (wind >= 12) { mult *= 0.92; note = `viento de ${Math.round(wind)}mph, algo de impacto en el pase`; }
  } else if (statKey === "kickingPoints") {
    if (wind >= 20) { mult *= 0.75; note = `viento fuerte (${Math.round(wind)}mph), complica el pateo`; }
    else if (wind >= 12) { mult *= 0.88; note = `viento de ${Math.round(wind)}mph, afecta el pateo`; }
  } else if (statKey === "rushYards" && wind >= 15) {
    mult *= 1.08;
    note = `clima duro (viento ${Math.round(wind)}mph), suele subir el juego terrestre`;
  }
  if (temp != null && temp <= 32 && ["passYards", "recYards", "kickingPoints"].includes(statKey)) {
    mult *= 0.95;
    note = note ? `${note} · frío (${Math.round(temp)}°F)` : `frío (${Math.round(temp)}°F), pelota más difícil de agarrar`;
  }
  return { mult: clamp(mult, 0.6, 1.3), note };
}

// ---------- Lesionados (ESPN, liga completa en 1 sola llamada) ----------
// "Out"/"Injured Reserve"/"Suspension" -> directamente no juega, se descarta
// el prop. "Questionable" no se descarta (en la practica muchas veces juegan
// igual) pero se avisa en el "why" para que quede claro el riesgo.
const OUT_STATUSES = new Set(["Out", "Injured Reserve", "Suspension", "Doubtful"]);
let nflInjuriesCache = null;
async function fetchNflInjuries() {
  if (nflInjuriesCache) return nflInjuriesCache;
  const byPlayerId = {};
  const countByTeamName = {};
  try {
    const data = await getJSON(`${ESPN_SITE}/injuries`);
    for (const team of data.injuries ?? []) {
      for (const inj of team.injuries ?? []) {
        const link = inj.athlete?.links?.find(l => l.href?.includes("/id/"));
        const id = link ? /\/id\/(\d+)\//.exec(link.href)?.[1] : null;
        if (id) {
          byPlayerId[id] = {
            name: inj.athlete?.displayName ?? null, team: team.displayName ?? null,
            status: inj.status, comment: inj.shortComment ?? null, date: inj.date ?? null
          };
        }
        if (OUT_STATUSES.has(inj.status) && team.displayName) {
          countByTeamName[team.displayName] = (countByTeamName[team.displayName] || 0) + 1;
        }
      }
    }
  } catch { /* seguimos sin filtro de lesionados si falla */ }
  nflInjuriesCache = { byPlayerId, countByTeamName };
  return nflInjuriesCache;
}

async function evaluateProp(prop, awayTeam, homeTeam, weather) {
  const proj = await getPlayerProjection(prop.player);
  if (!proj) return null;
  if (proj.team && proj.team !== awayTeam && proj.team !== homeTeam) return null;

  const injuries = await fetchNflInjuries();
  const injury = injuries.byPlayerId[proj.id];
  if (injury && OUT_STATUSES.has(injury.status)) return null;

  const distro = proj[prop.statKey];
  if (!distro) return null;

  const wx = weatherAdjustment(prop.statKey, weather);
  const adjustedMean = distro.mean * wx.mult;

  const pick = pickSide(prop.over, prop.under, normalProbOver(prop.line, adjustedMean, distro.std));
  if (pick.odds == null || pick.impliedProb == null) return null;

  const injuryNote = injury?.status === "Questionable" ? `⚠️ Questionable (riesgo de no jugar)` : null;
  const why = [wx.note, injuryNote].filter(Boolean).join(" · ") || null;

  return {
    ...prop,
    playerId: proj.id,
    side: pick.side,
    odds: pick.odds,
    ourProb: Math.round(pick.ourProb * 1000) / 1000,
    impliedProb: Math.round(pick.impliedProb * 1000) / 1000,
    edge: Math.round(pick.edge * 1000) / 1000,
    isValue: isRealValue(pick.edge, pick.ourProb, pick.odds, 0.08),
    why
  };
}

// ---------- Moneyline de valor, evaluado SOLO contra la cuota de Bovada ----------
// Nota de lesionados para el pick de moneyline, cuando la diferencia es
// suficiente como para explicar parte del ajuste.
function injuryNoteForMoneyline(teamName, oppName, standingsMap) {
  const t = standingsMap[teamName]?.injuryCount ?? 0;
  const o = standingsMap[oppName]?.injuryCount ?? 0;
  if (t === o) return null;
  return t < o
    ? `${teamName} tiene menos bajas confirmadas (${t} vs ${o} de ${oppName})`
    : `${teamName} tiene mas bajas confirmadas (${t} vs ${o} de ${oppName}) — jugado a favor del rival`;
}

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
      edge, isValue: isRealValue(edge, awayProb, ml.away, 0.06),
      why: injuryNoteForMoneyline(ev.away, ev.home, standingsMap)
    });
  }
  if (homeImplied != null) {
    const edge = Math.round((homeProb - homeImplied) * 1000) / 1000;
    legs.push({
      market: "Moneyline", kind: "moneyline", player: ev.home, line: null, side: "gana",
      odds: ml.home, bookmaker: "Bovada",
      ourProb: Math.round(homeProb * 1000) / 1000, impliedProb: Math.round(homeImplied * 1000) / 1000,
      edge, isValue: isRealValue(edge, homeProb, ml.home, 0.06),
      why: injuryNoteForMoneyline(ev.home, ev.away, standingsMap)
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
  const cutoff = Date.now() + 6 * 24 * 60 * 60 * 1000;
  const events = allEvents.filter(ev => new Date(ev.date).getTime() <= cutoff);

  const standingsMap = await fetchStandingsMap().catch(() => ({}));

  const oddsById = {};
  for (let i = 0; i < events.length; i += 10) {
    const batch = events.slice(i, i + 10);
    await sleep(300);
    try {
      const eventIds = batch.map(ev => ev.id).join(",");
      const list = await getJSON(`${ODDS_BASE}/odds/multi?apiKey=${API_KEY}&eventIds=${eventIds}&bookmakers=${BOOKMAKERS}`);
      for (const item of list) oddsById[item.id] = item;
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

      const venue = NFL_VENUES[ev.home] ?? null;
      const weather = venue ? await fetchWeather(venue, ev.date) : null;

      const evaluatedProps = [];
      for (const prop of rawProps) {
        const evaluated = await evaluateProp(prop, ev.away, ev.home, weather);
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

  // Lista de lesionados visible, filtrada a los equipos que juegan en la
  // ventana que estamos mostrando (mostrar las ~800 bajas de toda la liga
  // no serviria de nada).
  const teamsInWindow = new Set();
  for (const g of Object.values(games)) { teamsInWindow.add(g.home); teamsInWindow.add(g.away); }
  const nflInjuriesData = await fetchNflInjuries().catch(() => ({ byPlayerId: {} }));
  const STATUS_ORDER = { "Out": 0, "Injured Reserve": 0, "Suspension": 0, "Doubtful": 1, "Questionable": 2, "Active": 3 };
  const injuries = Object.values(nflInjuriesData.byPlayerId ?? {})
    .filter(inj => inj.team && teamsInWindow.has(inj.team) && inj.status !== "Active")
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));

  const output = { updatedAt: new Date().toISOString(), games, parlays, injuries };

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
