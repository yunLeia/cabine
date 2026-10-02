# Cabine loading mark: the C draws itself from its top tip, around and down,
# straight on up the hanger's right arm to the neck; then the hook curls and the
# left arm reaches back to the C. One continuous stroke, steady speed.
#
#   python3 scripts/brand-loading.py
#
# Reads public/brand/monogram.png (the logo, ink + alpha). Writes:
#   public/brand/loading.webp          transparent, for the panel
#   docs/brand/cabine-loading.gif      on white
#   docs/brand/cabine-loading-ivory.gif on ivory (#FAF9F6)
#   docs/brand/cabine-loading.webp     transparent
#
# How: a round "pen" follows hand-placed centrelines and reveals the real logo
# pixels under it, so the mark is exact. The C and the hanger are separate
# layers (the hanger's thin lines are carved out of the C layer), so the C's
# wide pen never uncovers a bit of hanger early.

import math
import os
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(__file__), '..')
mono = Image.open(os.path.join(ROOT, 'public/brand/monogram.png'))  # 281 x 277
W, H = mono.size
INK = mono.getchannel('A')
SS = 3  # supersampling for the masks


def catmull(pts, n=24):
    p = [pts[0]] + pts + [pts[-1]]
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for k in range(n):
            t = k / n
            out.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t ** 3) for j in (0, 1)))
    out.append(pts[-1])
    return out


# Centrelines in monogram pixels (measured on the logo).
NECK = (148, 167)
# The right arm starts just above the tip: the tip stays with the C, so the C
# ends in its point and the arm grows straight out of it. The left arm ends
# where it meets the C's inner edge.
C_LINE = catmull([(274, 60), (260, 30), (235, 15), (195, 9), (150, 13), (100, 30), (55, 65), (27, 115), (22, 165), (42, 215), (80, 250), (130, 268), (185, 265), (230, 250), (257, 236)])
RIGHT_ARM = catmull([(243, 228), (204, 204), NECK])
HOOK = catmull([NECK, (160, 159), (168, 151), (172, 142), (171, 132), (165, 124), (154, 120), (143, 121), (134, 127), (131, 136), (132, 145)])
LEFT_ARM = catmull([NECK, (102, 192), (61, 214)])


def length(pts):
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def head(pts, dist):
    """The first `dist` pixels of a path."""
    if dist <= 0:
        return []
    out, acc = [pts[0]], 0.0
    for i in range(len(pts) - 1):
        d = math.dist(pts[i], pts[i + 1])
        if acc + d >= dist:
            r = (dist - acc) / d if d else 0
            out.append((pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r))
            return out
        acc += d
        out.append(pts[i + 1])
    return out


def pen(mask, pts, width):
    """Stamp a round brush every pixel along the path (no gaps, no streaks)."""
    d = ImageDraw.Draw(mask)
    r = width * SS / 2
    p = [(x * SS, y * SS) for x, y in pts]
    if len(p) == 1:
        p = p * 2
    for i in range(len(p) - 1):
        (x0, y0), (x1, y1) = p[i], p[i + 1]
        steps = max(1, int(math.dist(p[i], p[i + 1])))
        for k in range(steps + 1):
            x, y = x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps
            d.ellipse((x - r, y - r, x + r, y + r), fill=255)


def down(mask):
    return mask.resize((W, H), Image.LANCZOS)


# Split the logo into the hanger's thin lines and everything else (the C).
zone = Image.new('L', (W * SS, H * SS), 0)
for path in (RIGHT_ARM, HOOK, LEFT_ARM):
    pen(zone, path, 11)
# Never carve the C's thick stroke: whatever survives a 9 px erosion is C body.
THICK = INK.point(lambda v: 255 if v > 128 else 0).filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MaxFilter(9))
ZONE = ImageChops.subtract(down(zone).filter(ImageFilter.MaxFilter(3)), THICK)
# Where the left arm joins the C, its root flares into the C's inner edge and
# the erosion above keeps it as "C". Everything just right of the inner edge
# there belongs to the arm (edge measured on the logo: x ≈ 52.5 + (y − 206) / 2).
joint = Image.new('L', (W, H), 0)
ImageDraw.Draw(joint).polygon([(52.5 + (y - 206) / 2 + 0.5, y) for y in (205, 220)] + [(76, 220), (76, 205)], fill=255)
ZONE = ImageChops.lighter(ZONE, joint)
HANGER_INK = ImageChops.multiply(INK, ZONE)
C_INK = ImageChops.subtract(INK, HANGER_INK)

