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

## D19. Clean product photos for My Closet: one FASHN Edit call per item, only when needed

- **Context:** store photos are often a model wearing a whole outfit, so My Closet thumbnails didn't show which piece you own. Cropping (D17) looked bad.
- **Test** (`scripts/fashn-trial/experiment.ts extract`, 4 credits):
  - **One Edit call per garment** turned a waist-up model shot into a faithful product shot of the lace cami, a trench photo into the coat, and the same trench photo into the model's trousers ("ignoring the coat").
  - Misses: the coat's belt was dropped, and the trousers kept a grey backdrop and the store page's ♡ icon.
  - **Batching** three photos in one grid (1 credit) left one panel unchanged and shared a smaller output, so it's unreliable.
  - Calls took 55–67 s while 4 ran in parallel.
- **Decision:**
  - `POST /api/extract`, in the same function as `/api/style` (dynamic route `api/[action].ts`), behind an `ExtractProvider` interface.
  - It shares validation, the key, the daily credit cap, streaming and logs.
  - Results are cached per photo hash, category and title (`clean/<hash>.jpg`), so the same photo is never cleaned twice.
  - Prompt: only the picked garment (the category wins over the store's title), pure white #FFFFFF background, no icons, badges or text, keep belts, straps and ties, add or change nothing.
  - **When it runs:** on *Add to My Closet*, in the background, only if the photo needs it: a light, plain border **and** under 6% skin-tone pixels in the middle means it's already a product shot, so it's skipped (free). For My Closet items, it runs on demand via *Clean up photo*.
  - The thumbnail shows "Cleaning up…" until it's done. *Use original photo* reverts at any time. **Renders always use the original.**
- **Tradeoffs:**
  - 1 credit per cleaned item.
  - Generated product shots can drop or invent small details; that's why they're thumbnails only, and reversible.
  - The check misses dress forms hidden by dark garments (they stay uncleaned, free) and can flag brown or camel garments as skin (an unneeded credit).
- **Revisit when:** clean-up errors show up in M1.6, a cheaper extractor matches FASHN's quality, or batching becomes reliable.

## D20. Closing the loop: Buy / Save / Pass, and choosing pieces from My Closet

- **Context:** the core loop stopped at the render. Cabine's question ("does this new piece work with what I own?") needs an answer step, and choosing the other pieces usually means choosing from what you own.
- **Decision:**
  - After a render is up to date, **"What are you thinking?"** appears with **Buy · Save · Pass** for each Fitting Room piece in the look.
    - **Buy** asks "Add *X* to My Closet?" inline, then moves it (photo clean-up only if needed, D19).
    - **Save** keeps it in the Fitting Room with a "Saved" badge.
    - **Pass** takes it out of the look and hides it from the drawers, but **keeps the record** (`decision: 'pass'`), so decisions can be counted when analytics arrive.
  - Choosing a slot (+ Top, or clicking a worn piece) **opens My Closet** filtered to that category; the Fitting Room tab is one tap away.
  - Render card: while rendering it shows the pieces' thumbnails and "Usually takes about 15 seconds". A render for a changed look is dimmed with **"Outfit changed"** and the button reads **"Update outfit"**.
  - Fitting Room menu: *Add to look / Take off*, *Open original page*, *Add to My Closet*, *Remove*.
- **Tradeoffs:**
  - A decision is per piece, not per look.
  - Buying doesn't record where or at what price.
  - Passed items can't be brought back from the UI yet.
- **Revisit when:** user tests show people want to compare several candidates, or to revisit passed items.

## D21. Adding clothes from a phone: an upload inbox, not a server closet

- **Context:** filling My Closet from a laptop is awkward, because your clothes are in your room and your phone has the camera. Cabine has no accounts.
- **Options:**
  - **A.** Make the server the home of the closet (per-user storage, sync).
  - **B.** **An upload inbox:** the server only bridges phone uploads into the extension's closet.
- **Decision: B.** My Closet stays authoritative in IndexedDB.
  - **Anonymous id:** created once per install (`chrome.storage.local`), sent as `X-Cabine-User`. It groups sessions now, and will power per-user limits and analytics later. It never appears in a URL.
  - **QR session:** `POST /api/upload-session` (extension key) creates a 256-bit random token that lasts **30 minutes** and allows **at most 20 photos, 3 MB each**. The server stores only the token's **hash**. The QR code encodes `…/add/{token}`.
  - **Phone page** (`public/add.html`, no login, no build): take or choose photos → a category for each → remove any → "Add N to My Closet". Photos are shrunk to 1600 px JPEG on the phone (the photo's rotation is respected), uploaded one by one, and failures can be retried.
    - The token can only **add** photos to its own inbox.
    - Expired, full or invalid links show plain messages.
    - The page is sent with `Referrer-Policy: no-referrer` and `noindex`.
  - **Extension:** My Closet → **Add clothes** → *Upload from this device* / *Use your phone*.
    - The QR card polls the inbox every 3 s (4 photos per pull), saves each photo as a closet garment, then **acknowledges so the server deletes it**. It keeps pulling for 2 minutes after expiry, in case uploads were still finishing.
    - It shows "✓ N new pieces added" and the time left, and offers a new QR when the old one expires.
  - **Cleanup:** a daily Vercel Cron (`GET /api/cleanup` with `CRON_SECRET`) deletes each session and any unclaimed photos a day after it expires.
- **Why:** the same experience as a synced closet, about half the work, nothing permanent on the server, and no accounts. It can grow into A when cross-device persistence or accounts are needed.
- **Tradeoffs:**
  - The extension must be open with the QR card showing to receive photos; otherwise they're pulled on the next open, or deleted after a day.
  - Photos made on the phone are only in the one browser that pulled them.
  - The inbox relies on polling, not push.
- **Tested:**
  - 22 server tests (sessions, token-only phone routes, caps, expiry, batching, deletion on ack, the phone can't read the inbox, the token isn't stored, cleanup).
  - A local end-to-end run: the phone page uploaded 3000×4000 photos as 1200×1600 JPEGs, the panel showed "2 new pieces added" within 3 s, and the server inbox was empty afterwards.
- **Revisit when:** people want their closet on more than one computer, or accounts arrive.

## D22. Spending safeguards before testers: per-person allowances, a global budget, one render per request

- **Context:** one shared daily cap (30 credits) meant a single tester could use everyone's budget. Two windows or a retry could also pay twice for the same look.
- **Decision:**
  - **Every paid request needs the anonymous install id** (`X-Cabine-User`, D21), or it's a 400. Only a hash of the id goes into storage paths.
  - **Per-install daily allowance:** 10 looks and 10 photo clean-ups (`USER_DAILY_LOOKS`, `USER_DAILY_CLEANUPS`). **Global budget:** 60 credits a day (`DAILY_CREDIT_LIMIT`, ≈ $4.50). The prepaid FASHN balance, with auto top-up off, is still the final ceiling.
  - **Order:** reserve the person's allowance, then the global budget. If the global budget is out, the person's allowance is given back. Both are JSON counters updated with `ifMatch` and randomized retries (the D14 counter, generalized).
  - **Cached results are free** and never count.
  - **Duplicate protection:** a short-lived lock per result (`locks/<hash>`, stale after 3 min). A second identical request waits up to 100 s for the first one's result instead of paying again.
  - **Messages written for people:** "You've used today's 10 looks. Try again tomorrow." and "Cabine has reached today's limit. Try again tomorrow."
- **Why:** each tester gets a fair share, the total cost per day is bounded, and accidental double renders cost nothing.
- **Tradeoffs:**
  - Anyone who can read the client key from the extension can make new ids (a fresh id per request). The global budget still caps the damage; real per-person limits need accounts.
  - Allowances reset at midnight UTC, not the tester's local midnight.
- **Tested:** 28 server tests, including separate allowances per person and per kind, cache hits not counting, the allowance given back when the global budget runs out, the missing-id 400, and two simultaneous identical requests giving 1 provider call, 1 credit and a released lock.
- **Revisit when:** accounts arrive, or tester usage shows the numbers are wrong.

## D23. Product analytics in Neon Postgres, first-party and minimal

- **Context:** the portfolio hypothesis needs evidence. The primary metric is *% of captured store items combined with at least one closet piece*, then the funnel captured → closet piece added → outfit requested → render viewed → decision. The original spec ruled out analytics services.
- **Options:** Postgres from the Vercel Marketplace (Neon) · PostHog · a local-only log with export
- **Decision: Neon Postgres** (`cabine-analytics`, provisioned via `vercel integration add neon`, free plan), written only by our own function.
  - **Table** `events(user_hash, name, props jsonb, client_at, received_at)`, in `server/db/schema.sql` (`npm run migrate`).
  - **What's recorded:** event names from a fixed list, a **hash** of the anonymous install id, and small flat properties: category, store **domain**, counts, timings, cached or not, random garment ids.
  - **What's never recorded:** photos, product titles or page URLs.
  - **Server** (`POST /api/events`, key + id): at most 50 per batch. Unknown names or oversized, nested properties are dropped and counted. Timestamps are trusted within a week, otherwise server time. One insert per batch (`jsonb_to_recordset`).
  - **Extension:**
    - `track()` appends to a local queue, one per context (worker / panel), so they never overwrite each other.
    - The panel sends up to 50 at a time on open and every 15 s, and trims the queue only after the server accepts them, so nothing is lost offline.
    - Capture outcome is recorded in the service worker; everything else in the panel.
  - **Events:** extension_opened, store_item_captured, store_item_category_selected, closet_upload_session_created, closet_item_uploaded, fitting_room_item_selected, closet_item_selected, outfit_render_requested (with candidate ids and closet count) / completed (seconds, cached) / failed, decision_buy / save / pass, item_moved_to_closet, photo_cleanup_requested / completed / failed.
  - **Queries** in `server/db/analytics.sql` (`npm run report`): primary metric, funnel, decisions, render speed and caching, capture success by store, how pieces reach the closet, clean-ups, daily activity. Checked against a synthetic dataset (the primary metric computed 1/3 = 33.3% as expected), then removed.
- **Why:** real SQL over our own data; no third-party tracker; costs nothing at tester scale.
- **Tradeoffs:**
  - Funnel steps aren't strictly ordered in time.
  - Events are client-reported (a modified extension could send junk), but the list of names and the size limits bound it.
  - `vercel integration add` rewrites `.env.local`, so the extension's build key now lives in `.env.production.local`.
- **Revisit when:** there are more than a few hundred installs (add retention and deletion), or funnel ordering matters (window functions over `client_at`).

## D24. Ship with an empty closet

- **Context:** every install copied 9 retailer dress-form photos into My Closet as a starter closet. They can't ship publicly, and a tester should build their own closet anyway.
- **Options:** empty closet with a first-run guide · a labelled demo closet the user can clear
- **Decision: empty.** A new install sees three steps in the look: add clothes you own (phone or this computer), right-click a product image on a store, then See the outfit. The photos moved to `scripts/seed-cleanup/closet/` (git-ignored, not bundled).
- **Tradeoff:** the first render needs the user's own clothes first. The phone QR makes that quick.
- **Revisit when:** first-run drop-off shows people leave before adding a piece (then add a few licensed demo pieces).

## D25. Retention for server-side images

- **Context:** rendered looks and clean photos were cached in Blob forever. So were daily usage counters and stale locks.
- **Decision:** the daily cleanup job (`GET /api/cleanup`) also deletes anything older than:
  - `looks/` and `clean/`: **30 days** after they were made;
  - `usage/`: 8 days;
  - `locks/`: 1 day.
  
  The ages are in `RETENTION_DAYS` and are stated in the privacy policy; change both together.
- **Why:** storage stays flat, and the privacy policy can make a concrete promise.
- **Tradeoff:** repeating a look older than 30 days costs one credit again. The panel keeps its own copy in IndexedDB, so people rarely notice.
- **Tested:** a server test checks that nothing goes before 30 days, both caches go after, today's look and counters stay, and an expired look is made again.

## D26. UX system: "What would I wear this with?"

- **Context:** the panel had grown into a wardrobe tool. It had slots ("+ Top", "Use a dress instead"), a category question on every capture, two equal drawers, and Buy / Save / Pass. The product question is narrower: *I found this. What do I have that works with it? Let me see them together.*
- **Decision:** rebuild the panel around that one loop. The user sees three things: this piece, my clothes, together. Categories, slots and the dress rule stay internal.
  - **Capture:** the category is guessed from the page title (`shared/infer.ts`: English and Korean garment words; the last one in the product-name part wins, so "Shirt Dress" is a dress). The guess shows as "Top · Edit". The panel asks "What is it?" only when nothing matches. A capture starts a fresh look around the piece.
  - **Your Look** (the main workspace):
    - the store piece, marked "From the store" with an oxblood edge;
    - the question "What would you wear this with?";
    - the whole closet, with the earlier "All 9 · Top 5 · Bottom 3…" chips. Under "All", the kinds that go with the piece come first, most recently used first. The order stays stable while picking.
    
    *Changed after review:* the first version showed 8 suggestions plus "View all". Kept from before: the white background and the category chips. Fitting Room and My Closet aren't tabs on the main page; they're only header links.
    
    Tapping a piece selects it; another piece of the same kind replaces it silently. The button is "See them together".
  - **Result:** the picture, then "Open original page ↗" (primary), "Try another look" and "♡ Save look". Cabine doesn't ask whether you bought it. "I got this — add to My Closet" is in the piece's ⋯ menu.
  - **Navigation:** the header has the brand plus "Fitting Room" and "My Closet". The Fitting Room lists the pieces you're considering and your saved looks. My Closet is a selection source, not a dashboard.
  - **Progressive closet:** an empty closet asks for "a few pieces you actually wear" (phone first). With a store piece and no closet, the look offers "Add a piece from your closet".
  - **Visual system:**
    - white background (kept from before), ink `#171717`, oxblood `#7B3040` only for "this piece" and selection;
    - Inter Tight, bundled in the extension (`@fontsource-variable/inter-tight`, no external request);
    - 6px radii, black primary buttons, no pills;
    - a soft gradient only while the picture is being made, and a blur-to-clear reveal.
  - **Copy:** natural and short. "Putting it together… / About 15 seconds". The panel never says outfit generation, AI or recommendation.
- **Supersedes:** D18 (layout), D20 (Buy / Save / Pass; old `decision` values are kept and `pass` pieces stay hidden), and the category step of D13.
- **Analytics:**
  - New events: `original_page_opened`, `look_saved`, `try_another_look`, `category_edited`.
  - `store_item_category_selected` carries `inferred`.
  - Funnel step 5 is now "acted on the look".
  - The report adds "Category guesses", which shows how often a guess was corrected.
- **Tradeoffs:**
  - A wrong guess costs a render if it isn't noticed. "Top · Edit" sits next to the piece to make that unlikely, and the report measures it.
  - Titles that use " – " for colour lose it in the display name ("Camisole – Navy" shows as "Camisole").
- **Revisit when:** the correction rate is high (then classify the image), or people want to compare several store pieces at once.

### D26 revision (after review)

- **Main page is fixed:** the Your Look section (picture, the pieces in it, actions) sits on top, and every piece (store and owned together) sits below under the "All · Top · Bottom…" chips. Nothing replaces these sections.
- **No "From the store" step:** a capture goes straight into the look in its guessed kind, and the chips switch to that kind. Store pieces wear a small STORE tag and an oxblood edge.
- **Fixing a guess:** ⋯ → "Edit category". The chips follow the piece to its new kind.
- **Result actions:** "Open original page ↗" and "♡ Save look". "Try another look" is gone: the pieces are always right there to change.
- **The picture:** it resolves only the first time it's shown, and it's capped at 46vh so the chips stay in view.

### D26 revision 2: fixed frame, result cases, automatic clean-up

- **The frame never disappears.**
  - It shows an empty mannequin (the same base the renders use) with "Pick pieces below" until there's a look.
  - Then it shows "Putting it together…", then the result.
  - It's the same height in every state, so nothing jumps. "See them together" stays visible (disabled when empty).
- **Result actions depend on where the pieces came from:**
  - only your own clothes: "♡ Save look" (there's no page to go back to);
  - one store piece: "Open original page ↗" plus Save;
  - several store pieces: one "↗" link per piece, plus Save.
- **"I got this — add to My Closet" always cleans up the photo** (1 credit). The "is it already clean?" check and the manual "Clean up photo" option are gone. While it runs, the tile shows a hanger turning on its hook. After a failure, the ⋯ menu offers "Try the clean-up again"; "Use original photo" stays.
- The ⋯ menu flips right on the first column so it isn't cut off.
- **Uploads are cleaned up too** (from this computer or the phone), right away, 1 credit each. This supersedes D19's "on demand for uploads".
  - Clean-ups queue two at a time, and the hanger shows from the moment a piece is queued.
  - Writes to the garment list now run one at a time (`store.ts`). With a phone batch and several clean-ups finishing together, parallel read-modify-writes could drop a piece.
  - Watch: the per-person limit is 10 clean-ups a day (`USER_DAILY_CLEANUPS`), so a first phone session of 20 photos leaves 10 at "Couldn't clean up" until tomorrow.

### D26 revision 3: mannequin + boxes

- **The frame keeps the mannequin's proportions** (848 × 1264, at most 72vh tall), so the whole figure shows at any panel width. Pictures are contained, never cropped.
- **Boxes to the right of the mannequin, head to toe:** Outer, Top, Bottom, Shoes. A dress takes the Top and Bottom boxes as one tall box. A filled box shows the piece (an oxblood edge for a store piece) with × to take it off. Tapping a box switches the chips to that kind. These boxes replace the thumbnail row under the picture.
- **After the result:** "♡ Save this look" and "Try another". "Try another" goes back to the empty mannequin and keeps the chosen pieces in their boxes. "See them together" on an unchanged look shows the saved picture again, with no new request. "Open original page" is in each store piece's ⋯ menu.
- When the look changes, the frame goes back to the empty mannequin instead of fading the old picture. Coming back to a combination you've already seen shows its saved picture.
- **Not done:** a hat box. There's no hat category, and the render prompt and server validation only know top, bottom, dress, outerwear and shoes.
- The clean-up limit stays at 10 a day per person (decided).

### D26 revision 5: back to the mannequin; picked pieces in a row

- The Look Board trial was reverted (it didn't feel right). The empty mannequin stays.
- The vertical OUTER / TOP / BOTTOM / SHOES rail is gone: empty category boxes read as "fill every slot".
- In its place, a column to the right of the mannequin shows only the chosen pieces, stacked head to toe. Each has × to take it off and an oxblood edge for store pieces; tapping one switches the chips to its kind. The column is always reserved, so the mannequin doesn't shift when the first piece arrives.
  - A horizontal row under the mannequin was tried first; the user preferred the column.
