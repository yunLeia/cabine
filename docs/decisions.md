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

## D13. Save originals, label by hand, render with AI only on "Style together"

- **Question:** should Cabine clean up each garment when it's captured, or keep the original and use AI only when generating an outfit?
- **Options:** clean up every garment on capture · save originals and render only when styling · hybrid (optional cleanup)
- **Decision:**
  - Store the original image as captured or uploaded. The user picks the category: Top, Bottom, Outerwear, Dress or Shoes.
  - The user selects garments into outfit slots and clicks **Style together**. Only then is AI called, through FASHN try-on on a fixed base mannequin/person.
  - Renders are cached.
- **Why:** cleaning up at capture adds cost, latency and complexity before we know whether a garment will ever be used. The value moment is the styled outfit, so AI is spent there. Originals stay the source of truth: faithful, and re-renderable later with better models or prompts. We've seen that 2D layers never look worn (D6–D12), and that background removal can't remove dress forms (D10).
- **How it works (from the FASHN docs):**
  - Try-on applies one garment per call, so an outfit is a chain in fixed layering order: base → bottom/dress → top → outerwear → shoes.
  - Each step is cached by `hash(previousStepKey, garmentId, model, promptVersion)`, so changing only the jacket re-runs one step, not the whole outfit.
  - A 3-piece outfit ≈ 3 credits ≈ $0.23, ~25–30 s.
  - The original image is still downloaded at capture (retailer URLs expire and block other sites).
  - The FASHN key lives in a small serverless proxy, never in the extension (D4).
- **Tradeoff:** no instant styled preview while swapping; the preview is a slot list with thumbnails. Hypothesis: users will take a deliberate "Style together" step because the result is worth it. A backend (the proxy) is now required.
- **Replaces:** the product role of D6 (background removal), D8 (slot geometry), D10 (seed cleanup) and D12 (fit controls). Those code paths get removed.
- **Open:**
  - Does FASHN accept a mannequin/dress form as the base, or does it need a person?
  - Does quality drift along the chain?
  - Packshot (Studio) could extract garments later if needed.
- **Revisit when:** users want faster visual feedback while mixing, renders cost too much per outfit, or chain drift makes a single-call general image model better.

## D14. Render proxy: one Vercel Function with a Blob-backed step cache

- **Context:** "Style together" (D13) needs the FASHN key, which can't ship in the extension (D4).
- **Options:**
  - Where it runs: Vercel Functions · Cloudflare Workers
  - How images reach it: sent with each request · uploaded to Blob under an install ID
  - Cache and limits in: Vercel Blob · Redis
- **Decision:**
  - A single Node.js Vercel Function, `POST /api/style` (`server/`).
  - The extension sends each garment's original image with the request (downsized first), so no accounts or install IDs are needed.
  - The function owns the model, settings, layering order, cache and spending limits, and streams progress as NDJSON (newline-delimited JSON, one event per line).
  - Each chain step is stored in **private** Blob at `steps/<hash>`, where the hash covers the previous step, the garment image, the settings and the prompt version. Changing only the outermost garment costs one step.
  - Daily credit cap: a Blob counter updated with `ifMatch` (optimistic concurrency), so no database is needed.
- **Why:**
  - Vercel: free Hobby tier, CLI already installed, streaming on Node.js with no configuration, and a 300 s limit that easily covers a 5-step chain (~50 s).
  - Blob alone covers both the cache (existence = hit) and the counter, so there's no second service.
  - Sending images avoids user identity entirely.
  - Hashing image contents replaces a manual `imageVersion`: a replaced image is automatically a new step.
- **Tradeoffs:**
  - Images are re-sent on every request (a few hundred KB each after downsizing).
  - The shared client key only deters casual misuse; the daily cap and the prepaid FASHN balance (auto top-up off) are the real limits.
  - Anyone who knows a step's hash could reuse its cached render. Harmless, since hashes are unguessable and Blob is private.
  - The cache grows without cleanup.
- **Revisit when:** more than one person uses it (per-user limits need identity), Blob storage cost matters (add cleanup), or request size becomes a problem (upload images once, send hashes).

## D15. The base is a bare headless mannequin, kept by Try-On Max prompts

- **Context:** the first live render used a generated woman as the base. The product wants a mannequin: neutral, not "a specific person". FASHN's docs describe try-on only for people.
- **Options:** keep a person · a faceless mannequin · a headless mannequin (all via Model Create + Try-On Max prompts) · switch to a general multi-reference image model (like FASHN's Studio Agent, which isn't in the API)
- **Test** (`scripts/fashn-trial`, 8 credits):
  - Both mannequin types stayed mannequins through jeans → on-model lace cami → on-model trench, when every step's prompt said so.
  - The garments were faithful, the coat layered open over the cami, and the jeans showed full length.
  - Headless invented two small details (an extra button, sleeve straps). Faceless was slightly more faithful.
