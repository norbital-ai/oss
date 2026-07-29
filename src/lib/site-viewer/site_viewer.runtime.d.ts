declare module 'https://esm.sh/three@0.185.1' {
	const module: import('./site_viewer.types.js').ThreeModule;
	export = module;
}

declare module 'https://esm.sh/three@0.185.1/examples/jsm/controls/OrbitControls.js' {
	export const OrbitControls: import('./site_viewer.types.js').OrbitControlsModule['OrbitControls'];
}
