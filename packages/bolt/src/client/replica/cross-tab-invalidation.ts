import { Result, Schema } from 'effect';
import {
	ReplicaSchemaMaintenance,
	type ReplicaSchemaMaintenance as ReplicaSchemaMaintenanceType,
	ReplicaSchemaMaintenanceClear,
	type ReplicaSchemaMaintenanceClear as ReplicaSchemaMaintenanceClearType
} from '@norbital-ai/bolt-protocol';

/** The small browser-message surface used to fan replica invalidation out to sibling tabs. */
export type ReplicaInvalidationChannel = {
	postMessage: (message: unknown) => void;
	close: () => void;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
};

type OpenReplicaInvalidationChannel = (name: string) => ReplicaInvalidationChannel | undefined;

export type ReplicaSchemaControl =
	| Readonly<{ readonly _tag: 'maintenance'; readonly value: ReplicaSchemaMaintenanceType }>
	| Readonly<{
			readonly _tag: 'maintenance-clear';
			readonly value: ReplicaSchemaMaintenanceClearType;
	  }>;

export type ReplicaInvalidationBus = Readonly<{
	announce: (collections: ReadonlyArray<string>) => void;
	announceMaintenance: (maintenance: ReplicaSchemaMaintenanceType) => void;
	announceMaintenanceClear: (clear: ReplicaSchemaMaintenanceClearType) => void;
	close: () => void;
}>;

const InvalidationMessage = Schema.Struct({ collections: Schema.Array(Schema.String) });
const MaintenanceMessage = Schema.Struct({ maintenance: ReplicaSchemaMaintenance });
const MaintenanceClearMessage = Schema.Struct({ maintenanceClear: ReplicaSchemaMaintenanceClear });
const ANY_COLLECTION = '*';

/**
 * Opens the document-local end of a workspace's cross-tab invalidation bus.
 *
 * PGlite's worker clients all proxy into one PostgreSQL session. `LISTEN` therefore cannot be owned
 * by a tab: one client's `UNLISTEN` disables every other client's listener, and a newly elected
 * worker starts with no `LISTEN` state to restore. A BroadcastChannel is owned by the document that
 * owns the live-query registry, so its lifetime and the registry's lifetime are the same.
 *
 * Ordering is still strict. The leader publishes only after the replica write Effect has completed;
 * by the time another tab receives this message, the shared database already contains the rows the
 * refreshed query may read.
 */
export const openReplicaInvalidationBus = (
	scope: string,
	onInvalidate: (collections: ReadonlyArray<string>) => void,
	open: OpenReplicaInvalidationChannel = (name) => {
		if (typeof BroadcastChannel === 'undefined') return undefined;
		const native = new BroadcastChannel(name);
		// Node exposes the browser API in tests. Do not let a document-lifetime channel keep a test
		// process alive; browsers have no `unref`, and need none because the document owns the lifetime.
		const unref = Reflect.get(native, 'unref');
		if (typeof unref === 'function') unref.call(native);
		let listener: ReplicaInvalidationChannel['onmessage'] = null;
		native.onmessage = (event) => listener?.({ data: event.data });
		return {
			postMessage: (message) => native.postMessage(message),
			close: () => native.close(),
			get onmessage() {
				return listener;
			},
			set onmessage(next) {
				listener = next;
			}
		};
	},
	onSchemaControl?: (control: ReplicaSchemaControl) => void
): ReplicaInvalidationBus => {
	// Storage policies and partially implemented browser globals can throw while constructing the
	// channel. Cross-tab freshness may degrade, but the replica itself must still start and serve reads.
	const opened = Result.try(() => open(`bolt-replica-changed:${scope}`));
	const channel = Result.isSuccess(opened) ? opened.success : undefined;
	if (channel === undefined)
		return {
			announce: () => undefined,
			announceMaintenance: () => undefined,
			announceMaintenanceClear: () => undefined,
			close: () => undefined
		};
	channel.onmessage = (event) => {
		const decoded = Schema.decodeUnknownResult(InvalidationMessage)(event.data);
		if (Result.isSuccess(decoded)) {
			onInvalidate(decoded.success.collections);
			return;
		}
		const maintenance = Schema.decodeUnknownResult(MaintenanceMessage)(event.data);
		if (Result.isSuccess(maintenance)) {
			onSchemaControl?.({ _tag: 'maintenance', value: maintenance.success.maintenance });
			return;
		}
		const cleared = Schema.decodeUnknownResult(MaintenanceClearMessage)(event.data);
		if (Result.isSuccess(cleared)) {
			onSchemaControl?.({ _tag: 'maintenance-clear', value: cleared.success.maintenanceClear });
			return;
		}
		onInvalidate([ANY_COLLECTION]);
	};
	return {
		announce: (collections) => {
			if (collections.length > 0)
				void Result.try(() => channel.postMessage({ collections: [...collections] }));
		},
		announceMaintenance: (maintenance) => {
			void Result.try(() => channel.postMessage({ maintenance }));
		},
		announceMaintenanceClear: (maintenanceClear) => {
			void Result.try(() => channel.postMessage({ maintenanceClear }));
		},
		close: () => {
			channel.onmessage = null;
			void Result.try(() => channel.close());
		}
	};
};
