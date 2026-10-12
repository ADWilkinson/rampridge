# Render RuneScape-style caption overlays (RS Bold 12, yellow, 1px black shadow, nearest-neighbour upscale).
#   python3 scripts/launch/caps.py <out dir> scripts/launch/capspec.json
# The font and logo come from the baked assets in public/game (bun run bake).
import os, sys, json
from PIL import Image, ImageDraw, ImageFont
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FONT = os.path.join(REPO, "public", "game", "fonts", "RuneScape-Bold-12.ttf")
LOGO = os.path.join(REPO, "public", "game", "ui", "logo.png")
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
f = ImageFont.truetype(FONT, 16)
YEL = (255, 255, 0, 255)

def native(text, color=YEL):
    l, t, r, b = f.getbbox(text)
    w, h = r + 2, 18
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im); d.fontmode = "1"
    d.text((1, 0), text, font=f, fill=(0, 0, 0, 255))
    d.text((0, -1), text, font=f, fill=color)
    return im

def block(lines, k, color=YEL, gap=2):
    ims = [native(s, color) for s in lines]
    w = max(i.width for i in ims); h = sum(i.height for i in ims) + gap * (len(ims) - 1)
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0)); y = 0
    for i in ims:
        im.paste(i, ((w - i.width) // 2, y), i); y += i.height + gap
    return im.resize((w * k, h * k), Image.NEAREST)

def band(W, H, y0, y1, peak, mode):
    # vertical alpha gradient; mode 'up' = 0 at y0 rising to peak at y1, 'mid' = feathered both ends
    a = Image.new("L", (1, H), 0); px = a.load()
    for y in range(y0, min(y1, H)):
        u = (y - y0) / max(1, (y1 - y0))
        if mode == "up": v = min(1, u * 1.6) ** 1.2
        else: v = min(1, min(u, 1 - u) * 3.2)
        px[0, y] = int(255 * peak * v)
    a = a.resize((W, H))
    im = Image.new("RGBA", (W, H), (0, 0, 0, 255)); im.putalpha(a); return im

spec = json.load(open(sys.argv[2]))
for name, c in spec.items():
    W, H = c["size"]
    canvas = band(W, H, *c["band"]) if c.get("band") else Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if c.get("logo"):
        lg = Image.open(LOGO).convert("RGBA"); lw = c["logo"]["w"]
        lg = lg.resize((lw, round(lg.height * lw / lg.width)), Image.LANCZOS)
        canvas.alpha_composite(lg, ((W - lw) // 2, c["logo"]["cy"] - lg.height // 2))
    for t in c.get("texts", []):
        b = block(t["lines"], t["k"], tuple(t.get("color", YEL)))
        if b.width > W - 40: print("WARN too wide", name, b.width, file=sys.stderr)
        canvas.alpha_composite(b, ((W - b.width) // 2, t["cy"] - b.height // 2))
    canvas.save(f"{OUT}/{name}.png")
    print(name, [ (t["lines"], block(t["lines"], t["k"]).size) for t in c.get("texts", [])])
