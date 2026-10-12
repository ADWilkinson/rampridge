# Edits the raw launch captures into the hero cuts and loops (see scripts/launch/README.md).
#   LAUNCH_DIR   where scripts/capture/record.mjs wrote raw/ and stills/; the edits land here too
#                (default: $TMPDIR/rampridge-launch)
#   LAUNCH_WORK  intermediate segments and the caption PNGs in caps/ (default: $LAUNCH_DIR/work)
#   FFMPEG       the ffmpeg binary (default: ffmpeg on PATH)
import subprocess, json, os, sys, re, tempfile
from concurrent.futures import ThreadPoolExecutor
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FF = os.environ.get("FFMPEG", "ffmpeg")
OUT = os.environ.get("LAUNCH_DIR", os.path.join(tempfile.gettempdir(), "rampridge-launch"))
E = os.environ.get("LAUNCH_WORK", os.path.join(OUT, "work"))
RAW = OUT + "/raw"
SND = os.path.join(REPO, "public", "game", "sounds")
B = E + "/build"; os.makedirs(B, exist_ok=True)
COLOR = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
INTER = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p", *COLOR, "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"]
CAPFMT = "format=rgba,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p"

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode: print(" ".join(cmd)); print(r.stderr[-3000:]); sys.exit(1)
    return r.stderr

# 1. QR-blurred sources (the payment scroll QR points at revolut.me/rampridge, an unverified handle)
QR = {"trade-16x9": (716, 164, 176, "gte(t,7.3)"), "payverify-16x9": (750, 142, 154, "lt(t,2.0)"),
      "trade-9x16": (450, 266, 180, "gte(t,6.9)"), "payverify-9x16": (450, 266, 180, "lt(t,2.0)")}
def src(name):
    return f"{B}/src-{name}.mkv" if name in QR else f"{RAW}/{name}.mp4"
def blur_src(name):
    x, y, s, en = QR[name]
    fc = f"[0:v]split[a][b];[b]crop={s}:{s}:{x}:{y},boxblur=28:5:14:5[q];[a][q]overlay={x}:{y}:enable='{en}'[v]"
    run([FF, "-v", "error", "-y", "-i", f"{RAW}/{name}.mp4", "-filter_complex", fc, "-map", "[v]", "-map", "0:a", *INTER, src(name)])

def segment(i, tag, name, ss, to, cap):
    out = f"{B}/{tag}-{i:02d}.mkv"; d = round(to - ss, 3)
    if cap:
        fc = f"[1:v]{CAPFMT}[c];[0:v][c]overlay=0:0[v]"
        ins = ["-i", f"{E}/caps/{cap}.png"]
    else:
        fc, ins = "[0:v]null[v]", []
    fc += f";[0:a]afade=t=in:d=0.012,afade=t=out:st={d-0.012}:d=0.012[a]"
    run([FF, "-v", "error", "-y", "-ss", str(ss), "-t", str(d), "-i", src(name), *ins, "-filter_complex", fc,
         "-map", "[v]", "-map", "[a]", "-r", "30", *INTER, out])
    return out

def endcard(tag, name, ss, d, card):
    out = f"{B}/{tag}-end.mkv"
    fc = (f"[0:v]gblur=sigma=6,eq=brightness=-0.10:saturation=0.85,drawbox=t=fill:color=black@0.45,fade=t=in:st=0:d=0.25[bg];"
          f"[1:v]{CAPFMT},fade=t=in:st=0.1:d=0.35:alpha=1[c];[bg][c]overlay=0:0:shortest=1[v];"
          f"[2:a]aresample=48000,aformat=channel_layouts=stereo,adelay=150|150,apad,atrim=0:{d},afade=t=out:st={d-0.4}:d=0.4[a]")
    run([FF, "-v", "error", "-y", "-ss", str(ss), "-t", str(d), "-i", f"{RAW}/{name}.mp4", "-loop", "1", "-t", str(d), "-i", f"{E}/caps/{card}.png",
         "-i", f"{SND}/coins.wav", "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-r", "30", *INTER, out])
    return out

