// iOS lays the page out under its on-screen keyboard (it ignores `interactive-widget`): what the keyboard covers is
// published as `--keyboard-inset`, so a bottom sheet rests on it. Elsewhere the layout viewport shrinks and this stays 0.
import { bind_viewport } from '../../behaviors/index.js';

let watching = false;
export function watchKeyboard(): void {
	if (watching || typeof visualViewport === 'undefined' || visualViewport === null) return;
	watching = true;
	bind_viewport()(document.documentElement);
}
