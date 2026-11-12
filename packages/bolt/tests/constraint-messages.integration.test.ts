// A named constraint's `message` is a catalogue key: a violation refuses with its rendered text and key, as an authored
// refusal does; a constraint without one keeps the default text.
import { expect, layer } from '@effect/vitest';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { Writes } from '../src/engine/services.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { split_model } from '../src/decl/model-data.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { admin, manifest as base } from './write-fixture.ts';

const movements = split_model('movements', {
	description: 'Movements',
	record_label: 'record.ref',
	fields: { ref: { kind: 'text' }, days: { kind: 'int' } },
	constraints: {
		one_ref: { unique: ['ref'], message: 'errors.ref_taken' },
		names_its_movement: { check: { days: { ne: 0 } }, message: 'errors.no_movement' },
		bounded: { check: { days: { lte: 1000 } } }
	},
	outputs: { default: { fields: 'all' } },
	create: { columns: { fields: ['ref', 'days'] } }
});
const manifest: EngineManifest = {
	...base,
	messages: {
		'errors.ref_taken': 'This reference is already used.',
		'errors.no_movement': 'A movement must move at least one day.'
	},
	models: { movements: movements.model },
	relationships: {},
	exposures: movements.exposure === undefined ? {} : { movements: movements.exposure },
	policies: {},
	teams: {}
};

layer(TestWorkspace.layer({ manifest }), { excludeTestServices: true })('constraint messages', (it) => {
	it.effect('refuses a check and a unique with their catalogue messages, and the default text without one', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace,
				writes = yield* Writes;
			const write = (ref: string, days: number) => {
				const key = randomUUID(),
					now = t.clock.now();
				return writes
					.act({
						model: 'movements',
						verb: 'create',
						input: [{ ref, days }],
						authority: admin,
						key,
						issuedAt: now,
						invocationId: key,
						mode: { _tag: 'Direct' },
						bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
					})
					.pipe(Effect.map((result) => result.outcome));
			};
			expect(yield* write('a', 1)).toMatchObject({ kind: 'committed' });
			expect(yield* write('b', 0)).toMatchObject({
				kind: 'refused',
				code: 'check',
				key: 'errors.no_movement',
				message: 'A movement must move at least one day.'
			});
			expect(yield* write('a', 2)).toMatchObject({
				kind: 'refused',
				code: 'unique',
				key: 'errors.ref_taken',
				message: 'This reference is already used.',
				field: 'ref'
			});
			const bare = yield* write('c', 1001);
			expect(bare).toMatchObject({ kind: 'refused', code: 'check', message: "the record breaks the rule 'bounded'" });
			expect(bare).not.toHaveProperty('key');
		})
	);
});
