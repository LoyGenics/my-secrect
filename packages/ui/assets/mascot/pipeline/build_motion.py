# python3 -I build_motion.py <frames_dir> <out_dir> name:seed ...   12 fps ping-pong loops, 256px, key-out on the flat mint
import os, sys, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy import ndimage as ndi
from keyout import key_alpha, decontaminate
from PIL import Image
src, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True)
for spec in sys.argv[3:]:
    name, seed = spec.split(":"); d = f"{src}/{name}_s{seed}"
    fs = sorted(f for f in glob.glob(f"{d}/*.png") if not f.endswith("_a.png"))
    rgbs = [np.array(Image.open(f).convert("RGB")) for f in fs]
    al = []; bgs = []
    for r in rgbs: a, bg = key_alpha(r, min_area=25); al.append(a); bgs.append(bg)
    al = np.stack(al)
    med = np.stack([np.median(al[max(0, i-1):i+2], axis=0) for i in range(len(al))])   # kills one-frame glitches
    frames = []
    for r, a, bg in zip(rgbs, med, bgs):
        frames.append(Image.fromarray(np.dstack([decontaminate(r, a, bg), a * 255]).astype(np.uint8), "RGBA"))
    box = None
    for f in frames:
        b = f.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
        box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    W = frames[0].size[0]; pad = 8
    box = (max(0, box[0]-pad), max(0, box[1]-pad), min(W, box[2]+pad), min(W, box[3]+pad))
    side = max(box[2]-box[0], box[3]-box[1]); cx, cy = (box[0]+box[2])//2, (box[1]+box[3])//2
    sq = (cx-side//2, cy-side//2, cx-side//2+side, cy-side//2+side)
    sm = [f.crop(sq).resize((256, 256), Image.LANCZOS) for f in frames][::2]
    sm[0].save(f"{out}/{name}_s{seed}-still.webp", quality=88, alpha_quality=90, method=6)
    loop = sm + sm[-2:0:-1]
    loop[0].save(f"{out}/{name}_s{seed}.webp", save_all=True, append_images=loop[1:], duration=83, loop=0, quality=72, alpha_quality=88, method=4)
    print(name, seed, len(loop), "frames", os.path.getsize(f"{out}/{name}_s{seed}.webp")//1024, "KB", "crop", sq)
