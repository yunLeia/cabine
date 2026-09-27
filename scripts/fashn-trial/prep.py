# Flatten the transparent closet cutouts onto white, like a studio product shot,
# so FASHN gets the kind of image it expects. Writes JPEGs to ./inputs/.
# Usage: python3 scripts/fashn-trial/prep.py   (needs Pillow)
from pathlib import Path
from PIL import Image

here = Path(__file__).parent
src = here.parent.parent / "public" / "closet"
out = here / "inputs"
out.mkdir(exist_ok=True)
for p in sorted(src.glob("*.png")):
    im = Image.open(p).convert("RGBA")
    pad = round(max(im.size) * 0.06)
    bg = Image.new("RGBA", (im.width + 2 * pad, im.height + 2 * pad), (255, 255, 255, 255))
    bg.alpha_composite(im, (pad, pad))
    bg.convert("RGB").save(out / f"{p.stem}.jpg", quality=95)
    print(f"{p.stem}.jpg", bg.size)
