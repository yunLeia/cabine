# FASHN try-on trial (dev tool, not shipped)

Question it answers: can FASHN render a natural, faithful outfit from our
garments, fast and cheap enough for a "See it styled" button?

It builds each outfit as a chain of single-garment try-ons on one generated
person (base → + bottom → + top → + outerwear), with Try-On v1.6 and Try-On Max,
and writes `out/report.html` showing every step with its time and cost.

## Run

```sh
python3 scripts/fashn-trial/prep.py                 # closet cutouts → white-background JPEGs in inputs/
node scripts/fashn-trial/trial.ts                   # dry run: plan + credit estimate, no network
node scripts/fashn-trial/trial.ts --mock            # full run against a fake API, no credits
node scripts/fashn-trial/trial.ts --live --yes      # real run (~17 credits ≈ $1.27)
```

Options: `--only v16|max`, `--max-credits N` (default 30), `--base <image>` to use
your own base person instead of generating one.

## API key

Set `FASHN_API_KEY` in your shell, or put `FASHN_API_KEY=...` in `.env.local` at
the repo root (git-ignored). Never pass it on the command line.

## Safety

- Checks your balance first (free call) and refuses if the estimate exceeds the
  balance or `--max-credits`. Spends nothing without `--live --yes`.
- Every step is cached by content in `out/cache/`, so reruns and added outfits
  only pay for new steps. Mock results use a separate cache from real ones.
- Outputs are downloaded immediately: FASHN's CDN links expire after ~3 days.

## Editing the test

`GARMENTS`, `OUTFITS`, `BASE` and `VARIANTS` at the top of `trial.ts`. A garment's
`src` can be an https:// product image URL, which is closest to what the
extension would send from a real store page.

## Judge each final image

Natural? Faithful to every garment? Same person across outfits? Does the chain
drift (e.g. the jeans change when the top is added)? Time and cost acceptable?
