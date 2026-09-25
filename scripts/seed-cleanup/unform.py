# Remove the dress form + pole from a Vision cutout (RGBA). Usage: unform.py in.png out.png top|bottom
import sys
from collections import deque
import numpy as np
from PIL import Image

import os
src, dst, kind = sys.argv[1], sys.argv[2], sys.argv[3]
STEP=int(os.environ.get('STEP','7')); CAP=int(os.environ.get('CAP','55')); LIMIT=os.environ.get('LIMIT')=='1'
im = np.array(Image.open(src).convert("RGBA")).astype(np.int16)
h, w = im.shape[:2]
rgb, a = im[..., :3], im[..., 3]
opaque = a > 128
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
lum = rgb.mean(-1)

# Dress-form skin: warm beige, fairly light.
beige = opaque & (r >= g) & (g >= b - 4) & ((r - b) > 12) & ((r - b) < 75) & (lum > 150)

# Where the form shows: below the hem for tops, above the waistband for bottoms.
zone = np.zeros_like(opaque)
if kind == "bottom":
    zone[: int(h * 0.12)] = True
else:
    zone[int(h * 0.62):] = True
    zone[: int(h * 0.14)] = True  # neck
seed = beige & zone
if seed.sum() == 0:
    print(src, "no form seed"); ref = None
else:
    ref = np.median(rgb[seed], axis=0)

remove = np.zeros_like(opaque)
if ref is not None:
    # Grow from the seeds through smoothly-shaded pixels that stay near the form colour.
    near_ref = opaque & (np.abs(rgb - ref).max(-1) < CAP)
    if LIMIT and kind != 'bottom':
        rows = np.arange(h)[:, None]
        near_ref &= (rows < h * float(os.environ.get('NECK','0.2'))) | (rows > h * 0.6)
    q = deque(zip(*np.nonzero(seed)))
    for y, x in q: remove[y, x] = True
    while q:
        y, x = q.popleft()
        c = rgb[y, x]
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not remove[ny, nx] and near_ref[ny, nx]:
                if np.abs(rgb[ny, nx] - c).max() <= STEP:
                    remove[ny, nx] = True
                    q.append((ny, nx))

overlay = (rgb.min(-1) > 225) & ((rgb.max(-1) - rgb.min(-1)) < 12)
keep = opaque & ~remove & ~overlay

R = int(os.environ.get('OPEN', '3'))
def shift_all(m, op):
    out = m.copy()
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            s = np.roll(np.roll(m, dy, 0), dx, 1)
            out = op(out, s)
    return out
if R: keep = shift_all(shift_all(keep, np.logical_and), np.logical_or) & keep

# Keep the largest connected piece (drops the neck cap, pole stubs, overlay icons).
lab = np.zeros((h, w), np.int32); best, best_n, cur = 0, 0, 0
for y0, x0 in zip(*np.nonzero(keep)):
    if lab[y0, x0]: continue
    cur += 1; n = 0; q = deque([(y0, x0)]); lab[y0, x0] = cur
    while q:
        y, x = q.popleft(); n += 1
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and keep[ny, nx] and not lab[ny, nx]:
                lab[ny, nx] = cur; q.append((ny, nx))
    if n > best_n: best, best_n = cur, n
keep = lab == best

# Pole under a skirt/top: from the bottom up, drop rows that are only a thin column.
for y in range(h - 1, -1, -1):
    if keep[y].sum() == 0: continue
    if keep[y].sum() < w * 0.09: keep[y] = False
    else: break

out = im.copy().astype(np.uint8)
out[..., 3] = np.where(keep, out[..., 3], 0)
ys, xs = np.nonzero(out[..., 3] > 8)
out = out[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]  # trim to garment
Image.fromarray(out).save(dst)
print(src, "form ref", None if ref is None else ref.astype(int), "removed", int(remove.sum()))
