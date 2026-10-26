# Sus Word: tables, live accusations and tournament (spec for steps 9–10)

The game must work from 3 players to 200+ in one Twitch chat. Model: **tables**. One table is exactly the current game.

## 1. Seating
- Only claimed players (linked card) are seated. Seating happens when a round starts (`go`):
  claimed players are dealt into tables of **max 12**. The number of tables is `ceil(n / 12)`, and players are spread as evenly as possible
  (30 → 10/10/10, 13 → 7/6, never a table under 3; if n < 3 the round can't start).
- Seating is reshuffled every round (randomly, but people who were at the featured table last round go first to non-featured ones, so the spotlight rotates).
- Players who join or claim during a round are seated next round. The bot replies once per round with a summary, not to each person.
- Table ids: 1, 2, 3… Table 1 is not special.

## 2. Roles per table
- Imposters per table: 3–9 seated → 1; 10–12 → 2. Never the same player twice in a row if avoidable.
- Every Imposter gets their own word from a category no other Imposter at that table has. Tables may share categories.
- Imposters at a table don't know about each other; their card says "You might not be the only Imposter at your table".

## 3. Messages and evidence
- A chat message from a seated player is evidence only for their own table. Smuggle/decoy detection is per table (word list of that table).
- Messages from unseated chatters (no card) are "crowd": counted, not evidence.

## 4. Live accusation: `!accuse name word`
- Seated players can accuse players at their own table. One accusation per player per round. Only valid during ROUND.
- Correct when the named player is an Imposter at that table, has already smuggled, and the word matches (findWord forms allowed, case-insensitive).
  - Correct: that Imposter is BUSTED immediately (they stop counting as uncaught; they still play but can't score more). Accuser +2. Event "busted".
  - Wrong (including "not smuggled yet"): the accuser's shot is spent. Event "accuseMiss". No penalty otherwise.
- The **crowd** (unseated chatters) can accuse players at the featured table only, same rules, max one per round; points still count on the leaderboard.

## 5. Vote (end of round)
- `!vote name`: seated players vote within their table; the crowd votes for the featured table. One vote each, replaceable.
- Per table: let k = number of Imposters at that table not busted. The accused are the top-k by votes; a tie at the boundary is not accused.
  An un-busted Imposter in the accused set is CAUGHT.

## 6. Scoring
- Imposter: smuggled and neither busted nor caught = +3; smuggled but busted/caught = +1; never smuggled = 0.
- Correct accusation = +2. A vote for an Imposter who ends up CAUGHT by the vote = +1.
- Accidental decoys: no points; in the reveal the first one gets a ribbon "Most suspicious civilian".
- One global leaderboard across tables.

## 7. Featured table and stream
- One table is featured on the overlay (the full board, evidence tray, vote and reveal as today).
  Default: rotate each round to the next table id. The host can pick: `POST /api/host/feature/:tableId` and buttons on the host page.
- Overlay extras: a small strip "TABLE 2 of 3 · 30 players" and, in REVEAL, a bottom strip with other tables' results ("T1: @mara GOT AWAY · T3: @fox BUSTED by @kai").
- Busted events at the featured table: the IMPOSTER/BUSTED stamp slams on that Polaroid live, with the accuser's name.

## 8. Phone card = your table
- Shows: your table number, your role, and your word if you are an Imposter. Your table's hints at the same times as now.
  The live feed of your table's messages (last 20), your table-mates as small Polaroids, and a quick "accuse" helper (pick a name, type a word → shows the exact `!accuse name word` to copy into chat).
- At REVEAL: your table's result, plus your own points this round.

## 9. Tournament: final table
- Host action `final`: in LOBBY, take the top scorer from each table (or the top 12 overall if there are more than 12 tables) and seat only them for one round on a single featured table.
  Everyone else becomes crowd (they can accuse and vote on the final table).
  After that round, the overlay shows "CHAMPION @name" with a big stamp, and the game returns to normal tables.

## 10. Bot messages (rate-safe)
- Lobby: one message. Round start: one message with "N tables · check your card for your table".
- Hints: one line for the featured table only ("Table 2 hint: places"); other tables get hints on their cards.
- Busted: batch into one line every 10 s ("🚨 Busted: @fox caught @mara (CANDLE), @kai caught @ben (ROCKET)").
- Reveal: one line for the featured table, then one summary line "Other tables: 3 caught, 2 got away".
- Never more than 1 message per 1.5 s (existing queue).

## 11. Tests (pure, with the injected clock)
- Seating sizes for 3, 4, 12, 13, 30, 200 players; no table under 3.
- Imposter counts per table size; distinct categories per table.
- Evidence isolation between tables (a word said at table 2 doesn't smuggle for table 1).
- Accuse: correct, wrong word, wrong person, before smuggle, twice, crowd on featured table only.
- Vote top-k with ties; scoring table above; the final table selection.
- A simulated 200-player round finishes in under 1 s of CPU.

## 12. The streamer at the tables (Roma 14134)
- Everyone hears the streamer's voice, so the streamer always sits at the **featured table** (the one on stream) and moves with it when it changes. Their voice and chat messages are evidence only for that table.
- At the featured table the streamer is an ordinary player: they can be an Imposter, they can be accused (`!accuse <streamer> word`), and the crowd can vote for them.
- When the streamer is an Imposter, they smuggle the word out loud on air. That's the main show of a big stream: the whole chat hears every phrase and tries to catch them.
- A "Host plays" switch on the host page (on by default). Off = the streamer only hosts (big tournaments, or when the streamer just wants to lead the game); then they aren't seated and can't be an Imposter.
- The streamer's card works as usual (role, word on their phone). The host page still never shows roles.
- The streamer doesn't count against the limit of 12: the featured table can have 12 players + the streamer.

## 13. Side tables talk on the phone, the main chat stays clean (Roma 14138)
Problem: 10 tables in one Twitch chat make a mess that's impossible to read.
Solution:
- **Main table (featured)** plays in Twitch chat, on stream, as now. The main chat holds only the main table, the crowd (!accuse/!vote on the main table) and the bot's summaries.
- **Side tables** talk in the **table chat inside the card** (on the phone/browser). The card's identity is already tied to the Twitch name through !claim, so messages are signed with the real nickname and avatar.
  Messages go to the server over the card's WebSocket (`{type:"tableChat", text}`) and pass through the same recordMessage: smuggle, decoys, accusations (`/accuse name word` or a button in the card), votes (buttons in the card).
- Messages typed into Twitch chat by side-table players don't count as their table's evidence (they're simply chat, the crowd).
- When a table becomes the main one next round, its players play in Twitch chat again (the card says "Your table is ON STREAM: talk in Twitch chat").
- Table chat safeguards: max 200 characters, at most 1 message every 2 s per player, links are cut, length and rate limits are enforced on the server. The streamer can mute a player with `!sus mute name` (they leave the tables until the end of the evening).
