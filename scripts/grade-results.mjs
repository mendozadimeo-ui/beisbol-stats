// Corre cada pocos minutos (GitHub Actions) para calificar picks pendientes
// apenas termina su partido -- separado a proposito del pipeline principal
// (fetch-odds.mjs, que corre cada 1-2hs): esto SOLO usa la API de MLB (gratis,
// sin limite), nunca odds-api.io, asi que puede correr todo lo seguido que
// haga falta sin tocar la cuota compartida de cuotas con futbol/NFL. El
// pipeline principal tambien califica en su propia corrida (queda mas robusto
// si este workflow liviano fallara), pero con esto Resultados se actualiza
// casi en vivo sin esperar a la proxima corrida de cuotas.

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
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
  let gradedNow = 0;
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
      gradedNow++;
    } catch {
      stillPending.push(pick);
    }
  }
  history.pending = stillPending;
  history.graded = history.graded.slice(0, 400);
  return gradedNow;
}

async function main() {
  const fs = await import("node:fs/promises");
  let history;
  try {
    history = JSON.parse(await fs.readFile("data/history.json", "utf8"));
  } catch {
    console.log("No hay data/history.json todavia -- nada que calificar.");
    return;
  }
  const gradedNow = await gradePendingPicks(history);
  await fs.writeFile("data/history.json", JSON.stringify(history, null, 2));
  console.log(`Calificados ${gradedNow} picks nuevos. Pendientes: ${history.pending.length}, calificados totales: ${history.graded.length}.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
