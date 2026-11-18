# Flat-colour keying (the generations sit on a plain mint background): sturdier than BiRefNet, which left grey blobs.
import numpy as np
from scipy import ndimage as ndi
from PIL import Image
def key_alpha(rgb, lo=9.0, span=14.0, min_area=40):
    a = rgb.astype(np.float32)
    ring = np.concatenate([a[:6].reshape(-1, 3), a[-6:].reshape(-1, 3), a[:, :6].reshape(-1, 3), a[:, -6:].reshape(-1, 3)])
    bg = np.median(ring, axis=0)
    d = np.linalg.norm(a - bg, axis=2)
    al = np.clip((d - lo) / span, 0, 1)
    lab, n = ndi.label(al > 0.5)
    if n:
        areas = ndi.sum(np.ones_like(al), lab, index=np.arange(1, n + 1))
        keep = np.isin(lab, 1 + np.flatnonzero(areas >= min_area))
        keep = ndi.binary_dilation(keep, iterations=3)
        al = al * keep
    al = ndi.gaussian_filter(al, 0.5)
    return al, bg
def decontaminate(rgb, al, bg):
    a = rgb.astype(np.float32); m = np.maximum(al, 0.04)[..., None]
    c = (a - (1 - al)[..., None] * bg) / m
    return np.clip(c, 0, 255)
def to_rgba(img):
    rgb = np.array(img.convert("RGB")); al, bg = key_alpha(rgb)
    out = np.dstack([decontaminate(rgb, al, bg), al * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")
