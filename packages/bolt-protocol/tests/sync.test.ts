import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import * as Protocol from '../src/index.js';
import {
	ChangeBatch,
	compactSyncChanges,
	MAX_SYNC_LOADED_KEYS,
	MAX_SYNC_OUTBOUND_FRAME_BYTES,
	SyncAdvanceSubscription,
	SyncAdvanceUpdate,
	SyncApplyFrame,
	SyncChange,
	SyncConnectRequest,
	SyncExtendPrefixRequest,
	SyncPrefixDelta,
	SyncRegistry,
	SyncSubEntry,
	syncApplyFrameByteLength,
	type SyncApplyFrame as SyncApplyFrameType,
	type SyncRegistryConnection,
	type SyncSubEntry as SyncSubEntryType
} from '../src/index.js';

const hash = (value: string): string =>
	[...value].reduce((result, character) => `${result}${character.codePointAt(0)?.toString(16)}`, '');

const connection = (credential: string): SyncRegistryConnection => ({
	credential,
	sink: { writable: () => true, write: () => true },
	subscriptions: new Map(),
	closed: false
});

const prefixEntry = (key: string, count: number, loadedPrefix = count): SyncSubEntryType => {
	const prefixKeys = Array.from({ length: count }, (_, index) => ({
		id: `r${index + 1}`,
		order: [index + 1, `r${index + 1}`]
	}));
	return {
		key,
		// Both viewers describe the same effective plan. Their admitted prefix lengths vary
		// independently; the query's semantic upper bound does not.
		input: { kind: 'findMany', collection: 'steps', limit: 3 },
		planKey: 'release:plan:steps',
		version: 7,
		prefixKeys,
		loadedPrefix,
		prefixBytes: count * 32,
		authorityFingerprint: 'policy-a',
		dependencies: ['steps'],
		routing: []
	};
};

