# Draw-on animation for the Cabine monogram: a thick "pen" follows the C from its
# top tip around to the bottom, up the hanger's right arm to the neck, then the
# hook and the left arm grow from the neck. The pen is a mask over the real logo.
import math, sys
from PIL import Image, ImageDraw

SP = sys.argv[1]
mono = Image.open(f'{SP}/brand/monogram.png')  # 281x277, ink + alpha
W, H = mono.size

def catmull(pts, n=16):
    out = []
    p = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in (0, 1)))
    out.append(pts[-1])
    return out

S = 0.5  # points below were measured on the 2x view
def sc(pts): return [(x * S, y * S) for x, y in pts]

# (points, pen width, start, end) in seconds
SEGMENTS = [
    (catmull(sc([(548, 120), (520, 60), (470, 30), (390, 18), (300, 26), (200, 60), (110, 130), (55, 230), (45, 330), (85, 430), (160, 500), (260, 535), (370, 530), (460, 500), (522, 462)])), 46, 0.0, 1.05),
    (catmull(sc([(522, 462), (410, 395), (302, 332)])), 12, 1.05, 1.35),
    (catmull(sc([(302, 332), (318, 312), (342, 285), (338, 255), (310, 240), (278, 248), (264, 272), (266, 292)])), 12, 1.35, 1.7),
    (catmull(sc([(302, 332), (210, 383), (115, 435)])), 12, 1.35, 1.65),
]
DRAW, HOLD, FADE = 1.7, 0.9, 0.35
LOOP = DRAW + HOLD + FADE

def length(pts): return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))

def partial(pts, f):
    if f <= 0: return []
    target, acc, out = length(pts) * min(f, 1), 0, [pts[0]]
    for i in range(len(pts) - 1):
        d = math.dist(pts[i], pts[i + 1])
        if acc + d >= target:
            r = (target - acc) / d if d else 0
            out.append((pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r))
            return out
        acc += d; out.append(pts[i + 1])
    return out

ease = lambda x: 1 - (1 - x) ** 3

def frame(t, scale=2, bg=(255, 255, 255), transparent=False):
    m = Image.new('L', (W * scale, H * scale), 0)
    d = ImageDraw.Draw(m)
    for pts, width, a, b in SEGMENTS:
        f = 0 if t < a else 1 if t >= b else ease((t - a) / (b - a))
        seg = [(x * scale, y * scale) for x, y in partial(pts, f)]
        # Stamp a round brush every pixel along the path (no gaps between segments).
        r = width * scale / 2
        for i in range(len(seg) - 1):
            (x0, y0), (x1, y1) = seg[i], seg[i + 1]
            steps = max(1, int(math.dist(seg[i], seg[i + 1])))
            for k in range(steps + 1):
                x, y = x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps
                d.ellipse((x - r, y - r, x + r, y + r), fill=255)
    m = m.resize((W, H), Image.LANCZOS)
    fade = 1 if t < DRAW + HOLD else max(0, 1 - (t - DRAW - HOLD) / FADE)
    a = mono.getchannel('A').point(lambda v: v)
    alpha = Image.composite(a, Image.new('L', a.size, 0), m).point(lambda v: int(v * fade))
    if transparent:
        return Image.merge('RGBA', [Image.new('L', (W, H), 26)] * 3 + [alpha])
    out = Image.new('RGB', (W, H), bg)
    ink = Image.new('RGB', (W, H), (26, 26, 26))
    out.paste(ink, (0, 0), alpha)
    return out

if __name__ == '__main__':
    mode = sys.argv[2]
    if mode == 'strip':
        ts = [0.2, 0.5, 0.8, 1.05, 1.25, 1.5, 1.7, 2.7]
        strip = Image.new('RGB', (W * len(ts), H), 'white')
        for i, t in enumerate(ts): strip.paste(frame(t), (i * W, 0))
        strip.save(f'{SP}/brand/strip.png')
    if mode == 'export':
        FPS = 30
        ts = [i / FPS for i in range(int(LOOP * FPS))]
        pad = lambda im, bg: (lambda c: (c.paste(im, (24, 24)), c)[1])(Image.new(im.mode, (W + 48, H + 48), bg))
        white = [pad(frame(t), (255, 255, 255)) for t in ts]
        white[0].save(f'{SP}/brand/cabine-loading.gif', save_all=True, append_images=white[1:], duration=int(1000 / FPS), loop=0, optimize=True)
        ivory = [pad(frame(t, bg=(250, 249, 246)), (250, 249, 246)) for t in ts]
        ivory[0].save(f'{SP}/brand/cabine-loading-ivory.gif', save_all=True, append_images=ivory[1:], duration=int(1000 / FPS), loop=0, optimize=True)
        clear = [frame(t, transparent=True) for t in ts]
        clear[0].save(f'{SP}/brand/cabine-loading.webp', save_all=True, append_images=clear[1:], duration=int(1000 / FPS), loop=0, lossless=False, quality=90, method=6)
    if mode == 'full':
        # full reveal check: everything visible at the end?
        frame(DRAW + 0.1).save(f'{SP}/brand/end.png')
