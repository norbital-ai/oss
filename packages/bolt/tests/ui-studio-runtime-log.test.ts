// @vitest-environment happy-dom
import './ui-setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it } from 'vitest';
import BundleLogs from '../src/client/ui/studio/bundle-logs.svelte';

/** Studio's runtime log is the release's `telemetry` records — the runtime's own, not a host ring. */
it('lists the release runtime records it is given, and says so when there are none', () => {
	const target = document.createElement('div');
	document.body.append(target);
	const filled = mount(BundleLogs, {
		target,
		props: {
			runtime: [
				{
					at: '2026-09-23T08:30:27.188Z',
					level: 'ERROR',
					line: '[field-ops-suspicion-review] 426 photo embedding(s) failed'
				}
			]
		}
	});
	flushSync();
	expect(target.textContent).toContain('426 photo embedding(s) failed');
	expect(target.textContent).not.toContain('bolt.studio.noRuntimeLog');
	unmount(filled);

	const empty = mount(BundleLogs, { target, props: { runtime: [] } });
	flushSync();
	expect(target.textContent).toContain('bolt.studio.noRuntimeLog');
	unmount(empty);
	target.remove();
});
