// iOS lays the page out under its on-screen keyboard (it ignores `interactive-widget`): what the keyboard covers is
// published as `--keyboard-inset`, so a bottom sheet rests on it. Elsewhere the layout viewport shrinks and this stays 0.
let watching = false;
export function watchKeyboard(): void {
	if (watching || typeof visualViewport === 'undefined' || visualViewport === null) return;
	watching = true;
	const viewport = visualViewport;
	const publish = () =>
		document.documentElement.style.setProperty(
			'--keyboard-inset',
			`${Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop))}px`
		);
	viewport.addEventListener('resize', publish);
	viewport.addEventListener('scroll', publish);
	publish();
}
