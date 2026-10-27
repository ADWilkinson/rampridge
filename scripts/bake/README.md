# RampRidge asset bake

Regenerates every world asset RampRidge ships from the Old School RuneScape
cache on disk: the Varrock West Bank scene, collision, gameplay metadata, the
minimap, interface sprites, item icons, fonts, sound effects and branding art.
Then it runs the actor bake (`actors/index.ts`, owned separately) so one
command bakes everything. Output is deterministic: re-running against the same
cache rewrites nothing.

The baked files are Jagex's art and data, so the repository does not contain
them: `public/game` (except the RampRidge wordmark) and the `public/og*.png`
link previews are gitignored. A fresh clone builds them with one command from
the repository root, which fetches the cache production was baked from (about
190 MB from archive.openrs2.org, once) and RuneStar's fonts into `.cache/`,
bakes, and reports how the result compares with production:

```bash
bun run setup:assets                 # fresh clone: fetch the pinned inputs, bake, compare
bun run bake                         # from the repo root (installs bake deps first), rewrites assets.lock.json
cd scripts/bake && bun run bake      # same, from here
bun run bake -- --only=world,collision
bun run bake -- --skip=ui --no-actors
bun run bake -- --no-lock            # leave assets.lock.json alone
bun run typecheck                    # bake sources (strict)
```

Requirements: Bun, Node (the bake runs under `tsx` on Node, not Bun: Bun's
`node:zlib` deflates differently, so 27 sprites come out pixel-identical but
not byte-identical to the lock), `unzip` (to unpack the downloads), the OSRS
cache under `.cache/osrs/caches` (`bun run setup:assets` or `bun run fetch-cache`, see
below) and Google Chrome for the wordmark in the `ui` step (`CHROME_PATH`
overrides the macOS default; profiles are throwaway temp dirs under
`SHOOT_PROFILE_ROOT` or the OS temp dir). Without Chrome the step keeps the
committed `logo.png` and `privy-logo.png`. A full bake takes about 20 s.

## The asset lock

`assets.lock.json` (committed) lists every untracked file the site serves
(the baked `public/game` files, `public/og-coins.png` and the link previews
scripts/og captures) with its size and SHA-256, and the openrs2 cache they
came from. The bake rewrites it at the end; `bun run assets:lock` rewrites it
from the files on disk without baking (after a new scripts/og capture).
`scripts/deploy.sh` copies exactly these files from the checkout into the
deploy and refuses to deploy if one is missing or different, or if the lock
disagrees with the code (an asset the code loads by name that the lock lacks,
`actors.bin` other than `catalog.generated.ts` describes, or a cache other
than `shared/world-meta.json` names). `scripts/assets.ts` implements this and
`scripts/assets.test.ts` checks the committed lock against the code in CI.

## Outputs

| Step | Files | Consumers |
|---|---|---|
| `collision` | `public/game/world/collision.json`, `shared/collision.json` (identical), `shared/world-meta.json` | engine pathfinding and placement, API move validation |
| `world` | `public/game/world/varrock-west-bank.glb` | engine scene |
| `minimap` | `public/game/world/minimap.png`, `minimap.json`, `minimap-icons/*.png` | engine minimap |
| `sprites` | `public/game/sprites/*.png`, `manifest.json` | UI interfaces, engine click crosses |
| `fonts` | `public/game/fonts/*.ttf`, `fonts.css`, `LICENSE.md` | UI |
| `sounds` | `public/game/sounds/*.wav`, `manifest.json`, `sources.json` | UI and engine sound |
| `ui` | `public/game/ui/{logo,privy-logo,favicon,apple-touch-icon,icon-192,icon-512,icon-maskable-512}.png`, `public/og-coins.png` | title screen, Privy, `index.html`, web app manifest, share cards |
| actors | `public/game/actors/actors.bin`, `src/game/osrs/catalog.generated.ts` | `src/game/osrs` (see `actors/index.ts`) |

