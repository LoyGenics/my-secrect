/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default account API base URL baked in at build time (e.g. https://vault.example.com/api). */
  readonly VITE_API_BASE_URL?: string;
}
