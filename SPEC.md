# Sus Word: build spec (v1, 26.10.2026)

The design spec the code is built from.

## 1. The game in one paragraph
Sus Word is a social deduction game played in Twitch chat.
1. Viewers type `!join`. Each round, one player is secretly the **Imposter** and gets a secret word.
2. The Imposter has 3 minutes to slip the word into chat naturally. Everyone else talks too and tries to spot it.
3. Hints get stronger as time runs out: the category appears at 1:30 and the first letter at 2:30.
4. Chat then votes `!vote name`.
5. The reveal is the payoff. The overlay rewinds the chat and lights up the one message that carried the word, a message everyone saw and missed.

## 3. Architecture
One Node 24 process (plain JavaScript, ES modules, no build step, no TypeScript).
- `server.js` runs an HTTP server (express) and a WebSocket server (`ws`) on port 3000.
- Twitch side:
  - EventSub WebSocket client: `wss://eventsub.wss.twitch.tv/ws`, with keepalive handling and reconnect on `session_reconnect`.
  - Subscription: `channel.chat.message` v1, condition `{broadcaster_user_id, user_id: BOT_ID}`.
  - Send chat: `POST https://api.twitch.tv/helix/chat/messages`.
  - Get Users for avatars (`profile_image_url`), cached.
  - Get Channel Information for the category name (feeds the word picker).
- Auth, done once with a local helper:
  - `npm run auth` opens `https://id.twitch.tv/oauth2/authorize` with scopes `user:read:chat user:write:chat user:bot channel:bot`
    and redirect `http://localhost:3000/auth/callback`.
  - It stores access and refresh tokens in `.tokens.json` (gitignored) and refreshes on 401.
  - The bot account and the broadcaster may be the same account (our demo uses `romabuilds`). The code must support both setups:
    `BOT_LOGIN` and `CHANNEL_LOGIN` in env.
- Pages served:
  - `/overlay`: OBS browser source, 1920×1080, transparent background.
  - `/card`: the player's secret role card (phone/browser).
  - `/host`: a small control panel for the streamer, with Start / Vote now / Next round / Reset buttons. The same actions are available as chat commands.
- Public access to `/card`: viewers on other networks open it through a tunnel (`cloudflared tunnel --url http://localhost:3000`).
  - `PUBLIC_URL` in env is the base the bot posts in chat. If it's empty, the bot posts `http://localhost:3000/card` (dev).
- State lives in memory only, and scores are kept for the session. A JSON snapshot goes to `data/session.json` after each round (gitignored).
- Optional AI (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, any OpenAI-compatible chat endpoint):
  - (a) Pick a word that fits the channel's category.
  - (b) Write a one-line "sneakiness" verdict at the reveal.
  - If the key is missing or a call fails or takes over 4 s, fall back to the word list and a template line. The game never waits on AI.

## 4. Identity without OAuth: the claim code
We must show each player their secret role privately without asking viewers to log in.
1. The player opens `/card` and types their Twitch name.
2. The server creates a 4-character code (letters A-Z without O/I, digits 2-9) bound to that browser session (a random sid in an httpOnly cookie).
3. The page shows: "Type `!claim K7Q2` in chat."
4. When a chat message `!claim K7Q2` arrives, the server checks that `chatter_user_login` equals the name entered on that card (case-insensitive) and the code is unused and under 10 min old.
   If so, the session is linked to that Twitch user id, and the player is auto-joined.
5. The card page holds a WebSocket (or polls `/api/card` every 1 s; WebSocket preferred) and shows the role for the current round.
   - Someone else typing your code fails, because the names don't match.
   - The code is useless to anyone else because the role is only ever sent to the bound session.
6. A player without a card can still play as a detective, but can't be picked as the Imposter.
   The Imposter is chosen only from claimed players. The lobby shows a 🔒 next to claimed names.

## 5. Game flow (state machine)
`IDLE → LOBBY → ROUND → VOTE → REVEAL → (LOBBY for next round | IDLE)`

| State | Enter by | What happens | Exit |
|---|---|---|---|
| IDLE | start / reset | overlay hidden (only a small "Sus Word" tag) | `!sus start` (broadcaster/mod) or host button |
| LOBBY | start | bot: "🕵️ Sus Word! Type !join to play. Get your secret card: {PUBLIC_URL}/card". Overlay shows the roster with avatars as people join. | ≥3 claimed players and `!sus go` / host button, or auto after 60 s if ≥3 claimed |
| ROUND (180 s) | go | Pick the Imposter (claimed, not the same as last round if possible). Pick the word. Imposter card: the word + mission. Other cards: "Detective. Someone is hiding a word. Watch the chat." Bot: "Round {n} has begun. Someone here has a secret word… 3 minutes." | timer ends, or `!sus vote` |
| VOTE (30 s) | timer / command | Bot: "Vote! !vote name". One vote per player, a new vote replaces the old one. Only players vote. Self-votes are ignored. Overlay shows live vote bars. | timer ends (or everyone has voted) |
| REVEAL (~20 s) | vote ends | The overlay sequence (§7). Bot posts the result in one line. Scores update. | auto → LOBBY (players stay joined), or `!sus end` → IDLE |

Hints during ROUND are shown on the overlay and posted by the bot:
- at 90 s: "Category: {category}"
- at 150 s: "Starts with: {letter}"

