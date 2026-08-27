import { describe, expect, it } from 'vitest';
import { describeCause } from '../../src/runtime/workspace.js';

/**
 * A schema failure has to say which value was wrong.
 *
 * Effect's schema errors carry the generic message "Schema validation failed" and put the whole
 * story in `issues`. Preferring the message meant a settle-phase refusal reached the operator as
 * three words: a payroll that computed 290 payslips and then refused to persist them reported
 * exactly as much as a refusal for any other reason, with the path, the expectation and the actual
 * value all discarded.
 */
describe('describeCause on a schema failure', () => {
	const schemaError = {
		_tag: 'SchemaError',
		message: 'Schema validation failed',
		issues: [
			{ path: ['component', 'kind'], message: 'Expected one of SCHEDULE | FORMULA, got "BONUS"' },
			{ path: ['amount'], message: 'Expected number, got null' }
		]
	};

	it('names the offending path and expectation', () => {
		const described = describeCause(schemaError);
		expect(described).toContain('component.kind');
		expect(described).toContain('BONUS');
		expect(described).toContain('amount');
	});

	it('keeps the headline rather than replacing it', () => {
		expect(describeCause(schemaError)).toContain('Schema validation failed');
	});

	it('bounds how much it renders and says how much it left out', () => {
		const many = {
			_tag: 'SchemaError',
			message: 'Schema validation failed',
			issues: Array.from({ length: 9 }, (_unused, index) => ({
				path: [`field${index}`],
				message: 'bad'
			}))
		};
		const described = describeCause(many);
		expect(described).toContain('+6 more');
		expect(described).toContain('field0');
		expect(described).not.toContain('field8');
	});

	it('still reports an ordinary error unchanged', () => {
		expect(describeCause(new Error('a plain failure'))).toBe('a plain failure');
	});
});

/**
 * Effect v4 renamed the field, and getting it wrong is silent.
 *
 * A v4 `SchemaError` carries `issue` — singular — with the list nested inside it. Reading only
 * `issues` meant the branch never fired and the generic sentence survived, which is exactly the
 * failure it was written to prevent.
 */
describe('describeCause across Effect schema-error shapes', () => {
	it('reads the v4 nested issue', () => {
		const v4 = {
			_tag: 'SchemaError',
			message: 'Schema validation failed',
			issue: { issues: [{ path: ['component'], message: 'Expected a declared arm' }] }
		};
		expect(describeCause(v4)).toContain('component');
		expect(describeCause(v4)).toContain('Expected a declared arm');
	});

	it('reads a bare v4 issue with no nested list', () => {
		const bare = {
			_tag: 'SchemaError',
			message: 'Schema validation failed',
			issue: { path: ['amount'], message: 'Expected number' }
		};
		expect(describeCause(bare)).toContain('amount');
	});
});

/**
 * The masked construction failure names its own site.
 *
 * `new SomeTaggedError({ message: '' })` against a `NonEmptyString` field throws a plain `Error`
 * with no `_tag` and no properties, so the failure it was wrapping is already gone. Its stack is
 * the only surviving evidence, and the first non-Effect frame is the construction site.
 */
describe('describeCause on a tagged-error construction failure', () => {
	it('names the constructing frame and says the cause was lost', () => {
		const masked = new Error('Schema validation failed');
		masked.stack = [
			'Error: Schema validation failed',
			'    at Schema.make (/x/node_modules/.pnpm/effect@4/node_modules/effect/dist/SchemaParser.js:114:11)',
			'    at new out (/x/node_modules/.pnpm/effect@4/node_modules/effect/dist/Schema.js:9094:78)',
			'    at settleDeclarativeGraph (/x/packages/bolt/src/runtime/collections/collections.ts:4356:11)'
		].join('\n');
		const described = describeCause(masked);
		expect(described).toContain('collections.ts:4356');
		expect(described).toContain('cause was lost');
		expect(described).not.toContain('SchemaParser.js');
	});

	it('skips Effect frames from a compiled tenant bundle too', () => {
		const bundled = new Error('Schema validation failed');
		bundled.stack = [
			'Error: Schema validation failed',
			'    at Schema.make (norbital://abc/code/dependency-effect-dcb57642.mjs:8075:9)',
			'    at new out (norbital://abc/code/dependency-effect-dcb57642.mjs:9094:78)',
			'    at persistPayslips (norbital://abc/code/tenant.mjs:412:19)'
		].join('\n');
		const described = describeCause(bundled);
		expect(described).toContain('tenant.mjs:412');
		expect(described).not.toContain('dependency-effect');
	});

	it('reports the caller, not the failing constructor', () => {
		const masked = new Error('Schema validation failed');
		masked.stack = [
			'Error: Schema validation failed',
			'    at Schema.make (/x/node_modules/effect/dist/SchemaParser.js:114:11)',
			'    at new AuthoredRefusal (/x/packages/bolt/src/authoring/refusal.ts:108:9)',
			'    at settleAfterHook (/x/packages/bolt/src/runtime/collections/collections.ts:4356:11)'
		].join('\n');
		const described = describeCause(masked);
		expect(described).toContain('collections.ts:4356');
		expect(described).not.toContain('new AuthoredRefusal');
	});

	it('degrades honestly when there is no usable frame', () => {
		const bare = new Error('Schema validation failed');
		bare.stack = 'Error: Schema validation failed';
		expect(describeCause(bare)).toContain('cause was lost');
	});
});
