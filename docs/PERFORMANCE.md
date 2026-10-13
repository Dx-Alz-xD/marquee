# Performance: latency & drift measurements

The brief sets three hard constraints. This document shows how each one is measured, under what conditions, and the results.

| Constraint | Target | Result (see tables below) |
|---|---|---|
| Users per room | ≥ 10 | Tested at **10, 25 and 50** per room, plus **20 rooms × 10** concurrently (200 clients, one server) |
| Playback control propagation | ≤ 250 ms p95 on a local network | **3.7 ms p95 on localhost, 46 ms p95 on simulated Wi-Fi** (bot harness, up to 50 users per room and 200 clients total); **6.3 ms p95 between two real browser tabs** |
| Playback drift after correction | ≤ 500 ms | **32–38 ms p95** in every scenario, including a 180 ms ± 90 ms "bad link"; YouTube in a real browser holds about 40–70 ms |

---

## 1. What exactly is measured

### Propagation latency (click → applied)

```
 initiator A                     server                         receiver B
 ───────────                     ──────                         ──────────
 click  ── issuedAt (server clock) ─►  applies + broadcasts  ──►  recvAt
                                                                 player.play()/pause()/seek()
                                                                 appliedAt  ──► ack{recvAt, appliedAt}
 propagation = appliedAt(B) − issuedAt(A)        (both on the SERVER clock)
```

* Every client runs an NTP-style clock sync (`shared/sync.ts → ClockEstimator`), so its `serverNow()` is accurate to a few ms. That lets **two different machines' timestamps be compared on one timeline**.
* The initiator stamps `issuedAt` at the moment of the click; each receiver stamps `recvAt` on arrival and `appliedAt` right after calling the player API, then sends an `ack`.
* The server records one sample per (command × receiver) in a ring buffer (`server/metrics.ts`). The initiator is excluded because it applied optimistically at 0 ms.
* The breakdown is kept too: **delivery** (network + server) and **apply** (time to issue the player call). The Sync Lab draws them as a waterfall.
* Live in the app: **Sync Lab (press `S`)**. Raw JSON: `GET /metrics` (`?raw=1` adds per-room samples).

### Drift (after correction)

