# Chrome Web Store: Privacy practices tab

What to enter on the Privacy practices tab when Cabine is submitted. These answers must stay in line with `server/public/privacy.html` (D32).

## Single purpose

Cabine lets you try store clothes against your own wardrobe. Save product images from shopping sites, keep photos of clothes you own, and see them styled together on a mannequin.

## Permission justifications

| Permission | Why |
|---|---|
| `sidePanel` | Cabine's interface is a side panel next to the store you're browsing. |
| `contextMenus` | The "Take it to Cabine" item when you right-click a product image. |
| `storage` | Keeps your closet, Fitting Room and saved looks in the browser. |
| `cookies` | Required by the sign-in library (Clerk) to keep you signed in. Cabine reads no other site's cookies. |
| `identity` | Opens Google's sign-in window for "Continue with Google". |
| Host permission `<all_urls>` | Downloads the product image you right-clicked, from whichever store it's on, and reaches the sign-in service. Cabine doesn't read or change page content. |

## Remote code

**No.** Everything is bundled. Clerk's no-remote-code build (`@clerk/clerk-js/no-rhc`) is used.

## Data usage (tick these)

- **Personally identifiable information:** yes. The email address, only if the user signs in. It's held by Clerk.
- **Authentication information:** yes. Sign-in session tokens are managed by Clerk.
- **Website content:** yes. Product images and names the user chooses to save. When signed in, the product page address of pieces in My Closet is also kept.
- **User activity:** yes. Anonymous usage events: event names, counts, timings and the store's domain. No page addresses.
- Everything else (health, financial, location, personal communications, web history): **no**.

## Certifications (all true)

- Data isn't sold to third parties outside the approved use cases.
- Data isn't used or transferred for purposes unrelated to the single purpose.
- Data isn't used or transferred to determine creditworthiness or for lending.

## Privacy policy URL

`https://cabine-server.vercel.app/privacy`

## Before submitting

- Add the store build's origin `chrome-extension://<store id>` in two places:
  - Clerk's allowed origins
  - the `CLERK_AUTHORIZED_PARTIES` environment variable on Vercel (comma-separated, next to the dev id)
- Move Clerk from its development keys (`pk_test_`) to a production instance (`pk_live_`).
