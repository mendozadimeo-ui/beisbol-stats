const API_KEY = process.env.ODDS_API_KEY;
const BASE = "https://api.odds-api.io/v3";

async function check(slug) {
  const res = await fetch(`${BASE}/events?apiKey=${API_KEY}&sport=football&league=${slug}&status=pending&limit=10`);
  const text = await res.text();
  console.log(`\n--- ${slug} -> ${res.status} ---`);
  console.log(text.slice(0, 800));
}

async function main() {
  for (const slug of [
    "international-clubs-uefa-champions-league",
    "international-clubs-uefa-champions-league-playoff-round",
    "international-clubs-uefa-europa-league",
    "international-clubs-uefa-europa-league-playoff-round",
    "international-clubs-uefa-conference-league",
    "international-clubs-uefa-conference-league-playoff-round",
    "spain-laliga",
    "italy-serie-a"
  ]) {
    await check(slug);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
