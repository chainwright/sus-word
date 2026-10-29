# Sus Word v3: build spec (29.10.2026)

Input for the next steps of the same Codex thread. Why v3: the first live playtest with real people (28.10, 3 players, 6 rounds)
showed the rules don't land. Players didn't know their role, typed `ijoin`, put the wrong name on the card, voted too early or too
late, and couldn't tell when voting started. v3 fixes that and makes the game fun to watch in motion.

Audience: English-speaking Twitch viewers. All UI and bot text in English.

Reference frames (static, approved direction): `design/v3/*.png`, with rough HTML/CSS in `design/v3/html/`. Use them for layout,
hierarchy and copy, not as production code. Fix the known mock issues listed in §9. Keep the existing art (desk, cork, case folder,
Oswald + Courier Prime, palette in `public/card.css`).

Rules that don't change: one table holds up to 12 players, 13+ split into balanced tables (`seatPlayers`); 10+ at a table = 2 imposters;
round 3:00, topic hint at 1:30 left, first-letter hint at 0:30 left, vote 0:30.

## 1. Joining (one command, name checked)

Playtest: both players typed `ijoin`; one typed a made-up name on the card and the code was rejected for 10 minutes.

- The card asks for the Twitch name first. Before issuing a code it checks whether that login has written in chat in the last
  15 minutes (any message counts, `!join` included). If yes: "✓ @name is in chat". If no: "We haven't seen @name in chat yet. Type
  anything in chat first, or check the spelling", with the button still allowed.
- One chat command links and joins: `!join CODE` (also accept `!claim CODE`). Plain `!join` still works and gets a reply with the card link.
- Accept `join`, `ijoin`, `!Join`, `!join` with trailing spaces; reply once with "@name almost! Type !join (with the !)" for
  `join`/`ijoin` without a code.
- If the code arrives from a different account: reply "@sender this code was made for @name. Open the card and type your own
  Twitch name". On the card show the same message and a real 44 px **Change name** button (it already exists as a hotfix in
  `public/card.js`; keep and restyle it).
- After linking, the card says "You're in. Keep this page open; your role appears here when the round starts."

## 2. Stable player numbers and simpler voting

Playtest: `!vote name` was awkward; votes typed before or after the vote window were silently lost.

- Each player gets a number in join order, stable for the whole session (1..N). Numbers are per table when tables split.
- During VOTE, a chat message that is only a number (`2`, `#2`, `!2`, `!vote 2`) votes for that number at the voter's table.
  `!vote name` keeps working, with case-insensitive match and leading `@` allowed.
- Vote by tap on the card (§5). Last vote wins until the window closes.
- **Stream latency:** viewers see the stream 2–8 s late. Accept votes for 6 s after the server's vote timer ends (silent grace).
  The overlay countdown hits 0:00 at the server deadline.
- A vote typed during ROUND gets one reply per player per round: "@name voting opens when the timer ends. Your number guess is
  saved: 2". Save it as their vote; they can change it in VOTE.
- A vote that can't count (unknown number, self-vote, not seated) gets a short reply instead of silence.
- Number-only and vote messages are never shown as chat slips and never count as smuggling.

## 3. Bot messages in chat (loud, short, English)

- Round start: `🔔 ROUND 4 · NEW ROLES! Check your card 👉 <card link>` then one line mentioning every seated player:
  `@a @b @c your role is on your card`.
- Hint: `🕵️ HINT: the word is about FOOD` / `🕵️ HINT: it starts with L`.
- Vote start: `🗳️🗳️ VOTE NOW: 30 SECONDS 🗳️🗳️ Type a number: 1 drovosek7777 · 2 cydshop · 3 romabuilds …` (wrap into two
  messages if over 500 chars). At 10 s left: `⏳ 10 seconds left to vote`.
- Reveal summary stays as now, but say "into the round" times and use "their".
- Ignore and never echo messages with links from non-players (spam bots posted viewer-selling links twice during the playtest).

## 4. Overlay (OBS browser source, 1280×720)

The page background must be transparent. Only panels carry the desk/cork art. The streamer's camera or game shows through the left area.

- **First lobby** (`design/v3/ov_lobby.png`): big HOW TO PLAY panel with 3 steps, the name warning and the LEMON example.
  Later lobbies (between rounds) use a compact bar: "Next round in 0:14 · 7 players ready · new? type !join".
  Show the full panel again for 15 s when a new player joins.
- **Round** (`ov_round.png`): slim top strip (phase, one-line rule, timer); right cork board with hints and the 12-player grid
  (number, real Twitch avatar from `profile_image_url`, name); 3 chat slips at the bottom; no vote counts during ROUND.
- **Vote** (`ov_vote.png`): full-width banner with countdown and "type a number"; vote bars per row.
- **Reveal**: see §6. Its static end frame is `ov_reveal.png`.
- Leaderboard (top 3) under the grid in ROUND.
- Sizes at 1280×720: anything a viewer acts on (numbers, names, timer, vote instruction) at least 20 px, Oswald or bold Courier.
  Labels at least 15 px. Vote bars 14 px tall, width scaled to the leading count. Long names: shrink to 14 px Oswald before ellipsis.

## 5. Phone card