## 6. Word detection (fair and testable)
- The secret word is one lowercase word, 4 to 9 letters, common and not a stopword (list in `words.js`, 300+ entries, each tagged with a category).
- The word counts as **smuggled** the first time the Imposter sends a chat message containing it as a whole word, case-insensitive.
  - Allowed forms: word, word+s, word+es, word's, and a word ending in y → ies.
  - Commands (messages starting with `!`) don't count.
  - A message that is ONLY the word (one token) does NOT count. It has to be used in a sentence, at least 3 words.
- If another player says the word, it's logged as an **accidental decoy**: shown at the reveal ("@x said it too, by accident"), with no penalty.
- The server never tells anyone it was smuggled before the reveal. The Imposter's card quietly shows "✓ delivered".
- Pure function `findWord(message, word) → {hit, index, length}` with unit tests (node:test) covering all the rules above.

## 7. The reveal (the WOW moment, about 20 s, must be smooth)
1. 0.0 s: the overlay dims and shows "THE IMPOSTER WAS…". A drumroll of avatar cards shuffles.
2. 2.5 s: the card flips to the Imposter (avatar, name, a red stamp "IMPOSTER").
3. 5.0 s: **Rewind.** A tape of the round's chat messages scrolls backwards fast (like a VHS rewind, with a timestamp counter running back) and slows to stop on
   the smuggling message. That one message grows, and the secret word inside it lights up with a highlighter sweep. The caption shows "{mm:ss} into the round. {k} people
   read this. Nobody noticed." The number of people is the count of other players who sent a message after it (so they were reading).
   If it was never smuggled: "The word never made it out." with the word shown crossed out.
4. 11 s: the verdict. If the Imposter got the most votes, "CAUGHT", detectives +1 each who voted right. Otherwise "GOT AWAY", Imposter +3.
   If the word was not smuggled, the Imposter scores 0 no matter what.
5. 13 s: the AI sneakiness line (or template), e.g. "Hid 'candle' inside a complaint about the power bill. Cold."
6. 16 s: a mini leaderboard (top 5).
The bot posts: "🕵️ It was @name! Word: CANDLE, smuggled at 1:12 ('...power went out so I lit a candle lol'). GOT AWAY. +3".

## 8. Overlay layout (1920×1080, transparent, safe for a webcam in the top-left)
Final look comes from the design pick (DESIGN.md). Structure:
- Right column (x 1340 to 1900): the game panel.
  - Header: logo, round number, phase.
  - A big timer ring.
  - Hint slots: "Category ▢" and "Starts with ▢" that flip open.
  - Player tiles: avatar, name, message count. A tile pulses on each message.
- Bottom strip (lower third, y 860 to 1060): the latest 3 player messages as "evidence cards" that slide in. During VOTE it becomes the vote bars.
- The reveal takes over the full screen.
- Everything animates with CSS + Web Animations API (no heavy libraries). Fonts are self-hosted in `/public/fonts` (no Google dependency during a stream).
- Text is readable from a stage: names at least 28 px, timer at least 96 px.

## 9. Chat commands
| Command | Who | Effect |
|---|---|---|
| `!join` | anyone | join the lobby (as a detective until claimed) |
| `!claim CODE` | anyone | link your card (see §4) |
| `!leave` | player | leave |
| `!vote name` (also `!vote @name`) | player, VOTE only | vote |
| `!sus start / go / vote / next / end` | broadcaster or mod | control |
| `!sus help` | anyone | one-line rules |
The bot's own messages are ignored by the game. Rate: at most 1 bot message per 1.5 s (queue).

## 10. Files
```
sus-word/
  package.json          (express, ws, dotenv; scripts: start, auth, test, demo)
  .env.example          (TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, CHANNEL_LOGIN, BOT_LOGIN, PUBLIC_URL, AI_BASE_URL, AI_API_KEY, AI_MODEL)
  src/server.js         HTTP + WS + routes
  src/twitch.js         auth/refresh, EventSub WS client, send chat, users, channel info
  src/game.js           state machine (pure, testable, injected clock)
  src/words.js          word list with categories + findWord()
  src/ai.js             optional word pick + verdict, 4 s timeout, fallback
  src/auth.js           one-time OAuth helper (npm run auth)
  src/demo.js           fake chat driver for local dev + rehearsals (npm run demo: 4 bots talk, one smuggles)
  public/overlay.html/.css/.js
  public/card.html/.css/.js
  public/host.html/.js
  public/fonts/…
  test/words.test.js, test/game.test.js
  README.md             setup in 5 steps, screenshots, how it works
  LICENSE (MIT)
```

## 11. Acceptance (must all pass before the demo stream)
1. `npm test` is green: findWord rules, state transitions, scoring, a claim with the wrong name rejected, and the Imposter never picked from unclaimed players.
2. `npm run demo` plays a full round locally in the overlay without Twitch: lobby → round → hints → vote → reveal.
3. On a real channel: `!join`/`!claim` from 3 accounts, a round runs, the Imposter's card shows the word on a phone over the tunnel, and the reveal highlights the right message.
4. Kill the network for 10 s mid-round: the EventSub client reconnects and the round continues.
5. No secrets in the repo (`.env`, `.tokens.json` and `data/` are gitignored).

## 12. Not in v1
Extensions, channel points, native polls, whispers, a database, multi-channel, TTS.
