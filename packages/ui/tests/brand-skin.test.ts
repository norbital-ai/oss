import './dom.ts';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it } from 'vitest';
import { CONCEPT_ICONS, ConceptIcon } from '../src/brand/index.ts';
import IconWrapper from '../src/primitives/icon/icon-wrapper.svelte';

it('every concept renders its own glyph with one accent group, and `Icon` takes it as `concept:<name>`', () => {
	// the one vocabulary the shell and the website name icons by
	expect(Object.keys(CONCEPT_ICONS)).toEqual([
		'workspace', 'model', 'access', 'automation', 'interface', 'studio', 'models', 'writes', 'data', 'history',
		'policies', 'approvals', 'automations', 'agents', 'apps', 'integrations', 'releases', 'quick-start', 'examples', 'api'
	]);
	const target = document.body.appendChild(document.createElement('div'));
	try {
		for (const name of Object.keys(CONCEPT_ICONS)) {
			const view = mount(IconWrapper, { target, props: { name: `concept:${name}`, class: 'size-3' } });
			flushSync();
			const svg = target.querySelector(`svg[data-concept-icon="${name}"]`);
			expect(svg?.getAttribute('class')).toBe('size-3');
			expect(svg?.querySelector('g[style*="--product-icon-accent"]')?.children.length).toBeGreaterThan(0);
			unmount(view);
		}
		const view = mount(ConceptIcon, { target, props: { name: 'approvals' } });
		flushSync();
		expect(target.querySelector('svg[data-concept-icon="approvals"]')?.getAttribute('class')).toBe('size-4');
		unmount(view);
	} finally {
		target.remove();
	}
});
