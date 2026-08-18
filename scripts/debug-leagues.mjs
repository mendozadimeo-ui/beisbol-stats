const BBS_API_KEY = process.env.BBS_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;

async function get(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) { console.log(`FAIL ${res.status} ${url}`); return null; }
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  const bbs = await get("https://api.bigballsdata.com/v1/leagues?sport=football", { Authorization: `Bearer ${BBS_API_KEY}` });
  console.log("=== BBS leagues (football) ===");
  console.log(JSON.stringify(bbs).slice(0, 6000));

  const odds = await get(`https://api.odds-api.io/v3/leagues?sport=football&apiKey=${ODDS_API_KEY}`);
  console.log("\n=== odds-api.io leagues (football), filtro europa/uefa ===");
  const filtered = (odds ?? []).filter(l => /uefa|europa|conference|england|spain|italy/i.test(l.name ?? l.slug ?? ""));
  console.log(JSON.stringify(filtered));
}

main().catch(e => { console.error(e); process.exit(1); });
