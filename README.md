# Sus Word

Sus Word is a live Twitch chat game about hiding one ordinary word in plain sight. One player is secretly the Imposter, everyone keeps chatting, and the stream ends each round by rewinding the evidence.

![The Case File reveal](design/A_casefile_reveal.jpg)

## How a round works

1. Viewers type `!join` and claim a private card.
2. One claimed player becomes the Imposter and gets a secret word.
3. The Imposter has three minutes to use it naturally in chat. Category and first-letter hints appear as time runs out.
4. Players vote with `!vote name`.
5. The overlay rewinds chat, highlights the hidden word, reveals the verdict, and updates the leaderboard.

## Setup in 5 steps

1. Register a Twitch application. Set its OAuth redirect URL to `http://localhost:3000/auth/callback`.
2. Copy `.env.example` to `.env`, then add the Twitch client ID, client secret, bot login, and channel login. The bot and broadcaster may be the same account.
3. Install Node 24 and run `npm install`.
4. Run `npm run auth` once and authorize the requested chat scopes.
5. Run `npm start`. In OBS, add `http://localhost:3000/overlay` as a 1920×1080 browser source. For remote player cards, run `cloudflared tunnel --url http://localhost:3000`, put its public base URL in `PUBLIC_URL`, and restart Sus Word.

Open `http://localhost:3000/host` for controls. For an offline rehearsal, run `npm run demo -- --fast` and open the overlay; omit `--fast` for full three-minute timing.

## Streamer voice

Open the host page in Google Chrome and turn on **🎙 Mic**. Allow microphone access when Chrome asks. Final speech chunks count as the broadcaster's game messages, so the streamer can be suspected or can hide the word out loud as the Imposter. The broadcaster still needs to join and claim a card first.

## Chat commands

| Command | Who | What it does |
| --- | --- | --- |
| `!join` | Anyone | Joins the game. |
| `!claim CODE` | Anyone | Links a private card to that Twitch name. |
| `!leave` | Player | Leaves the game. |
| `!vote name` | Player | Votes during the vote phase. |
| `!sus start` | Broadcaster/mod | Opens the lobby. |
| `!sus go` | Broadcaster/mod | Starts a round. |
| `!sus vote` | Broadcaster/mod | Opens voting early. |
| `!sus next` | Broadcaster/mod | Moves from reveal to the next lobby. |
| `!sus end` | Broadcaster/mod | Ends the session. |
| `!sus help` | Anyone | Posts the short rules. |

## Private cards without viewer OAuth

The card page gives a viewer a short claim code tied to an HTTP-only browser session. They type that code in Twitch chat, and the server links the card only when the chat name matches the name entered on the page. The secret role is sent only to that browser session; viewers never need to authorize a Twitch account.

## Built with Codex

The project was built in four focused steps:

1. Pure game logic, word detection, scoring, and tests.
2. Twitch OAuth, EventSub chat, server routes, and live state.
3. The Case File overlay, private mobile cards, reveal animation, and host controls.
4. Offline rehearsal mode, streamer documentation, and final polish.
