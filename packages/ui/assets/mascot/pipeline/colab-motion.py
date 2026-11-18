# Round 2 of the mascot loops: Wan 2.2 TI2V-5B (Apache-2.0) starting from the edited expression stills.
import glob, json, os, shutil, time, urllib.request, urllib.error
API = "http://127.0.0.1:8188"; M = "/content/ComfyUI/models"; OUT = "/content/motion2_out"
os.makedirs(f"{OUT}/motion", exist_ok=True)
def say(*a): print(" ".join(str(x) for x in a), flush=True)
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
def model(sub, needle):
    return sorted(os.path.basename(p) for p in glob.glob(f"{M}/{sub}/*") if needle in p)[0]
W_UNET, W_TE, W_VAE = model("diffusion_models", "wan2.2_ti2v_5B"), model("text_encoders", "umt5_xxl_fp8"), model("vae", "wan2.2_vae")
GH = "The cute white soft-clay ghost holding an orange key on a flat plain mint background. "
KEEP = " The ghost keeps both hands on the orange key the whole time and the key never leaves its hands. Small, smooth, loopable motion, static camera."
MNEG = ("camera movement, zoom, cut, text, letters, logo, people, flicker, distortion, morphing, new objects, changing colors, key flying away, key detached, "
        "dropping the key, extra limbs, shape change, low quality, blurry")
CLIPS = {  # id: (start expression, prompt)
 "hello": ("wave", GH + "The smiling ghost waves its raised hand left and right in a friendly hello while its body stays in place; the other hand keeps holding the key against its belly."),
 "joy": ("happy", GH + "The happy smiling ghost bounces gently up and down on the spot with joy." + KEEP),
 "loading": ("neutral", GH + "The calm ghost floats gently up and down in place and rocks slightly left and right." + KEEP),
 "idle": ("neutral", GH + "The ghost floats softly up and down and blinks its eyes slowly." + KEEP),
}
SEEDS = [5501, 6602]
for name, (start, text) in CLIPS.items():
    src = sorted(glob.glob(f"/content/ComfyUI/output/mascot/{start}_s1101_*.png"))
    if not src: say("missing start", start); continue
    shutil.copy(src[0], f"/content/ComfyUI/input/{name}_start.png")
    for seed in SEEDS:
        prefix = f"mascot_motion2/{name}_s{seed}"
        if glob.glob(f"/content/ComfyUI/output/{prefix}_*.png"): continue
        wf = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": W_UNET, "weight_dtype": "default"}},
              "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": W_TE, "type": "wan"}},
              "3": {"class_type": "VAELoader", "inputs": {"vae_name": W_VAE}},
              "4": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["1", 0], "shift": 8.0}},
              "5": {"class_type": "CLIPTextEncode", "inputs": {"text": text, "clip": ["2", 0]}},
              "6": {"class_type": "CLIPTextEncode", "inputs": {"text": MNEG, "clip": ["2", 0]}},
              "7": {"class_type": "LoadImage", "inputs": {"image": f"{name}_start.png"}},
              "8": {"class_type": "Wan22ImageToVideoLatent", "inputs": {"vae": ["3", 0], "width": 704, "height": 704, "length": 49, "batch_size": 1, "start_image": ["7", 0]}},
              "9": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["8", 0],
                    "seed": seed, "steps": 30, "cfg": 5.0, "sampler_name": "uni_pc", "scheduler": "simple", "denoise": 1.0}},
              "10": {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
              "11": {"class_type": "SaveImage", "inputs": {"images": ["10", 0], "filename_prefix": prefix}}}
        try: t = time.time(); run(wf); say(f"clip {name} {seed} {time.time()-t:.0f}s")
        except Exception as e: say("FAILED clip", name, seed, e)
json.dump({"model": f"Wan 2.2 TI2V-5B ({W_UNET}, {W_TE}, {W_VAE}), Apache-2.0", "clips": {k: {"start": v[0], "prompt": v[1]} for k, v in CLIPS.items()}, "negative": MNEG, "seeds": SEEDS, "frames": 49, "size": 704},
          open(f"{OUT}/manifest.json", "w"), indent=2)
try: post("/free", {"unload_models": True, "free_memory": True})
except Exception as e: say("free failed", e)
from PIL import Image
from rembg import new_session, remove
sess = new_session("birefnet-general")
for name in CLIPS:
    for seed in SEEDS:
        fr = sorted(glob.glob(f"/content/ComfyUI/output/mascot_motion2/{name}_s{seed}_*.png"))
        if not fr: continue
        cut = [remove(Image.open(f).convert("RGB"), session=sess) for f in fr]
        box = None
        for c in cut:
            b = c.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
            if b: box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
        pad = 12; box = (max(0, box[0]-pad), max(0, box[1]-pad), min(704, box[2]+pad), min(704, box[3]+pad))
        side = max(box[2]-box[0], box[3]-box[1]); cx, cy = (box[0]+box[2])//2, (box[1]+box[3])//2
        sq = (cx-side//2, cy-side//2, cx-side//2+side, cy-side//2+side)
        sm = [c.crop(sq).resize((256, 256), Image.LANCZOS) for c in cut][::2]   # 12 fps
        sm[0].save(f"{OUT}/motion/{name}_s{seed}-still.webp", quality=88, alpha_quality=90, method=6)
        loop = sm + sm[-2:0:-1]                                                  # ping-pong = seamless loop
        loop[0].save(f"{OUT}/motion/{name}_s{seed}.webp", save_all=True, append_images=loop[1:], duration=83, loop=0, quality=72, alpha_quality=85, method=4)
        say("motion", name, seed, len(loop), "frames", os.path.getsize(f"{OUT}/motion/{name}_s{seed}.webp") // 1024, "KB")
shutil.make_archive("/content/motion2_all", "zip", OUT)
say("MOTION2 DONE")
