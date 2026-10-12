# Launch media

Scripts that turned raw gameplay captures into the launch videos, captions and
phone mockups. They need the baked assets (`bun run bake`), Chrome, ffmpeg and
Python 3 with Pillow. Nothing here runs in CI or ships with the site.

Everything reads and writes one folder, `LAUNCH_DIR` (default
`$TMPDIR/rampridge-launch`): the recorder writes `raw/` and `stills/` there, the
captions and intermediate segments go to `$LAUNCH_DIR/work`, and the finished
cuts land in `LAUNCH_DIR`.

1. **Record** the raw clips with the capture harness (`dev/capture.html`,
   driven frame by frame over the Chrome DevTools protocol). Prices come from
   the frozen `src/capture/market-snapshot.json`, so no network is needed.

   ```bash
   export LAUNCH_DIR="${TMPDIR:-/tmp}/rampridge-launch"
   node_modules/.bin/vite --port 5199 --strictPort &   # the capture page's dev server
   node scripts/capture/record.mjs --base http://localhost:5199   # --beats exchange,trade --layouts desktop,phone --jobs 4
   ```

2. **Captions**: render the RuneScape-style overlays from `capspec.json`.

   ```bash
   python3 scripts/launch/caps.py "$LAUNCH_DIR/work/caps" scripts/launch/capspec.json
   ```

3. **Edit**: QR blur, caption overlays, end cards and a two-pass loudness
   normalisation into the hero cuts (16:9 and 9:16) and the loops.

   ```bash
   python3 scripts/launch/build.py              # or any of: src hero16 hero9 loops
   ```

4. **Phone mockups**: open `mock-world.html` or `mock-trade.html` in headless
   Chrome at a 2x device pixel ratio, passing the still to frame as
   `?img=<file URL>`.

`CHROME_PATH` and `FFMPEG` override the browser and ffmpeg binaries for the
recorder; `FFMPEG` does the same for `build.py`.
