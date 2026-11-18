# python3 -I process_expr.py <raw_dir> <out_dir> <picks.json> [size]   picks: {"happy": 1101, ...}
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from keyout import to_rgba
from PIL import Image
raw, out, picks = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3])); size = int(sys.argv[4]) if len(sys.argv) > 4 else 384
os.makedirs(out, exist_ok=True)
CUT = {"empty"}   # object with a ground shadow on the mint: BiRefNet's cutout (cutouts/) is cleaner than keying
ims = {k: (Image.open(f"{os.path.dirname(raw)}/cutouts/{k}_s{s}_00001.webp").convert("RGBA") if k in CUT else to_rgba(Image.open(f"{raw}/{k}_s{s}_00001.png"))) for k, s in picks.items()}
box = None
for im in ims.values():
    b = im.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
pad = 14; side = max(box[2]-box[0], box[3]-box[1]) + 2*pad
cx, cy = (box[0]+box[2])//2, (box[1]+box[3])//2
sq = (cx-side//2, cy-side//2, cx-side//2+side, cy-side//2+side)
print("common crop", sq, "side", side)
for k, im in ims.items():
    c = Image.new("RGBA", (side, side), (0, 0, 0, 0)); c.paste(im.crop(sq), (0, 0))
    c.resize((size, size), Image.LANCZOS).save(f"{out}/{k}.webp", quality=84, alpha_quality=90, method=6)
