# Seed image cleanup (dev tool, not shipped)

One-off tools that turned dress-form product screenshots into the transparent
PNGs in `public/closet/`. macOS only.

1. `lift.swift`: Apple Vision subject lift (`VNGenerateForegroundInstanceMaskRequest`).
   Removes the white background and most overlay buttons. Keeps the dress form,
   because Vision sees form + garment as one subject.
2. `unform.py`: removes the dress form. Flood-fills from the visible beige form
   (below the hem / above the waistband), strips thin leftover strands, keeps the
   largest piece, drops the pole, and trims.

```sh
swiftc -O lift.swift -o lift && ./lift in.webp out/          # -> out/<name>-all.png
python3 unform.py out/<name>-all.png clean.png top|bottom
# Light garments close to the form's colour (cream, light grey) need stricter settings:
STEP=3 CAP=35 LIMIT=1 NECK=0.13 OPEN=4 python3 unform.py ...
```

Needs Pillow and NumPy. Findings from running it are in `docs/decisions.md` (D6, D10).
