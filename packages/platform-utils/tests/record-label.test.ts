import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// `context.ts` imports its neighbours by their emitted `.js` names, which is right for the build
// and unresolvable for `node --test` running the sources. Point those at the `.ts` beside them.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
			const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
			if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
		}
		return nextResolve(specifier, context);
	}
});

const { resolveRecordDisplayLabel, resolveRecordLabel } =
	await import('../src/manifest/context.ts');

/**
 * What a record is *called*, and the one thing that must never answer that question: its uuid.
 *
 * The schema builder compiles `recordLabel: [a, b]` into the CEL expression
 * `scope.record.a + ' · ' + scope.record.b`. CEL has no `+` overload but string+string, and — as
 * this suite's subject was written to prove — no `string()` overload for a timestamp or for null
 * either, so wrapping the terms does not save it. Any label naming a date, a number, a boolean or
 * an empty field therefore threw. The throw was swallowed, the label came back null, and the
 * fallback then joined every scalar column, which is how raw foreign-key uuids ended up as record
 * panel titles.
 *
 * Both halves are asserted: the terms have to survive their own types, and the fallback has to be
 * incapable of emitting an identifier even when it has nothing else to say.
 */

type Metadata = Parameters<typeof resolveRecordDisplayLabel>[0];

function collection(recordLabel: string | null = null): Metadata {
	return { collection_name: 'roster_entries', record_label: recordLabel } as Metadata;
}

const TWO_FIELD_LABEL = `scope.record.employee_name + ' · ' + scope.record.work_date`;

describe('record labels', () => {
	it('renders a date term instead of throwing the whole label away', () => {
		const label = resolveRecordLabel(TWO_FIELD_LABEL, {
			employee_name: 'Ada Lovelace',
			work_date: new Date('2026-08-05T00:00:00.000Z')
		});
		assert.equal(label, 'Ada Lovelace · 2026-08-05');
	});

	it('renders number and boolean terms', () => {
		const label = resolveRecordLabel(`scope.record.hours + ' · ' + scope.record.approved`, {
			hours: 7.5,
			approved: true
		});
		assert.equal(label, '7.5 · true');
	});

	it('degrades to the non-null terms rather than losing the whole label', () => {
		const label = resolveRecordLabel(TWO_FIELD_LABEL, {
			employee_name: 'Ada Lovelace',
			work_date: null
		});
		assert.equal(label, 'Ada Lovelace');
	});

	/**
	 * `job_assignments` is `['status', 'dispatched_at']` — a nullable enum *and* a timestamp — so it
	 * fails on both axes at once, and neither coercion nor the null guard rescues it alone. Asserted
	 * separately from the two single-axis cases because a fix could pass both of those and still
	 * lose this one.
	 */
	it('handles a label that is both nullable and non-string', () => {
		const label = `scope.record.status + ' · ' + scope.record.dispatched_at`;
		assert.equal(
			resolveRecordLabel(label, {
				status: 'DISPATCHED',
				dispatched_at: new Date('2026-08-05T14:30:00.000Z')
			}),
			'DISPATCHED · 2026-08-05 14:30'
		);
		assert.equal(
			resolveRecordLabel(label, {
				status: null,
				dispatched_at: new Date('2026-08-05T14:30:00.000Z')
			}),
			'2026-08-05 14:30'
		);
		assert.equal(resolveRecordLabel(label, { status: 'PENDING', dispatched_at: null }), 'PENDING');
	});

	it('resolves a single-field label whose value is not a string', () => {
		const label = resolveRecordLabel(`scope.record.work_date`, {
			work_date: new Date('2026-08-05T09:30:00.000Z')
		});
		assert.equal(label, '2026-08-05 09:30');
	});

	it('returns null only when no term has anything to contribute', () => {
		assert.equal(
			resolveRecordLabel(TWO_FIELD_LABEL, { employee_name: null, work_date: null }),
			null
		);
		assert.equal(resolveRecordLabel(null, {}), null);
	});

	it('leaves an ordinary string label exactly as it was', () => {
		assert.equal(resolveRecordLabel(`scope.record.name`, { name: 'Payroll run' }), 'Payroll run');
	});

	/**
	 * A label naming a `custom()` JSONB column cannot be rescued — an object is not a title, however
	 * it is coerced. What matters is that failing to build one degrades to a placeholder rather than
	 * to the scan that put uuids on screen, and that the blob itself is never printed as the name,
	 * whether it arrives as an object or as its own serialization after a JSONB round trip.
	 */
	it('degrades honestly when the label names a JSON column', () => {
		assert.equal(
			resolveRecordLabel(`scope.record.selector`, { selector: { authority: 'EPF', tier: 2 } }),
			null
		);
		assert.equal(
			resolveRecordLabel(`scope.record.selector`, { selector: '{"authority":"EPF","tier":2}' }),
			null
		);
		const resolved = resolveRecordDisplayLabel(
			collection(`scope.record.selector`),
			{
				norbital_id: '0198c4f2-1b3a-7c8d-9e0f-1a2b3c4d5e6f',
				selector: { authority: 'EPF' },
				jurisdiction_id: '0198c4f2-1b3a-7c8d-9e0f-cccccccccccc'
			},
			{
				selector: { dataType: 'custom', notNull: true },
				jurisdiction_id: { dataType: 'uuid', notNull: true }
			}
		);
		assert.equal(resolved.text, 'Untitled roster entries');
		assert.equal(resolved.isFallback, true);
	});

	it('does not mistake ordinary prose for a JSON blob', () => {
		assert.equal(
			resolveRecordLabel(`scope.record.note`, { note: '[Urgent] review before Friday' }),
			'[Urgent] review before Friday'
		);
	});

	it('never falls back to a uuid, and says what kind of record it is', () => {
		const resolved = resolveRecordDisplayLabel(
			collection(),
			{
				norbital_id: '0198c4f2-1b3a-7c8d-9e0f-1a2b3c4d5e6f',
				employment_id: '0198c4f2-1b3a-7c8d-9e0f-aaaaaaaaaaaa',
				leave_type_id: '0198c4f2-1b3a-7c8d-9e0f-bbbbbbbbbbbb'
			},
			{
				employment_id: { dataType: 'uuid', notNull: true },
				leave_type_id: { dataType: 'uuid', notNull: true }
			}
		);
		assert.equal(resolved.text, 'Untitled roster entries');
		assert.equal(resolved.isFallback, true);
	});

	it('still uses the real scalar columns when there are any worth reading', () => {
		const resolved = resolveRecordDisplayLabel(
			collection(),
			{
				norbital_id: '0198c4f2-1b3a-7c8d-9e0f-1a2b3c4d5e6f',
				employment_id: '0198c4f2-1b3a-7c8d-9e0f-aaaaaaaaaaaa',
				shift: 'Night'
			},
			{
				employment_id: { dataType: 'uuid', notNull: true },
				shift: { dataType: 'text', notNull: true }
			}
		);
		assert.equal(resolved.text, 'Night');
		assert.equal(resolved.isFallback, false);
	});

	it('prefers the configured label over the column scan', () => {
		const resolved = resolveRecordDisplayLabel(
			collection(TWO_FIELD_LABEL),
			{ employee_name: 'Ada Lovelace', work_date: new Date('2026-08-05T00:00:00.000Z') },
			{ employee_name: { dataType: 'text', notNull: true } }
		);
		assert.equal(resolved.text, 'Ada Lovelace · 2026-08-05');
		assert.equal(resolved.isFallback, false);
	});
});