Every PNG the bake writes (sprites, item icons, minimap, GLB textures,
branding) goes through `lib/png-encode.ts`, the smallest lossless encoding it
can find: an indexed PNG (palette plus tRNS, 1 to 8 bits) when the image has
at most 256 colours, as cache art does, otherwise RGB or RGBA, each with the
best of several row filters and zlib strategies. Pixels are kept exactly,
including the colour of fully transparent pixels. Against pngjs at level 9
this took the sprite and minimap PNGs from 606 KB to 210 KB, the GLB textures
from 113 KB to 32 KB and logo.png from 162 KB to 113 KB.
`bun run optimize-png [dirs]` re-encodes existing files the same way (default
`public/game/ui`), checking every pixel, for images a step didn't regenerate
(the Chrome-rendered wordmarks, the app icons).

### Coordinate frame

1 unit = 1 tile, y up, north = -z. The origin is the south-west corner of world
tile (3176, 3428), so tile (X, Y) has its centre at
`x = X - 3176 + 0.5, z = -(Y - 3428 + 0.5)`. The bank floor is flat at
`floorHeight` = 312/128 = 2.4375; the street in front of the entrance is lower,
so use `world-meta.json` `heightMap` (tile-corner heights, interpolate
bilinearly like the client) for anything outside. Models face south by default.

### varrock-west-bank.glb

- Area: world x 3164-3206, y 3414-3462. The core room (3176-3194 x 3428-3452)
  plus a ring of street and neighbouring buildings so the doorway and windows
  look out on Varrock.
- One node, `plane0`, under `varrock_west_bank`: map level 0 only. The 2007
  client hid levels 1-3 (upper floors and every building's roof) while the
  player stood on a tile flagged indoors (`world-meta.json` `indoors`), and
  RampRidge players never leave the hall and its street strip, so the engine
  never showed them. Dropping them took the GLB from 2.49 MB to 1.81 MB
  (1.08 MB to 0.79 MB brotli) with plane 0 bit-identical.
- Built by rs-map-viewer's `SceneBuilder`: the client's floor blending, loc
  placement and rotation, ground contouring and Gouraud lighting, baked into
  `COLOR_0`. Materials are `KHR_materials_unlit` (three.js
  `MeshBasicMaterial` with vertex colours), single-sided like the client's
  back-face culling. Palette and textures use the client's default brightness
  (0.8). Textured faces carry their light level as a linear vertex colour that
  multiplies the texture, like the client's textured rasteriser.
- Draw order: the client paints faces by render priority within a model and
  floor decorations over the floor. A depth buffer would z-fight there, so
  higher-priority faces are pushed 0.12 RS units per priority step towards
  their front and floor decorations (the rug) are lifted 0.75 units.
- Multiloc/animated locs are shown in their default state at frame 0 (booth
  34810 resolves to 10583).
- Compressed with gltf-transform dedup, weld, quantize and meshopt
  (`EXT_meshopt_compression`, `KHR_mesh_quantization`); textures are indexed
  PNGs (`lib/png-encode.ts`). Re-encoding at meshopt `medium`, dropping the
  constant alpha of opaque vertex colours or reordering for size made no
  difference after brotli (checked 2026-10-11). Load with three.js
  `GLTFLoader().setMeshoptDecoder(MeshoptDecoder)`
  (`three/examples/jsm/libs/meshopt_decoder.module.js`).

### collision.json

`{ originX: 3176, originY: 3428, width: 19, height: 25, flags: number[] }`,
row-major, `index = (y - originY) * width + (x - originX)`, plane 0. Flags are
the client's own collision bits (rs-map-viewer `CollisionMap`, with the
floor-collision indexing fix below):