- **Decision:**
  - **Headless** (product preference): bare, no base clothes, so only the chosen pieces appear.
  - **Pure white background with no shadow**, set in the base prompt (Try-On Max keeps the base's background, so it costs nothing extra per render).
  - Every try-on prompt says: take only this garment (named by its product title when known) from the reference, its layer ("worn open over the top"), reproduce it exactly with no added details, and keep the mannequin.
- **Tradeoffs:**
  - FASHN shifts colours slightly darker (seen twice).
  - Small details can be invented; the fidelity wording reduces this but can't guarantee it.
  - Store titles go into prompts, so they're cleaned (letters, digits and basic punctuation, max 80 characters).
- **Revisit when:** M1.6 shows colour or detail errors that affect decisions, or FASHN opens its multi-reference Agent in the API.

## D16. One render call per look, behind a provider interface

- **Context:** the chained render (D14: one Try-On Max call per garment) took ~55 s for 3 pieces the first time (~40 s after), cost 1–3 credits per change, and redrew the whole outfit at every step. Detail drifted: a jacket was rendered like a vest over a knit. Model Create also ignored "headless" once.
- **Options:**
  - Keep the chain and tune it.
  - All garments in one Try-On Max call, placed side by side in a single product image.
  - A general multi-reference image model (like FASHN's Studio Agent, which isn't in the API).
- **Test** (`scripts/fashn-trial/experiment.ts`, 4 credits):
  - The one-call version rendered in **~15 s for 1 credit**.
  - It kept the jacket's full sleeves, layered a knit under an open jacket and a cami under an open trench, took only the garments from on-model store photos, and showed the jeans at full length with frayed hems.
- **Decision:**
  - **One call per look.**
    - The proxy composes the garments left to right in layering order on white (`sharp`).
    - It calls Try-On Max once onto a **pinned base**: one reviewed headless mannequin on pure white (seed 11), bundled with the function and never regenerated.
    - The prompt names each garment by position, category and title, says how they layer, and repeats the fidelity and mannequin rules.
    - The output is trimmed to fill the frame.
  - **Whole-look cache:** keyed by the provider id and each garment's category, image hash and title. The same look is free; any change costs 1 credit.
  - **Provider interface** (`RenderProvider`: `id`, `credits`, `render(items)`): validation, cache, limits, streaming and logs don't know which model is used. Switching models means writing a new provider, and its id makes old cached looks unreachable automatically.
  - **Kept:** original garment images as input, 1 s status polling, timing logs, the daily cap.
  - **Removed:** chained rendering, per-step caching, step-by-step progress. The panel shows "Styling your look… N pieces · about 15 seconds".
- **Tradeoffs:**
  - No partial reuse: swapping only the jacket still re-renders the whole look (but for 1 credit, the chain's best case).
  - Up to 5 garments must share one ~1K image, so fine detail may drop with many pieces.
  - A new dependency (`sharp`, native but standard on Vercel).
- **Revisit when:** looks with 4–5 pieces lose detail (try 2K resolution, or send fewer pieces per image), or another model beats FASHN on faithfulness or cost; add it as a provider and compare.
- **Supersedes:** the chain parts of D13 and D14, and D15's Model Create base (the prompts carry over).

## D17. Thumbnails of full-body store photos show only the garment's band

- **Context:** a top captured from a full-body model shot showed the whole person (and their other clothes) in the closet and the look, so you couldn't tell which piece was saved.
- **Options:** a crop box preset by category that the user adjusts · **an automatic crop by category, no adjusting** · AI garment detection · a generated packshot per item
- **Decision:**
  - When a **store** photo is saved and it's **tall** (height/width ≥ 1.4, typical of full-body shots), store a band by category: top 10–58% of the height, outerwear 8–78%, bottom 40–100%, shoes 78–100%. A dress shows the whole figure.
  - Thumbnails show that band with CSS `object-view-box`.
  - **Preview only:** the original image is untouched and is still what the renderer receives. FASHN picks the garment out of a model shot using the prompt and title, and a wrong band would clip the garment in the render.
- **Why:** no extra step and no cost. Product-only shots and waist-up model shots aren't tall, so they're left alone.
- **Tradeoffs:**
  - A fixed band is a guess: unusual framing (a seated pose, a cropped-at-the-knee shot) can show the wrong area.
  - The band can't be adjusted.
  - Items captured before this change have no band.
- **Revisit when:** M1.6 shows bands landing wrong often. Then add an adjustable crop box (the preset becomes its starting position) or AI detection to place it.

## D18. Panel hierarchy: Your Look on top, Fitting Room · My Closet drawers below

- **Context:**
  - A full-panel result screen broke your context every time you rendered.
  - A single closet mixed store pieces you're considering with clothes you own.
  - The band crop (D17) made store photos look worse, not better.
- **Options:** three peer tabs (Fitting Room · Closet · Looks) · **a workspace on top with source drawers below** · keep the full-screen result
- **Decision:**
  - **Your Look** (top) is the workspace: the selected pieces (Trying / With my closet), the slot adders, **See the outfit**, and the **render inside the card**.
    - Changing a piece dims the render with "Look changed" until you render again.
    - Coming back to a look shows its saved render.
  - **Fitting Room** holds store captures as their **original photos, uncropped**, free to add. Tap to wear. Item menu: *Add to My Closet*, *Remove*.
  - **My Closet** holds what you own: your uploads and items moved over from the Fitting Room. Item menu: *Remove* (plus *Clean up photo*, step b).
  - A garment's `location` (fittingRoom | closet) is separate from where it came from (`sourceType`). "Trying" means it's in the Fitting Room.
  - Choosing a slot filters the open drawer, and you can switch drawers while choosing.
  - **Extraction (step b):** only when an item moves to My Closet and its photo needs it, or on demand for uploads. Renders always use the original photo.
- **Why:** the top area is what I'm building now, and the bottom is where pieces come from. It matches the product question (does this store piece work with what I own?), and credits are only spent on pieces you keep.
- **Tradeoffs:**
  - A dimmed old render still takes space while you edit.
  - Moving an item between drawers is a menu action, not drag-and-drop.
- **Supersedes:** D17's band crop (removed), and the full-panel result screen from R5.
