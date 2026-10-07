import { createClerkClient } from '@clerk/chrome-extension/client';

// Optional sign-in (D32). Signed out, Cabine works exactly as before (an
// anonymous install id). Signed in, requests carry a short-lived Clerk session
// token, so daily limits follow the account, and (next step) the closet syncs.
// Clerk's "no remote code" build is bundled, as the Chrome Web Store requires.

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '';
const PANEL_URL = chrome.runtime.getURL('sidepanel/index.html');

type Clerk = ReturnType<typeof createClerkClient>;
let clerk: Clerk | null = null;

export interface Account {
  id: string; // the Clerk user id
  email: string;
  initial: string;
}

export const authAvailable = () => !!PUBLISHABLE_KEY;

// Load Clerk once; `onChange` runs whenever someone signs in or out.
export async function startAuth(onChange: () => void): Promise<void> {
  if (!PUBLISHABLE_KEY || clerk) return;
  try {
    clerk = createClerkClient({ publishableKey: PUBLISHABLE_KEY });
    await clerk.load({
      afterSignOutUrl: PANEL_URL,
      signInForceRedirectUrl: PANEL_URL,
      signUpForceRedirectUrl: PANEL_URL,
      allowedRedirectProtocols: ['chrome-extension:'],
    });
    clerk.addListener(onChange);
    onChange();
  } catch (err) {
    // Sign-in is optional: if Clerk can't load (offline, blocked), stay anonymous.
    console.warn('[cabine] sign-in unavailable', err);
    clerk = null;
  }
}

export function account(): Account | null {
  const user = clerk?.user;
  if (!user) return null;
  const email = user.primaryEmailAddress?.emailAddress ?? '';
  return { id: user.id, email, initial: (user.firstName?.[0] ?? email[0] ?? '?').toUpperCase() };
}

export function signIn(): void {
  clerk?.openSignIn({});
}

// Clerk's own Google button tries a web redirect, which can't come back to a
// side panel. Catch the click before Clerk sees it and run `run` instead.
export function interceptGoogle(run: () => void): void {
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null;
      if (!target?.closest('[class*="cl-socialButtons"][class*="__google"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clerk?.closeSignIn();
      clerk?.closeSignUp();
      run();
    },
    true,
  );
}

// Google through Chrome's own sign-in window (chrome.identity), which can return
// to the extension. Google hands back an ID token; Clerk signs in with it (or
// creates the account), the same exchange as Google One Tap.
export async function signInWithGoogle(): Promise<void> {
  const client = clerk?.client;
  // The Google client id Clerk is configured with; Clerk publishes it to its frontend.
  const clientId = (clerk as unknown as { __unstable__environment?: { displayConfig?: { googleOneTapClientId?: string } } })
    ?.__unstable__environment?.displayConfig?.googleOneTapClientId;
  if (!clerk || !client || !clientId) throw new Error('Google sign-in isn’t set up');

  const nonce = crypto.randomUUID();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'id_token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: 'openid email profile',
    nonce,
    prompt: 'select_account',
  }).toString();

  const back = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true }).catch((err: Error) => {
    // Chrome says only "could not be loaded" when Google rejects the request
    // (most often: this redirect isn't allowed on the Google client yet).
    throw new Error(`${err.message} (redirect ${chrome.identity.getRedirectURL()})`);
  });
  const token = back && new URLSearchParams(new URL(back).hash.slice(1)).get('id_token');
  if (!token) throw new Error('Google didn’t return a sign-in');

  const attempt = await client.signIn
    .create({ strategy: 'google_one_tap', token } as never)
    .catch((err: { errors?: { code?: string }[] }) => {
      // First time with this Google account: create the Cabine account instead.
      if (err?.errors?.[0]?.code === 'external_account_not_found') {
        return client.signUp.create({ strategy: 'google_one_tap', token } as never);
      }
      throw err;
    });
  if (attempt.status !== 'complete' || !attempt.createdSessionId) throw new Error('Google sign-in didn’t finish');
  await clerk.setActive({ session: attempt.createdSessionId });
}

export async function signOut(): Promise<void> {
  await clerk?.signOut({ redirectUrl: PANEL_URL });
}

// A fresh session token for the server (Clerk refreshes it as needed), or null when signed out.
export async function sessionToken(): Promise<string | null> {
  try {
    return (await clerk?.session?.getToken()) ?? null;
  } catch {
    return null;
  }
}