# Hanger pens are wider than the carved zone (11 px + 1 px spread): they only
# reveal hanger ink, and a narrower pen would leave a faint seam at the edges.
HANGER_PEN = 16

# One stroke: C, then the right arm, then the hook and left arm together.
L_C, L_R = length(C_LINE), length(RIGHT_ARM)
L_HOOK, L_LEFT = length(HOOK), length(LEFT_ARM)
L_BRANCH = max(L_HOOK, L_LEFT)
TOTAL = L_C + L_R + L_BRANCH

DRAW, HOLD, FADE = 2.1, 0.8, 0.4
LOOP = DRAW + HOLD + FADE


def ease(x):  # gentle start and finish, steady in the middle
    return 0.5 - 0.5 * math.cos(math.pi * min(1.0, max(0.0, x)))


def frame(t):
    """The mark at time t, as ink alpha."""
    d = TOTAL * ease(t / DRAW)
    c_mask = Image.new('L', (W * SS, H * SS), 0)
    h_mask = Image.new('L', (W * SS, H * SS), 0)
    pen(c_mask, head(C_LINE, d), 48)
    if d > L_C:
        pen(h_mask, head(RIGHT_ARM, d - L_C), HANGER_PEN)
    if d > L_C + L_R:
        f = (d - L_C - L_R) / L_BRANCH  # hook and left arm finish together
        pen(h_mask, head(HOOK, f * L_HOOK), HANGER_PEN)
        pen(h_mask, head(LEFT_ARM, f * L_LEFT), HANGER_PEN)
    alpha = ImageChops.add(ImageChops.multiply(C_INK, down(c_mask)), ImageChops.multiply(HANGER_INK, down(h_mask)))
    if t > DRAW + HOLD:
        k = max(0.0, 1 - (t - DRAW - HOLD) / FADE)
        alpha = alpha.point(lambda v: int(v * k))
    return alpha


def on(alpha, bg, pad=24):
    out = Image.new('RGB', (W + 2 * pad, H + 2 * pad), bg)
    out.paste(Image.new('RGB', (W, H), (26, 26, 26)), (pad, pad), alpha)
    return out


def clear(alpha):
    return Image.merge('RGBA', [Image.new('L', (W, H), 26)] * 3 + [alpha])


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'strip':  # quick look at a few moments
        ts = [0.25, 0.55, 0.85, 1.15, 1.4, 1.6, 1.85, 2.2]
        strip = Image.new('RGB', ((W + 8) * len(ts), H), 'white')
        for i, t in enumerate(ts):
            strip.paste(on(frame(t), (255, 255, 255), pad=0), (i * (W + 8), 0))
        strip.save(sys.argv[2])
        sys.exit()

    webp_fps, gif_fps = 40, 25  # GIF delays are in 10 ms steps
    webp = [clear(frame(i / webp_fps)) for i in range(int(LOOP * webp_fps))]
    for path in ('public/brand/loading.webp', 'docs/brand/cabine-loading.webp'):
        webp[0].save(os.path.join(ROOT, path), save_all=True, append_images=webp[1:], duration=1000 // webp_fps, loop=0, quality=90, method=6)
    gif_frames = [frame(i / gif_fps) for i in range(int(LOOP * gif_fps))]
    for name, bg in (('cabine-loading.gif', (255, 255, 255)), ('cabine-loading-ivory.gif', (250, 249, 246))):
        frames = [on(a, bg) for a in gif_frames]
        frames[0].save(os.path.join(ROOT, 'docs/brand', name), save_all=True, append_images=frames[1:], duration=1000 // gif_fps, loop=0, optimize=True)
    print('wrote', len(webp), 'webp frames,', len(gif_frames), 'gif frames')
