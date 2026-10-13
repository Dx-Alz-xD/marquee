// npm run seed — (re)build data/catalog.tmdb.json from TMDB using TMDB_API_KEY in .env
import { seedTmdb } from '../server/catalog/tmdb';

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}
const key = process.env.TMDB_API_KEY?.trim();
if (!key) {
  console.error('TMDB_API_KEY is empty — paste your key into .env first.');
  process.exit(1);
}
seedTmdb(key).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
