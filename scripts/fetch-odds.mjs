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

// Un partido nocturno en la costa oeste/central de EE.UU. arranca pasada la
// medianoche UTC (ej: Rockies 20:40 hora local = 00:40 UTC del dia siguiente).
// El calendario oficial de MLB sigue asignando ese partido al dia calendario
// en que arranco en horario de EE.UU., no al dia UTC. Ningun partido de MLB
// arranca de madrugada UTC en su fecha "real" -- si el commence_time cae antes
// de las 10:00 UTC, en realidad pertenece al dia anterior. Sin este ajuste,
// estos partidos quedaban guardados bajo una fecha que el sitio (que arma sus
// claves con la fecha que devuelve el calendario oficial de MLB) nunca busca,
// y sus props quedaban invisibles aunque estuvieran bien calculados.
function mlbDateKey(isoDateStr) {
  const d = new Date(isoDateStr);
  if (d.getUTCHours() < 10) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

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
  const [standingsData, teamsData, injuries] = await Promise.all([
    getJSON(`${MLB_BASE}/standings?leagueId=103,104&season=${SEASON}&standingsTypes=regularSeason`),
    getJSON(`${MLB_BASE}/teams?sportId=1`),
    fetchMlbInjuries().catch(() => ({ countByTeamId: {} }))
  ]);
  const byId = {};
  for (const division of standingsData.records ?? []) {
    for (const r of division.teamRecords ?? []) {
      const last10 = r.records?.splitRecords?.find(s => s.type === "lastTen");
      const streakNum = r.streak?.streakNumber ?? 0;
      byId[r.team.id] = {
        pct: parseFloat(r.leagueRecord.pct) || 0.5,
        streakSigned: r.streak?.streakType === "wins" ? streakNum : -streakNum,
        last10Diff: last10 ? last10.wins - last10.losses : 0,
        injuryCount: injuries.countByTeamId[r.team.id] || 0
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
// El ajuste por lesionados es deliberadamente chico y crudo: contamos cuantos
// jugadores del roster de 40 estan inactivos por equipo, sin distinguir si es
// un titular clave o un suplente (no tenemos ese dato con precision) -- es
// honesto reflejar solo "este equipo tiene mas bajas que el rival", no fingir
// que sabemos cuanto vale cada ausencia especifica.
function estimateWinProb(teamName, oppName, standingsMap, isHome) {
  const t = standingsMap[teamName];
  const o = standingsMap[oppName];
  if (!t || !o) return null;
  const pa = Math.min(0.9, Math.max(0.1, t.pct));
  const pb = Math.min(0.9, Math.max(0.1, o.pct));
  let p = (pa - pa * pb) / (pa + pb - 2 * pa * pb);
  const streakAdj = (t.streakSigned - o.streakSigned) * 0.01 + (t.last10Diff - o.last10Diff) * 0.008;
  const injuryDiff = (t.injuryCount ?? 0) - (o.injuryCount ?? 0);
  const injuryAdj = Math.max(-0.03, Math.min(0.03, -injuryDiff * 0.006));
  p += streakAdj + injuryAdj + (isHome ? 0.02 : -0.02);
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

// Para lineas de 2+ hits (Over 1.5) el codigo usaba Poisson(avg*AB) -- mismo
// error estructural que tenia Bases Totales: hits por partido esta acotado por
// los turnos al bate (no es un conteo libre), asi que Poisson sobreestima la
// cola alta. Con N turnos al bate enteros, P(al menos 2 hits) es exacta via
// binomial: 1 - P(0 hits) - P(1 hit).
function binomialProbOver(line, atBatsPerGame, p) {
  const n = Math.max(1, Math.round(atBatsPerGame));
  const k = Math.floor(line);
  let cdf = 0;
  for (let i = 0; i <= k && i <= n; i++) {
    let comb = 1;
    for (let j = 0; j < i; j++) comb = comb * (n - j) / (j + 1);
    cdf += comb * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

// Bases totales por partido NO es Poisson: es la suma de un numero acotado de
// turnos al bate (3-5 por partido), cada uno con resultado 0/1/2/3/4 bases segun
// tasa real de sencillo/doble/triple/HR. Poisson(lambda = promedio de temporada)
// sobreestima sistematicamente P(over) porque su cola no baja tan rapido como la
// de un proceso acotado por AB -- confirmado contra el historial real de picks
// (calibracion: predecia 74-79% de probabilidad promedio, el resultado real
// rondaba 56-60%). Esta convolucion exacta sobre N turnos al bate reemplaza esa
// aproximacion; para la linea 0.5 (al menos 1 base = al menos 1 hit) da el mismo
// resultado que binomialProbAtLeastOneHit, como deberia.
function totalBasesDistribution(atBats, p1b, p2b, p3b, phr) {
  const pOut = Math.max(0, 1 - p1b - p2b - p3b - phr);
  const outcomes = [[0, pOut], [1, p1b], [2, p2b], [3, p3b], [4, phr]];
  let dist = [1];
  for (let i = 0; i < atBats; i++) {
    const next = new Array(dist.length + 4).fill(0);
    for (let tb = 0; tb < dist.length; tb++) {
      if (!dist[tb]) continue;
      for (const [bases, prob] of outcomes) next[tb + bases] += dist[tb] * prob;
    }
    dist = next;
  }
  return dist;
}
function totalBasesProbOver(line, atBatsPerGame, p1b, p2b, p3b, phr) {
  const n = Math.max(1, Math.round(atBatsPerGame));
  const dist = totalBasesDistribution(n, p1b, p2b, p3b, phr);
  const k = Math.floor(line);
  let cdf = 0;
  for (let i = 0; i <= k && i < dist.length; i++) cdf += dist[i];
  return Math.max(0, Math.min(1, 1 - cdf));
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
    // Tasas por turno al bate de cada tipo de hit (no solo el promedio de bases
    // totales) -- necesarias para el modelo de convolucion de Bases Totales, que
    // reemplaza a Poisson por ser un evento acotado por AB, no un conteo libre.
    const ab = stat.atBats || 0;
    const hits = stat.hits || 0;
    const doubles = stat.doubles || 0;
    const triples = stat.triples || 0;
    const homeRuns = stat.homeRuns || 0;
    return {
      isPitcher: false,
      id: person.id,
      team,
      avg: parseFloat(stat.avg) || 0,
      abPerGame: ab / gamesPlayed,
      hrPerGame: homeRuns / gamesPlayed,
      tbPerGame: (stat.totalBases || 0) / gamesPlayed,
      seasonHr: homeRuns,
      seasonTb: stat.totalBases || 0,
      gamesPlayed,
      p1b: ab > 0 ? Math.max(0, hits - doubles - triples - homeRuns) / ab : 0,
      p2b: ab > 0 ? doubles / ab : 0,
      p3b: ab > 0 ? triples / ab : 0,
      phr: ab > 0 ? homeRuns / ab : 0
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

// ---------- Parques (factor real de HR), clima, y abridores probables ----------
// Factor de parque real (escala aprox. -1 a 1, ya usado como referencia visual en
// el sitio). positivo = favorece bateo, negativo = favorece pitcheo. Coors Field
// (altura) es el mas extremo en +, Oracle Park (marine layer) el mas extremo en -.
const VENUES = {
  133: { name: "Sutter Health Park", lat: 38.57994, lon: -121.51246, roofed: false, parkFactor: 0.2, parkLabel: "Favorece bateo (parque chico)" },
  134: { name: "PNC Park", lat: 40.446904, lon: -80.005753, roofed: false, parkFactor: -0.25, parkLabel: "Favorece pitcheo" },
  135: { name: "Petco Park", lat: 32.707861, lon: -117.157278, roofed: false, parkFactor: -0.3, parkLabel: "Favorece pitcheo" },
  136: { name: "T-Mobile Park", lat: 47.591333, lon: -122.33251, roofed: false, parkFactor: -0.35, parkLabel: "Favorece pitcheo (aire marino)" },
  137: { name: "Oracle Park", lat: 37.778383, lon: -122.389448, roofed: false, parkFactor: -0.45, parkLabel: "Favorece pitcheo fuerte (marine layer)" },
  138: { name: "Busch Stadium", lat: 38.62256667, lon: -90.19286667, roofed: false, parkFactor: -0.2, parkLabel: "Favorece pitcheo (leve)" },
  139: { name: "Tropicana Field", lat: 27.767778, lon: -82.6525, roofed: true, parkFactor: -0.1, parkLabel: "Neutral (techo)" },
  140: { name: "Globe Life Field", lat: 32.747299, lon: -97.081818, roofed: true, parkFactor: 0, parkLabel: "Neutral (techo retractil)" },
  141: { name: "Rogers Centre", lat: 43.64155, lon: -79.38915, roofed: true, parkFactor: 0.1, parkLabel: "Leve bateo (techo retractil)" },
  142: { name: "Target Field", lat: 44.981829, lon: -93.277891, roofed: false, parkFactor: 0, parkLabel: "Neutral" },
  143: { name: "Citizens Bank Park", lat: 39.90539086, lon: -75.16716957, roofed: false, parkFactor: 0.35, parkLabel: "Favorece bateo" },
  144: { name: "Truist Park", lat: 33.890672, lon: -84.467641, roofed: false, parkFactor: 0.1, parkLabel: "Leve bateo" },
  145: { name: "Rate Field", lat: 41.83, lon: -87.634167, roofed: false, parkFactor: 0.15, parkLabel: "Leve bateo" },
  146: { name: "loanDepot park", lat: 25.77796236, lon: -80.21951795, roofed: true, parkFactor: -0.35, parkLabel: "Favorece pitcheo (techo)" },
  147: { name: "Yankee Stadium", lat: 40.82919482, lon: -73.9264977, roofed: false, parkFactor: 0.3, parkLabel: "Favorece bateo (porche corto)" },
  158: { name: "American Family Field", lat: 43.02838, lon: -87.97099, roofed: true, parkFactor: 0.1, parkLabel: "Leve bateo (techo retractil)" },
  108: { name: "Angel Stadium", lat: 33.80019044, lon: -117.8823996, roofed: false, parkFactor: 0, parkLabel: "Neutral" },
  109: { name: "Chase Field", lat: 33.445302, lon: -112.066687, roofed: true, parkFactor: 0.25, parkLabel: "Leve bateo (techo retractil)" },
  110: { name: "Oriole Park at Camden Yards", lat: 39.283787, lon: -76.621689, roofed: false, parkFactor: 0, parkLabel: "Neutral" },
  111: { name: "Fenway Park", lat: 42.346456, lon: -71.097441, roofed: false, parkFactor: 0.3, parkLabel: "Favorece bateo (Green Monster)" },
  112: { name: "Wrigley Field", lat: 41.948171, lon: -87.655503, roofed: false, parkFactor: 0, parkLabel: "Variable (depende del viento)" },
  113: { name: "Great American Ball Park", lat: 39.097389, lon: -84.506611, roofed: false, parkFactor: 0.4, parkLabel: "Favorece bateo" },
  114: { name: "Progressive Field", lat: 41.495861, lon: -81.685255, roofed: false, parkFactor: -0.1, parkLabel: "Neutral/leve pitcheo" },
  115: { name: "Coors Field", lat: 39.756042, lon: -104.994136, roofed: false, parkFactor: 0.9, parkLabel: "Favorece bateo extremo (altitud)" },
  116: { name: "Comerica Park", lat: 42.3391151, lon: -83.048695, roofed: false, parkFactor: -0.3, parkLabel: "Favorece pitcheo" },
  117: { name: "Daikin Park", lat: 29.756967, lon: -95.355509, roofed: true, parkFactor: 0.1, parkLabel: "Neutral/leve bateo (techo retractil)" },
  118: { name: "Kauffman Stadium", lat: 39.051567, lon: -94.480483, roofed: false, parkFactor: -0.25, parkLabel: "Favorece pitcheo" },
  119: { name: "Dodger Stadium", lat: 34.07368, lon: -118.24053, roofed: false, parkFactor: -0.15, parkLabel: "Leve pitcheo" },
  120: { name: "Nationals Park", lat: 38.872861, lon: -77.007501, roofed: false, parkFactor: 0, parkLabel: "Neutral" },
  121: { name: "Citi Field", lat: 40.75753012, lon: -73.84559155, roofed: false, parkFactor: -0.2, parkLabel: "Favorece pitcheo (leve)" }
};

let teamIdByNameCache = null;
async function getTeamIdMap() {
  if (teamIdByNameCache) return teamIdByNameCache;
  const data = await getJSON(`${MLB_BASE}/teams?sportId=1`);
  teamIdByNameCache = {};
  for (const t of data.teams ?? []) teamIdByNameCache[t.name] = t.id;
  return teamIdByNameCache;
}

// ---------- Lesionados/inactivos (roster de 40 de cada equipo) ----------
// A diferencia de NFL, MLB no tiene un endpoint de lesionados de toda la liga
// en una sola llamada -- pero el roster de 40 hombres de cada equipo ya trae
// el estado real por jugador (activo, lista de lesionados 7/10/15/60 dias,
// reasignado a ligas menores, etc). Cualquier estado que no sea "A" (Active)
// significa que ese jugador no esta disponible para jugar hoy.
let mlbInjuriesCache = null;
// Dias minimos reales por regla de MLB para cada lista de lesionados -- no es
// una estimacion nuestra, es la regla oficial (elegible a partir de ese dia,
// no necesariamente vuelve ese dia).
const IL_MIN_DAYS = { D7: 7, D10: 10, D15: 15, D60: 60 };

async function fetchMlbInjuries() {
  if (mlbInjuriesCache) return mlbInjuriesCache;
  const byPlayerId = {};
  const countByTeamId = {};
  try {
    const teamIdMap = await getTeamIdMap();
    const teamIds = Object.values(teamIdMap);
    const teamNameById = {};
    for (const [name, tid] of Object.entries(teamIdMap)) teamNameById[tid] = name;
    const todayStr = new Date().toISOString().slice(0, 10);
    const lookbackStr = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const id of teamIds) {
      try {
        const [roster, txnsData] = await Promise.all([
          getJSON(`${MLB_BASE}/teams/${id}/roster?rosterType=40Man`),
          getJSON(`${MLB_BASE}/transactions?teamId=${id}&startDate=${lookbackStr}&endDate=${todayStr}`).catch(() => ({ transactions: [] }))
        ]);
        // Para cada jugador, nos quedamos con la transaccion de "injured list"
        // mas reciente (effectiveDate mas nueva) -- un jugador puede pasar de
        // 10-day a 60-day, nos interesa la que explica su status actual.
        const latestIlTxn = {};
        for (const t of txnsData.transactions ?? []) {
          if (!/injured list/i.test(t.description ?? "")) continue;
          const pid = t.person?.id;
          if (!pid || !t.effectiveDate) continue;
          const prev = latestIlTxn[pid];
          if (!prev || new Date(t.effectiveDate) > new Date(prev.effectiveDate)) latestIlTxn[pid] = t;
        }
        for (const p of roster.roster ?? []) {
          if (p.status?.code && p.status.code !== "A") {
            const entry = {
              name: p.person.fullName, team: teamNameById[id] ?? null,
              code: p.status.code, description: p.status.description, note: p.note ?? null
            };
            const minDays = IL_MIN_DAYS[p.status.code];
            const txn = latestIlTxn[p.person.id];
            if (minDays && txn?.effectiveDate) {
              entry.since = txn.effectiveDate;
              const eligible = new Date(txn.effectiveDate);
              eligible.setUTCDate(eligible.getUTCDate() + minDays);
              entry.eligibleReturn = eligible.toISOString().slice(0, 10);
            }
            byPlayerId[p.person.id] = entry;
            // Para el ajuste de fuerza de equipo solo contamos lesiones reales
            // (codigos "D..." = lista de lesionados). "RM" (reasignado a ligas
            // menores) es rotacion normal de roster, no dice nada de si el
            // equipo llega mas debil a HOY -- contarlo diluiria la señal.
            if (p.status.code.startsWith("D")) {
              countByTeamId[id] = (countByTeamId[id] || 0) + 1;
            }
          }
        }
      } catch { /* seguimos con los demas equipos si uno falla */ }
    }
  } catch { /* seguimos sin filtro de lesionados si falla del todo */ }
  mlbInjuriesCache = { byPlayerId, countByTeamId };
  return mlbInjuriesCache;
}

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

// Abridores probables por partido, desde el calendario oficial (no depende de que
// odds-api.io haya posteado un prop de K para ese abridor, a diferencia de antes).
const probablePitchersCache = new Map();
async function fetchProbablePitchers(dateISO) {
  if (probablePitchersCache.has(dateISO)) return probablePitchersCache.get(dateISO);
  const map = {};
  try {
    // lineups viene en la misma llamada: homePlayers/awayPlayers solo estan
    // presentes cuando la alineacion ya se confirmo (tipicamente unas horas
    // antes del partido). Si no esta, dejamos lineup en null -- eso significa
    // "todavia no sabemos", no "no juega".
    const data = await getJSON(`${MLB_BASE}/schedule?sportId=1&date=${dateISO}&hydrate=probablePitcher,lineups`);
    for (const g of data.dates?.[0]?.games ?? []) {
      const away = g.teams.away.probablePitcher;
      const home = g.teams.home.probablePitcher;
      const lineups = g.lineups ?? {};
      map[`${g.teams.away.team.name}@${g.teams.home.team.name}`] = {
        away: away ? { id: away.id, name: away.fullName } : null,
        home: home ? { id: home.id, name: home.fullName } : null,
        awayLineup: lineups.awayPlayers?.length ? new Set(lineups.awayPlayers.map(p => p.id)) : null,
        homeLineup: lineups.homePlayers?.length ? new Set(lineups.homePlayers.map(p => p.id)) : null
      };
    }
  } catch { /* seguimos sin ajuste de abridor/lineup si falla */ }
  probablePitchersCache.set(dateISO, map);
  return map;
}

const pitcherHandCache = new Map();
async function getPitcherHand(pitcherId) {
  if (pitcherHandCache.has(pitcherId)) return pitcherHandCache.get(pitcherId);
  try {
    const data = await getJSON(`${MLB_BASE}/people/${pitcherId}`);
    const hand = data.people?.[0]?.pitchHand?.code ?? null;
    pitcherHandCache.set(pitcherId, hand);
    return hand;
  } catch {
    pitcherHandCache.set(pitcherId, null);
    return null;
  }
}

// Split del bateador contra la mano del abridor de hoy, temporada actual.
// Con menos de 15 turnos no confiamos en la muestra (queda null).
const batterSplitCache = new Map();
async function getBatterSplitVsHand(batterId, hand) {
  if (!hand) return null;
  const sitCode = hand === "L" ? "vl" : "vr";
  const key = `${batterId}-${sitCode}`;
  if (batterSplitCache.has(key)) return batterSplitCache.get(key);
  try {
    const data = await getJSON(
      `${MLB_BASE}/people/${batterId}/stats?stats=statSplits&group=hitting&season=${SEASON}&sitCodes=${sitCode}`
    );
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    const result = stat && stat.atBats >= 15
      ? { hrPerAB: (stat.homeRuns || 0) / stat.atBats, tbPerAB: (stat.totalBases || 0) / stat.atBats, atBats: stat.atBats }
      : null;
    batterSplitCache.set(key, result);
    return result;
  } catch {
    batterSplitCache.set(key, null);
    return null;
  }
}

// Forma reciente: promedio de los ultimos 15 partidos jugados, para pesarlo un
// poco junto al promedio de toda la temporada (una racha caliente o fria real).
const recentRateCache = new Map();
async function getBatterRecentRate(batterId) {
  if (recentRateCache.has(batterId)) return recentRateCache.get(batterId);
  try {
    const data = await getJSON(`${MLB_BASE}/people/${batterId}/stats?stats=gameLog&group=hitting&season=${SEASON}`);
    const fullLog = data.stats?.[0]?.splits ?? [];
    const log = fullLog.slice(-15);
    const last5 = fullLog.slice(-5);
    const totalAB = log.reduce((a, g) => a + (g.stat.atBats || 0), 0);
    const result = totalAB > 0 ? {
      hrPerAB: log.reduce((a, g) => a + (g.stat.homeRuns || 0), 0) / totalAB,
      tbPerAB: log.reduce((a, g) => a + (g.stat.totalBases || 0), 0) / totalAB,
      games: log.length,
      last5Hr: last5.reduce((a, g) => a + (g.stat.homeRuns || 0), 0),
      last5Games: last5.length
    } : null;
    recentRateCache.set(batterId, result);
    return result;
  } catch {
    recentRateCache.set(batterId, null);
    return null;
  }
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Combina parque + clima + split vs mano + historial puntual vs el abridor +
// forma reciente en un solo multiplicador sobre la tasa base (HR o TB por
// partido), mas un texto corto explicando que peso mas. Todo acotado para que
// una muestra chica (ej. 3 turnos de por vida contra un abridor) no dispare la
// proyeccion a un extremo -- esto es contexto real, no una certeza.
function buildAdjustment(statKey, seasonPerAB, ctx) {
  let mult = 1;
  const why = [];

  if (ctx.venue) {
    mult *= clamp(1 + ctx.venue.parkFactor * 0.12, 0.85, 1.15);
    if (Math.abs(ctx.venue.parkFactor) >= 0.15) why.push(`${ctx.venue.name} (${ctx.venue.parkLabel.toLowerCase()})`);
  }
  if (ctx.weather?.temp != null) {
    mult *= clamp(1 + (ctx.weather.temp - 70) * 0.0015, 0.94, 1.08);
    if (ctx.weather.temp >= 85) why.push(`${Math.round(ctx.weather.temp)}°F, el calor ayuda a la pelota a viajar`);
    else if (ctx.weather.temp <= 55) why.push(`${Math.round(ctx.weather.temp)}°F, el frío le resta distancia a la pelota`);
  }
  if (ctx.handSplit && seasonPerAB > 0) {
    const splitRate = statKey === "hr" ? ctx.handSplit.hrPerAB : ctx.handSplit.tbPerAB;
    const ratio = clamp(splitRate / seasonPerAB, 0.75, 1.35);
    mult *= ratio;
    if (Math.abs(ratio - 1) >= 0.1) {
      const handLabel = ctx.pitcherHand === "L" ? "zurdos" : "derechos";
      why.push(`${ratio > 1 ? "mejor" : "peor"} de lo normal vs lanzadores ${handLabel} esta temporada`);
    }
  }
  if (ctx.matchup && ctx.matchup.ab >= 8 && statKey === "hr" && seasonPerAB > 0) {
    const matchupRate = ctx.matchup.hr / ctx.matchup.ab;
    const ratio = clamp(matchupRate / seasonPerAB, 0.85, 1.2);
    mult *= ratio;
    why.push(`${ctx.matchup.hr} HR en ${ctx.matchup.ab} turnos de por vida vs ${ctx.pitcherName}`);
  }
  if (ctx.recentRate && seasonPerAB > 0) {
    const recentVal = statKey === "hr" ? ctx.recentRate.hrPerAB : ctx.recentRate.tbPerAB;
    const ratio = clamp(recentVal / seasonPerAB, 0.7, 1.4);
    mult *= (0.7 + ratio * 0.3); // se pesa mas suave: 15 partidos es muestra chica
    if (ratio >= 1.25) why.push(`en racha en los últimos ${ctx.recentRate.games} partidos`);
    else if (ratio <= 0.75) why.push(`bajón en los últimos ${ctx.recentRate.games} partidos`);
  }

  return { mult: clamp(mult, 0.6, 1.8), why: why.length ? why.join(" · ") : null };
}

// Un pick "de valor" no es solo edge positivo: tambien tiene que ser realista
// (nuestra propia proyeccion le da bastante chance de pasar) y tiene que dejar
// ganancia real si pasa. Sin esto, un edge matematico positivo puede colar
// falsos value picks tipo "99% de probabilidad a cuota 1.01" (no deja nada de
// ganancia) o "12% de probabilidad a cuota 15.00" (dificil que ocurra en la
// practica). No hay techo de cuota maxima: una cuota alta con probabilidad
// realista sigue siendo un pick valido, y no queremos descartar los mejores
// pagos a proposito.
const MIN_REALISTIC_PROB = 0.55;
// El HR es un evento de baja probabilidad por naturaleza -- ni el mejor bateador en el
// mejor matchup suele pasar de 35-40% de pegar uno en un partido puntual. Pedirle el
// mismo 55% que a Hits/Bases Totales/Moneyline dejaria esta categoria vacia siempre.
const MIN_REALISTIC_PROB_HR = 0.15;
const MIN_PAYOUT_ODDS = 1.20;
function isRealValue(edge, ourProb, odds, edgeThreshold, minProb = MIN_REALISTIC_PROB) {
  return edge >= edgeThreshold && ourProb >= minProb && odds >= MIN_PAYOUT_ODDS;
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

async function evaluateProp(prop, awayTeam, homeTeam, gameCtx) {
  const proj = await getPlayerProjection(prop.player);
  if (!proj) return null;
  // odds-api.io a veces mezcla props de jugadores que no juegan este partido
  // (visto en vivo: un prop de Home Runs de un jugador de otro equipo colado
  // en el mercado de un partido distinto). Si no coincide con ninguno de los
  // dos equipos, lo descartamos aunque tengamos datos del jugador.
  if (proj.team && proj.team !== awayTeam && proj.team !== homeTeam) return null;

  // Si la alineacion de hoy ya esta confirmada y este bateador no esta en ella,
  // no recomendamos el prop -- no tiene sentido proyectar un HR de alguien que
  // no va a jugar. Si todavia no se confirmo (lineup === null), no filtramos:
  // "no sabemos" no es lo mismo que "no juega".
  if (!proj.isPitcher && gameCtx) {
    const lineup = proj.team === homeTeam ? gameCtx.homeLineup : gameCtx.awayLineup;
    if (lineup && !lineup.has(proj.id)) return null;
  }

  // Lesionado o fuera del roster activo (lista de 7/10/15/60 dias, reasignado
  // a ligas menores, etc) -- no importa si el prop es de bateo o de pitcheo,
  // si no esta activo no va a jugar.
  const injuries = await fetchMlbInjuries();
  if (injuries.byPlayerId[proj.id]) return null;

  let ourProbOver = null;
  let why = null;
  let statLine = {};
  const opposingPitcher = gameCtx && (proj.team === homeTeam ? gameCtx.awayPitcher : gameCtx.homePitcher);
  const abPerGame = proj.abPerGame || 4;

  if (prop.market === "Pitcher Strikeouts O/U" && proj.isPitcher && proj.kPerStart) {
    ourProbOver = poissonProbOver(prop.line, proj.kPerStart);
  } else if (prop.market === "Hits O/U" && !proj.isPitcher && proj.avg != null) {
    // Hits O/U casi siempre es linea 0.5 (al menos 1 hit) -- modelo ya afinado,
    // no le metemos los ajustes de parque/clima/matchup de HR y TB. Si algun dia
    // aparece una linea de 1.5+ (2 o mas hits), se usa binomial exacto (no Poisson).
    ourProbOver = prop.line < 1
      ? binomialProbAtLeastOneHit(proj.avg, abPerGame)
      : binomialProbOver(prop.line, abPerGame, proj.avg);
  } else if (prop.market === "Home Runs O/U" && !proj.isPitcher && proj.hrPerGame != null) {
    const seasonHrPerAB = abPerGame > 0 ? proj.hrPerGame / abPerGame : 0;
    const [handSplit, matchup, recentRate] = await Promise.all([
      opposingPitcher?.hand ? getBatterSplitVsHand(proj.id, opposingPitcher.hand) : null,
      opposingPitcher?.id ? getMatchup(proj.id, opposingPitcher.id) : null,
      getBatterRecentRate(proj.id)
    ]);
    const adj = buildAdjustment("hr", seasonHrPerAB, {
      venue: gameCtx?.venue, weather: gameCtx?.weather, handSplit, matchup, recentRate,
      pitcherHand: opposingPitcher?.hand, pitcherName: opposingPitcher?.name
    });
    ourProbOver = poissonProbOver(prop.line, proj.hrPerGame * adj.mult);
    why = adj.why;
    statLine = {
      seasonHr: proj.seasonHr,
      gamesPlayed: proj.gamesPlayed,
      last5Hr: recentRate?.last5Hr ?? null,
      last5Games: recentRate?.last5Games ?? null
    };
  } else if (prop.market === "Total Bases O/U" && !proj.isPitcher && proj.tbPerGame != null) {
    const seasonTbPerAB = abPerGame > 0 ? proj.tbPerGame / abPerGame : 0;
    const [handSplit, recentRate] = await Promise.all([
      opposingPitcher?.hand ? getBatterSplitVsHand(proj.id, opposingPitcher.hand) : null,
      getBatterRecentRate(proj.id)
    ]);
    const adj = buildAdjustment("tb", seasonTbPerAB, {
      venue: gameCtx?.venue, weather: gameCtx?.weather, handSplit, matchup: null, recentRate,
      pitcherHand: opposingPitcher?.hand, pitcherName: opposingPitcher?.name
    });
    // Se escala cada tasa de hit por el mismo multiplicador contextual (parque,
    // clima, matchup, forma reciente) que antes se aplicaba directo al promedio
    // de bases totales -- el ajuste no cambia, solo el modelo de probabilidad
    // subyacente (convolucion exacta en vez de Poisson, ver comentario arriba).
    const mult = adj.mult;
    ourProbOver = totalBasesProbOver(prop.line, abPerGame, proj.p1b * mult, proj.p2b * mult, proj.p3b * mult, proj.phr * mult);
    why = adj.why;
    statLine = {
      seasonTb: proj.seasonTb,
      gamesPlayed: proj.gamesPlayed,
      tbPerGame: Math.round(proj.tbPerGame * 100) / 100
    };
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
    isValue: isRealValue(pick.edge, pick.ourProb, pick.odds, 0.08, prop.market === "Home Runs O/U" ? MIN_REALISTIC_PROB_HR : MIN_REALISTIC_PROB),
    pitcherHand: opposingPitcher?.hand ?? null,
    pitcherName: opposingPitcher?.name ?? null,
    why,
    ...statLine
  };
}

// ---------- Moneyline de valor, evaluado SOLO contra la cuota de Bovada ----------
// (para que un pick recomendado siempre sea jugable en la casa que el usuario realmente usa)
// Nota de lesionados para el pick de moneyline, cuando la diferencia es
// suficiente como para explicar parte del ajuste (no la mostramos si esta
// pareja, para no ensuciar picks donde no influyo en nada).
function injuryNoteForMoneyline(teamName, oppName, standingsMap) {
  const t = standingsMap[teamName]?.injuryCount ?? 0;
  const o = standingsMap[oppName]?.injuryCount ?? 0;
  if (t === o) return null;
  return t < o
    ? `${teamName} tiene menos lesionados en la lista (${t} vs ${o} de ${oppName})`
    : `${teamName} tiene mas lesionados en la lista (${t} vs ${o} de ${oppName}) — jugado a favor del rival`;
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
const BATTING_MARKETS = new Set(["Hits O/U", "Home Runs O/U", "Total Bases O/U"]);
const REUSE_EDGE_THRESHOLD = 0.20; // pick muy fuerte: se deja repetir en mas de un parlay igual

function buildParlays(allEvaluatedProps) {
  const valuePicks = allEvaluatedProps
    .filter(p => p.isValue)
    .sort((a, b) => b.edge - a.edge);
  const hitsPicks = valuePicks.filter(p => p.market === "Hits O/U");
  const hrPicks = valuePicks.filter(p => p.market === "Home Runs O/U");
  const tbPicks = valuePicks.filter(p => p.market === "Total Bases O/U");
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
  add(hitsPicks, 2, "Solo Hits (2 picks)", "hits");
  add(hitsPicks, 3, "Solo Hits (3 picks)", "hits");
  add(hrPicks, 2, "Solo HR (2 picks)", "hr");
  add(hrPicks, 3, "Solo HR (3 picks)", "hr");
  add(tbPicks, 2, "Solo Bases Totales (2 picks)", "tb");
  add(tbPicks, 3, "Solo Bases Totales (3 picks)", "tb");
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
    const dateISO = mlbDateKey(game.date);
    const gamePk = await getGamePk(game.home, dateISO);
    if (!gamePk) continue;
    const candidates = [...(game.props ?? []), ...(game.moneylinePicks ?? [])].filter(p => p.isValue);
    for (const p of candidates) {
      const record = {
        date: dateISO, gamePk, game: `${game.away} @ ${game.home}`,
        market: p.market, player: p.player, playerId: p.playerId ?? null,
        line: p.line ?? null, side: p.side, odds: p.odds, bookmaker: p.bookmaker,
        ourProb: p.ourProb, edge: p.edge, why: p.why ?? null
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

  // /odds/multi trae hasta 10 eventos por llamada y cuenta como 1 sola call,
  // en vez de gastar 1 call por partido (antes: hasta 60 calls por corrida).
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

      // Contexto del partido para ajustar HR/TB de bateadores: abridores probables
      // (calendario oficial, no depende de que odds-api.io haya posteado un prop
      // de K), su mano, el parque real del local y el clima real de la hora del
      // partido.
      const dateISO = mlbDateKey(ev.date);
      const [probablePitchers, teamIds] = await Promise.all([
        fetchProbablePitchers(dateISO),
        getTeamIdMap()
      ]);
      const pitcherPair = probablePitchers[`${ev.away}@${ev.home}`] ?? {};
      const venue = teamIds[ev.home] != null ? VENUES[teamIds[ev.home]] ?? null : null;
      const weather = venue ? await fetchWeather(venue, ev.date) : null;
      async function withHand(p) {
        if (!p) return null;
        return { id: p.id, name: p.name, hand: await getPitcherHand(p.id) };
      }
      const gameCtx = {
        venue, weather,
        awayPitcher: await withHand(pitcherPair.away),
        homePitcher: await withHand(pitcherPair.home),
        awayLineup: pitcherPair.awayLineup ?? null,
        homeLineup: pitcherPair.homeLineup ?? null
      };

      const evaluatedProps = [];
      for (const prop of rawProps) {
        const evaluated = await evaluateProp(prop, ev.away, ev.home, gameCtx);
        if (evaluated) {
          evaluatedProps.push(evaluated);
          allEvaluatedProps.push({ ...evaluated, game: `${ev.away} @ ${ev.home}` });
        }
      }

      // Historial bateador vs abridor rival, para los bateadores con props en este
      // partido (para mostrar en la tarjeta, no solo para el ajuste de HR).
      for (const prop of evaluatedProps) {
        if (!BATTING_MARKETS.has(prop.market)) continue;
        const proj = await getPlayerProjection(prop.player);
        if (!proj?.id || !proj.team) continue;
        const pitcher = proj.team === ev.home ? gameCtx.awayPitcher : gameCtx.homePitcher;
        if (!pitcher?.id) continue;
        const matchup = await getMatchup(proj.id, pitcher.id);
        if (matchup) prop.matchup = { pitcher: pitcher.name, ...matchup };
      }

      // Moneyline de valor, evaluado solo contra Bovada (asi siempre es jugable ahi).
      const moneylineLegs = evaluateMoneylineLegs(ev, gameOdds, standingsMap);
      moneylineLegs.forEach(leg => allEvaluatedProps.push({ ...leg, game: `${ev.away} @ ${ev.home}` }));

      const hasData = Object.keys(gameOdds.moneyline).length || Object.keys(gameOdds.total).length;
      if (hasData) withOdds++;

      games[`${ev.away}@${ev.home}@${dateISO}`] = {
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

  // Lista de lesionados visible en el sitio, filtrada a los equipos que juegan
  // en la ventana de partidos que estamos mostrando (si mostraramos las ~570
  // bajas de toda la liga no serviria de nada). Se ordena por fecha de regreso
  // elegible cuando la tenemos.
  const teamsInWindow = new Set();
  for (const g of Object.values(games)) { teamsInWindow.add(g.home); teamsInWindow.add(g.away); }
  const mlbInjuries = await fetchMlbInjuries().catch(() => ({ byPlayerId: {} }));
  const injuries = Object.values(mlbInjuries.byPlayerId ?? {})
    .filter(inj => inj.code.startsWith("D") && teamsInWindow.has(inj.team))
    .sort((a, b) => (a.eligibleReturn ?? "9999").localeCompare(b.eligibleReturn ?? "9999"));

  const output = {
    updatedAt: new Date().toISOString(),
    games,
    parlays,
    injuries
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
