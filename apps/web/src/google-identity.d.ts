// Minimal ambient types for the bits of Google Identity Services (the
// "Sign In With Google" JS library, loaded via <script> in index.html)
// this app actually uses — see GoogleSignInButton.tsx. There's no
// official/reliable @types package for this API, so this is hand-written
// rather than pulling in a heavier or unofficial dependency.
export {};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: { client_id: string; callback: (response: { credential: string }) => void }): void;
          renderButton(parent: HTMLElement, options: { theme?: string; size?: string; width?: number; text?: string }): void;
        };
      };
    };
  }
}
