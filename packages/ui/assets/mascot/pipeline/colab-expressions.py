# My Secret mascot: expressions (Qwen-Image-Edit, Apache-2.0) + loops (Wan 2.2 TI2V-5B, Apache-2.0)
# via the ComfyUI server on :8188; cutouts with BiRefNet (MIT) through rembg.
import glob, json, os, shutil, sys, time, urllib.request, urllib.error
API = "http://127.0.0.1:8188"; M = "/content/ComfyUI/models"; OUT = "/content/mascot_out"
for d in ("raw", "cutouts", "motion", "motion_frames"): os.makedirs(f"{OUT}/{d}", exist_ok=True)
log = open(f"{OUT}/log.txt", "a")
def say(*a):
    s = " ".join(str(x) for x in a); print(s, flush=True); log.write(s + "\n"); log.flush()
def post(path, data):
    req = urllib.request.Request(API + path, data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
    try: return json.loads(urllib.request.urlopen(req).read() or b"{}")
    except urllib.error.HTTPError as e: raise RuntimeError(e.read().decode()[:1500])
def run(wf, timeout=3600):
    pid = post("/prompt", {"prompt": wf})["prompt_id"]; t = time.time()
    while time.time() - t < timeout:
        h = json.loads(urllib.request.urlopen(f"{API}/history/{pid}").read())
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error": raise RuntimeError(json.dumps(st)[:1500])
            return h[pid]
        time.sleep(1)
    raise TimeoutError(pid)
def pick_model(sub, *needles):
    c = sorted(os.path.basename(p) for p in glob.glob(f"{M}/{sub}/*"))
    for n in needles:
        for f in c:
            if n in f: return f
    raise RuntimeError(f"no model in {sub} for {needles}: {c}")
nodes = json.loads(urllib.request.urlopen(f"{API}/object_info").read())
PLUS = "TextEncodeQwenImageEditPlus" in nodes
say("edit text-encode node:", "Plus" if PLUS else "base")
E_UNET = pick_model("diffusion_models", "edit_2511_fp8", "edit_2509_fp8", "edit_fp8")
Q_TE = pick_model("text_encoders", "qwen_2.5_vl_7b_fp8"); Q_VAE = pick_model("vae", "qwen_image_vae")
say("edit model:", E_UNET, Q_TE, Q_VAE)
shutil.copy("/content/ref.png", "/content/ComfyUI/input/ghost_ref.png")

STYLE = ("Keep exactly the same white soft-clay ghost character, the same orange clay key, the same matte soft 3D clay toy style, "
         "the same lighting, the same flat plain mint background and the same camera framing and size. Change only the expression and pose: ")
TAIL = " The ghost has simple oval dark eyes and a tiny mouth, no other face details. No text, no letters, no numbers, no symbols."
NEG = "text, letters, numbers, symbols, logo, watermark, extra limbs, extra eyes, realistic, photo, scary, blurry, deformed, different character, background scene, gradient background"
EXPR = {
 "neutral": "calm gentle smile, eyes open looking at the viewer, holding the key to its chest with both hands",
 "happy": "big joyful smile, happy closed arc-shaped eyes, tiny rosy cheeks, holding the key to its chest",
 "wave": "smiling with open eyes, one arm raised high in a friendly wave hello, the other arm holding the orange key",
 "sleepy": "eyes closed and drowsy, small relaxed mouth, head tilted slightly, holding the key loosely against its belly",
 "surprised": "eyes wide open, tiny round open mouth, startled but cute, holding the key tightly",
 "sad": "droopy sad eyes, small downturned mouth, a single tiny teardrop, holding the key to its chest",
 "proud": "proud confident smile, chin slightly raised, eyes closed in content arcs, holding the orange key up proudly in front of it",
 "searching": "curious eyes looking to the side, one hand held above the eyes as if searching far away, the other hand holding the key",
 "working": "focused determined expression, slightly narrowed eyes, both hands gripping the orange key, ready to turn it",
 "success": "overjoyed, both arms raised up holding the orange key high above its head, big open smile, a few small pastel confetti pieces around it",
 "error": "worried anxious expression, wide eyes, a wobbly wavy mouth, one tiny sweat drop, the key held close and protectively",
 "thinking": "eyes looking up and to the side, one hand on its chin, small pensive mouth, the other hand holding the key",
 "empty": "peeking with curious eyes into an empty open cardboard box in front of it, holding the key in one hand",
 "guard": "brave serious face, hugging the orange key tightly with both arms like a guardian protecting a treasure",
}
SEEDS = [1101, 2202]
def edit_wf(prompt, seed, prefix):
    enc = ({"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["2", 0], "prompt": prompt, "vae": ["3", 0], "image1": ["9", 0]}},
           {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["2", 0], "prompt": NEG, "vae": ["3", 0], "image1": ["9", 0]}}) if PLUS else \
          ({"class_type": "TextEncodeQwenImageEdit", "inputs": {"clip": ["2", 0], "prompt": prompt, "vae": ["3", 0], "image": ["9", 0]}},
           {"class_type": "TextEncodeQwenImageEdit", "inputs": {"clip": ["2", 0], "prompt": NEG, "vae": ["3", 0], "image": ["9", 0]}})
    return {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": E_UNET, "weight_dtype": "default"}},
            "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": Q_TE, "type": "qwen_image"}},
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": Q_VAE}},
            "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.0}},
            "5": {"class_type": "CFGNorm", "inputs": {"model": ["4", 0], "strength": 1.0}},
            "6": enc[0], "7": enc[1],
            "8": {"class_type": "LoadImage", "inputs": {"image": "ghost_ref.png"}},
            "9": {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": ["8", 0], "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 1}},
            "10": {"class_type": "VAEEncode", "inputs": {"pixels": ["9", 0], "vae": ["3", 0]}},
            "11": {"class_type": "KSampler", "inputs": {"model": ["5", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["10", 0],
                   "seed": seed, "steps": 25, "cfg": 4.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
            "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
            "13": {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": prefix}}}
manifest = {"expressions": [], "motion": [], "edit_model": f"Qwen-Image-Edit ({E_UNET}, {Q_TE}, {Q_VAE}), Apache-2.0"}
if not os.environ.get("SKIP_EXPR"):
    t0 = time.time()
    for name, d in EXPR.items():
        prompt = STYLE + d + "." + TAIL
        for seed in SEEDS:
            prefix = f"mascot/{name}_s{seed}"
            if glob.glob(f"/content/ComfyUI/output/{prefix}_*.png"): continue
            try: t = time.time(); run(edit_wf(prompt, seed, prefix)); say(f"expr {name} {seed} {time.time()-t:.0f}s")
            except Exception as e: say("FAILED expr", name, seed, e)
        manifest["expressions"].append({"id": name, "seeds": SEEDS, "prompt": prompt, "negative": NEG})
    say(f"expressions done in {(time.time()-t0)/60:.1f} min")
    for p in sorted(glob.glob("/content/ComfyUI/output/mascot/*.png")):
        shutil.copy(p, f"{OUT}/raw/{os.path.basename(p).rsplit('_',1)[0]}.png")
    json.dump(manifest, open(f"{OUT}/manifest.json", "w"), indent=2)
    shutil.make_archive("/content/mascot_expressions", "zip", f"{OUT}/raw"); say("EXPR ZIP READY")

# ---- motion: Wan 2.2 TI2V-5B from the reference ghost ----
W_UNET = pick_model("diffusion_models", "wan2.2_ti2v_5B"); W_TE = pick_model("text_encoders", "umt5_xxl_fp8"); W_VAE = pick_model("vae", "wan2.2_vae")
manifest["motion_model"] = f"Wan 2.2 TI2V-5B ({W_UNET}, {W_TE}, {W_VAE}), Apache-2.0"
MNEG = "camera movement, zoom, cut, text, letters, logo, people, flicker, distortion, morphing, new objects, changing colors, low quality, blurry"
GH = "The cute white soft-clay ghost holding an orange key on a flat plain mint background. "
CLIPS = {
 "hello": GH + "The ghost waves one arm in a friendly hello and smiles, with a gentle floating bob. Static camera, smooth loopable motion.",
 "sleepy": GH + "The ghost's eyes slowly close and its body sways gently side to side as it dozes off, soft breathing. Static camera, smooth loopable motion.",
 "joy": GH + "The ghost hops up and down happily with a joyful bounce, smiling. Static camera, smooth loopable motion.",
 "loading": GH + "The ghost floats gently up and down while its hands slowly turn the orange key, calm and focused. Static camera, smooth loopable motion.",
 "idle": GH + "The ghost floats softly up and down and blinks its eyes once, calm. Static camera, smooth loopable motion.",
}
SEED = 5501
for name, text in CLIPS.items():
    prefix = f"mascot_motion/{name}_s{SEED}"
    if glob.glob(f"/content/ComfyUI/output/{prefix}_*.png"): continue
    try:
        wf = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": W_UNET, "weight_dtype": "default"}},
              "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": W_TE, "type": "wan"}},
              "3": {"class_type": "VAELoader", "inputs": {"vae_name": W_VAE}},
              "4": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["1", 0], "shift": 8.0}},
              "5": {"class_type": "CLIPTextEncode", "inputs": {"text": text, "clip": ["2", 0]}},
              "6": {"class_type": "CLIPTextEncode", "inputs": {"text": MNEG, "clip": ["2", 0]}},
              "7": {"class_type": "LoadImage", "inputs": {"image": "ghost_ref.png"}},
              "8": {"class_type": "Wan22ImageToVideoLatent", "inputs": {"vae": ["3", 0], "width": 704, "height": 704, "length": 49, "batch_size": 1, "start_image": ["7", 0]}},
              "9": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["8", 0],
                    "seed": SEED, "steps": 30, "cfg": 5.0, "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1.0}},
              "10": {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
              "11": {"class_type": "SaveImage", "inputs": {"images": ["10", 0], "filename_prefix": prefix}}}
        t = time.time(); run(wf); say(f"clip {name} {time.time()-t:.0f}s")
    except Exception as e: say("FAILED clip", name, e)
    manifest["motion"].append({"id": name, "seed": SEED, "prompt": text, "negative": MNEG, "frames": 49, "size": 704})

