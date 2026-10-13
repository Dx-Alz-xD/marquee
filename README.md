# 🎬 Marquee: watch parties in perfect sync

Marquee is a real-time watch-party app: create a room, share a code or QR, and everyone watches on the same frame. You get live chat, emoji reactions, shared queues, polls, a group movie-picker, and a lab that **shows you the sync working, then lets you break it on purpose**.

| | |
|---|---|
| **Sync** | 3.7 ms p95 control propagation on localhost (6.3 ms between real browser tabs), 46 ms p95 on simulated Wi-Fi with 50 people, drift 32–38 ms p95 after correction ([measurements](docs/PERFORMANCE.md)) |
| **Scale** | Tested with 50 people in one room and 20 rooms × 10 at once on a laptop |
| **Reliability** | Resume-with-replay reconnects, crash-safe rooms, strict/relaxed buffering policy, Chaos mode ([failure handling](docs/FAILURE-MODES.md)) |
| **How** | Anchor-based playback, NTP-style clocks, a drift-correction ladder ([architecture](docs/ARCHITECTURE.md)) |

---

## Quick start

```bash
npm install
npm start          # builds the UI and serves everything on http://localhost:3000
```

* **Phones and laptops on the same Wi-Fi:** open the *Network* URL the server prints (e.g. `http://192.168.1.20:3000`), or scan the QR code in **Invite**. On first run Windows asks to allow Node through the firewall; allow it on *Private networks*.
* **Friends on a different network:**
  ```bash
  npm run share      # same as start, plus a free Cloudflare tunnel (no account needed)
  ```
  The public `https://….trycloudflare.com` link appears in the terminal and in **Invite → Anywhere**. LAN and remote viewers share the same synced room.
* **Movie catalog:** 35 free, full-length public-domain classics and open movies work out of the box. Paste a TMDB key into `.env` (`TMDB_API_KEY=…`, either the v3 key or the v4 read token) and restart. The server then builds a ~1,000-film catalog with posters, trailers, cast and keywords in about a minute (`npm run seed` to rebuild).
* **Development:** `npm run dev` gives you the API on :3000 plus the Vite UI with hot reload on :5173.

Requires Node ≥ 20.12 (developed on Node 24).

> **Voice and the microphone:** browsers only allow mic access on secure pages, meaning https or `localhost`. On the public `npm run share` link (https) everyone can talk. On a plain `http://192.168…` Wi-Fi link people can **listen** but not talk; use the "Anywhere" link instead.

## What you can do

**Rooms**
* 6-character codes without look-alike characters, an invite link, and a QR code. Optional passcode.
* Guest identities (name, avatar, seat colour). No sign-up.
* Refresh or reconnect and you keep your seat, role and chat. Missed events are replayed.

**Watch together**
* Sources: YouTube, any MP4/WebM URL, HLS (`.m3u8`, adaptive), and **local files**. For local files, either everyone picks their own copy (matched by fingerprint, nothing uploaded) or you upload once to stream to the room.
* **3·2·1 countdown starts** land on the same frame everywhere, drawn as a film-leader countdown.
* **Personal Detour**: step out to rewatch a moment without affecting anyone, then **GO LIVE** to snap back.
* **Buffering policy**: *strict* (the room waits for a buffering member, at most 10 s) or *relaxed* (they catch up).
* **Synced speed**: 0.75× / 1× / 1.25× / 1.5× for everyone. The anchor re-bases at the moment of the change, so nobody jumps.
* **What you missed**: late joiners get a card with the reaction peaks and chat buzz from before they arrived. Tap a moment to rewatch it privately (a Personal Detour), then GO LIVE.

