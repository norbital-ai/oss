/// <reference types="@vitest/browser-playwright" />
import { afterEach, expect, it } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { flushSync, mount, tick, unmount } from 'svelte';
import { page } from 'vitest/browser';
import type { UiContext } from '@norbital-ai/ui';
import Harness from './support/structured-form-geometry.svelte';
import { required } from './support/required.ts';
import './support/shell.css';

let dispose: (() => Promise<void>) | undefined;

afterEach(async () => {
	await dispose?.();
	dispose = undefined;
});

async function mountHarness() {
	await page.viewport(1200, 900);
	document.documentElement.classList.add('dark');
	localStorage.clear();
	const runtime = ManagedRuntime.make(Layer.empty);
	const stopEdge = mount_edge(runtime);
	const ctx: UiContext = {
		ui: {
			kinds: {
				catalog: {},
				query: () => Effect.succeed({}),
				locale: 'en',
				zone: 'UTC',
				currency: 'SGD'
			}
		}
	};
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const app = mount(Harness, { target, props: { ctx } });
	for (let i = 0; i < 3; i++) {
		flushSync();
		await tick();
	}
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	dispose = async () => {
		await unmount(app);
		await stopEdge();
		target.remove();
		document.documentElement.classList.remove('dark');
	};
	return target;
}

