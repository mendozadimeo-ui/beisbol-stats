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
// Nota: "spain-la-liga" (guion) no existe en odds-api.io, el slug real es
// "spain-laliga" -- estaba mal desde el principio, nunca trajo cuotas de La Liga.
//
// Europa League y Conference League llevan "source: odds-api" porque Big Balls
// Sports Data (fixtures/tabla) no las tiene en su catalogo en absoluto (confirmado
// contra la API real). Para esas dos armamos el fixture directo desde los eventos
// de odds-api.io en vez de BBS -- por eso no van a tener tabla de posiciones,
// la pestana de Posiciones lo va a mostrar como "sin tabla disponible", honesto.
//
// oddsLeagues es un array: en agosto las 3 copas UEFA todavia no arrancaron la
// fase de liga (arranca en septiembre), asi que el slug base esta vacio y lo
// unico con partidos reales es la variante "-playoff-round". Consultamos ambos
// slugs y los combinamos -- asi se ve la fase de playoff ahora, y en septiembre
// el slug base empieza a traer datos solo, sin tocar el codigo de nuevo.
const LEAGUES = {
  epl: { name: "Premier League", oddsLeagues: ["england-premier-league"] },
  laliga: { name: "La Liga", oddsLeagues: ["spain-laliga"] },
  seriea: { name: "Serie A", oddsLeagues: ["italy-serie-a"] },
  // UCL tambien via odds-api: el catalogo de BBS para esta liga esta desactualizado
  // (devuelve fixtures y tabla de la temporada 2025-26 anterior, ya terminada --
  // confirmado contra datos reales), asi que los partidos de la fase de playoff
  // de esta semana no aparecian nunca.
  ucl: {
    name: "Champions League",
    oddsLeagues: ["international-clubs-uefa-champions-league", "international-clubs-uefa-champions-league-playoff-round"],
    source: "odds-api"
  },
  uel: {
    name: "Europa League",
    oddsLeagues: ["international-clubs-uefa-europa-league", "international-clubs-uefa-europa-league-playoff-round"],
    source: "odds-api"
  },
  uecl: {
    name: "Conference League",
    oddsLeagues: ["international-clubs-uefa-conference-league", "international-clubs-uefa-conference-league-playoff-round"],
    source: "odds-api"
  }
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

// Los dos proveedores no escriben los nombres de club igual ("Arsenal" vs "Arsenal FC",
// "Atlético Madrid" vs "Atletico Madrid"). Sacamos acentos (NFD + quitar diacriticos)
// antes de sacar sufijos comunes, si no "Atlético" y "Atletico" no cruzan nunca --
// bug real que rompia el matching de cualquier equipo con tilde (La Liga, Serie A).
function normalizeTeam(name) {
  return (name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|cd|ac)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// ---------- Cuotas (odds-api.io) ----------
// /odds/multi trae hasta 10 eventos por llamada y cuenta como 1 sola call contra
// la cuota horaria (100/hora en el plan free) -- antes pedia 1 llamada de /odds
// POR EVENTO, lo que agotaba la cuota horaria en una sola corrida del pipeline
// (llegabamos a Europa League/Conference League, las ultimas ligas del loop, ya
// sin cuota, y quedaban sin ningun pick). Mismo patron que ya usan MLB/NBA/NFL.
async function fetchOddsMultiBatched(events) {
  const oddsById = new Map();
  for (let i = 0; i < events.length; i += 10) {
    const batch = events.slice(i, i + 10);
    await sleep(300);
    try {
      const eventIds = batch.map(ev => ev.id).join(",");
      const list = await getJSON(`${ODDS_BASE}/odds/multi?apiKey=${ODDS_API_KEY}&eventIds=${eventIds}&bookmakers=${BOOKMAKERS}`);
      for (const item of list) oddsById.set(item.id, item);
    } catch (e) {
      console.error(`  odds error batch (${batch.map(ev => ev.id).join(",")}):`, e.message);
    }
  }
  return oddsById;
}

async function fetchOddsForLeague(oddsLeagueSlugs) {
  const oddsByMatch = {}; // key: normAway|normHome -> {moneyline, total}
  for (const slug of oddsLeagueSlugs) {
    try {
      const events = await getJSON(
        `${ODDS_BASE}/events?apiKey=${ODDS_API_KEY}&sport=football&league=${slug}&status=pending&limit=40`
      );
      const cutoff = Date.now() + 5 * 24 * 60 * 60 * 1000; // solo los proximos 5 dias, para no gastar cuota en fixtures lejanos
      const soon = events.filter(ev => new Date(ev.date).getTime() <= cutoff);
      const oddsById = await fetchOddsMultiBatched(soon);
      for (const ev of soon) {
        const raw = oddsById.get(ev.id);
        if (!raw) continue;
        const parsed = extractFootballOdds(raw);
        const key = `${normalizeTeam(ev.away)}|${normalizeTeam(ev.home)}`;
        oddsByMatch[key] = parsed;
      }
    } catch (e) {
      console.error(`Odds no disponibles para ${slug}:`, e.message);
    }
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

// ---------- Props de jugador (ESPN) ----------
// BBS (fixtures/tabla) no tiene lineups ni stats individuales cargadas todavia para
// esta temporada -- confirmado en vivo contra la API real, no es un supuesto. ESPN
// si tiene (misma API no documentada que usa su propia web, sin key): roster, stats
// de temporada y "ultimos 5 partidos" por jugador (tiros, tiros al arco, goles,
// asistencias, tarjetas). Mismo patron que Baseball Savant en MLB -- no es un
// "proveedor" contratado, es un endpoint publico que se consulta con cuidado.
const ESPN_SITE_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_WEB_BASE = "https://site.web.api.espn.com/apis/common/v3/sports/soccer";
const ESPN_LEAGUE_SLUGS = { epl: "eng.1", laliga: "esp.1", seriea: "ita.1" };

// No tiene limite de cuota documentado, pero corre cada 2hs via GitHub Actions --
// sin cache, en un dia con muchos partidos se puede terminar pidiendo cientos de
// jugadores por corrida a un endpoint no oficial. Reusamos los stats de un equipo
// si se pidieron hace menos de 20hs (alcanza de sobra: el "ultimos 5 partidos" de
// un jugador no cambia entre dos corridas del mismo dia salvo que haya jugado).
const ESPN_STATS_MAX_AGE_MS = 20 * 60 * 60 * 1000;

async function fetchEspnTeamMap(espnLeague) {
  const map = new Map(); // nombre normalizado -> id de equipo ESPN
  try {
    const data = await getJSON(`${ESPN_SITE_BASE}/${espnLeague}/teams?limit=40`);
    const teams = data.sports?.[0]?.leagues?.[0]?.teams ?? [];
    for (const t of teams) map.set(normalizeTeam(t.team.displayName), t.team.id);
  } catch (e) {
    console.error(`  ESPN teams no disponible para ${espnLeague}:`, e.message);
  }
  return map;
}

async function fetchTeamRoster(espnLeague, teamId) {
  try {
    const data = await getJSON(`${ESPN_SITE_BASE}/${espnLeague}/teams/${teamId}/roster`);
    return (data.athletes ?? [])
      .filter(a => a.position?.abbreviation !== "G") // arqueros no aportan a tiros/goles
      .map(a => ({ id: a.id, name: a.fullName, position: a.position?.abbreviation ?? null }));
  } catch (e) {
    console.error(`  ESPN roster no disponible para equipo ${teamId}:`, e.message);
    return [];
  }
}

// El gameLog trae la columna "APP" como texto ("Started"/"Sub"), el resto son
// numeros en string -- si no se distingue, parseFloat("Started") da NaN.
function parseStatRow(labels, statsRow) {
  const row = {};
  labels.forEach((label, i) => {
    const raw = statsRow[i];
    row[label] = (raw === "Started" || raw === "Sub") ? 1 : (parseFloat(raw) || 0);
  });
  return row;
}

async function fetchAthleteFootballStats(espnLeague, athleteId, currentLeagueSlug) {
  try {
    const data = await getJSON(`${ESPN_WEB_BASE}/${espnLeague}/athletes/${athleteId}/overview`);
    const gameLogStat = data.gameLog?.statistics?.[0];
    const labels = gameLogStat?.labels ?? [];
    const rows = (gameLogStat?.events ?? []).map(e => parseStatRow(labels, e.stats));
    const gp = rows.length;
    const sum = key => rows.reduce((acc, r) => acc + (r[key] ?? 0), 0);
    const recent = gp ? {
      games: gp,
      shotsPerGame: Math.round((sum("SHOT") / gp) * 100) / 100,
      sogPerGame: Math.round((sum("SOG") / gp) * 100) / 100,
      goalsPerGame: Math.round((sum("G") / gp) * 100) / 100,
      yellowRate: Math.round((sum("YC") / gp) * 100) / 100
    } : null;

    const seasonLabels = data.statistics?.labels ?? [];
    const split = (data.statistics?.splits ?? []).find(s => s.leagueSlug === currentLeagueSlug);
    let season = null;
    if (split) {
      const row = parseStatRow(seasonLabels, split.stats);
      const gp2 = row.STRT || row.APP || 0;
      if (gp2 > 0) {
        season = {
          games: gp2,
          totalGoals: row.G ?? 0,
          totalShots: row.SHOT ?? 0,
          shotsPerGame: Math.round(((row.SHOT ?? 0) / gp2) * 100) / 100,
          sogPerGame: Math.round(((row.SOG ?? 0) / gp2) * 100) / 100,
          goalsPerGame: Math.round(((row.G ?? 0) / gp2) * 100) / 100
        };
      }
    }
    return { recent, season };
  } catch {
    return { recent: null, season: null };
  }
}

// P(X >= k) via Poisson -- mismo enfoque que el HR de MLB: evento contable acotado
// por partido, no una tasa libre.
function poissonProbAtLeast(lambda, k) {
  if (lambda <= 0) return 0;
  let cdf = 0;
  for (let i = 0; i < k; i++) cdf += poissonPMF(i, lambda);
  return Math.max(0, Math.min(1, 1 - cdf));
}

// Forma reciente pesa mas que el promedio de toda la temporada (mismo criterio que
// "ultimos 15 partidos" en MLB) -- 65/35. Si todavia no hay stats de liga actual
// (arranque de temporada, jugador recien transferido) usamos solo lo reciente.
function blendedLambda(recent, season, key) {
  if (recent && season) return recent[key] * 0.65 + season[key] * 0.35;
  if (recent) return recent[key];
  if (season) return season[key];
  return null;
}

function buildPlayerProps(player, stats, team, opponent) {
  const { recent, season } = stats;
  if (!recent && !season) return null;
  const gamesSeen = recent?.games ?? season?.games ?? 0;
  if (gamesSeen < 2) return null; // muestra insuficiente, no confiamos en la proyeccion
  const sogLambda = blendedLambda(recent, season, "sogPerGame");
  const goalLambda = blendedLambda(recent, season, "goalsPerGame");
  const props = [];
  if (sogLambda != null) {
    props.push({
      market: "Tiros al arco O/U", side: "over", line: 0.5, player: player.name, playerId: player.id,
      team, opponent, ourProb: Math.round(poissonProbAtLeast(sogLambda, 1) * 1000) / 1000
    });
  }
  if (goalLambda != null) {
    props.push({
      market: "Anota gol O/U", side: "over", line: 0.5, player: player.name, playerId: player.id,
      team, opponent, ourProb: Math.round(poissonProbAtLeast(goalLambda, 1) * 1000) / 1000
    });
  }
  props.forEach(p => {
    p.recent = recent; p.season = season;
  });
  return props;
}

// Orquesta ESPN para una liga: resuelve equipo->id, trae roster+stats (con cache
// de hasta 20hs) solo para los partidos de las proximas ~36hs, y arma playerProps
// por partido. No se toca para partidos mas lejanos -- se calculan cuando entren
// en esa ventana en una corrida posterior.
async function fetchLeaguePlayerProps(espnLeague, leagueSlug, leagueMatches, previousCache) {
  const cache = {};
  const teamMap = await fetchEspnTeamMap(espnLeague);
  const now = Date.now();
  const upcoming = leagueMatches.filter(m => {
    if (m.status === "finished") return false;
    const kickoff = new Date(m.kickoff).getTime();
    return kickoff - now < 36 * 60 * 60 * 1000 && kickoff - now > -3 * 60 * 60 * 1000;
  });
  if (!upcoming.length) return cache;

  async function statsForTeam(teamName) {
    const key = normalizeTeam(teamName);
    const cached = previousCache?.[key];
    if (cached && (now - new Date(cached.fetchedAt).getTime()) < ESPN_STATS_MAX_AGE_MS) {
      cache[key] = cached;
      return cached;
    }
    const teamId = teamMap.get(key);
    if (!teamId) return null;
    const roster = await fetchTeamRoster(espnLeague, teamId);
    const candidates = roster.slice(0, 10); // acota llamadas a un endpoint no oficial, sin key ni cuota documentada
    const players = [];
    for (const p of candidates) {
      await sleep(150);
      const stats = await fetchAthleteFootballStats(espnLeague, p.id, leagueSlug);
      if (stats.recent || stats.season) players.push({ id: p.id, name: p.name, position: p.position, recent: stats.recent, season: stats.season });
    }
    const entry = { teamId, fetchedAt: new Date().toISOString(), players };
    cache[key] = entry;
    return entry;
  }

  for (const m of upcoming) {
    const [homeEntry, awayEntry] = await Promise.all([statsForTeam(m.home), statsForTeam(m.away)]);
    const homeProps = (homeEntry?.players ?? []).flatMap(p => buildPlayerProps(p, { recent: p.recent, season: p.season }, m.home, m.away) ?? []);
    const awayProps = (awayEntry?.players ?? []).flatMap(p => buildPlayerProps(p, { recent: p.recent, season: p.season }, m.away, m.home) ?? []);
    m.playerProps = [...homeProps, ...awayProps];
  }
  return cache;
}

// ---------- Fuerza de equipos y modelo de Poisson (picks de valor) ----------
// A nivel de partido: fuerza de ataque/defensa de cada equipo relativa al promedio
// de goles de la liga (estandar de la industria para proyectar resultados de
// futbol), a partir de goles a favor/en contra reales de la tabla de posiciones.
// Con eso, dos Poisson independientes (goles de local, goles de visitante) dan la
// probabilidad de local/empate/visitante y de over/under.
function poissonPMF(k, lambda) {
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / f;
}

function computeLeagueStrength(standingsData) {
  const rows = standingsData?.standings?.[0]?.rows ?? [];
  const withGames = rows.filter(r => r.games_played > 0);
  if (!withGames.length) return null;
  const totalGoals = withGames.reduce((a, r) => a + (r.points_for || 0), 0);
  const totalGames = withGames.reduce((a, r) => a + r.games_played, 0);
  const leagueAvgGoals = totalGoals / totalGames;
  if (!leagueAvgGoals) return null;
  const teamStrength = {};
  for (const r of withGames) {
    teamStrength[r.team_name] = {
      attack: (r.points_for / r.games_played) / leagueAvgGoals,
      defense: (r.points_against / r.games_played) / leagueAvgGoals
    };
  }
  return { teamStrength, leagueAvgGoals };
}

const HOME_ADVANTAGE = 1.12; // ventaja de local tipica en futbol (~10-15% mas goles)
function expectedGoals(homeTeam, awayTeam, strength) {
  const h = strength.teamStrength[homeTeam], a = strength.teamStrength[awayTeam];
  if (!h || !a) return null;
  return {
    homeXG: strength.leagueAvgGoals * h.attack * a.defense * HOME_ADVANTAGE,
    awayXG: strength.leagueAvgGoals * a.attack * h.defense
  };
}

function matchProbabilities(homeXG, awayXG, maxGoals = 8) {
  let pHome = 0, pDraw = 0, pAway = 0, pOver25 = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonPMF(h, homeXG) * poissonPMF(a, awayXG);
      if (h > a) pHome += p; else if (h === a) pDraw += p; else pAway += p;
      if (h + a >= 3) pOver25 += p;
    }
  }
  return { pHome, pDraw, pAway, pOver25, pUnder25: 1 - pOver25 };
}

function decimalToImpliedProb(decimalOdds) {
  const d = parseFloat(decimalOdds);
  return d > 0 ? 1 / d : null;
}

// Mismo criterio de "value real" que MLB/NBA/NFL: edge positivo, probabilidad
// realista y cuota que deje ganancia real. Sin techo de cuota maxima. Ver
// fetch-odds.mjs para el razonamiento completo de por que se agrego esto.
const MIN_REALISTIC_PROB = 0.55;
const MIN_PAYOUT_ODDS = 1.20;
function isRealValue(edge, ourProb, odds, edgeThreshold) {
  return edge >= edgeThreshold && ourProb >= MIN_REALISTIC_PROB && odds >= MIN_PAYOUT_ODDS;
}

function evaluateFootballPicks(match, strength) {
  if (!match.odds || !strength) return [];
  const xg = expectedGoals(match.home, match.away, strength);
  if (!xg) return [];
  const probs = matchProbabilities(xg.homeXG, xg.awayXG);
  const picks = [];

  const mlBook = match.odds.moneyline?.Bovada ? "Bovada" : Object.keys(match.odds.moneyline ?? {})[0];
  const ml = mlBook ? match.odds.moneyline[mlBook] : null;
  if (ml) {
    const outcomes = [
      { side: "home", team: match.home, ourProb: probs.pHome, odds: ml.home },
      { side: "draw", team: null, ourProb: probs.pDraw, odds: ml.draw },
      { side: "away", team: match.away, ourProb: probs.pAway, odds: ml.away }
    ];
    for (const o of outcomes) {
      const implied = decimalToImpliedProb(o.odds);
      if (implied == null) continue;
      const edge = Math.round((o.ourProb - implied) * 1000) / 1000;
      picks.push({
        market: "Moneyline", side: o.side, team: o.team,
        odds: o.odds, bookmaker: mlBook,
        ourProb: Math.round(o.ourProb * 1000) / 1000, impliedProb: Math.round(implied * 1000) / 1000,
        edge, isValue: isRealValue(edge, o.ourProb, o.odds, 0.08)
      });
    }
  }

  const totalBooks = Object.keys(match.odds.total ?? {});
  const totalBook = totalBooks.includes("Bovada") ? "Bovada" : totalBooks[0];
  const t = totalBook ? match.odds.total[totalBook] : null;
  if (t && Math.abs(t.line - 2.5) < 0.1) { // solo evaluamos si la linea real es ~2.5
    const outcomes = [
      { side: "over", ourProb: probs.pOver25, odds: t.over },
      { side: "under", ourProb: probs.pUnder25, odds: t.under }
    ];
    for (const o of outcomes) {
      const implied = decimalToImpliedProb(o.odds);
      if (implied == null) continue;
      const edge = Math.round((o.ourProb - implied) * 1000) / 1000;
      picks.push({
        market: "Total 2.5 goles", side: o.side, team: null,
        odds: o.odds, bookmaker: totalBook,
        ourProb: Math.round(o.ourProb * 1000) / 1000, impliedProb: Math.round(implied * 1000) / 1000,
        edge, isValue: isRealValue(edge, o.ourProb, o.odds, 0.08)
      });
    }
  }
  return picks;
}

// Parlays: solo con picks de la misma casa (jugable en un solo lugar), sin repetir
// el mismo partido dos veces dentro del mismo combo.
function buildFootballParlays(matches) {
  const valuePicks = [];
  for (const m of matches) {
    for (const p of m.picks ?? []) {
      if (p.isValue) valuePicks.push({ ...p, game: `${m.away} @ ${m.home}` });
    }
  }
  if (!valuePicks.length) return [];
  valuePicks.sort((a, b) => b.edge - a.edge);

  const counts = {};
  for (const p of valuePicks) counts[p.bookmaker] = (counts[p.bookmaker] || 0) + 1;
  const bestBookmaker = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const pool = valuePicks.filter(p => p.bookmaker === bestBookmaker);

  function toParlay(legs, label) {
    if (legs.length < 2) return null;
    const combinedOdds = legs.reduce((acc, l) => acc * parseFloat(l.odds), 1);
    const combinedProb = legs.reduce((acc, l) => acc * l.ourProb, 1);
    return {
      label, bookmaker: bestBookmaker,
      legs: legs.map(l => ({ team: l.team, market: l.market, side: l.side, odds: l.odds, ourProb: l.ourProb, game: l.game })),
      combinedOdds: Math.round(combinedOdds * 100) / 100,
      combinedProb: Math.round(combinedProb * 1000) / 1000
    };
  }
  function pickLegs(count) {
    const legs = [];
    const usedGames = new Set();
    for (const p of pool) {
      if (legs.length >= count) break;
      if (usedGames.has(p.game)) continue;
      legs.push(p);
      usedGames.add(p.game);
    }
    return legs;
  }
  return [toParlay(pickLegs(2), "Value picks (2)"), toParlay(pickLegs(3), "Value picks (3)")].filter(Boolean);
}

// ---------- Fixtures y tabla (BBS) ----------
async function fetchLeagueData(leagueKey) {
  const [matchesRes, standingsRes] = await Promise.all([
    bbsGet(`/matches?sport=football&league=${leagueKey}`).catch(() => ({ data: [] })),
    bbsGet(`/standings?sport=football&league=${leagueKey}`).catch(() => ({ data: null }))
  ]);
  return { matches: matchesRes.data ?? [], standings: standingsRes.data ?? null };
}

// ---------- Fixtures directo desde odds-api.io (ligas sin datos en BBS) ----------
// El mismo evento nos da equipos + fecha + cuotas en una sola pasada. No hay tabla
// de posiciones posible por esta via (odds-api.io no la tiene).
async function fetchOddsApiFixtures(oddsLeagueSlugs) {
  const seenIds = new Set();
  const soonEvents = [];
  for (const slug of oddsLeagueSlugs) {
    try {
      const events = await getJSON(
        `${ODDS_BASE}/events?apiKey=${ODDS_API_KEY}&sport=football&league=${slug}&status=pending&limit=40`
      );
      const cutoff = Date.now() + 5 * 24 * 60 * 60 * 1000;
      for (const ev of events) {
        if (new Date(ev.date).getTime() > cutoff) continue;
        if (seenIds.has(ev.id)) continue;
        seenIds.add(ev.id);
        soonEvents.push(ev);
      }
    } catch (e) {
      console.error(`Fixtures odds-api no disponibles para ${slug}:`, e.message);
    }
  }
  const oddsById = await fetchOddsMultiBatched(soonEvents);
  return soonEvents.map(ev => ({
    id: ev.id, home: ev.home, homeLogo: null, away: ev.away, awayLogo: null,
    kickoff: ev.date, status: ev.status === "pending" ? "scheduled" : ev.status,
    score: ev.status !== "pending" && ev.scores ? { home: ev.scores.home, away: ev.scores.away } : null,
    odds: oddsById.has(ev.id) ? extractFootballOdds(oddsById.get(ev.id)) : null
  }));
}

// ---------- Historial y calificacion (solo en ligas con modelo: EPL/LaLiga/SerieA) ----------
// UCL/UEL/UECL no tienen tabla de posiciones -> no tienen picks -> no hay nada
// que registrar ahi. Mismo patron que fetch-odds.mjs/fetch-nfl.mjs.
const HISTORY_PATH = "data/football-history.json";
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

function pickHistoryId(pick) {
  return `${pick.matchId}|${pick.market}|${pick.side}`;
}

function recordPicks(leagueKey, leagueName, matches, history) {
  const known = new Set([...history.pending, ...history.graded].map(p => p.id));
  for (const m of matches) {
    for (const p of m.picks ?? []) {
      if (!p.isValue) continue;
      const record = {
        matchId: m.id, league: leagueKey, leagueName,
        game: `${m.away} @ ${m.home}`, home: m.home, away: m.away, kickoff: m.kickoff,
        market: p.market, side: p.side, team: p.team ?? null,
        odds: p.odds, bookmaker: p.bookmaker, ourProb: p.ourProb, edge: p.edge
      };
      const id = pickHistoryId(record);
      if (known.has(id)) continue;
      known.add(id);
      history.pending.push({ id, ...record, recordedAt: new Date().toISOString() });
    }
  }
}

function gradePick(pick, match) {
  if (match.status !== "finished" || !match.score) return null;
  const hs = match.score.home, as = match.score.away;
  if (hs == null || as == null) return null;
  if (pick.market === "Moneyline") {
    const outcome = hs > as ? "home" : hs < as ? "away" : "draw";
    const won = pick.side === outcome;
    return { result: won ? "win" : "loss", actual: `${match.away} ${as} - ${match.home} ${hs}` };
  }
  if (pick.market === "Total 2.5 goles") {
    const totalGoals = hs + as;
    const over = totalGoals > 2.5;
    const won = pick.side === "over" ? over : !over;
    return { result: won ? "win" : "loss", actual: `${totalGoals} goles` };
  }
  return null;
}

function gradePendingPicks(matchesByLeague, history) {
  const matchById = {};
  for (const matches of Object.values(matchesByLeague)) {
    for (const m of matches) matchById[m.id] = m;
  }
  const stillPending = [];
  for (const pick of history.pending) {
    const daysOld = (Date.now() - new Date(pick.recordedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysOld > 10) continue; // partido cancelado/suspendido/postergado, no lo arrastramos para siempre
    const match = matchById[pick.matchId];
    if (!match) { stillPending.push(pick); continue; }
    const graded = gradePick(pick, match);
    if (!graded) { stillPending.push(pick); continue; }
    history.graded.unshift({ ...pick, ...graded, gradedAt: new Date().toISOString() });
  }
  history.pending = stillPending;
  history.graded = history.graded.slice(0, 400);
}

async function main() {
  // Si odds-api.io esta con la cuota agotada, un fetch fallido de una liga que
  // depende 100% de esa API (UCL/UEL/UECL) devuelve [] -- sin esto, esa corrida
  // pisaria partidos reales de la corrida anterior con "no hay nada". Guardamos
  // el snapshot previo para no perder datos buenos por una falla temporal.
  let previous = null;
  try {
    const fs = await import("node:fs/promises");
    previous = JSON.parse(await fs.readFile("data/football.json", "utf8"));
  } catch { /* primera corrida, o archivo corrupto: segui sin fallback */ }

  const output = { updatedAt: new Date().toISOString(), leagues: {}, matches: {}, standings: {}, parlays: {}, playerStatsCache: {} };
  const history = await loadHistory();

  for (const [key, cfg] of Object.entries(LEAGUES)) {
    output.leagues[key] = cfg.name;
    console.log(`Trayendo ${cfg.name}...`);

    if (cfg.source === "odds-api") {
      // Sin tabla de posiciones por esta via -> sin modelo de fuerza de equipos ->
      // sin picks para estas 3 ligas. Mismo criterio de honestidad que con la tabla.
      output.standings[key] = null;
      const fresh = ODDS_API_KEY ? await fetchOddsApiFixtures(cfg.oddsLeagues) : [];
      output.matches[key] = fresh.length ? fresh : (previous?.matches?.[key] ?? []);
      output.parlays[key] = [];
      continue;
    }

    const { matches, standings } = await fetchLeagueData(key);
    output.standings[key] = standings;
    const strength = computeLeagueStrength(standings);

    let oddsByMatch = {};
    if (ODDS_API_KEY && cfg.oddsLeagues) {
      oddsByMatch = await fetchOddsForLeague(cfg.oddsLeagues);
    }

    const leagueMatches = matches.map(m => {
      const oddsKey = `${normalizeTeam(m.away.name)}|${normalizeTeam(m.home.name)}`;
      const odds = oddsByMatch[oddsKey] ?? null;
      const match = {
        id: m.id,
        home: m.home.name, homeLogo: m.home.logo_url,
        away: m.away.name, awayLogo: m.away.logo_url,
        kickoff: m.kickoff_utc, status: m.status, score: m.score,
        odds
      };
      match.picks = strength ? evaluateFootballPicks(match, strength) : [];
      return match;
    });

    const espnLeague = ESPN_LEAGUE_SLUGS[key];
    if (espnLeague) {
      try {
        output.playerStatsCache[key] = await fetchLeaguePlayerProps(
          espnLeague, espnLeague, leagueMatches, previous?.playerStatsCache?.[key]
        );
      } catch (e) {
        console.error(`  Props de jugador (ESPN) fallaron para ${cfg.name}:`, e.message);
        output.playerStatsCache[key] = previous?.playerStatsCache?.[key] ?? {};
      }
    }

    output.matches[key] = leagueMatches;
    output.parlays[key] = buildFootballParlays(leagueMatches);
    recordPicks(key, cfg.name, leagueMatches, history);
  }

  gradePendingPicks(output.matches, history);
  await saveHistory(history);

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/football.json", JSON.stringify(output, null, 2));

  const totalMatches = Object.values(output.matches).reduce((a, arr) => a + arr.length, 0);
  const withOdds = Object.values(output.matches).reduce((a, arr) => a + arr.filter(m => m.odds).length, 0);
  const valuePicks = Object.values(output.matches).reduce((a, arr) => a + arr.reduce((b, m) => b + (m.picks ?? []).filter(p => p.isValue).length, 0), 0);
  const wins = history.graded.filter(p => p.result === "win").length;
  const losses = history.graded.filter(p => p.result === "loss").length;
  const playerPropsCount = Object.values(output.matches).reduce((a, arr) => a + arr.reduce((b, m) => b + (m.playerProps?.length ?? 0), 0), 0);
  console.log(`Listo: ${Object.keys(LEAGUES).length} ligas, ${totalMatches} partidos, ${withOdds} con cuotas, ${valuePicks} value picks, ${playerPropsCount} props de jugador (ESPN). Historial: ${wins}-${losses} (${history.pending.length} pendientes).`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
