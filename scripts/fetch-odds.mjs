// Corre periodicamente (GitHub Actions) y guarda un snapshot estatico en data/odds.json.
// El sitio nunca llama a odds-api.io directamente: asi la API key no queda expuesta
// en el navegador y no se gasta la cuota gratuita (100/hora, 500/dia) por cada visita.

const API_KEY = process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error("Falta la variable de entorno ODDS_API_KEY");
  process.exit(1);
}

const BOOKMAKERS = "Bet365,DraftKings";
const BASE = "https://api.odds-api.io/v3";

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

// Nombres exactos confirmados contra la API real (odds-api.io usa "ML" y "Totals"
// para las lineas de partido completo; hay decoys parecidos como "Team Total Home",
// "First 5 Innings Totals" o "Alternative Run Line" que NO son el total del partido).
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const allEvents = await getJSON(
    `${BASE}/events?apiKey=${API_KEY}&sport=baseball&league=usa-mlb&status=pending&limit=60`
  );

  // Las lineas de ML/Totals recien aparecen horas antes del primer lanzamiento,
  // asi que no tiene sentido (ni ahorra cuota) pedir partidos muy lejanos.
  const cutoff = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const events = allEvents.filter(ev => new Date(ev.date).getTime() <= cutoff);

  const games = {};
  let withOdds = 0;

  for (const ev of events) {
    try {
      await sleep(300);
      const odds = await getJSON(`${BASE}/odds?apiKey=${API_KEY}&eventId=${ev.id}&bookmakers=${BOOKMAKERS}`);
      const parsed = extractGameOdds(odds);
      const hasData = Object.keys(parsed.moneyline).length || Object.keys(parsed.total).length;
      if (hasData) withOdds++;
      games[`${ev.away}@${ev.home}@${ev.date.slice(0, 10)}`] = {
        home: ev.home,
        away: ev.away,
        date: ev.date,
        ...parsed
      };
    } catch (e) {
      console.error(`Error en evento ${ev.id}:`, e.message);
    }
  }

  const output = {
    updatedAt: new Date().toISOString(),
    games
  };

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/odds.json", JSON.stringify(output, null, 2));
  console.log(`Listo: ${Object.keys(games).length} partidos, ${withOdds} con cuotas de moneyline/total disponibles.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