| Bit | Name | Meaning |
|---|---|---|
| `0x1` | WALL_NORTH_WEST | diagonal wall in the north-west corner |
| `0x2` | WALL_NORTH | wall on the tile's north edge |
| `0x4` | WALL_NORTH_EAST | |
| `0x8` | WALL_EAST | wall on the east edge |
| `0x10` | WALL_SOUTH_EAST | |
| `0x20` | WALL_SOUTH | wall on the south edge |
| `0x40` | WALL_SOUTH_WEST | |
| `0x80` | WALL_WEST | wall on the west edge |
| `0x100` | OBJECT | solid loc (booth, table, deposit box, ...) occupies the tile |
| `0x200`..`0x10000` | LOS walls | the eight wall bits again, for line of sight / projectiles |
| `0x20000` | OBJECT_LOS | the object also blocks line of sight |
| `0x40000` | FLOOR_DECORATION | blocking floor decoration |
| `0x100000` | OUT_OF_BOUNDS | RampRidge: outside the playable `bounds` (the client's BLOCK_PLAYERS bit) |
| `0x200000` | FLOOR | blocked floor (map setting), e.g. behind the counter |

A tile can be stood on iff `(flags & 0x340100) === 0`. A step is legal iff the
destination passes the mask below, and for a diagonal also the two orthogonal
neighbours (the client's own masks, with OUT_OF_BOUNDS added). These are also
in `world-meta.json` under `collision`.

| Step | Destination | (x+dx, y) | (x, y+dy) |
|---|---|---|---|
| west | `0x340108` | | |
| east | `0x340180` | | |
| south | `0x340102` | | |
| north | `0x340120` | | |
| south-west | `0x34010e` | `0x340108` | `0x340102` |
| south-east | `0x340183` | `0x340180` | `0x340102` |
| north-west | `0x340138` | `0x340108` | `0x340120` |
| north-east | `0x3401e0` | `0x340180` | `0x340120` |

The south entrance's double doors stand permanently open in game (locs 11786
and 11787 are the open leaves, placed along the door frame), so they block only
along their edge, as in game. The staircase door (11775, "Open") and the
bankers' back door (11788, "Knock-at") are closed. The north back entrance is
open but leads outside `bounds`.

Walkable grid (north up; `##` blocked, `~~` outside bounds, `|` and `--`
walls, `B` booth, `u` booth use tile, `N` booth banker, `n` banker with no
booth, `s` spawn, `m` merchant tiles). Regenerated by the `collision` step:

<!-- collision-grid:start -->
```text
      76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 
                                                           /
 3452 ~~ ~~ ~~ ## ## ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ##
                                                              /
 3451 ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~

 3450 ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ## ## ~~

 3449 ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ## ## ~~

 3448 ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~
                  -- --       -- -- -- -- -- -- --/
 3447 ~~ ~~ ~~ ~~|## ##|     |##   |## ## ## ## ##|~~ ~~ ~~ ~~

 3446 ~~ ~~ ~~ ~~|                 |## nn ## ## ##|~~ ~~ ~~ ~~

 3445 ~~ ~~ ~~ ~~|   mm mm mm mm   |## ## ## ## ##|~~ ~~ ~~ ##
                                    -- --
 3444 ~~ ~~ ~~ ~~|##    mm mm    uu BB NN ## ## ##|~~ ~~ ~~ ##
                              -- --
 3443 ~~ ~~ ~~ ~~|##    mm mm mm   |## ## ## ## ##|~~ ~~ ~~ ~~

 3442 ~~ ~~ ~~ ~~|##    mm mm    uu BB NN ## ## ##|~~ ~~ ~~ ~~
                              -- --
 3441 ~~ ~~ ~~ ~~|   mm mm mm mm   |## ## ## ## ##|~~ ~~ ~~ ~~
                                                --
 3440 ~~ ~~ ~~ ~~|##    mm mm    uu BB NN ## ## ##|~~ ~~ ~~ ~~
                              -- --
 3439 ~~ ~~ ~~ ~~|   mm mm mm mm   |## ## ##|## ##|~~ ~~ ~~ ~~

 3438 ## ## ~~ ~~|##    mm mm    uu BB NN ##|## ##|~~ ~~ ~~ ~~
                              -- --
 3437 ## ## ~~ ~~|   mm mm mm mm   |## ## ##|## ##|~~ ~~ ~~ ~~

 3436 ~~ ~~ ~~ ~~|##             uu BB ## ##|## ##|~~ ~~ ~~ ~~
                                    -- -- -- -- --
 3435 ~~ ~~ ~~ ~~|##               |## ## ## ## ##|~~ ~~ ~~ ~~

 3434 ~~ ~~ ~~ ~~|   ss ss ss ss   |   ## ## ## ##|~~ ~~ ~~ ~~

 3433 ~~ ~~ ~~ ~~|##   |ss ss|     |   ## ## ## ##|~~ ~~ ~~ ~~
                 /-- --       -- -- -- -- -- -- --
 3432 ~~ ~~ ~~ ~~                                  ~~ ~~ ~~ ~~

 3431 ~~ ~~ ~~ ~~                                  ~~ ~~ ~~ ~~

 3430 ~~ ~~ ~~ ~~                                  ~~ ~~ ~~ ~~

 3429 ~~ ~~ ~~ ~~                                  ~~ ~~ ~~ ~~

 3428 ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~ ~~
```
<!-- collision-grid:end -->

### world-meta.json

Derived from the decoded locs and the collision grid, with assertions that
fail the bake if the bank layout changes:

- `origin`, `floorHeight`, `exported` (collision rect), `bounds` (playable:
  the hall plus four rows of street in front of the south entrance),
  `interior` (tiles flagged indoors), `indoors` (row-major 0/1 over the
  collision grid), `heightMap`.
- `spawn`: hall tiles on the south entrance's inside row and the row behind
  it, within one column of the opening, minus any with a wall on their south
  edge: the default camera looks north, so a player right behind the façade
  either side of the doorway would be hidden until they moved
  (`lib/placement.ts`).
- `bankers`: `{ npcId, name, tile, faceDir, faceYaw, actions, boothIndex }`.
  NPC spawns are not in the cache (servers place NPCs); positions come from the
  community spawn dump and are validated against the booths. `faceDir` is a
  compass direction; `faceYaw` is the three.js `rotation.y` that turns a
  south-facing model to it. `actions` is the NPC type's five cache menu ops in
  slot order (`null` = empty); the client always appends Examine. `boothIndex`
  is the booth the banker serves (the inverse of `booths[].bankerIndex`) or
  `null`. The four booth bankers (2897/2898) have `Talk-to`, `Bank`, `Collect`;
  the north banker (8666) stands behind the closed Knock-at door with no booth
  and no ops, so the original client offers only Examine on it. The bake fails
  unless a banker has a `Bank` op exactly when it has a booth.
- `booths`: `{ locId, name, tile, faceDir, faceYaw, useTile, bankerIndex }`.
  `useTile` is the hall tile a player stands on to use it; `bankerIndex`
  points into `bankers` (the southern booth has no banker).
- `merchantArea`: tiles the merchant NPCs wander between (`lib/placement.ts`):
  reachable hall floor minus each booth's queue (its use tile and the tile
  behind it), tiles beside (4-neighbour) an entrance or door, tiles within two
  tiles of a spawn or entrance tile, and tiles beside (4-neighbour) a solid
  object; floor decorations such as the rug and debris do not count. The bake
  fails if fewer than 24 tiles over 3 columns remain.