it('form labels are small and muted, sole matching section labels are suppressed, and StructuredData aligns caret, guide, labels and section padding', async () => {
	const target = await mountHarness();

	// 1. FieldControl and Label both use small muted typography distinct from data values
	const codeLabel = required(target.querySelector<HTMLElement>('#geom-code-label'));
	const bareLabel = required(target.querySelector<HTMLElement>('[data-bare-label]'));
	const dataValue = required(target.querySelector<HTMLElement>('[data-data-value]'));
	const codeLabelStyle = getComputedStyle(codeLabel);
	const bareLabelStyle = getComputedStyle(bareLabel);
	const dataStyle = getComputedStyle(dataValue);
	expect(codeLabelStyle.fontSize).toBe('12px');
	expect(codeLabelStyle.fontWeight).toBe('510');
	expect(bareLabelStyle.fontSize).toBe('12px');
	expect(bareLabelStyle.fontWeight).toBe('510');
	expect(codeLabelStyle.color).toBe(bareLabelStyle.color);
	expect(codeLabelStyle.color).not.toBe(dataStyle.color);
	expect(parseFloat(codeLabelStyle.fontSize)).toBeLessThan(parseFloat(dataStyle.fontSize));

	// 2. Duplicate inner label inside a sole-field Section is suppressed (sr-only, no visible row)
	const readsLabel = required(target.querySelector<HTMLElement>('#geom-reads-label'));
	expect(readsLabel.classList.contains('sr-only')).toBe(true);
	expect(readsLabel.getBoundingClientRect().width).toBeLessThanOrEqual(1);

	// 3. StructuredData: compact summary typography, zero top/between gap, equal top/bottom padding,
	//    indentation guide aligned with caret center, and inner content LHS aligned with section label LHS
	const conversions = required(target.querySelector<HTMLElement>('[data-conversions]'));
	const root = required(conversions.querySelector<HTMLElement>('.structured-root'));
	const rootRect = root.getBoundingClientRect();
	const nestedDetails = [
		...conversions.querySelectorAll<HTMLDetailsElement>('details.structured-nested')
	];
	expect(nestedDetails).toHaveLength(3);
	const day = required(nestedDetails[0]);
	const hour = required(nestedDetails[1]);
	const rounding = required(nestedDetails[2]);

	const daySummary = required(day.querySelector<HTMLElement>(':scope > summary'));
	const hourSummary = required(hour.querySelector<HTMLElement>(':scope > summary'));
	const roundingSummary = required(rounding.querySelector<HTMLElement>(':scope > summary'));
	const daySummaryStyle = getComputedStyle(daySummary);
	expect(daySummaryStyle.fontSize).toBe('12px');
	expect(daySummaryStyle.fontWeight).toBe('510');
	expect(daySummaryStyle.color).toBe(codeLabelStyle.color);

	// Zero awkward top gap between outer frame border and first section summary
	const rootBorderTop = parseFloat(getComputedStyle(root).borderTopWidth);
	expect(Math.abs(daySummary.getBoundingClientRect().top - (rootRect.top + rootBorderTop))).toBeLessThanOrEqual(0.5);

	// Zero dark gaps between consecutive sections
	expect(Math.abs(hourSummary.getBoundingClientRect().top - day.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0.5);
	expect(Math.abs(roundingSummary.getBoundingClientRect().top - hour.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0.5);

	// Standardized top and bottom padding on Proration and inside nested sections
	const prorationField = required(
		conversions.querySelector<HTMLElement>('[data-schema-field="conversions.proration"]')
	);
	const prorationStyle = getComputedStyle(prorationField);
	expect(prorationStyle.paddingTop).toBe(prorationStyle.paddingBottom);
	const rootBorderBottom = parseFloat(getComputedStyle(root).borderBottomWidth);
	const prorationTopSpace = prorationField.getBoundingClientRect().top - rounding.getBoundingClientRect().bottom;
	const prorationBottomSpace = rootRect.bottom - rootBorderBottom - prorationField.getBoundingClientRect().bottom;
	expect(Math.abs(prorationTopSpace)).toBeLessThanOrEqual(0.5);
	expect(Math.abs(prorationBottomSpace)).toBeLessThanOrEqual(0.5);

	const daysField = required(
		conversions.querySelector<HTMLElement>('[data-schema-field="conversions.day.days"]')
	);
	expect(getComputedStyle(daysField).paddingTop).toBe(prorationStyle.paddingTop);
	expect(getComputedStyle(daysField).paddingBottom).toBe(prorationStyle.paddingBottom);

	// Indentation guide aligns with caret center, and inner content LHS aligns with section label LHS
	const hourLabelSpan = required(hourSummary.querySelector<HTMLElement>('span'));
	const roundingCaret = required(roundingSummary.querySelector<SVGElement>('svg'));
	const roundingLabelSpan = required(roundingSummary.querySelector<HTMLElement>('span'));
	const roundingBody = required(rounding.querySelector<HTMLElement>(':scope > .structured-section-body'));
	const modeLabel = required(
		conversions.querySelector<HTMLElement>('[data-schema-field="conversions.rounding.mode"] [id$="-label"]')
	);
	const daysLabel = required(
		conversions.querySelector<HTMLElement>('[data-schema-field="conversions.day.days"] [id$="-label"]')
	);
	const dayLabelSpan = required(daySummary.querySelector<HTMLElement>('span'));

	const caretCenterX =
		roundingCaret.getBoundingClientRect().left + roundingCaret.getBoundingClientRect().width / 2;
	const guideCenterX =
		roundingBody.getBoundingClientRect().left +
		parseFloat(getComputedStyle(roundingBody).borderLeftWidth) / 2;
	expect(Math.abs(guideCenterX - caretCenterX)).toBeLessThanOrEqual(0.75);

	expect(Math.abs(modeLabel.getBoundingClientRect().left - hourLabelSpan.getBoundingClientRect().left)).toBeLessThanOrEqual(0.5);
	expect(Math.abs(modeLabel.getBoundingClientRect().left - roundingLabelSpan.getBoundingClientRect().left)).toBeLessThanOrEqual(0.5);
	expect(Math.abs(daysLabel.getBoundingClientRect().left - dayLabelSpan.getBoundingClientRect().left)).toBeLessThanOrEqual(0.5);

	// 2 levels deep: inner caret aligns with outer label, inner guide aligns with inner caret, leaf label aligns with inner label
	const deep = required(target.querySelector<HTMLElement>('[data-deep]'));
	const outer = required(deep.querySelector<HTMLDetailsElement>('details.structured-nested'));
	const inner = required(
		outer.querySelector<HTMLDetailsElement>(':scope > .structured-section-body details.structured-nested')
	);
	const outerLabelSpan = required(outer.querySelector<HTMLElement>(':scope > summary > span'));
	const innerSummary = required(inner.querySelector<HTMLElement>(':scope > summary'));
	const innerCaret = required(innerSummary.querySelector<SVGElement>('svg'));
	const innerLabelSpan = required(innerSummary.querySelector<HTMLElement>('span'));
	const innerBody = required(inner.querySelector<HTMLElement>(':scope > .structured-section-body'));
	const leafLabel = required(
		deep.querySelector<HTMLElement>('[data-schema-field="deep.outer.inner.leaf"] [id$="-label"]')
	);

	expect(Math.abs(innerCaret.getBoundingClientRect().left - outerLabelSpan.getBoundingClientRect().left)).toBeLessThanOrEqual(0.5);
	const innerCaretCenterX =
		innerCaret.getBoundingClientRect().left + innerCaret.getBoundingClientRect().width / 2;
	const innerGuideCenterX =
		innerBody.getBoundingClientRect().left +
		parseFloat(getComputedStyle(innerBody).borderLeftWidth) / 2;
	expect(Math.abs(innerGuideCenterX - innerCaretCenterX)).toBeLessThanOrEqual(0.75);
	expect(Math.abs(leafLabel.getBoundingClientRect().left - innerLabelSpan.getBoundingClientRect().left)).toBeLessThanOrEqual(0.5);
});