- **Role** (`card_role.png`, `card_detective.png`): "YOUR ROLE THIS ROUND", big role stamp, the secret word with a highlighter,
  the job in one sentence, 3 tips for the role, one example sentence. With 2 imposters: Imposter card says "2 Imposters this
  round; the other one has a different word"; Detective card says "Someone (or two) is hiding a word: catch them".
  The frame and NEW ROUND banner are neutral; role colour only inside the sheet (so the role can't be read from across the room).
- **Delivered**: the Imposter's "Word not sent yet" chip turns into "✓ DELIVERED 0:47 into the round".
- **Vote** (`card_vote.png`): banner + countdown + progress bar; a 3-column grid of every player at the table (avatar, number,
  name); tap to vote, tap another to change; "✓ YOUR VOTE" marker; your own tile disabled; footer "Or type the number in chat".
- **Reveal hold**: during REVEAL the card shows "👀 Watch the stream: the reveal is on" and switches to the result only after the
  reveal has played plus 6 s, so the phone never spoils the stream.
- **Result** (`card_result.png`): your role, your vote and whether it was right, the imposter(s) and word(s), points this round, total and rank.
- New-round signal: chime (≤0.4 s, mute toggle), border flash twice at 150 ms (never more than 3 flashes/s), vibration
  `[80,60,80]` where supported. Unlock audio on the GET MY CODE tap (create the AudioContext there). Request a Screen Wake Lock.
- Accessibility: `aria-live="polite"` on role, timer and result. Respect `prefers-reduced-motion` (replace moves/shakes/flashes with a 200 ms crossfade).

## 6. Motion (this is what "fun to watch" means; build it exactly)

New round, overlay:
- 0 ms: the strip text flips like a split-flap (rotateX 90°→0, 300 ms) to "ROUND 4 · NEW ROLES".
- Same moment: a full-width bar drops from the top (translateY −100%→0, 280 ms, ease-out back): "🔔 NEW ROLES: CHECK YOUR CARD".
  Holds 3 s, slides up over 250 ms.
- Player rows shuffle like paper: each row ±2° random rotation settling to 0 over 400 ms, staggered 30 ms per row.

New round, card:
- 0–600 ms: face-down TOP SECRET folder. 600–1100 ms: flip (rotateY 0→180°, cubic-bezier(.2,.8,.2,1)) to the role.
- 1100 ms: role stamp slams (scale 1.6→1, opacity 0→1, 160 ms) then a 2 px shake for 100 ms.
- 1300 ms: highlighter sweeps under the word (background-size 0→100%, 450 ms, left to right).

During the round:
- A player talks: their row's yellow glow fades from full to 0 over 1.8 s; the message-count chip bumps (scale 1.2→1, 150 ms).
- A new chat slip drops in (translateY −20 px→0, random rotation ±1.5°, 220 ms); the oldest slides out left over 200 ms.
- A hint unlocks: the note flips (rotateY 180°, 400 ms), the text lands with a 120 ms thud-shake; the bot posts the hint at the same moment.

Vote:
- Banner drops over 350 ms with a slight bounce. Digits flip every second; in the last 5 s the number scales 1→1.12 per tick and the banner darkens one step.
- Bars grow over 300 ms ease-out. Rows never re-sort (numbers must stay put).
- At 0:00 a "VOTES LOCKED" stamp hits the banner (scale 2→1, 180 ms).

Reveal (about 9 s per imposter; the second imposter uses a 2 s rewind). The camera area dims to 60% with a vignette but stays visible.

| Time | What happens |
|---|---|
| 0.0 s | Title "THE REVEAL" types in. |
| 1.2–3.5 s | **Rewind.** The round's slips scroll backwards fast through the slip tray with motion blur and VHS scanlines; a timestamp counter runs back; it eases out and stops on the hidden message. |
| 3.5 s | That message lifts to the centre (scale 1→1.35, 400 ms, deep shadow). |
| 4.0 s | Highlighter sweep over the word, 500 ms. |
| 4.6 s | Caption counts up, at least 40 px: "1:12 into the round · **9 people read it** · nobody noticed" (number rolls 0→N over 600 ms; N = players who posted after it). |
| 5.5 s | 0.8 s silent beat; the imposter's board row pulses twice. |
| 6.3 s, BUSTED | Stamp slams (scale 2.2→1, rotate −14°→−8°, 160 ms); the overlay shakes 3 px for 120 ms; one red flash for 80 ms. |
| 6.3 s, GOT AWAY | Stamp ink-bleeds in (mask grows from the centre, 400 ms, green); "+3" floats from the stamp to the leaderboard over 700 ms. |
| End | Leaderboard re-sorts with a FLIP animation (600 ms) and shows ▲/▼; after 10 s the case cards shrink into a bottom bar. |

If an imposter never delivered: skip the rewind, show their word with "THE WORD NEVER MADE IT OUT" and a grey stamp.

## 7. Other screens in the same style
- Host page: phase controls, players with numbers, a "chat preview" of what the bot will post.
- Error toasts on the card: vote rejected, not seated this round, joined mid-round ("you play next round").
- FINAL / CHAMPION screen on overlay and card.
- `!accuse name word` stays: show an ACCUSED/BUSTED stamp on the row live; document it on the HOW TO PLAY panel as an optional pro move.

## 8. Tests to add
Join aliases and replies; name check before code; `!join CODE` links; wrong-account code message; stable numbers across rounds;
number votes (`2`, `#2`, `!2`, `!vote 2`); 6 s vote grace; vote during ROUND saved and replied once; vote/number messages never
count as smuggling or slips; link spam ignored; card hides result until reveal end + 6 s; 2-imposter copy.

## 9. Known issues in the mock files (don't copy them)
- `ov.css` paints the body with `desk.jpg`; production body must be transparent.
- `players.js` bar width `votes*16%` overflows; scale to the leader.
- `.hints small` is 13 px; use ≥15 px.
- Mock numbers disagree between frames (vote vs reveal vs leaderboard); production uses live data only.
- "5 of 9 detectives" with 2 imposters at 12 players must read "5 of 10".
