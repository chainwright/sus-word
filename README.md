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

Open `http://localhost:3000/host` for controls. For an offline rehearsal, run `npm run demo -- --fast` and open the overlay; omit `--fast` for full three-minute timing. Add `--players 30` (up to 200) to rehearse multiple tables.

## Mixed rehearsal on your real channel

Testing alone? `npm run sim` connects to your real Twitch channel like `npm start`, and also seats three simulated players (`--sim 5` for more). Their names start with "Sim", their lines show on the overlay and in the reveal, and they never post in Twitch chat. You join and claim a card as usual, start rounds with `!sus go` in chat, and play against them: they chat, one of them may be the Imposter and hide the word, and they vote. In this mode the lobby waits for `!sus go` and rounds are 75 seconds.

## Big chats: tables

One table is the whole game for a small stream. When more people claim cards, Sus Word deals them into tables of up to 12, and every table plays at the same time on one timer.

- A table of 3–9 players has one Imposter. A table of 10–12 has two, each with their own word.
- The table on stream (the featured table) plays in Twitch chat. Every other table talks in its own chat inside the phone card, so the main chat stays readable.
- `!accuse name word` is a live accusation: one shot per round, valid only after the word was smuggled. Right answer: that Imposter is busted on the spot.
- Viewers without a card are the crowd: they can accuse and vote on the featured table.
- The streamer always sits at the featured table, so their voice only counts where everyone can hear it. Turn off **Host plays** to just host.
- The featured table rotates every round, and the host can pick any table. **FINAL** seats the top scorer from each table for one last round on stream.

Tested in rehearsal with up to 200 virtual players; a 200-player round resolves in a few milliseconds.

## Streamer voice

Open the host page in Google Chrome and turn on **🎙 Mic**. Allow microphone access when Chrome asks. Final speech chunks count as the broadcaster's game messages, so the streamer can be suspected or can hide the word out loud as the Imposter. The broadcaster still needs to join and claim a card first.

## Chat commands

| Command | Who | What it does |
| --- | --- | --- |
| `!join` | Anyone | Joins the game. |
| `!claim CODE` | Anyone | Links a private card to that Twitch name. |
| `!leave` | Player | Leaves the game. |
| `!vote name` | Player or crowd | Votes during the vote phase. |
| `!accuse name word` | Player or crowd | One live accusation per round. |
| `!sus start` | Broadcaster/mod | Opens the lobby. |
| `!sus go` | Broadcaster/mod | Starts a round. |
| `!sus vote` | Broadcaster/mod | Opens voting early. |
| `!sus next` | Broadcaster/mod | Moves from reveal to the next lobby. |
| `!sus end` | Broadcaster/mod | Ends the session. |
| `!sus mute name` | Broadcaster/mod | Removes a player from tables for the session. |
| `!sus help` | Anyone | Posts the short rules. |

## Private cards without viewer OAuth

The card page gives a viewer a short claim code tied to an HTTP-only browser session. They type that code in Twitch chat, and the server links the card only when the chat name matches the name entered on the page. The secret role is sent only to that browser session; viewers never need to authorize a Twitch account.

## Built with Codex

Everything was built in one Codex thread, step by step, with tests at every step:

1. Pure game logic, word detection, scoring, and tests.
2. Twitch OAuth, EventSub chat, server routes, and live state.
3. The Case File overlay, private mobile cards, reveal animation, and host controls.
4. Offline rehearsal mode and streamer documentation.
5. Streamer voice through the Web Speech API.
6. The detective-desk host page from an approved design frame and generated image assets.
7. The photo-real overlay and phone card.
8. Screens that hold up with 30+ players.
9. Tables, live accusations, crowd play, and the final table.
10. Table screens, phone table chat, and the streamer's seat.

The first live test ran on a real Twitch channel and caught one rule bug (a three-way tie counted as a catch), which is now covered by a test.
