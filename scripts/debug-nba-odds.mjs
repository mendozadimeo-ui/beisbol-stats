const API_KEY = process.env.ODDS_API_KEY;
const BASE = "https://api.odds-api.io/v3";

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  console.log(`\n--- GET ${path.replace(API_KEY, "***")} -> ${res.status} ---`);
  console.log(text.slice(0, 4000));
  if (!res.ok) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  await get(`/leagues?sport=basketball&apiKey=${API_KEY}`);

  for (const league of ["usa-nba", "nba", "basketball-nba"]) {
    const events = await get(`/events?apiKey=${API_KEY}&sport=basketball&league=${league}&status=pending&limit=5`);
    if (events && events.length) {
      console.log(`\n=== liga correcta: ${league}, ${events.length} eventos ===`);
      const odds = await get(`/odds?apiKey=${API_KEY}&eventId=${events[0].id}&bookmakers=Bovada,Bet365`);
      if (odds) {
        const markets = new Set();
        for (const arr of Object.values(odds.bookmakers ?? {})) {
          for (const m of arr) markets.add(m.market);
        }
        console.log("\n=== mercados encontrados ===", [...markets]);
      }
      break;
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
