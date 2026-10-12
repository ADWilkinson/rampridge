# Link preview cards

The images that make a shared link unfurl. They are captured from the running
game (live merchant offers, players, chat and level-up fireworks), so the bake
does not make them; these scripts do. They show Jagex's art, so like
`public/game` they are gitignored: `scripts/bake/assets.lock.json` records
them and `scripts/deploy.sh` copies them into the deploy from the checkout.

| File | Size | Used by |
|---|---|---|
| `public/og.png` | 1200x630 | `index.html` `og:image` / `twitter:image`, the fallback card in `api/og.ts`, the manifest's wide screenshot |
| `public/og-square.png` | 1200x1200 | the manifest's square screenshot |
| `public/og-bg.png` | 1200x630 | backdrop of each trade's card (`api/_lib/shareCard.ts`) |
| `public/og-coins.png` | 108x96 | coin stack on each trade's card (baked by `bun run bake`, not captured) |

`vercel.json` bundles `og.png`, `og-bg.png` and `og-coins.png` into the
`api/og.ts` function, so keep those names.

## Scripts

- `capture.mjs` drives `dev/engine.html` on a running dev server in headless
  Chrome (real GPU). It hides the harness controls, swaps the merchants for
  eight that shout the best live offers from `/api/market`, has six players
  chat, sets off fireworks on the second frame and writes `<out>-N.png`.
- `compose.mjs` lays the logo, dark vignettes and the copy (`compose.html`,
  RS Bold 12) over a captured scene and saves the card at 1x.
- `cdp.mjs` is the small Chrome DevTools driver both use (Node 22+, no
  dependencies). `CHROME_PATH` overrides the macOS Chrome path; throwaway
  profiles go under `SHOOT_PROFILE_ROOT` or the OS temp dir.

## Camera

The camera looks down over the hall with the booths along the top edge and
the rope lanes and rug in the middle. Scenes are captured at half size with a
device pixel ratio of 2: the game frames the bank as a 600 px wide window
would, overhead text keeps its in-game size, and the PNG comes out at full card
size.

| Card | Viewport | Yaw | Pitch | Zoom | Mode |
|---|---|---|---|---|---|
| `og.png` | 600x315 at 2x | -pi/2 (-1.5708) | 0.9 | 1.3 | `chat` |
| `og-square.png` | 600x600 at 2x | -pi/2 (-1.5708) | 0.95 | 1.1 | `chat` |
| `og-bg.png` | 600x315 at 2x | -pi/2 (-1.5708) | 0.9 | 1.3 | `fireworks`, `--no-stall` |

`chat` shows merchant shouts, player chat and fireworks. `fireworks` keeps the
crowd and the fireworks but no text, so a trade card's own text reads cleanly
over it. `quiet` is the bare scene. Every capture uses 16 players.

## Run

```bash
# 1. Dev server with the dev API on (capture only reads /api/market).
RAMPRIDGE_DEV_LIVE_DB=1 bunx vite --port 5173 --strictPort

# 2. Scenes: each run writes several frames. The crowd moves, so look at them
#    and keep the one that reads best (the shipped cards used frame 2).
node scripts/og/capture.mjs --out /tmp/og/wide --size 600x315 --camera=-1.5708,0.9,1.3 --mode chat
node scripts/og/capture.mjs --out /tmp/og/square --size 600x600 --camera=-1.5708,0.95,1.1 --mode chat --frames 5
node scripts/og/capture.mjs --out /tmp/og/bg --size 600x315 --camera=-1.5708,0.9,1.3 --mode fireworks --no-stall --frames 4

# 3. Cards.
node scripts/og/compose.mjs wide /tmp/og/wide-2.png public/og.png
node scripts/og/compose.mjs square /tmp/og/square-2.png public/og-square.png
cp /tmp/og/bg-2.png public/og-bg.png

# 4. Record the new files in the asset lock and commit it (the images themselves stay out of git).
bun run assets:lock
```

The coin stack (`og-coins.png`, the 10,000-coin icon at 3x) comes from the
bake's `ui` step.

Set `OG_ORIGIN` (or `--origin`) when the dev server is not on
`http://localhost:5173`. The camera value needs the `=` form because it
starts with a minus sign.

The merchant shouts are the real best offers at capture time, so a new
capture shows that moment's rates. To change only the copy or layout, re-run
step 3 on the scenes you kept: `compose.mjs` reproduces the shipped cards from
their scenes to within one colour level. After changing a card, check it with
`bunx vitest run api/_lib/share.test.ts` (sizes) and in a link preview
validator once deployed.
