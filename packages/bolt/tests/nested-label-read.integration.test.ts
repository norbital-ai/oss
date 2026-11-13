// A ref layer to a model whose label crosses a relation carries the engine's `$label`; the page client's decoder
// for that read (the real `read_catalog` and `read_answer` with `readValue`) accepts exactly what the host answers.
import { expect, layer } from '@effect/vitest';
import { Effect, Result } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { read_catalog } from '../src/engine/access/exposure.ts';
import { readValue } from '../src/page/read-value.ts';
import { read_answer } from '../src/protocol/read-answer.ts';
import { dynamic_read } from '../src/protocol/read-request.ts';
import { TestWorkspace, type WorkspaceServices } from '../../bolt-cli/src/test/index.ts';
import { q_reply, route_fixture } from './support/route-fixture.ts';

const P = '0199a000-0000-4000-8000-0000000000a1',
	E = '0199a000-0000-4000-8000-0000000000b1',
	L = '0199a000-0000-4000-8000-0000000000c1';
const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		person: { description: 'A person', record_label: 'record.name', fields: { name: { kind: 'text' } } },
		// the label crosses a relation, so it is computed per read at every level
		contract: { description: 'A contract', record_label: 'record.person.name', fields: { title: { kind: 'text' } } },
		loan: { description: 'A loan', record_label: 'record.purpose', fields: { purpose: { kind: 'text' } } }
	},
	relationships: {
		'contract.person': { to: 'person', inverse: 'contracts' },
		'loan.contract': { to: 'contract', inverse: 'loans' }
	},
	exposures: {
		person: { outputs: { default: { person: { fields: 'all' } } } },
		contract: { outputs: { default: { contract: { fields: 'all' }, 'contract.person': { fields: 'all' } } } },
		loan: {
			outputs: {
				default: { loan: { fields: 'all' }, 'loan.contract': { fields: 'all' }, 'loan.contract.person': { fields: 'all' } }
			}
		}
	},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};
const seed = {
	person: [{ id: P, name: 'Ada' }],
	contract: [{ id: E, title: 'Engineer', person: P }],
	loan: [{ id: L, purpose: 'Car', contract: E }]
};

layer(TestWorkspace.layer({ manifest, seed }))('nested labels on the page client', (it) => {
	it.effect('a filtered child read with a ref layer decodes the label the engine resolves', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const route = yield* route_fixture(yield* Effect.context<TestWorkspace | WorkspaceServices>());
			const admin = yield* t.as(t.admin);
			const request = dynamic_read({
				loan: { where: { contract: { eq: E } }, fields: ['purpose', 'contract'], contract: { fields: ['title'] } }
			});
			const reply = yield* q_reply(route, admin.authority, { reads: [{ m: 'query', a: [request] }] });
			const catalog = yield* read_catalog(manifest, admin.authority);
			const decoded = readValue(() => read_answer(catalog, request), reply.answers[0]);
			expect(Result.isSuccess(decoded) ? decoded.success : decoded.failure.message).toMatchObject({
				loan: { rows: [{ id: L, purpose: 'Car', contract: { id: E, title: 'Engineer', $label: 'Ada' } }] }
			});
		})
	);
});
