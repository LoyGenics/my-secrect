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

CLIPS = {
 "loader": ("neutral", GH + "The calm ghost bobs up and down clearly and rhythmically in place, about a tenth of its height, and tilts a little left and right like a happy float, a steady loading rhythm." + KEEP),
}
SEEDS = [5501, 6602]
for name, (start, text) in CLIPS.items():
    src = sorted(glob.glob(f"/content/ComfyUI/output/mascot/{start}_s1101_*.png"))
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
try: post("/free", {"unload_models": True, "free_memory": True})
except Exception as e: say("free failed", e)
# frames for local post-processing: 384px RGB + BiRefNet alpha mask, every clip we may ship
from PIL import Image
from rembg import new_session, remove
sess = new_session("birefnet-general")
os.makedirs("/content/mframes", exist_ok=True)
PICKS = [("hello", 6602, "mascot_motion2"), ("hello", 5501, "mascot_motion2"), ("joy", 5501, "mascot_motion2"), ("joy", 6602, "mascot_motion2"),
         ("loading", 6602, "mascot_motion2"), ("idle", 6602, "mascot_motion2"), ("idle", 5501, "mascot_motion2"),
         ("loader", 5501, "mascot_motion2"), ("loader", 6602, "mascot_motion2"), ("sleepy", 5501, "mascot_motion")]
for name, seed, d in PICKS:
    fr = sorted(glob.glob(f"/content/ComfyUI/output/{d}/{name}_s{seed}_*.png"))
    if not fr: say("no frames", name, seed); continue
    od = f"/content/mframes/{name}_s{seed}"; os.makedirs(od, exist_ok=True)
    for i, f in enumerate(fr):
        im = Image.open(f).convert("RGB"); m = remove(im, session=sess, only_mask=True)
        im.resize((384, 384), Image.LANCZOS).save(f"{od}/{i:02d}.png"); m.resize((384, 384), Image.LANCZOS).save(f"{od}/{i:02d}_a.png")
    say("frames", name, seed, len(fr))
shutil.make_archive("/content/mframes", "zip", "/content/mframes")
say("MFRAMES DONE", os.path.getsize("/content/mframes.zip") // 1048576, "MB")
