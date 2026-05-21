/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLASSES_AUTH_TOKEN?: string;
  readonly VITE_AI_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