**Social**
* **Theater Row**: everyone is a seat under the screen. The ring colour shows sync health, with icons for buffering, away, detour and reconnecting. Reactions float up from the sender's seat.
* **Emoji reactions** with **combo bursts** when three or more people react the same way at once.
* **Reaction heatmap** on the seek bar shows where the room lost it.
* **Push-to-talk voice**: hold `V` (or the button) to talk; hands-free mode is optional. The movie automatically **ducks to 25 %** for everyone else while someone speaks. Audio goes peer to peer over WebRTC (the server only relays the connection setup). A level meter decides when you're *actually* talking, and the speaker's seat glows.
* **Laser pointer & drawing**: hold `Shift` to put a glowing laser dot (with your name) on everyone's screen; Shift-drag, or the ✏️ button on phones, draws strokes that fade after a few seconds.
* **Ghost scrubbing**: see where others are hovering on the timeline ("Ben is eyeing 1:02:10").
* **Live chat**: replies, @mentions, typing indicators, message reactions, and timestamps (`12:34`) that become jump links. Movie suggestion cards can be queued in one click.
* **Shared queue**: drag to reorder (anchor-based, so it's safe under concurrent edits), play next, and auto-advance once the credits screen has had its moment.
* **Movie Night Wrap**: when a film ends, the credits roll for everyone. It shows the top 3 moments (tap to rewatch), awards (🔥 Hype machine, 😱 Most dramatic, 😂 Laughed the loudest, 💬 Chatterbox, 🎛 Remote hog, 🎯 **Sync sniper** for the lowest drift), time watched together, and tonight's lineup. You can also open it mid-film as an "intermission report".
* **Ratings**: everyone rates 1–5★ in the Wrap. The room verdict is posted to chat, and 4–5★ / 1–2★ feed the group recommender, so the next Group Pick knows the room better.
* **Polls**: single or multiple choice, anonymous, timed. **The winner can be auto-queued or auto-played.**
* **Control modes**: Everyone · Host only · **Democracy** (members' presses start a 15 s majority vote).
* **Host transfer**: hand over the remote, appoint co-hosts, auto-succession when the host leaves.

**Discovery**
* Fuzzy search that forgives typos, with a query language: `nolan sci-fi year:>2010`, `by:keaton`, `with:"audrey hepburn"`, `90s`, `mood:cozy`, `is:free`. The app shows what it understood as chips.
* Filters for genre, mood, decade, rating, length and free-to-watch. Shelves: *Picked for this room*, *Free to watch*, *Trending*, *Ends before midnight* (uses the current time), moods and decades.
* **Live browsing presence**: see who's looking at which movie.
* **Group Pick**: everyone swipes on the same shortlist built by a **group recommender** (taste vectors, average-without-misery, explained picks). The first unanimous ❤ wins; ties go to a runoff poll.

**Sync Lab** (press `S`)
* Live per-member drift sparklines, RTT, clock offset and correction rate.
* Room propagation p50/p95/p99 against the targets, and a waterfall of recent commands.
* Hosts get **Chaos mode**: inject lag or jitter, knock a player out of sync, or pull someone's connection, then watch the room heal.

### Keyboard shortcuts
| Key | Action |
|---|---|
| `Space` / `K` | play / pause |
| `←` `→` / `J` `L` | ∓10 s |
| `1`–`0` | reactions |
| `D` | Discover |
| `G` | Group Pick |
| `S` | Sync Lab |
| `I` | Invite |
| `V` (hold) | push-to-talk |
| `Shift` (hold) | laser pointer; Shift-drag to draw |

## A 5-minute demo script
1. `npm run share`. Create a room on the laptop. Scan the QR with two phones; send the public link to someone on mobile data.
2. Press **G** and run a Group Pick: everyone swipes, *It's a match!* is queued, and the film starts with a **3·2·1** on every screen.
3. Spam 🔥 from three devices for a **combo**. Later, point out the **heatmap** on the seek bar.
4. **Join voice** on two devices and talk: the movie dips while you speak. Hold **Shift** and point at something on screen.
5. Open **Sync Lab**: show propagation p95 and per-person drift.
6. **Chaos**: give a phone 400 ms of lag, then *Nudge 0.6 s*. Its sparkline glides back via playbackRate. *Drop connection*: the seat goes 📡, comes back, and the chat line catches up.
7. Close the host's tab and show the 👑 passing to the next person. Switch to **Democracy** and press pause from a phone, which starts a vote.
8. Jump near the end of a short film and let it finish: the **Movie Night Wrap** rolls on every screen. Everyone rates it, and the verdict lands in chat.

## Tests & measurements
```bash
npm test           # 50 unit tests: sync math, closed-loop controller sim, clock estimator, room concurrency, persistence, search, recommender, voice relay, Wrap
npm run e2e        # 10 end-to-end checks against a running server (speed, Wrap stats, ratings, voice signalling, pointer, hover)
npm run bench      # spins up a server + headless bots: 10/25/50 users, 20 rooms, Wi-Fi/WAN/bad links, simultaneous commands, reconnect storm
npm run typecheck
```
`npm run bench` rewrites the results table in [docs/PERFORMANCE.md](docs/PERFORMANCE.md) and exits non-zero if any target is missed.

## Stack
* TypeScript end to end. **Server**: Node + Fastify + `ws` (raw WebSockets, our own protocol) + zod.
* **Web**: React 19 + Vite + Tailwind 4 + Zustand + Motion.
* **Players**: native `<video>`, hls.js, the YouTube IFrame API.
* **Search**: MiniSearch. **Voice**: WebRTC audio mesh with public STUN. **Public link**: Cloudflare quick tunnels.
* **Data**: TMDB (optional), plus the Internet Archive and Blender open movies.

This product uses the TMDB API but is not endorsed or certified by TMDB.
