const API_KEY = process.env.ODDS_API_KEY;
const BASE = "https://api.odds-api.io/v3";

async function get(path, log = true) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  if (log) {
    console.log(`\n--- GET ${path.replace(API_KEY, "***")} -> ${res.status} ---`);
    console.log(text.slice(0, 4000));
  }
  if (!res.ok) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function checkLeague(league, wantProps) {
  const events = await get(`/events?apiKey=${API_KEY}&sport=basketball&league=${league}&status=pending&limit=15`, false);
  if (!events || !events.length) { console.log(`\n${league}: sin eventos`); return; }
  const soon = [...events].sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  console.log(`\n${league}: ${events.length} eventos, mas cercano ${soon.date} (id ${soon.id})`);
  const odds = await get(`/odds?apiKey=${API_KEY}&eventId=${soon.id}&bookmakers=Bovada,Bet365`, false);
  if (!odds) return;
  const marketNames = new Set();
  for (const arr of Object.values(odds.bookmakers ?? {})) {
    for (const m of arr) marketNames.add(m.name);
  }
  console.log(`${league} mercados:`, [...marketNames]);
  if (wantProps) console.log(`${league} odds completo:`, JSON.stringify(odds).slice(0, 3000));
}

async function main() {
  await checkLeague("usa-nba", false);
  for (const league of ["germany-bbl", "france-lnb-elite-2", "australia-nbl"]) {
    await checkLeague(league, true);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
