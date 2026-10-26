# Sus Word: notes for Codex

- SPEC.md is the source of truth. If something isn't covered there, pick the simplest option and leave a one-line comment.
- design/*.jpg are the approved concept frames: the "Case File" detective noir look. Match their layout, palette and type feel. The text in them is placeholder.
- Node 24, plain JavaScript ES modules, no TypeScript, no build step. Dependencies: express, ws, dotenv only.
- Keep game logic pure and testable (src/game.js, src/words.js) with an injected clock. Twitch I/O lives only in src/twitch.js.
- Tests use node:test (`npm test`). Run them after every change.
- Never commit secrets: .env, .tokens.json, data/ are gitignored.
- Small, readable files. Comments only where the why isn't obvious.
