// Baked by `bolt build`'s client build (`compiler/artifact/client.ts` `define`) for the account menu (L-BOLT-073).
declare const __BOLT_BUILD__: { workspace: string | null; bolt: string | null; node: string };
// ui's product mark, a URL the client build (vite) resolves; the access pages' header shows it.
declare module '@norbital-ai/ui/assets/logo.svg' { const url: string; export default url; }
// a dependency's stylesheet the client build (vite) bundles (Svelte Flow's, under the team chart)
declare module '@xyflow/svelte/dist/style.css';
