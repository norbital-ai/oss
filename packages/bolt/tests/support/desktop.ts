// A desktop, whatever the host reports: a fine pointer that hovers. A Linux runner's headless Chromium reports
// `hover: none`, which neither a launch flag nor media emulation overrides, and the kit then opens hints by tap rather
// than by hover or focus. Until a test emulates touch (`Emulation.setTouchEmulationEnabled`), the hover and pointer
// queries answer as a desktop; every other query, and these under touch, are the browser's.
const DESKTOP: { readonly [query: string]: boolean } = {
	'(hover:none)': false,
	'(hover:hover)': true,
	'(any-hover:none)': false,
	'(any-hover:hover)': true,
	'(pointer:coarse)': false,
	'(pointer:fine)': true,
	'(any-pointer:coarse)': false,
	'(any-pointer:fine)': true
};
const host = window.matchMedia.bind(window);
const touch = host('(pointer: coarse)');
class Desktop extends EventTarget implements MediaQueryList {
	onchange: MediaQueryList['onchange'] = null;
	private readonly real: MediaQueryList;
	private readonly desktop: boolean;
	constructor(real: MediaQueryList, desktop: boolean) {
		super();
		this.real = real;
		this.desktop = desktop;
		const relay = () => this.dispatchEvent(new Event('change'));
		real.addEventListener('change', relay);
		touch.addEventListener('change', relay);
	}
	get media() {
		return this.real.media;
	}
	get matches() {
		return navigator.maxTouchPoints > 0 ? this.real.matches : this.desktop;
	}
	addListener() {}
	removeListener() {}
}
window.matchMedia = (query) => {
	const desktop = DESKTOP[query.replace(/\s/g, '')];
	return desktop === undefined ? host(query) : new Desktop(host(query), desktop);
};
