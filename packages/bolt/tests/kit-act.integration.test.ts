import { actReply, routeFixture } from './support/route-fixture.ts';
import { Context, Effect, Layer } from 'effect';
// The test kit's `As.act` routes a model callable as `/__bolt/act` does (`dispatchAct`): `<c>.erase` is the engine's
// generated erase (rule 38e), never a lookup of an action named `erase`.
import { describe, expect, it } from '@effect/vitest';
import type { ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../src/test/index.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { docs: { description: 'A doc', label: 'title', fields: { title: { kind: 'text' } } } },
	relationships: {},
	exposures: {
		docs: { read: { docs: { fields: 'all' } }, create: { columns: { docs: ['title'] } } }
	},
	policies: { p: { description: 'P', grants: { docs: { read: true, create: true } } } },
	automations: {},
	integrations: {},
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

const created = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return present(o.records[0]).id;
};

describe('t.as(x).act routes a generated verb as /__bolt/act does', () => {
	it.live(
		"'docs.erase' is the engine's erase: a member's is refused, an administrator's removes the row",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
					const t = Context.get(context, TestWorkspace),
						route = yield* routeFixture(context);
					const id = created(
						(yield* actReply(route, t.as(t.admin).authority, {
							callable: 'docs.create',
							input: [{ title: 'desk' }],
							issuedAt: t.clock.now()
						})).outcome
					);
					expect(
						(yield* actReply(route, t.as(t.member(['p'])).authority, {
							callable: 'docs.erase',
							input: { target: id },
							issuedAt: t.clock.now()
						})).outcome
					).toMatchObject({ kind: 'refused', code: 'forbidden' });
					expect(
						(yield* actReply(route, t.as(t.admin).authority, {
							callable: 'docs.erase',
							input: { target: id },
							issuedAt: t.clock.now()
						})).outcome
					).toMatchObject({ kind: 'committed' });
					expect(
						present(
							(yield* t.db.read([{ text: 'SELECT count(*)::int AS n FROM docs', params: [] }]))[0]
						).rows
					).toEqual([{ n: 0 }]);
				})
			)
	);
});
