import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { Authority } from '../src/authority.ts';
import { InstanceStatus } from '../src/integrations.ts';

// What a release's engine answers, whole: a host decodes it into the parts it reads and drops the rest.
const engineAuthority = {
	key: 'k',
	actor: {
		kind: 'member',
		id: 'u1',
		email: 'a@example.test',
		phone: null,
		external: false,
		teams: ['ops'],
		team_path: ['ops'],
		admin: true,
		party: { model: 'person', id: 'p1' }
	},
	admin: true,
	policies: ['staff'],
	agent: { conversation: 'c1' },
	run: { depth: 1, holder: { actor: { kind: 'system', run: 'r1' }, policies: [], admin: false } },
	models: {
		order: {
			read: { default: { order: [{ policy: 'staff', where: { t: 'const', value: true } }] } },
			create: [],
			update: [],
			delete: [],
			moves: {}
		}
	},
	automations: [],
	capabilities: { apps: [], syncs: [], tools: [], mcp: [] },
	limits: [],
	teamTree: [],
	scopes: {}
};

describe('a host decodes the narrow contract from a release’s full answer', () => {
	it('keeps the authority a host reads and drops the engine’s grants', () => {
		expect(Schema.decodeUnknownSync(Authority)(engineAuthority)).toEqual({
			actor: {
				kind: 'member',
				id: 'u1',
				email: 'a@example.test',
				phone: null,
				external: false,
				admin: true
			},
			admin: true,
			agent: { conversation: 'c1' },
			models: {
				order: {
					read: { default: { order: [{ policy: 'staff', where: { t: 'const', value: true } }] } }
				}
			}
		});
	});

	it('decodes a system run’s actor without its cause', () => {
		const actor = { kind: 'system', run: 'r1', by: { automation: 'nightly' } };
		expect(Schema.decodeUnknownSync(Authority)({ ...engineAuthority, actor }).actor).toEqual({
			kind: 'system',
			run: 'r1'
		});
	});

	it('decodes an instance status with its optional conversation', () => {
		const status = {
			state: 'connected',
			account: 'desk@example.test',
			instance: 'desk',
			integration: 'email',
			driver: 'email',
			conversation: true,
			stored: true,
			providers: [{ id: 'imap', label: 'IMAP', setup: { kind: 'form', steps: [] } }]
		};
		expect(Schema.decodeUnknownSync(InstanceStatus)(status).conversation).toBe(true);
		const { conversation: _, ...older } = status;
		expect(Schema.decodeUnknownSync(InstanceStatus)(older)).not.toHaveProperty('conversation');
	});
});
