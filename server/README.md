# Cabine server (Vercel)

One function, `POST /api/style`, that renders an outfit in one call. See
`docs/decisions.md` D13, D14 and D16.

## What it owns

- The render provider, behind the `RenderProvider` interface in `api/style.ts`.
  Today that's FASHN: the garments are placed side by side on white in one image
  (`composeGarments`), and one Try-On Max call dresses a pinned headless mannequin
  (`assets/base-mannequin.jpg`) with a prompt built from the categories and titles
  (`fashnPrompt`). The result is trimmed to fill the frame.
- The whole-look cache in private Vercel Blob (`looks/<hash>.jpg`), keyed by the
  provider id and each garment's category, image hash and title. The same look
  again is free.
- Spending limits: max 5 garments, 3 MB per image, and a daily credit cap
  (`usage/YYYY-MM-DD.json`, updated with etag-based optimistic concurrency).
- Timing logs per look and per provider call (`vercel logs`).

## Request / response

```
POST /api/style
Authorization: Bearer <CABINE_CLIENT_KEY>
{ "items": [{ "category": "top", "image": "data:image/jpeg;base64,...", "title": "Silk lace cami" }, ...] }
```

Response: `application/x-ndjson`, one event per line:

```
{"type":"plan","cached":false,"credits":1}
{"type":"result","image":"data:image/jpeg;base64,...","credits":1}
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
