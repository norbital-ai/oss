// A definition's webhook handler (`webhook.handle`): a verified delivery runs the body as the webhook's policies; its acts
// commit and its reply is the provider's response. A bad signature never reaches it; a refusal answers 422.
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { randomBytes } from 'node:crypto';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { credentials } from '../src/engine/integrations/credentials.ts';
import { integration_links } from '../src/engine/integrations/links.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { loopback_tcp_port } from '@norbital-ai/host-api/node';
import { seed_accounts } from './support/accounts.ts';

const PUBLIC = 'https://apex.example/acme';
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { leads: { description: 'A lead', record_label: 'record.name', fields: { name: { kind: 'text' } } } },
	relationships: {},
	exposures: { leads: { outputs: { default: { leads: { fields: 'all' } } }, create: { columns: { leads: ['name'] } } } },
	policies: { inbound: { description: 'Inbound', grants: { leads: { outputs: { default: {} }, create: {} } } } },
	automations: {},
	integrations: {
		crm: {
			description: 'The CRM',
			driver: 'http',
			http: { base_url: 'https://crm.example' },
			credential: { token: { kind: 'text' } },
			webhook: { verify: { scheme: 'bearer', secret: 'token' }, policies: ['inbound'], handle: true }
		}
	},
	teams: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const guestSource = `export default {
	integration_definition: { crm: { bodies: { webhook: function* (request, ctx) {
		if (request.body.name === '') return yield* ctx.refuse('A lead has a name.');
		yield* ctx.act({ 'leads.create': [{ name: request.body.name }] }, { key: request.headers['x-delivery'] });
		return { status: 202, body: { received: request.body.name } };
	} } } }
};`;
const delivery = (token: string, name: string) =>
	new Request(`${PUBLIC}/hooks/integration/hook1`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-delivery': `d-${name}` },
		body: JSON.stringify({ name })
	});

describe('a webhook handler', () => {
	it.live('answers each verified delivery with its own reply, writing as the webhook policies', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					TestWorkspace.layer({ manifest, guest: yield* program(guestSource), host: { public_url: PUBLIC }, secrets_key: Redacted.make(randomBytes(32)) })
				);
				const t = Context.get(context, TestWorkspace);
				yield* seed_accounts(t.db, [{ id: 'hook1', integration: 'crm' }]);
				const store = yield* credentials(t.db, Context.get(context, Secrets)).pipe(Effect.provide(NodeCrypto.layer));
				const opened = yield* store.open('hook1');
				yield* store.write('hook1', opened.epoch, new Map([['credential', { token: 's3cret' }]]));
				const links = yield* integration_links({
					providers: [],
					enter: (effect) => effect.pipe(Effect.provide(context)),
					admit: (effect) => effect.pipe(Effect.provide(context)),
					credentials: store,
					public_url: PUBLIC,
					tcp: loopback_tcp_port,
					log: () => {}
				}).pipe(Effect.provide(NodeCrypto.layer));
				const leads = t.db.rows(Schema.Struct({ name: Schema.String }), { text: 'SELECT name FROM leads', params: [] });

				expect((yield* links.webhook('hook1', delivery('wrong', 'Eve'))).status).toBe(401);
				const answer = yield* links.webhook('hook1', delivery('s3cret', 'Ada'));
				expect(answer.status).toBe(202);
				expect(yield* Effect.promise(() => answer.json())).toEqual({ received: 'Ada' });
				// the provider redelivers: the keyed act commits once
				expect((yield* links.webhook('hook1', delivery('s3cret', 'Ada'))).status).toBe(202);
				expect(yield* leads).toEqual([{ name: 'Ada' }]);
				expect((yield* links.webhook('hook1', delivery('s3cret', ''))).status).toBe(422);
				yield* links.close;
			})
		)
	);
});
