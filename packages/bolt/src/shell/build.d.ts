// Set by the workspace entry `bolt build` writes (bolt-cli's `compiler/artifact/client.ts`, `globalThis.__BOLT_BUILD__`), not a
// `define`: the shared platform layer cannot carry one workspace's versions. Read by the account menu (L-BOLT-073).
declare const __BOLT_BUILD__: { workspace: string | null; bolt: string | null; node: string };
// ui's product mark, a URL the client build (vite) resolves; the access pages' header shows it.
declare module '@norbital-ai/ui/assets/logo.svg' {
	const url: string;
	export default url;
}
