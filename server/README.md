# Cabine server (Vercel)

One function, `POST /api/style`, that renders an outfit with FASHN. See
`docs/decisions.md` D13 and D14.

## What it owns

- The FASHN model and settings (`TRYON`, `BASE`, `tryOnPrompt` in `api/style.ts`): a bare
  headless mannequin on white, and a Try-On Max prompt per step that keeps it a mannequin,
  names the garment (optional `title`), sets the layering, and asks for fidelity
- Layering order: bottom → dress → top → outerwear → shoes
- The step cache: each chain step is stored in private Vercel Blob under a key
  derived from everything that affects it (previous step, garment image hash,
  settings). Changing only the last garment re-renders one step.
- Spending limits: max 5 garments, 3 MB per image, and a daily credit cap
  (`usage/YYYY-MM-DD.json`, updated with etag-based optimistic concurrency).

## Request / response

```
POST /api/style
Authorization: Bearer <CABINE_CLIENT_KEY>
{ "items": [{ "category": "top", "image": "data:image/jpeg;base64,...", "title": "Silk lace cami" }, ...] }
```

Response: `application/x-ndjson`, one event per line:

```
{"type":"plan","steps":[{"category":"base","cached":true},{"category":"bottom","cached":false},...],"credits":2}
{"type":"step","index":1,"category":"bottom","status":"running"}
{"type":"step","index":1,"category":"bottom","status":"done","seconds":9.8}
...
{"type":"result","image":"data:image/jpeg;base64,...","credits":2}
```

or `{"type":"error","code":"daily_limit"|"render_failed","message":"..."}`.
Bad requests get a plain 400/401 JSON response before anything is spent.

## Environment variables

| Name | Value |
|---|---|
| `FASHN_API_KEY` | FASHN API key (set it yourself: `vercel env add FASHN_API_KEY`) |
| `CABINE_CLIENT_KEY` | Shared secret the extension sends. Deters casual use only: it can be read from the extension. |
| `DAILY_CREDIT_LIMIT` | Optional, default 30 (≈ $2.25/day) |
| `BLOB_READ_WRITE_TOKEN` | Added automatically when a **private** Blob store is connected |

## Develop

```sh
cd server
npm install
npm test          # fake FASHN + in-memory store: no network, no credits
npm run typecheck
```

Deploy as a Vercel project whose Root Directory is `server/`.
