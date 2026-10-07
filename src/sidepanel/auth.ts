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
  return { email, initial: (user.firstName?.[0] ?? email[0] ?? '?').toUpperCase() };
}

export function signIn(): void {
  clerk?.openSignIn({});
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
