import { expect, it as test } from '@effect/vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { mountEdge } from '@norbital-ai/ui/effect';
import { scriptedBolt } from '../../ui/tests/scripted-bolt.ts';
import Chart from './support/chart.svelte';

test.each(['line', 'area', 'bar', 'scatter'] as const)(
	'%s keeps numeric axis labels inside a narrow chart',
	async (kind) => {
		const client = await scriptedBolt({
			answer: () => {
				throw new Error('A local chart must not read the server');
			}
		});
		const disposeEdge = mountEdge(client.runtime);
		const target = document.body.appendChild(document.createElement('div'));
		const view = mount(Chart, { target, props: { kind, bolt: client.bolt } });
		try {
			flushSync();
			await tick();
			const labels = () =>
				[...target.querySelectorAll('svg text')].filter((text) =>
					/^-?\d[\d.,]*$/.test(text.textContent ?? '')
				);
			await expect.poll(() => labels().length).toBeGreaterThan(1);
			await document.fonts.ready;
			const svg = target.querySelector('svg');
			if (svg === null) throw new Error('Chart did not render its SVG');
			const bounds = svg.getBoundingClientRect();
			expect(bounds.width).toBeGreaterThan(0);
			for (const label of labels()) {
				const rect = label.getBoundingClientRect();
				expect(rect.left, label.textContent ?? '').toBeGreaterThanOrEqual(bounds.left);
				expect(rect.top, label.textContent ?? '').toBeGreaterThanOrEqual(bounds.top);
				expect(rect.right, label.textContent ?? '').toBeLessThanOrEqual(bounds.right);
				expect(rect.bottom, label.textContent ?? '').toBeLessThanOrEqual(bounds.bottom);
			}
		} finally {
			await unmount(view);
			target.remove();
			await disposeEdge();
		}
	}
);