- `doors`: entrances (open) and doors (closed) with hall-side and far-side tiles.
- `landmarks`: named solid locs inside (deposit box, poll booth, tables, ...).
- `collision`: the flag table, `blocked` mask and `stepMasks`.

### minimap.png / minimap.json

The 2007 client's minimap: 4 px per tile, each tile its underlay/overlay
minimap colour with the client's shape masks, walls white, doors red, map
scenes (trees, plants, stairs) stamped in. North up, covering the GLB area.
`minimap.json` gives the bounds and the mapping: world tile (x, y) covers
`px = (x - minX) * 4`, `py = (maxY - y) * 4`. Map-function icons (bank, poll
booth, shops) are separate PNGs listed with their tiles; the client drew them
unrotated over the rotating map. Fixed-mode layout from interface 548: cover
`minimap_frame` at (0, 0), map viewport (`minimap_mask`, opaque outside the
visible area) at (25, 5), `compass_mask` at (0, 0). `dev/bake.html?page=minimap`
draws it.

### Sprites

`manifest.json`: `{ name: { file, w, h, offsetX, offsetY, canvasW, canvasH, id, frame } }`.
`offsetX/offsetY` place the PNG inside the sprite's canvas, like the client's
sprite offsets. IDs come from RuneLite's gameval `SpriteID`; layout choices were
checked against the cache's interface definitions (548 fixed frame, 12 bank,
465 GE, 162 chatbox, 160 orbs, 203 clue scroll). Notes:

- Tab icons are the fixed-mode set interface 548 uses (168, 898-910, 1709 for
  Account Management).
- The fixed-mode tab highlights 1027-1030 ship with an all-zero alpha channel
  over intact pixels; the decoder treats that as palette transparency, which
  recovers the red stone highlights.
- `parchment_scroll` is the clue scroll interface's 3D scroll model rendered as
  the client draws interface models; `content` is the text box from interface
  203.
- Item icons (`item_*`, 36x32) are rendered from item models exactly like the
  client's `ObjType.getItemSprite`: 512 focal length, item 2D angles and zoom,
  the client's depth/priority face ordering and Gouraud rasteriser, 1 px outline
  and the inventory shadow `0x302020`. Coins use the stack-size models (1, 2, 3,
  4, 5, 25, 100, 250, 1,000, 10,000). `item_bank_note` is coins drawn on the
  note template (item 799) as the client draws noted items; `item_note_blank`
  is the bare note.

### Fonts

RuneStar's TrueType conversions (https://github.com/RuneStar/fonts, release
1.103-0, asset `RuneScape-Fonts.zip`). `fetch-fonts.ts` downloads the release
into `.cache/runestar-fonts/1.103-0` and checks the zip and every face against
pinned SHA-256 hashes; the `fonts` step runs it when the files are missing.
RuneStar's conversion is CC0 1.0 (its repository's LICENSE); the glyph
designs are Jagex's, which is why the files are fetched, not committed.
`fonts.css` defines `RS Plain 11`, `RS Plain 12`,
`RS Bold 12`, `RS Quill 8` (plus Quill, Quill Caps, Fairy, Fairy Large,
Barbarian Assault, Surok), all `font-display: block`. They are pixel fonts with
16 units per em (32 or 64 for the large faces): render at 16 px or integer
multiples with font smoothing off.

### Sounds

Synthesised from cache index 4 with a TypeScript port of the client's synth
(`lib/synth.ts`): Java int arithmetic, float filter maths and the client's
`java.util.Random(0)` noise table. Written as mono 8-bit 22050 Hz WAV, which is
what the client plays and works in every browser. Verified bit-exact against
the OSRS Wiki's recording of sound 2115 (`Coins.wav`). IDs and config names
from the Wiki's "List of sound IDs" and RuneLite's `SoundEffectID`:

| Logical | File | ID | Config name |
|---|---|---|---|
| click | interface_select.wav | 2266 | interface_select1 |
| offer | ge_offer_placed.wav | 3925 | ge_trade_ok |
| collect | ge_collect_items.wav | 3928 | ge_collect_items |
| coins | ge_collect_coins.wav | 3924 | ge_collect_coins |
| levelup | level_up_fireworks.wav | 2396 | firework |
| trade | ge_place_item.wav | 3927 | ge_place_item |
| error | interface_wrong.wav | 2268 | interface_wrong |
| open | bank_unlocking.wav | 2027 | bank_unlocking |
| close | bank_locking.wav | 2024 | bank_locking |
| tradeError | ge_offer_error.wav | 3926 | ge_trade_error |
| increment / decrement | ge_increment.wav / ge_decrement.wav | 3929 / 3930 | ge_up_amount / ge_down_amount |
| coinsPickup / coinsDrop | coins_pickup.wav / coins_drop.wav | 2582 / 2739 | pick2 / put_down |