* `drift = actualMediaPosition − expectedPosition(anchor, serverNow)`, sampled per client.
* *After correction* means we skip the first 3 s after any state change (that's the window in which the correction ladder works). We only sample while playing and not mid-seek.
* Browsers report it every 2 s. The server aggregates it into `driftP95`, shown in the Sync Lab and in `/metrics`. Bots sample every 500 ms.

### Clock-sync accuracy

Unit-tested in `tests/sync.test.ts`. With 5–35 ms random one-way delays and 15 % asymmetric 200 ms spikes, the estimator stays within **15 ms** of the true offset. On a LAN, observed jitter is ±1–4 ms (shown live in the Sync Lab).

---

## 2. Test conditions

### Bot harness (`npm run bench`)

`tools/bench.ts` starts a **fresh server process** and connects headless clients (`tools/bot.ts`). The bots speak the real WebSocket protocol, run the **same** clock-sync and correction code as the browser (`shared/sync.ts`), and drive a *simulated* player with realistic imperfections:

| Imperfection | Value |
|---|---|
| Decoder clock skew | uniform ±0.4 % per client (real players drift) |
| Seek latency | 30–120 ms per seek |
| Start latency | 5–30 ms |
| Position read noise | ±4 ms |

Network profiles are applied **in both directions**, order-preserving (a FIFO delay line, same as Chaos mode):

| Profile | One-way delay | Extra |
|---|---|---|
| LAN | 0 (loopback) | — |
| Wi-Fi | 4 ms + U(0, 12) ms | 0.2 % chance of a 200–400 ms retransmit-like spike |
| Internet | 30 ms + U(0, 25) ms | 0.5 % spikes |
| Bad link | 90 ms + U(0, 90) ms | 2 % spikes |

A driver issues a random play / pause / seek every 2.5–5 s (pauses are always followed by a play). Each run also checks **convergence**: every client in a room must end on the same playback version.

Extra scenarios:
* **concurrent-actions**: 10 users fire pause/seek within the same 30 ms window, 12 rounds. Pass = every client ends on one identical state.
* **reconnect-storm**: 10 users chat continuously while randomly dropping their connection for 0.2–3 s. Pass = no duplicate messages, every client re-converges, and drift is back under the target.

### Real browsers

Two Chromium tabs on the same machine (Vite dev server, `localhost`), playing a 720p H.264 MP4 streamed from archive.org:

* Pause propagation: both `<video>` elements froze at **60.5913 s vs 60.5930 s**, i.e. **1.7 ms apart**.
* Sync Lab after a play/pause/seek series: **propagation p95 6.3 ms, p50 4.2 ms**. Steady-state member drift was −15 ms and +2 ms.
* YouTube (IFrame API, production build): after a countdown start, the player began **−37 ms** from the room (the muted warm-up pre-buffers the start; without it the first start lagged about 2.3 s). Steady state holds −18 to −71 ms under the seek-only ladder.
* Late joiner: entered mid-film, converged to −26 ms within about 3 s via a playbackRate nudge, with no pause for anyone else.

To reproduce across a real LAN: start the server, open the invite link on 2+ devices on the same Wi-Fi, run a few commands, then open the Sync Lab (or `GET /metrics`).

---

## 3. Results

<!-- BENCH:START -->
_Run 2026-10-13T12:50:14.984Z · 13th Gen Intel(R) Core(TM) i5-13420H (12 cores, 8 GB) · Windows_NT 10.0.26200 (x64) · Node v24.18.0 · full run_

| Scenario | Users | Network | Cmds | Samples | Propagation p50 / p95 / p99 / max (ms) | Drift p50 / p95 / p99 (ms) | Result |
|---|---|---|---|---|---|---|---|
| lan-10 | 10 | LAN (localhost) | 10 | 99 | 1.3 / 3.7 / 4.4 / 4.4 | 18.6 / 34.9 / 37.5 | ✅ converged=true, errors=0 |
| wifi-10 | 10 | Wi-Fi (8 ms ±12) | 10 | 99 | 30.8 / 45.9 / 368.4 / 368.4 | 18.9 / 34.3 / 36.2 | ✅ converged=true, errors=0 |
| wifi-25 | 25 | Wi-Fi (8 ms ±12) | 11 | 288 | 31 / 45.9 / 47.7 / 400.7 | 16.7 / 31.9 / 36.3 | ✅ converged=true, errors=0 |
| wifi-50 | 50 | Wi-Fi (8 ms ±12) | 10 | 539 | 30.9 / 46 / 46.9 / 373.3 | 17.1 / 35.2 / 38.6 | ✅ converged=true, errors=0 |
| multi-room-20x10 | 20×10 | Wi-Fi (8 ms ±12) | 214 | 2106 | 31 / 46.3 / 47.8 / 426.2 | 17 / 34.6 / 37.8 | ✅ converged=true, errors=0 |
| wan-10 | 10 | Internet (60 ms ±25) | 10 | 99 | 107.5 / 123.5 / 124.1 / 124.1 | 18 / 36.1 / 39.2 | ✅ converged=true, errors=0 |
| bad-10 | 10 | Bad link (180 ms ±90, 2% spikes) | 11 | 108 | 287.8 / 380 / 587.5 / 647.9 | 17.6 / 37.6 / 59.8 | ✅ converged=true, errors=0 |
| concurrent-actions | 10 | wifi | 120 | 12 | — / — / — / — | — / — / — | ✅ rounds=12, convergedRounds=12 |
| reconnect-storm | 10 | wifi | 170 | 33 | — / — / — / — | — / 32 / — | ✅ drops=33, resumes=33, snapshotResumes=0, messages=170, missing=0, dupes=0, converged=true |
<!-- BENCH:END -->

**How to read this.**
* **All 9 scenarios pass.** On the 250 ms target: LAN p95 is **3.7 ms**, simulated Wi-Fi p95 is **46 ms** at 10, 25 and 50 users per room and across 20 rooms × 10 users (2,106 samples).
* Adding users or rooms doesn't move the p95: fan-out is one `JSON.stringify` per event and N socket writes.
* The Wi-Fi **max** (and the p99 when n≈100) of ~370–430 ms are the simulated 0.2 % TCP-retransmit spikes (200–400 ms), injected on purpose. Even those land within one correction cycle.
* The **reconnect storm** produced 33 drops, all resumed by event replay (no full snapshot needed). Of 170 chat messages sent while connections were flapping, 0 were lost and 0 duplicated.
* The 250 ms propagation target is defined for a local network, so `wan-10` and `bad-10` are informational for latency. They are still required to meet the drift and convergence targets, and they do.
* Drift stays around 30–40 ms p95 even on the bad link. That's the point of the anchor model: a late message doesn't create drift, because the receiver computes where the room *is now*, not where it was when the message was sent.
* With extreme jitter the drift p99 can briefly exceed the dead zone. The rate controller then absorbs it.

---

## 4. Why the numbers are this low

1. **Anchor at intent time.** The server stores `{position, at}` with `at` = the initiator's click time (clamped to `[now−1 s, now]`). Transit delay is compensated by math (`expectedPosition`), not by waiting.
2. **Optimistic initiator.** The clicker's own player reacts at 0 ms. Everyone else applies the moment the frame arrives: no polling, no "next tick".
3. **Monotonic clocks.** `performance.timeOrigin + performance.now()` on both sides, so NTP steps and laptop sleep can't corrupt the timeline.
4. **Correction ladder.** Under 40 ms: nothing. Under 1 s: a ±8 % playbackRate nudge (pitch-preserved, inaudible). Above that: seek ahead by the device's *learned* seek latency.
5. **Precise countdown starts.** Scheduled starts fire on a dedicated timer, early by the device's learned start latency, so devices land on the same frame.

## 5. Regression gate

`npm run bench` exits non-zero if any scenario fails its targets, so it can run in CI. `npm test` covers the sync math, a closed-loop controller simulation, clock-estimator accuracy, concurrency and convergence in the room actor, persistence round-trips, search and the recommender.
