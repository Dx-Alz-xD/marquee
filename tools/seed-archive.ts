// Builds data/catalog.open.json — full-length, legally free films that anyone
// in the room can stream: public-domain classics from the Internet Archive and
// Blender's open movies. Metadata is hand-curated; the script only resolves and
// verifies a direct, playable MP4 for each title.
//
//   npm run seed:archive
import { writeFileSync } from 'node:fs';
import type { Movie } from '../shared/types';

interface Curated {
  title: string;
  year: number;
  genres: string[];
  director: string;
  cast: string[];
  overview: string;
  keywords: string[];
  /** Pin a known archive identifier (skips search). */
  id?: string;
  query?: string;
  source?: 'archive' | 'open';
  rating?: number;
}

const CURATED: Curated[] = [
  // ── Blender open movies ──
  { title: 'Big Buck Bunny', year: 2008, genres: ['Animation', 'Comedy', 'Family'], director: 'Sacha Goedegebure', cast: [], overview: 'A giant, gentle rabbit is pushed too far by three bullying rodents — and plans a gloriously over-engineered revenge.', keywords: ['rabbit', 'revenge', 'forest', 'open movie'], id: 'BigBuckBunny_124', source: 'open', rating: 7.2 },
  { title: 'Sintel', year: 2010, genres: ['Animation', 'Fantasy', 'Adventure'], director: 'Colin Levy', cast: ['Halina Reijn', 'Thom Hoffman'], overview: 'A lonely young woman searches the world for the baby dragon she raised — and discovers what the journey has turned her into.', keywords: ['dragon', 'quest', 'twist ending', 'open movie'], id: 'Sintel', source: 'open', rating: 7.4 },
  { title: 'Elephants Dream', year: 2006, genres: ['Animation', 'Science Fiction'], director: 'Bassam Kurdali', cast: ['Tygo Gernandt', 'Cas Jansen'], overview: 'Two men explore an infinite, surreal machine — one sees wonders, the other sees only his own version of reality.', keywords: ['surreal', 'machine', 'reality', 'mind', 'open movie'], id: 'ElephantsDream', source: 'open', rating: 6.4 },
  { title: 'Tears of Steel', year: 2012, genres: ['Science Fiction', 'Action'], director: 'Ian Hubert', cast: ['Derek de Lint', 'Sergio Hasselbaink'], overview: 'In a future Amsterdam overrun by robots, a group of scientists stage a desperate memory-rewriting experiment to save the world.', keywords: ['robots', 'memory', 'time', 'amsterdam', 'open movie'], query: 'tears of steel', source: 'open', rating: 6.6 },
  { title: 'Cosmos Laundromat', year: 2015, genres: ['Animation', 'Comedy', 'Fantasy'], director: 'Mathieu Auvray', cast: ['Pierre Bokma', 'Reinout Scholten van Aschat'], overview: 'A suicidal sheep on a desolate island meets a mysterious salesman who offers him the gift of a lifetime — many lifetimes.', keywords: ['sheep', 'alternate reality', 'parallel worlds', 'open movie'], query: 'cosmos laundromat', source: 'open', rating: 7.1 },
  // ── Public-domain classics ──
  { title: 'Night of the Living Dead', year: 1968, genres: ['Horror', 'Thriller'], director: 'George A. Romero', cast: ['Duane Jones', "Judith O'Dea", 'Karl Hardman'], overview: 'Strangers barricade themselves in a Pennsylvania farmhouse as the recently dead rise and lay siege — the film that invented the modern zombie.', keywords: ['zombie', 'siege', 'farmhouse', 'survival'], rating: 7.8, id: 'night_of_the_living_dead_dvd' },
  { title: 'His Girl Friday', year: 1940, genres: ['Comedy', 'Romance'], director: 'Howard Hawks', cast: ['Cary Grant', 'Rosalind Russell', 'Ralph Bellamy'], overview: 'A ruthless newspaper editor uses every trick he knows to stop his star reporter — and ex-wife — from quitting to remarry. Dialogue at machine-gun speed.', keywords: ['newspaper', 'screwball', 'divorce', 'reporter'], rating: 7.8 },
  { title: 'Charade', year: 1963, genres: ['Mystery', 'Romance', 'Comedy', 'Thriller'], director: 'Stanley Donen', cast: ['Cary Grant', 'Audrey Hepburn', 'Walter Matthau'], overview: "A widow in Paris is hunted by her late husband's associates for a fortune she knows nothing about, aided by a charming stranger with too many names.", keywords: ['paris', 'stolen money', 'twist', 'con man'], rating: 7.8, query: 'title:(charade) AND year:1963' },
  { title: 'Nosferatu', year: 1922, genres: ['Horror', 'Fantasy'], director: 'F. W. Murnau', cast: ['Max Schreck', 'Gustav von Wangenheim', 'Greta Schröder'], overview: 'Count Orlok, a vampire of terrible stillness, travels by ship to a German port town — bringing plague, and an unforgettable shadow.', keywords: ['vampire', 'silent film', 'expressionism', 'plague'], rating: 7.9 },
  { title: 'The General', year: 1926, genres: ['Comedy', 'Action', 'Adventure'], director: 'Buster Keaton', cast: ['Buster Keaton', 'Marion Mack'], overview: 'A train engineer single-handedly chases down the soldiers who stole his locomotive — with the girl he loves on board. Stunts that still look impossible.', keywords: ['train', 'chase', 'silent film', 'stunts'], query: 'the general buster keaton 1926', rating: 8.1 },
  { title: 'Sherlock Jr.', year: 1924, genres: ['Comedy', 'Fantasy'], director: 'Buster Keaton', cast: ['Buster Keaton', 'Kathryn McGuire'], overview: 'A projectionist who dreams of being a detective falls asleep and walks straight into the movie on screen.', keywords: ['dream', 'movie within a movie', 'detective', 'silent film'], query: 'sherlock jr 1924', rating: 8.2 },
    { title: 'The Gold Rush', year: 1925, genres: ['Comedy', 'Adventure', 'Romance'], director: 'Charlie Chaplin', cast: ['Charlie Chaplin', 'Georgia Hale', 'Mack Swain'], overview: 'The Lone Prospector braves the Klondike, a starving cabin-mate and a boot for dinner in search of gold and love.', keywords: ['klondike', 'gold', 'silent film', 'tramp'], query: 'the gold rush chaplin 1925', rating: 8.1 },
  { title: 'Metropolis', year: 1927, genres: ['Science Fiction', 'Drama'], director: 'Fritz Lang', cast: ['Brigitte Helm', 'Gustav Fröhlich', 'Alfred Abel'], overview: "In a towering city of the future, the son of the city's master falls for a prophet of the workers below — and a robot is built in her image.", keywords: ['dystopia', 'robot', 'class struggle', 'silent film'], query: 'metropolis 1927 fritz lang', rating: 8.3 },
  { title: 'The Cabinet of Dr. Caligari', year: 1920, genres: ['Horror', 'Mystery', 'Thriller'], director: 'Robert Wiene', cast: ['Werner Krauss', 'Conrad Veidt', 'Lil Dagover'], overview: 'A sinister showman and his sleepwalking servant arrive at a village fair — and the murders begin. The original twist ending.', keywords: ['somnambulist', 'expressionism', 'twist ending', 'madness'], query: 'cabinet of dr caligari', rating: 8.0 },
  { title: 'A Trip to the Moon', year: 1902, genres: ['Science Fiction', 'Adventure', 'Fantasy'], director: 'Georges Méliès', cast: ['Georges Méliès', 'Bleuette Bernon'], overview: "Astronomers fire themselves at the moon in a giant shell — and hit the Man in the Moon right in the eye. Cinema's first sci-fi.", keywords: ['moon', 'space travel', 'silent film', 'short'], query: 'trip to the moon melies', rating: 8.1 },
  { title: 'Plan 9 from Outer Space', year: 1957, genres: ['Science Fiction', 'Horror'], director: 'Ed Wood', cast: ['Bela Lugosi', 'Vampira', 'Tor Johnson'], overview: 'Aliens resurrect the dead to stop humanity from building a doomsday weapon. Lovingly crowned the best worst movie ever made.', keywords: ['aliens', 'zombie', 'cult film', 'so bad its good'], id: 'plan-9-from-outer-space', rating: 3.9 },
  { title: 'The Little Shop of Horrors', year: 1960, genres: ['Comedy', 'Horror'], director: 'Roger Corman', cast: ['Jonathan Haze', 'Jackie Joseph', 'Jack Nicholson'], overview: 'A clumsy florist raises a talking plant with a taste for human blood. Shot in two days; features a young Jack Nicholson.', keywords: ['killer plant', 'flower shop', 'cult film', 'dark comedy'], query: 'little shop of horrors 1960', rating: 6.2 },
  { title: 'Detour', year: 1945, genres: ['Crime', 'Thriller', 'Drama'], director: 'Edgar G. Ulmer', cast: ['Tom Neal', 'Ann Savage'], overview: 'A hitchhiking pianist makes one bad decision on the road to Los Angeles — and fate never lets go. Noir at its bleakest.', keywords: ['film noir', 'hitchhiker', 'fate', 'road trip'], query: 'detour 1945', rating: 7.2 },
  { title: 'D.O.A.', year: 1949, genres: ['Crime', 'Thriller', 'Mystery'], director: 'Rudolph Maté', cast: ["Edmond O'Brien", 'Pamela Britton'], overview: 'A man walks into a police station to report a murder — his own. He has been poisoned and has days to find out why.', keywords: ['film noir', 'poison', 'race against time', 'murder'], query: 'D.O.A. 1949', rating: 7.2 },
  { title: 'The Phantom of the Opera', year: 1925, genres: ['Horror', 'Drama', 'Romance'], director: 'Rupert Julian', cast: ['Lon Chaney', 'Mary Philbin', 'Norman Kerry'], overview: 'A disfigured genius haunting the Paris Opera grooms a young soprano for stardom — and the unmasking scene still shocks.', keywords: ['opera', 'mask', 'obsession', 'silent film'], query: 'phantom of the opera 1925', rating: 7.5 },
  { title: 'Safety Last!', year: 1923, genres: ['Comedy', 'Romance'], director: 'Fred C. Newmeyer', cast: ['Harold Lloyd', 'Mildred Davis'], overview: 'A small-town boy fakes success in the big city and ends up climbing a skyscraper — the iconic clock-hanging stunt.', keywords: ['skyscraper', 'stunts', 'clock', 'silent film'], query: 'safety last harold lloyd', rating: 8.1 },
  { title: 'House on Haunted Hill', year: 1959, genres: ['Horror', 'Mystery'], director: 'William Castle', cast: ['Vincent Price', 'Carol Ohmart', 'Richard Long'], overview: 'An eccentric millionaire offers five strangers $10,000 each to survive one night in a house with a murderous past.', keywords: ['haunted house', 'party', 'inheritance', 'twist'], query: 'house on haunted hill 1959', rating: 6.8 },
  { title: 'The Last Man on Earth', year: 1964, genres: ['Science Fiction', 'Horror', 'Drama'], director: 'Ubaldo Ragona', cast: ['Vincent Price', 'Franca Bettoia'], overview: 'After a plague turns humanity into vampiric creatures, one immune scientist fights through each day alone — the first I Am Legend adaptation.', keywords: ['plague', 'vampire', 'post-apocalyptic', 'loneliness'], query: 'last man on earth 1964 vincent price', rating: 6.8 },
  { title: 'Carnival of Souls', year: 1962, genres: ['Horror', 'Mystery', 'Fantasy'], director: 'Herk Harvey', cast: ['Candace Hilligoss', 'Sidney Berger'], overview: 'After surviving a car crash, an organist is drawn to an abandoned lakeside pavilion by a pale figure only she can see.', keywords: ['ghost', 'dream', 'reality', 'twist ending', 'cult film'], query: 'carnival of souls 1962', rating: 7.0 },
  { title: 'Steamboat Willie', year: 1928, genres: ['Animation', 'Comedy', 'Family', 'Music'], director: 'Walt Disney', cast: ['Walt Disney'], overview: 'A whistling deckhand mouse turns a riverboat into a musical instrument in the first fully synchronised sound cartoon.', keywords: ['mouse', 'riverboat', 'music', 'short'], query: 'steamboat willie', rating: 7.3 },
  { title: 'Superman: The Mechanical Monsters', year: 1941, genres: ['Animation', 'Action', 'Science Fiction'], director: 'Dave Fleischer', cast: ['Bud Collyer', 'Joan Alexander'], overview: 'A mad scientist sends giant flying robots to rob the city — and only the Man of Steel can stop them. Fleischer at its art-deco best.', keywords: ['superhero', 'robots', 'short', 'art deco'], query: 'superman mechanical monsters', rating: 7.6 },
  { title: 'Popeye the Sailor Meets Sindbad the Sailor', year: 1936, genres: ['Animation', 'Comedy', 'Adventure', 'Family'], director: 'Dave Fleischer', cast: ['Jack Mercer', 'Gus Wickie', 'Mae Questel'], overview: "Sindbad claims to be the greatest sailor in the world. Popeye, a can of spinach and a two-headed giant disagree.", keywords: ['sailor', 'spinach', 'monster', 'short'], query: 'popeye meets sindbad', rating: 7.1 },
  { title: 'The Hitch-Hiker', year: 1953, genres: ['Thriller', 'Crime'], director: 'Ida Lupino', cast: ["Edmond O'Brien", 'Frank Lovejoy', 'William Talman'], overview: 'Two friends on a fishing trip pick up a killer who never fully closes his right eye — even when he sleeps.', keywords: ['film noir', 'hostage', 'road trip', 'mexico'], query: 'the hitch-hiker 1953', rating: 7.1 },
  { title: 'The Stranger', year: 1946, genres: ['Thriller', 'Crime', 'Drama'], director: 'Orson Welles', cast: ['Orson Welles', 'Loretta Young', 'Edward G. Robinson'], overview: 'A war-crimes investigator tracks a fugitive Nazi mastermind to a sleepy Connecticut town where he has married into respectability.', keywords: ['film noir', 'nazi hunter', 'small town', 'clock tower'], query: 'the stranger 1946 orson welles', rating: 7.3 },
  { title: 'Scarlet Street', year: 1945, genres: ['Crime', 'Drama', 'Thriller'], director: 'Fritz Lang', cast: ['Edward G. Robinson', 'Joan Bennett', 'Dan Duryea'], overview: 'A meek cashier and Sunday painter is seduced and swindled by a grifter couple who sell his paintings as their own.', keywords: ['film noir', 'painter', 'femme fatale', 'con'], query: 'scarlet street 1945', rating: 7.6 },
  { title: 'Gulliver’s Travels', year: 1939, genres: ['Animation', 'Adventure', 'Family', 'Music'], director: 'Dave Fleischer', cast: ['Sam Parker', 'Pinto Colvig'], overview: 'Shipwrecked Gulliver wakes up a giant in Lilliput, where two tiny kingdoms are about to go to war over a wedding song.', keywords: ['giant', 'kingdom', 'musical'], query: 'gullivers travels 1939', rating: 6.3 },
  { title: 'Dementia 13', year: 1963, genres: ['Horror', 'Thriller'], director: 'Francis Ford Coppola', cast: ['William Campbell', 'Luana Anders', 'Patrick Magee'], overview: "A scheming widow joins her late husband's family at their Irish castle, where an axe murderer stalks the grounds.", keywords: ['castle', 'axe murderer', 'ireland', 'family secrets'], query: 'title:("dementia 13") AND -trailer AND -TERROR', rating: 5.8 },
  { title: 'McLintock!', year: 1963, genres: ['Western', 'Comedy', 'Romance'], director: 'Andrew V. McLaglen', cast: ['John Wayne', "Maureen O'Hara"], overview: 'A rough-and-tumble cattle baron must deal with his estranged wife, homesteaders, and the biggest mud-pit brawl in Western history.', keywords: ['cattle baron', 'brawl', 'western'], query: 'mclintock 1963', rating: 7.1 },
  { title: 'Battleship Potemkin', year: 1925, genres: ['Drama', 'History', 'War'], director: 'Sergei Eisenstein', cast: ['Aleksandr Antonov', 'Vladimir Barsky'], overview: 'Sailors mutiny over maggot-ridden meat, and the Odessa Steps sequence changes film editing forever.', keywords: ['mutiny', 'revolution', 'montage', 'silent film'], query: 'battleship potemkin', rating: 7.9 },
];

