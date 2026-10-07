/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Shared secret for the render proxy (server/api/style.ts). It ships inside the
  // extension, so it only deters casual use; the proxy's daily cap is the real limit.
  readonly VITE_CABINE_CLIENT_KEY?: string;
  readonly VITE_CABINE_API?: string; // defaults to the production proxy
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string; // optional sign-in (D32); public by design
}