Music is not rendered. OSRS music and jingles (index 6 and 11, including the
level-up jingles and "Scape Main") need the client's MIDI synthesiser with its
instrument patches (index 15) and Vorbis samples (index 14). osrscachereader's
port of that engine is incomplete (its Vorbis decoder is a stub and the MIDI
sequencer only loads patches), and a General MIDI soundfont would not sound
like the game, so the bake skips music rather than ship an inaccurate render.
`levelup` therefore plays the level-up fireworks effect.

### Branding

`render/logo.html` draws the wordmark (Cinzel Black small caps, vendored under
`vendor/cinzel`, OFL) in the RuneScape title style: gold gradient, specular
bevel, dark outline and drop shadow. `logo.png` is 2x for ~640 px display;
`privy-logo.png` is the small version for the Privy modal. Both are RampRidge's
own art and stay committed. Chrome runs with single-threaded CPU raster so the
PNGs are byte-identical between runs.

`favicon.png` and `apple-touch-icon.png` are the client-rendered 10,000-coin
icon. The web app manifest's `icon-192.png`, `icon-512.png` and
`icon-maskable-512.png` are the whole 36x32 icon at 4x, 12x and 8x (the
maskable one inside the safe zone) on `#3e3528`, and `public/og-coins.png`
(108x96) is the icon at 3x for each trade's share card, all nearest neighbour.

The link preview cards (`public/og.png`, `og-square.png`, `og-bg.png`) are not
baked. They are captured from the running game with merchants, players and
fireworks, so `scripts/og` makes them; see its README.

## Fetching the cache

The bake always uses the newest entry in `.cache/osrs/caches/caches.json`.
`assets.lock.json` pins the cache production was baked from (openrs2 2735,
build 241, 2026-10-07); `fetch-cache` fetches that one unless told otherwise,
and registers a cache already on disk without downloading it again.

```bash
cd scripts/bake && bun run fetch-cache            # the pinned cache
bun run fetch-cache -- --latest                   # newest live cache, to update the game data
bun run fetch-cache -- --id=2735                  # a specific openrs2 id
```

What it does (also how to do it by hand):

1. For `--latest` or `--id`, download `https://archive.openrs2.org/caches.json`
   and keep entries with `game == "oldschool"`, `environment == "live"`,
   `language == "en"`; take the newest `timestamp` or the id.
2. Download `https://archive.openrs2.org/caches/runescape/<id>/disk.zip` and
   unzip `cache/main_file_cache.*` into
   `.cache/osrs/caches/osrs-<build>_<yyyy-mm-dd>/`.
3. Save `https://archive.openrs2.org/caches/runescape/<id>/keys.json` there
   (maps are unencrypted since build 237, so it is usually `[]`).
4. Append `{ name, game: "oldschool", environment: "live", revision: <build>,
   timestamp, size, openrs2Id: <id> }` to `.cache/osrs/caches/caches.json`.

`OPENRS2_URL` points it at a mirror. A failed download says so and how to
install the files by hand; nothing half-unpacked is left behind.

To move to a newer game build: `bun run fetch-cache -- --latest`, then
`bun run bake` (it records the new cache and hashes in `assets.lock.json`),
check the dev harness and commit the lock with the regenerated
`shared/*.json` and `catalog.generated.ts`. The collision step asserts the
bank layout (5 booths, the south entrance, a flat floor, staffed booths), so a
game update that changes the room fails loudly instead of shipping wrong data.

## Dev harness