def finish(parts, final, crf="18", gain=None):
    # concat -> encode video final quality, then two-pass loudnorm on audio, mux faststart
    tmp = f"{B}/{os.path.basename(final)}.tmp.mkv"
    n = len(parts); ins = sum([["-i", p] for p in parts], [])
    fc = "".join(f"[{k}:v][{k}:a]" for k in range(n)) + f"concat=n={n}:v=1:a=1[v][a]"
    run([FF, "-v", "error", "-y", *ins, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-crf", crf, "-maxrate", "20M", "-bufsize", "40M",
         "-pix_fmt", "yuv420p", *COLOR, "-r", "30", "-g", "60", "-c:a", "pcm_s16le", tmp])
    err = run([FF, "-hide_banner", "-i", tmp, "-map", "0:a", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"])
    m = json.loads(err[err.rindex("{"):err.rindex("}") + 1])
    if gain is not None: ln = f"volume={gain}dB,alimiter=limit=0.84:level=false,aresample=48000"
    else: ln = (f"loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
          f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,aresample=48000")
    run([FF, "-v", "error", "-y", "-i", tmp, "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-af", ln,
         "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", final])
    os.remove(tmp)
    return m['input_i']

H16 = [("social-16x9", 1.5, 5.5, "c16_0"), ("walkin-16x9", 4.3, 7.8, "c16_1"),
       ("exchange-16x9", 0.6, 2.2, "c16_2"), ("exchange-16x9", 5.6, 9.6, "c16_2"),
       ("trade-16x9", 1.4, 6.4, "c16_3"),
       ("payverify-16x9", 0.0, 1.3, "c16_4"), ("payverify-16x9", 3.2, 5.4, "c16_4"), ("payverify-16x9", 6.2, 9.8, "c16_5"),
       ("sell-16x9", 2.5, 3.3, "c16_6"), ("sell-16x9", 6.2, 12.3, "c16_6")]
H9 = [("social-9x16", 1.8, 5.4, "c9_0"), ("walkin-9x16", 5.0, 7.6, "c9_1"),
      ("exchange-9x16", 0.5, 1.6, "c9_2"), ("exchange-9x16", 4.4, 7.8, "c9_2"),
      ("trade-9x16", 0.4, 1.4, "c9_3"), ("trade-9x16", 3.4, 6.0, "c9_3"),
      ("payverify-9x16", 0.0, 1.0, "c9_4"), ("payverify-9x16", 3.0, 4.6, "c9_4"), ("payverify-9x16", 5.4, 8.6, "c9_5"),
      ("sell-9x16", 0.4, 1.2, "c9_6"), ("sell-9x16", 4.4, 6.0, "c9_6"), ("sell-9x16", 7.3, 9.8, "c9_6")]
LOOPS = {"loop-exchange": [("exchange-16x9", 0.5, 2.2), ("exchange-16x9", 5.6, 11.0)],
         "loop-trade": [("trade-16x9", 1.2, 10.0)],
         "loop-payverify": [("payverify-16x9", 0.0, 10.5)],
         "loop-sell": [("sell-16x9", 1.0, 12.5)],
         "loop-social": [("social-16x9", 0.0, 9.0)]}

what = sys.argv[1:] or ["src", "hero16", "hero9", "loops"]
with ThreadPoolExecutor(8) as ex:
    if "src" in what:
        list(ex.map(blur_src, QR))
    jobs = {}
    if "hero16" in what:
        jobs["hero-16x9"] = [ex.submit(segment, i, "h16", *s) for i, s in enumerate(H16)] + [ex.submit(endcard, "h16", "orbit-16x9", 6.5, 3.5, "end16")]
    if "hero9" in what:
        jobs["hero-9x16"] = [ex.submit(segment, i, "h9", *s) for i, s in enumerate(H9)] + [ex.submit(endcard, "h9", "orbit-9x16", 7.0, 3.0, "end9")]
    if "loops" in what:
        for k, segs in LOOPS.items():
            jobs[k] = [ex.submit(segment, i, k, n, a, b, None) for i, (n, a, b) in enumerate(segs)]
    fins = {k: ex.submit(finish, [f.result() for f in v], f"{OUT}/{k}.mp4", "18", None if k.startswith("hero") else -2.0) for k, v in jobs.items()}
    for k, f in fins.items(): print(k, "input_I", f.result())
