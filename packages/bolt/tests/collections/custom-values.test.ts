import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { collection, field } from '../../src/authoring/workspace-schema.js';
import {
	describeGeneratedColumnWrite,
	describeInvalidCustomValue
} from '../../src/runtime/collections/custom-values.js';

/**
 * A `custom()` column advertises a closed union, but the write path decoded values as arbitrary
 * JSON, so a value of the wrong shape was stored rather than refused. The damage surfaced far from
 * the cause: columns generated from the value read null and a table rendered dashes, with nothing
 * anywhere reporting an error.
 */

// The real `leave_event` arm, reduced to what the failure actually turned on.
//
// `onExcessProperty: 'error'` is load-bearing, not decoration: this was `z.strictObject`, and an
// Effect `Struct` without it *strips* an unknown key and reports success. A misspelled member would
// then be dropped on the way in and the write accepted — the exact silent-store failure this whole
// module exists to stop, reintroduced by a conversion that type-checks.
const leaveEvent = Schema.toStandardSchemaV1(
	Schema.Struct({
		kind: Schema.Literal('TIME_OFF'),
		range: Schema.Struct({
			start: Schema.Struct({ date: Schema.String }),
			end: Schema.Struct({ date: Schema.String })
		}),
		chargeable_days: Schema.NullOr(Schema.Finite)
	}),
	{ parseOptions: { onExcessProperty: 'error' } }
);

const customTypes = {
	leave_event: { name: 'leave_event', description: 'A leave event', schema: leaveEvent }
};

const leaveRequests = collection({
	name: 'leave_requests',
	fields: {
		employment_id: field.string({ required: true }),
		event: { type: 'json', required: true, indexed: false, customType: 'leave_event' }
	}
});

const valid = {
	kind: 'TIME_OFF',
	range: { start: { date: '2026-04-02' }, end: { date: '2026-04-02' } },
	chargeable_days: 1
};

describe('custom value validation', () => {
	it('accepts a value matching its declared schema', () => {
		expect(
			describeInvalidCustomValue(leaveRequests.fields, { event: valid }, customTypes)
		).toBeUndefined();
	});

	it('refuses the flat shape that was silently stored', () => {
		// This is verbatim the seed-bank row that got in: fields at the top level, no `range`.
		const failure = describeInvalidCustomValue(
			leaveRequests.fields,
			{ event: { kind: 'TIME_OFF', from_date: '2026-04-02', to_date: '2026-04-02', days: 1 } },
			customTypes
		);
		expect(failure).toContain('event');
		expect(failure).toContain('leave_event');
	});

	/**
	 * A key the declared schema does not have is a rejection, not something to strip.
	 *
	 * Asserted because it is invisible to the value type: the declaration inferred the same TypeScript
	 * shape before and after this schema stopped being strict, so nothing but a runtime assertion can
	 * tell whether `chargable_days` is refused or quietly discarded.
	 */
	it('refuses a value carrying a member the schema does not declare', () => {
		const failure = describeInvalidCustomValue(
			leaveRequests.fields,
			{ event: { ...valid, chargable_days: 1 } },
			customTypes
		);
		expect(failure).toContain('chargable_days');
	});

	it('names the field and type so the failure points at the cause', () => {
		expect(
			describeInvalidCustomValue(
				leaveRequests.fields,
				{ event: { kind: 'NOT_A_KIND' } },
				customTypes
			)
		).toMatch(/^event is not a valid leave_event: /);
	});

	it('ignores columns a partial update does not set', () => {
		// An update naming only `employment_id` must not be rejected for an `event` it never touched.
		expect(
			describeInvalidCustomValue(leaveRequests.fields, { employment_id: 'e1' }, customTypes)
		).toBeUndefined();
	});

	it('lets the schema decide about null rather than skipping the check', () => {
		expect(
			describeInvalidCustomValue(leaveRequests.fields, { event: null }, customTypes)
		).toContain('event');
	});

	it('leaves ordinary columns alone', () => {
		const people = collection({
			name: 'people',
			fields: { name: field.string({ required: true }) }
		});
		expect(describeInvalidCustomValue(people.fields, { name: 'Ada' }, customTypes)).toBeUndefined();
	});

	it('passes a write through when the workspace carries no custom types', () => {
		// An older artifact predates the map; a write must still be allowed, not universally refused.
		expect(
			describeInvalidCustomValue(leaveRequests.fields, { event: { nonsense: true } }, undefined)
		).toBeUndefined();
	});

	it('passes through a type it cannot resolve rather than guessing', () => {
		expect(
			describeInvalidCustomValue(leaveRequests.fields, { event: { nonsense: true } }, {})
		).toBeUndefined();
		// A definition whose `schema` is a factory needs options this layer does not have.
		expect(
			describeInvalidCustomValue(
				leaveRequests.fields,
				{ event: { nonsense: true } },
				{ leave_event: { schema: () => leaveEvent } }
			)
		).toBeUndefined();
	});
});

/**
 * A generated column cannot be written — the database computes it. `writableValues` drops these
 * before the statement, so an explicit edit setting one returned `{updated: true}` while the value
 * silently stayed as it was: the caller was told the write worked and it had not.
 */
describe('generated column writes', () => {
	const fields = {
		event: { type: 'json', required: true, indexed: false },
		days: {
			type: 'number',
			required: false,
			indexed: false,
			generated: "(event ->> 'chargeable_days')::numeric"
		},
		summary: { type: 'string', required: false, indexed: false, generated: "'Time off'" }
	} as const;

	it('names the generated column an edit tried to set', () => {
		expect(describeGeneratedColumnWrite(fields, { days: 3 })).toMatch(
			/^days is a generated column/
		);
	});

	it('names every one of them, so a caller fixes the write in one pass', () => {
		const message = describeGeneratedColumnWrite(fields, { days: 3, summary: 'x' });
		expect(message).toContain('days');
		expect(message).toContain('summary');
		expect(message).toContain('are generated columns');
	});

	it('allows a write that touches only real columns', () => {
		expect(describeGeneratedColumnWrite(fields, { event: { kind: 'TIME_OFF' } })).toBeUndefined();
	});

	it('ignores a generated column the write does not mention', () => {
		// A partial update names a subset; absent is not the same as set-to-null.
		expect(describeGeneratedColumnWrite(fields, {})).toBeUndefined();
	});
});