const UA = { 'User-Agent': 'Marquee-watch-party-seed/1.0' };

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

interface ArchiveFile {
  name: string;
  format?: string;
  size?: string;
  length?: string;
  source?: string;
}

function parseLength(l?: string): number | null {
  if (!l) return null;
  if (l.includes(':')) return l.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
  const n = Number(l);
  return Number.isFinite(n) ? n : null;
}

async function resolveItem(identifier: string, short: boolean): Promise<{ url: string; duration: number | null } | null> {
  if (/trailer|preview/i.test(identifier)) return null;
  const meta = await json<{ files?: ArchiveFile[]; is_dark?: boolean; metadata?: { access_restricted_item?: string } }>(
    `https://archive.org/metadata/${identifier}`,
  );
  if (meta.is_dark || !meta.files || meta.metadata?.access_restricted_item === 'true') return null;
  const mp4s = meta.files.filter((f) => f.name.toLowerCase().endsWith('.mp4'));
  const rank = (f: ArchiveFile) => {
    const size = Number(f.size ?? 0);
    const fmt = (f.format ?? '').toLowerCase();
    let s = 0;
    if (fmt === 'h.264') s += 30;
    if (fmt.includes('512kb')) s += 20;
    if (fmt.includes('mpeg4')) s += 10;
    if (size > 2.5e9) s -= 50; // too large to stream comfortably
    if (/trailer|preview|sample/i.test(f.name)) s -= 40;
    return s + Math.min(10, size / 1e8);
  };
  const best = mp4s.sort((a, b) => rank(b) - rank(a))[0];
  if (!best) return null;
  const url = `https://archive.org/download/${identifier}/${best.name.split('/').map(encodeURIComponent).join('/')}`;
  const head = await fetch(url, { method: 'GET', headers: { ...UA, Range: 'bytes=0-1' }, redirect: 'follow' });
  head.body?.cancel();
  if (!(head.status === 200 || head.status === 206)) return null;
  const duration = parseLength(best.length) ?? parseLength(meta.files.find((f) => f.length)?.length);
  if (duration != null && !short && (duration < 40 * 60 || duration > 150 * 60)) return null;
  return { url, duration };
}

