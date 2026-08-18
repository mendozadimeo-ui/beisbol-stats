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

async function main() {
  await get(`/sports?apiKey=${API_KEY}`);
  await get(`/leagues?sport=football&apiKey=${API_KEY}`);

  for (const [sport, league] of [["football", "usa-nfl"], ["football", "nfl"], ["american-football", "usa-nfl"]]) {
    const events = await get(`/events?apiKey=${API_KEY}&sport=${sport}&league=${league}&status=pending&limit=15`, false);
    if (!events || !events.length) { console.log(`\n${league}: sin eventos`); continue; }
    const soon = [...events].sort((a, b) => new Date(a.date) - new Date(b.date))[0];
    console.log(`\n${league}: ${events.length} eventos, mas cercano ${soon.date} (id ${soon.id}, ${soon.away} @ ${soon.home})`);
    const odds = await get(`/odds?apiKey=${API_KEY}&eventId=${soon.id}&bookmakers=Bovada,Bet365`, false);
    if (!odds) continue;
    const marketNames = new Set();
    for (const arr of Object.values(odds.bookmakers ?? {})) {
      for (const m of arr) marketNames.add(m.name);
    }
    console.log(`${league} mercados:`, [...marketNames]);
    console.log(`${league} odds completo:`, JSON.stringify(odds).slice(0, 3500));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