# ---- post: free GPU, BiRefNet cutouts, 256px ping-pong loops ----
try: post("/free", {"unload_models": True, "free_memory": True})
except Exception as e: say("free failed", e)
from PIL import Image
from rembg import new_session, remove
sess = new_session("birefnet-general")
for p in sorted(glob.glob(f"{OUT}/raw/*.png")):
    base = os.path.basename(p)[:-4]; dst = f"{OUT}/cutouts/{base}.webp"
    if os.path.exists(dst): continue
    remove(Image.open(p).convert("RGB"), session=sess).save(dst, quality=92, method=6)
say("cutouts done")
for name in CLIPS:
    fr = sorted(glob.glob(f"/content/ComfyUI/output/mascot_motion/{name}_s{SEED}_*.png"))
    if not fr: continue
    cut = [remove(Image.open(f).convert("RGB"), session=sess) for f in fr]
    box = None
    for c in cut:
        b = c.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
        if b: box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    pad = 12; box = (max(0, box[0]-pad), max(0, box[1]-pad), min(704, box[2]+pad), min(704, box[3]+pad))
    side = max(box[2]-box[0], box[3]-box[1]); cx, cy = (box[0]+box[2])//2, (box[1]+box[3])//2
    sq = (cx-side//2, cy-side//2, cx-side//2+side, cy-side//2+side)
    sm = [c.crop(sq).resize((256, 256), Image.LANCZOS) for c in cut]
    sm[0].save(f"{OUT}/motion/{name}-still.webp", quality=88, alpha_quality=90, method=6)
    loop = sm + sm[-2:0:-1]  # ping-pong for a seamless loop
    loop[0].save(f"{OUT}/motion/{name}.webp", save_all=True, append_images=loop[1:], duration=42, loop=0, quality=76, alpha_quality=85, method=4)
    say("motion", name, len(loop), "frames", os.path.getsize(f"{OUT}/motion/{name}.webp") // 1024, "KB")
json.dump(manifest, open(f"{OUT}/manifest.json", "w"), indent=2)
shutil.rmtree(f"{OUT}/motion_frames", ignore_errors=True)
shutil.make_archive("/content/mascot_all", "zip", OUT)
say("MASCOT DONE", os.path.getsize("/content/mascot_all.zip") // 1048576, "MB")