describe('clean-cut live query v2 protocol', () => {
	it('does not export any cursor, digest, held-state, patch, or fallback contract', () => {
		for (const symbol of [
			'SyncAnswer',
			'SyncPageAnswer',
			'SyncCursor',
			'SyncHeldCoordinate',
			'SyncPatch',
			'SyncApplyPatch',
			'SyncPrefixApplyFrame',
			'SyncAdvanceRefusal',
			'MAX_SYNC_HELD_IDS'
		])
			expect(Object.hasOwn(Protocol, symbol)).toBe(false);

		expect(Object.keys(SyncConnectRequest.fields)).toEqual(['queries', 'detached', 'pending']);
		expect(Object.keys(SyncApplyFrame.fields)).toEqual(['updates', 'resets', 'outcomes']);
		for (const field of ['digest', 'digestOnly', 'heldIds', 'heldCoordinates']) {
			expect(Object.hasOwn(SyncSubEntry.fields, field)).toBe(false);
			expect(Object.hasOwn(SyncAdvanceSubscription.fields, field)).toBe(false);
		}
		expect(Object.keys(SyncAdvanceUpdate.fields)).toEqual([
			'subId',
			'fromVersion',
			'toVersion',
			'prefixKeys',
			'prefixBytes',
			'deltas',
			'authorityFingerprint',
			'dependencies'
		]);
	});

	it('requires one complete versioned largest-prefix registration', () => {
		expect(Schema.decodeUnknownResult(SyncSubEntry)(prefixEntry('steps', 2))._tag).toBe('Success');
		const { version: _version, ...withoutVersion } = prefixEntry('steps', 2);
		expect(Schema.decodeUnknownResult(SyncSubEntry)(withoutVersion)._tag).toBe('Failure');
		const { planKey: _planKey, ...withoutPlan } = prefixEntry('steps', 2);
		expect(Schema.decodeUnknownResult(SyncSubEntry)(withoutPlan)._tag).toBe('Failure');
		const { prefixKeys: _prefixKeys, ...withoutPrefix } = prefixEntry('steps', 2);
		expect(Schema.decodeUnknownResult(SyncSubEntry)(withoutPrefix)._tag).toBe('Failure');
	});

	it('admits only findMany and findFirst as live query inputs', () => {
		expect(
			Schema.is(Protocol.SyncQueryInput)({ kind: 'findMany', collection: 'steps', limit: 100 })
		).toBe(true);
		expect(Schema.is(Protocol.SyncQueryInput)({ kind: 'findFirst', collection: 'steps' })).toBe(
			true
		);
		expect(Schema.is(Protocol.SyncQueryInput)({ kind: 'count', collection: 'steps' })).toBe(false);
		expect(
			Schema.is(Protocol.SyncQueryInput)({
				kind: 'findGrouped',
				collection: 'steps',
				group: { by: 'lane' }
			})
		).toBe(false);
	});

	it('carries exact before/after row transitions', () => {
		const batch = {
			changes: [
				{
					collection: 'steps',
					id: 'step-1',
					operation: 'update',
					before: { lane_id: 'todo' },
					after: { lane_id: 'done' },
					mutationId: '11111111-1111-5111-8111-111111111111'
				}
			]
		};
		expect(Schema.is(ChangeBatch)(batch)).toBe(true);
		expect(
			Schema.is(SyncChange)({ collection: 'steps', id: 'step-1', operation: 'insert' })
		).toBe(false);
		expect(
			Schema.is(SyncChange)({
				collection: 'steps',
				id: 'step-1',
				operation: 'update',
				after: { lane_id: 'done' }
			})
		).toBe(false);
	});

	it('compacts repeated transitions to first-before and final-after facts', () => {
		const before = { lane_id: 'todo' };
		const middle = { lane_id: 'doing' };
		const after = { lane_id: 'done' };
		const insert = (values: typeof before): SyncChange => ({
			collection: 'steps',
			id: 'step-1',
			operation: 'insert',
			after: values
		});
		const update = (oldValues: typeof before, newValues: typeof after): SyncChange => ({
			collection: 'steps',
			id: 'step-1',
			operation: 'update',
			before: oldValues,
			after: newValues
		});
		const remove = (values: typeof before): SyncChange => ({
			collection: 'steps',
			id: 'step-1',
			operation: 'delete',
			before: values
		});
		expect(compactSyncChanges([insert(before), update(before, middle), update(middle, after)])).toEqual(
			[insert(after)]
		);
		expect(compactSyncChanges([update(before, middle), remove(middle)])).toEqual([
			remove(before)
		]);
		expect(compactSyncChanges([insert(before), remove(before)])).toEqual([]);
		expect(compactSyncChanges([remove(before), insert(after)])).toEqual([
			update(before, after)
		]);
	});

	it('uses one bounded atomic prefix delta and same-version extension request', () => {
		expect(Schema.is(SyncPrefixDelta)({ removeIds: [], put: [] })).toBe(true);
		expect(
			Schema.is(SyncPrefixDelta)({
				removeIds: [],
				put: [{ id: 'outside', index: MAX_SYNC_LOADED_KEYS, row: { id: 'outside' } }]
			})
		).toBe(false);
		expect(
			Schema.is(SyncExtendPrefixRequest)({
				queryKey: 'steps',
				version: 4,
				loadedPrefix: 100,
				requestedPrefix: MAX_SYNC_LOADED_KEYS
			})
		).toBe(true);
	});

	it('shares one largest prefix while preserving independent viewer lengths', () => {
		const registry = new SyncRegistry<SyncRegistryConnection>({ hash });
		const longer = connection('longer');
		const shorter = connection('shorter');
		registry.attach(longer, [prefixEntry('long', 2)]);
		registry.attach(shorter, [prefixEntry('short', 1)]);

		expect(registry.prefixViewer(shorter, 'short')).toMatchObject({
			version: 7,
			loadedPrefix: 1,
			retainedPrefix: 2
		});
		const extension = registry.extendPrefix(shorter, {
			queryKey: 'short',
			version: 7,
			fromPrefix: 1,
			toPrefix: 3,
			rows: [{ id: 'r2' }, { id: 'r3' }],
			prefixKeys: [
				{ id: 'r1', order: [1, 'r1'] },
				{ id: 'r2', order: [2, 'r2'] },
				{ id: 'r3', order: [3, 'r3'] }
			],
			retainedBytes: 96
		});
		expect(extension).toMatchObject({
			accepted: true,
			version: 7,
			loadedPrefix: 3,
			retainedPrefix: 3
		});
		expect(registry.prefixViewer(longer, 'long')).toMatchObject({
			version: 7,
			loadedPrefix: 2,
			retainedPrefix: 3
		});
	});

	it('requires an empty delta for a shorter viewer on every shared version advance', () => {
		const registry = new SyncRegistry<SyncRegistryConnection>({ hash });
		const longer = connection('longer');
		const shorter = connection('shorter');
		registry.attach(longer, [prefixEntry('long', 2)]);
		registry.attach(shorter, [prefixEntry('short', 1)]);
		const subId = registry.prefixViewer(longer, 'long')?.subId;
		if (subId === undefined) throw new Error('fixture plan was not registered');
		const update = {
			subId,
			fromVersion: 7,
			toVersion: 8,
			prefixKeys: [
				{ id: 'r1', order: [1, 'r1'] },
				{ id: 'r2', order: [2, 'r2'] }
			],
			prefixBytes: 64,
			deltas: [
				{ loadedPrefix: 1, delta: { removeIds: [], put: [] } },
				{
					loadedPrefix: 2,
					delta: { removeIds: [], put: [{ id: 'r2', index: 1, row: { id: 'r2' } }] }
				}
			],
			authorityFingerprint: 'policy-a',
			dependencies: ['steps']
		};
		expect(registry.validateAdvance(update)).toBe(true);
		expect(registry.commitAdvance(update)).toBe(true);
		expect(registry.prefixViewer(shorter, 'short')?.version).toBe(8);
	});

	it('admits an exactly two-mebibyte v2 frame and refuses one additional byte', () => {
		const frame: SyncApplyFrameType = {
			updates: [
				{
					queryKey: 'steps',
					fromVersion: 1,
					toVersion: 2,
					delta: {
						removeIds: [],
						put: [{ id: 'r1', index: 0, row: { id: 'r1', payload: '' } }]
					}
				}
			],
			resets: [],
			outcomes: []
		};
		const emptyBytes = syncApplyFrameByteLength(frame);
		const exactPayload = 'x'.repeat(MAX_SYNC_OUTBOUND_FRAME_BYTES - emptyBytes);
		const exact = {
			...frame,
			updates: [
				{
					...frame.updates[0]!,
					delta: {
						removeIds: [],
						put: [{ id: 'r1', index: 0, row: { id: 'r1', payload: exactPayload } }]
					}
				}
			]
		} satisfies SyncApplyFrameType;
		const registry = new SyncRegistry<SyncRegistryConnection>({ hash });
		expect(syncApplyFrameByteLength(exact)).toBe(MAX_SYNC_OUTBOUND_FRAME_BYTES);
		expect(registry.frameFits(exact)).toBe(true);
		const over = {
			...exact,
			updates: [
				{
					...exact.updates[0]!,
					delta: {
						removeIds: [],
						put: [
							{ id: 'r1', index: 0, row: { id: 'r1', payload: `${exactPayload}x` } }
						]
					}
				}
			]
		} satisfies SyncApplyFrameType;
		expect(syncApplyFrameByteLength(over)).toBe(MAX_SYNC_OUTBOUND_FRAME_BYTES + 1);
		expect(registry.frameFits(over)).toBe(false);
	});
});