async function search(c: Curated): Promise<string[]> {
  const q = `(${c.query ?? `"${c.title}"`}) AND mediatype:movies`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=year&sort[]=downloads+desc&rows=8&output=json`;
  const r = await json<{ response: { docs: { identifier: string; title: string; year?: number | string }[] } }>(url);
  const want = c.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  return r.response.docs
    .filter((d) => (d.title ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(want.slice(0, 6)))
    .map((d) => d.identifier);
}

async function main() {
  const out: Movie[] = [];
  for (const c of CURATED) {
    try {
      const ids = c.id ? [c.id] : await search(c);
      let found: { id: string; url: string; duration: number | null } | null = null;
      for (const ident of ids.slice(0, 5)) {
        const short = c.source === 'open' || c.genres.includes('Animation') || c.year < 1910;
        let r = await resolveItem(ident, short).catch(() => null);
        if (!r) r = await resolveItem(ident, short).catch(() => null);
        if (r) {
          found = { id: ident, ...r };
          break;
        }
      }
      if (!found) {
        console.warn(`✗ ${c.title} — no playable file`);
        continue;
      }
      const runtime = found.duration ? Math.round(found.duration / 60) : null;
      out.push({
        id: `${c.source ?? 'archive'}:${found.id}`,
        title: c.title,
        year: c.year,
        overview: c.overview,
        genres: c.genres,
        runtime,
        rating: c.rating ?? null,
        votes: 0,
        popularity: 0,
        language: 'en',
        director: c.director,
        cast: c.cast,
        keywords: c.keywords,
        poster: `https://archive.org/services/img/${found.id}`,
        backdrop: null,
        trailer: null,
        playable: { kind: 'file', url: found.url },
        source: c.source ?? 'archive',
      });
      console.log(`✓ ${c.title} → ${found.id} (${runtime ?? '?'} min)`);
    } catch (e) {
      console.warn(`✗ ${c.title}: ${(e as Error).message}`);
    }
  }
  // Adaptive-bitrate showcase (HLS).
  out.push({
    id: 'open:bbb-hls',
    title: 'Big Buck Bunny (adaptive HLS)',
    year: 2008,
    overview: 'The Blender classic as an adaptive HLS stream — quality adjusts to each viewer’s bandwidth while staying in sync.',
    genres: ['Animation', 'Comedy', 'Family'],
    runtime: 10,
    rating: 7.2,
    votes: 0,
    popularity: 0,
    language: 'en',
    director: 'Sacha Goedegebure',
    cast: [],
    keywords: ['rabbit', 'hls', 'adaptive streaming', 'open movie'],
    poster: 'https://archive.org/services/img/BigBuckBunny_124',
    backdrop: null,
    trailer: null,
    playable: { kind: 'hls', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
    source: 'open',
  });
  writeFileSync(new URL('../data/catalog.open.json', import.meta.url), JSON.stringify(out, null, 1));
  console.log(`\nWrote ${out.length} playable titles → data/catalog.open.json`);
}

main();
