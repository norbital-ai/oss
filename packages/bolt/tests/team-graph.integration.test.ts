// Teams are `sys_team` rows an administrator edits: a member holds what their team's row names on the next request,
// a team never sits under itself, and a team a member holds stays.
import { expect } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { layer } from '../../bolt-cli/src/test/effect.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { Json } from '../src/decl/values.ts';
import { manifest } from './catalogue-fixture.ts';

layer(TestWorkspace.layer({ manifest }))('the team graph', (it) => {
	/** An administrator's act, as a page sends it. */
	const act = Effect.fnUntraced(function* (input: Readonly<Record<string, Json>>) {
		const t = yield* TestWorkspace;
		return yield* (yield* t.as(t.admin)).act(input);
	});
	const team = Effect.fnUntraced(function* (name: string, parent: string | null = null) {
		const [record] = (yield* act({ 'sys_team.create': [{ name, parent }] })).records;
		if (record === undefined) throw new Error('expected one team');
		return record;
	});
	const update = (of: { readonly id: string; readonly revision: number }, set: Json) =>
		act({ 'sys_team.update': [{ target: { id: of.id, revision: of.revision }, set }] });

	it.effect("a change to a team's policies is its members' on the next request", () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace,
				desk = yield* team('Desk');
			yield* act({ 'products.create': [{ external_code: 'p-1', name: 'Bolt' }] });
			yield* t.as(t.member([], { email: 'desk@example.test', teams: [desk.id] }));
			const read = Effect.gen(function* () {
				const member = yield* t.as(yield* t.sign_in('desk@example.test'));
				return yield* Effect.exit(member.query({ products: {} }));
			});
			expect((yield* read)._tag).toBe('Failure');
			yield* update(desk, { policies: ['viewer'] });
			expect((yield* t.sign_in('desk@example.test')).policies).toEqual(['viewer']);
			expect((yield* read)._tag).toBe('Success');
		})
	);

	it.effect('a staff member reads the teams that hold a policy, as a flow names its approvers', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace,
				finance = yield* team('Finance');
			yield* team('Bystanders');
			yield* update(finance, { policies: ['viewer'] });
			yield* t.as(t.member([], { email: 'asker@example.test', teams: [finance.id] }));
			const asker = yield* t.as(yield* t.sign_in('asker@example.test'));
			const answer = yield* asker.query({
				sys_team: { where: { policies: { has: 'viewer' } }, fields: ['name'] }
			});
			const { sys_team } = yield* Schema.decodeUnknownEffect(
				Schema.Struct({
					sys_team: Schema.Struct({ rows: Schema.Array(Schema.Struct({ name: Schema.String })) })
				})
			)(answer);
			const names = sys_team.rows.map((row) => row.name);
			expect(names).toContain('Finance');
			expect(names).not.toContain('Bystanders');
		})
	);

	it.effect('a parent chain that returns to its team is refused', () =>
		Effect.gen(function* () {
			const region = yield* team('Region'),
				depot = yield* team('Depot', region.id);
			for (const parent of [depot.id, region.id])
				expect(String((yield* Effect.flip(update(region, { parent }))).message)).toContain(
					'A team cannot sit under itself.'
				);
		})
	);

	it.effect('a team a member holds cannot be deleted', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace,
				crew = yield* team('Crew');
			yield* t.as(t.member([], { teams: [crew.id] }));
			const remove = act({ 'sys_team.delete': [{ target: { id: crew.id, revision: crew.revision } }] });
			expect((yield* Effect.exit(remove))._tag).toBe('Failure');
			const [kept] = yield* t.db.read([
				{ text: 'SELECT id FROM sys_team WHERE id = $1', params: [crew.id] }
			]);
			expect(kept?.rows).toEqual([{ id: crew.id }]);
		})
	);
});
