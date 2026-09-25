# Decisions

> **Build the uncertain product behavior before the uncertain infrastructure.**
>
> The riskiest question in Cabine is whether flat product images composed on a
> mannequin help someone decide to buy. It is not whether a model can classify
> a garment at 95% accuracy. Code order follows that.

Each entry: decision, options considered, why, tradeoff, and what would make us revisit it.

---

## D1. Stack: plain TypeScript + manual Vite, no framework

- **Options:** plain TS + Vite · Preact/React + Vite · WXT · Plasmo
- **Why:** the UI is stacked images and a thumbnail grid. A handwritten `manifest.json` keeps every permission and entry point visible, which is the point of the project. Zero runtime dependencies. Dev deps: `vite`, `typescript`, `@types/chrome`.
- **Tradeoff:** no hot reload for the extension (rebuild, then click reload in `chrome://extensions`). DOM updates are written by hand.
- **Revisit when:** M2 UI state (upload form, Buy/Save/Skip) makes the render functions hard to follow. Preact is the smallest step up.

## D2. Storage: IndexedDB for images, `chrome.storage.local` for light state

- **Options:** everything in `chrome.storage.local` + `unlimitedStorage` · image blobs in IndexedDB, metadata and settings in `chrome.storage.local`
- **Why:** images are stored as binary (no 33% base64 overhead) and loaded only when shown. `chrome.storage.local` keeps its `onChanged` event, which the panel can use to react to the service worker's writes.
  - IndexedDB: original and processed image blobs
  - `chrome.storage.local`: settings, IDs, lightweight garment metadata, active outfit and candidate
- **Tradeoff:** two stores to keep consistent (write the blob first, then the metadata). A small hand-written IndexedDB wrapper.
- **Revisit when:** metadata queries get complex enough to want them in IndexedDB too.
- **Status:** decided, built in M1.5. M1.1 keeps state in memory.

## D3. Folders organised by runtime

```
public/            copied as-is: manifest.json, mannequin.svg, seed images
src/background/    service worker (no DOM, stopped by Chrome when idle)
src/sidepanel/     the panel page: state, mannequin, closet
src/shared/        types and data used by more than one runtime
docs/
```

- **Options:** by runtime · by feature (`capture/`, `mannequin/`, `closet/`)
- **Why:** each runtime has different APIs and lifetimes, which is the most common source of extension bugs. The folder tells you what's available.
- **Tradeoff:** one feature (capture) spans two folders.
- **Revisit when:** a single runtime folder grows past about 10 files.

## D4. No AI in Milestone 1

- **Options:** own API key in the extension · Chrome on-device model · serverless proxy · none
- **Why:** the core loop (capture → compose → decide) can be tested without AI. AI brings API keys, latency, network errors, response parsing, cost, privacy and tester setup.
- **Tradeoff:** category needs a keyword guess plus a one-tap correction.
- **Revisit when:** M1.6 real-store tests show the keyword guess plus correction is a real source of friction.
  - If we add AI: a developer key is fine for solo development only; it can be extracted from the extension. Testers either bring their own key or use a tiny serverless proxy.
  - "No backend" is not a user value in itself. If 30 lines of backend unlock a product test, write them.

## D5. Capture: right-click first

- **Options:** right-click context menu · drag into panel · click-to-select overlay · page scan / automatic product detection · region screenshot
- **Why:** smallest amount of code, clearest mental model, and it matches the clean-image assumption: the user chooses the clean packshot, so Cabine doesn't have to work out which image is the garment.
- **Tradeoff:** fails when a site covers the image with a transparent layer. Low discoverability.
- **Roadmap:** V0 right-click → V1 click-to-select overlay ("Choose a piece to try") → V2 automatic product detection.
- **Revisit when:** M1.6 shows right-click failing on more than a few stores.

## D6. Background removal: staged, not a blocker

- **Options:** do nothing · CSS `mix-blend-mode: multiply` · flood fill inward from the image edges · in-browser segmentation model · cloud API
- **Why:** get the compose interaction testable first.
  - v0: CSS multiply
  - v0.1: flood fill from the edges plus trim (M1.3)
  - v1: in-browser segmentation, only for images the flood fill fails on
- **Tradeoff (v0, observed in M1.1):** multiply makes every layer see-through. The mannequin shows through light garments, the top shows through the coat's sleeves, and where the coat hem overlaps the waistband it turns near-black. Fine for checking slots and swapping, but it distorts the "does this read as an outfit?" judgement.
- **Update (M1.1, real seed images):** multiply was dropped. Seed images are pre-cut to transparent PNGs offline (D10), so layers now stack properly.
- **Revisit when:** M1.6 flood-fill failure rate is above about 20%. Check segmentation model licences (RMBG is non-commercial; `@imgly/background-removal` is AGPL).

## D7. Category: keywords, then user correction, AI later

- **Why:** product title, breadcrumbs and page metadata usually name the garment ("jacket", "jeans"). A one-tap correction ("Looks like a top: [Top] [Bottom] [Outerwear]") costs the user almost nothing.
- **Revisit when:** see D4.

