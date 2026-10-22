/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** "true" only in local development: shows a stand-in for Google sign-in (see Login.tsx). Never set for a real build. */
  readonly VITE_DEV_GOOGLE_STUB?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
