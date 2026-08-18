const API_KEY = process.env.ODDS_API_KEY;
const BASE = "https://api.odds-api.io/v3";

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const events = await get(`/events?apiKey=${API_KEY}&sport=american-football&league=usa-nfl&status=pending&limit=15`);
  const soon = [...events].sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  console.log(`evento: id ${soon.id}, ${soon.away} @ ${soon.home}, ${soon.date}`);

  const odds = await get(`/odds?apiKey=${API_KEY}&eventId=${soon.id}&bookmakers=Bovada,Bet365`);
  for (const [bookmaker, markets] of Object.entries(odds.bookmakers ?? {})) {
    console.log(`\n=== ${bookmaker}: ${markets.length} mercados ===`);
    for (const m of markets) {
      console.log(`  ${m.name} (${m.odds.length} lineas)`);
    }
  }

  // Bloque completo de "Player Props" y de un mercado dedicado, para ver el formato exacto de label
  for (const [bookmaker, markets] of Object.entries(odds.bookmakers ?? {})) {
    const pp = markets.find(m => m.name === "Player Props");
    if (pp) console.log(`\n${bookmaker} Player Props sample:`, JSON.stringify(pp.odds.slice(0, 5)));
    const dedicated = markets.filter(m => m.name !== "Player Props" && m.name.includes("O/U") && !["Totals"].includes(m.name));
    for (const d of dedicated.slice(0, 4)) {
      console.log(`${bookmaker} "${d.name}" sample:`, JSON.stringify(d.odds.slice(0, 3)));
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