`dev/bake.html` (served by Vite) renders the outputs; pages set
`document.title = "READY"` when done so `preview/shoot.ts` can screenshot them:

```bash
cd ../.. && bunx vite --port 5176 --strictPort &
cd scripts/bake && bun run shoot -- --size=1280x800 \
  "http://localhost:5176/dev/bake.html?view=top&overlay=1" /tmp/top.png
```

- `?page=world&view=interior|booths|doorway|street|exterior|north|rug|top`,
  `&overlay=1` draws collision (red blocked tiles and wall edges, blue outside
  bounds, cyan booths, green use tiles, yellow bankers, white spawn, magenta
  merchant tiles).
- `?page=minimap&x=&y=&yaw=` the fixed-mode minimap.
- `?page=sprites&filter=` sprite contact sheet.
- `?page=ui` branding.

## Layout

```
index.ts            orchestrator          fetch-cache.ts   cache download
setup.ts            fresh-clone setup     fetch-fonts.ts   RuneStar font download
assets.lock.json    shipped untracked files and their hashes (../assets.ts)
lib/                cache, paths, region, grid, placement, locs,
                    sprite-decode, item-icons, interfaces, synth, png,
                    png-encode, chrome
optimize-png.ts     lossless re-encode of existing PNGs
steps/              collision, world, minimap, sprites, fonts, sounds, ui
render/             logo.html (Chrome render page)
preview/            dev harness pages + shoot.ts
tests/              checks on the shipped outputs and the placement rules
                    (run by the root vitest)
types/              declarations for untyped JS deps
vendor/rs-map-viewer   dennisdev/rs-map-viewer d3c569b (BSD-2-Clause)
vendor/cinzel          Cinzel (SIL OFL 1.1)
actors/             actor bake (separate owner)
```

### Patches to the vendored rs-map-viewer

- `src/rs/scene/SceneBuilder.ts`: floor collision (`setBlockedByFloor`) used
  map-local instead of scene coordinates, misplacing blocked floor whenever
  the scene does not start on a map-square boundary.
- `src/rs/config/loctype/LocType.ts`: keep opcode 69 (access-block mask) as
  `accessBlockFlag` instead of discarding it.
- `src/rs/config/objtype/ObjType.ts`: decode opcode 43 (inventory sub-ops) and
  251 (flag), added to 2025-2026 caches.
- `src/rs/compression/Bzip2.ts`: ESM import instead of `require`.
- `src/mapviewer/Caches.ts`, `src/mapviewer/buffer/DataBuffer.ts`: added from
  upstream (imported by the vendored files); `src/mapviewer/data/npc/NpcSpawn.ts`
  reduced to its type (upstream loads JSON through Vite `?url` imports).
- Type-only casts for TypeScript 5.9 in `CacheFiles.ts`, `Model.ts`,
  `SkeletalBone.ts`, `PerlinNoiseOperation.ts`.
- The vendored map-square sprite loaders find no map scenes in 2026 caches;
  `steps/minimap.ts` decodes them itself rather than patching the loader.

`vendor/rs-map-viewer/scripts/cache/*.ts` are the research-era exporters kept
with the snapshot; `steps/` supersedes them.

## Licensing

All extracted art, models, sprites, sounds and the font glyphs are Jagex Ltd's
(RuneScape and Old School RuneScape are trademarks of Jagex Ltd), so none of
them is committed: the repository holds the code that decodes them from the
public cache, as rs-map-viewer and RuneLite do. What stays committed from the
cache is small factual data the game logic needs: `shared/collision.json` and
`shared/world-meta.json` (tile flags, coordinates, ids and menu option names;
the API validates moves against them) and `src/game/osrs/catalog.generated.ts`
(designer counts and the hash of `actors.bin`). Code: rs-map-viewer and
osrscachereader (the synth structure) are BSD-2-Clause; RuneStar's font
conversion is CC0; Cinzel is under the SIL Open Font License.