## D8. Mannequin: fixed slot boxes per category

- **Options:** point + width per category · box per category with contain-fit · automatic placement from garment shape analysis
- **Why:** a slot is a box (`left, top, width, height` in % of the stage). The image is scaled to fit inside the box and pinned to its top edge: shoulders for tops, waist for bottoms. Product photos vary a lot in shape (shorts are almost square, trousers are tall), and a width-only slot would push trousers past the mannequin's feet.
  - Per-garment `adjust { scale, dx, dy }` exists for images that still land badly, and is used only when needed.
  - Draw order: bottom → top → outerwear.
- **Tradeoff:** a cropped top and a longline top both hang from the shoulders at the same width; length reads correctly, fit does not. Slots are tuned to one mannequin drawing.
- **Revisit when:** dresses, skirts or shoes arrive (M3), or trimmed real images land badly in more than about 1 in 5 cases.

## D9. The candidate owns its slot, and the closet shows what it could be worn with

- **Why:** when the piece under consideration is a top, showing other tops is pointless. The candidate always occupies its category's slot, and the closet hides that category. The closet item it displaced stays in state, so removing the candidate puts it back.
- **Tradeoff:** you can't compare the candidate side by side with a similar piece you own ("is this better than my navy tee?"). That's a different question from "does it go with what I own?"
- **Revisit when:** testers ask to compare against owned pieces of the same kind.

## D10. Seed closet images are cleaned offline, once

- **Context:** the first real images were dress-form photos from a resale site, not garments on plain white. The form (torso, neck, pole) and the site's own overlay buttons were in the frame, so the spec's "clean product image" assumption didn't hold.
- **Options:** use them as-is with multiply · clean them by hand · clean them offline with a script · build form removal into the capture pipeline now
- **Why:** a script in `scripts/seed-cleanup` (Apple Vision subject lift, then a flood fill that removes the form) handles the 8 seed images once. M1.1 can test composition without waiting for the pipeline.
- **Findings:**
  - Vision alone removes the background and overlays but keeps the dress form.
  - The colour-based form removal works on 7 of 9 images with default settings.
  - Cream and light-grey garments are close to the form's beige. They needed stricter per-image settings, and the cream tee lost some of its neckline.
- **Tradeoff:** hand-tuned settings don't carry over to captured items. Dress-form photos are common on real stores (resale sites especially), so M1.3 edge-fill will fail on them. This is the strongest early case for a segmentation model (D6 v1).
- **Also found (D8):** the bounding-box width is not the shoulder width. A boxy cropped tee with sleeves sticking out gets scaled as wide as a jacket and pokes out from under it. For now it's fixed per garment with `adjust.scale`. A shoulder-width anchor is the likely real fix.
- **Revisit when:** M1.6 shows how often captured images include a dress form.
- **Note:** the seed photos are a retailer's images. Keep them out of a public repo, or replace them with your own photos before publishing.

## D11. Target browser: Google Chrome (Arc not supported)

- **Context:** Arc runs Chrome extensions but doesn't implement the side panel, so `chrome.sidePanel` does nothing there. Found in M1.1 testing.
- **Options:** Chrome only · fall back to a separate panel window (`chrome.windows.create`) · a panel injected into the page by a content script
- **Why:** the side panel is the core UX (the shop page and the closet side by side), and Chrome is where users and reviewers will run it. A fallback adds a second UI to maintain before the core loop is proven.
- **Tradeoff:** Arc users (including the developer) have to switch browsers to use Cabine.
- **Revisit when:** testers in M2 use browsers without a side panel. The separate-window fallback is about 10 lines; the injected panel is the robust but expensive option.

## D12. Manual fit controls for the candidate

- **Context:** in M1.3 testing on real stores, captured garments didn't fit the mannequin. The dress form stays in the image (D10), so its neck and torso are inside the trimmed box. The form's neck gets pinned to the mannequin's shoulders, and the garment comes out too small and too low. Separately, bounding-box width is not shoulder width (D8).
- **Options:** manual fit controls · clothes-segmentation model (SegFormer trained on clothing classes, via Transformers.js) · build the offline form remover (D10) into the pipeline · cloud clothing-segmentation API
- **Why:** manual controls unblock testing today, work for any image, and stay useful after better cleanup, because automatic placement can't be right for every crop. The candidate card has Smaller / Bigger / Up / Down / Reset, saved as `capture.adjust` in storage.
- **Not chosen yet:** generic background removal (Apple Vision, remove.bg, RMBG) can't fix this: it treats form + garment as one subject. A clothes-segmentation model labels pixels as top/pants/skirt, so it could remove the form *and* give the category (M1.4). It's unproven on dress-form photos; it needs a trial on the seed photos first.
- **Tradeoff:** the user fixes each capture by hand. The dress form stays visible.
- **Revisit when:** M1.6 shows how many captures need fixing. Log how many clicks each capture needed.
