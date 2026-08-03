export type CollectionHookParams =
	| {
			type: 'create';
			payload: Record<string, unknown>;
			scope: {
				incoming_record: Record<string, unknown>;
				requestor: Record<string, unknown>;
				organization: { norbital_id: string; name: string };
				requestor_subordinates: Record<string, unknown>[];
			};
			collection: { id: string; name: string };
	  }
	| {
			type: 'update';
			payload: Record<string, unknown>;
			scope: {
				incoming_record: Record<string, unknown>;
				original_record: Record<string, unknown>;
				requestor: Record<string, unknown>;
				organization: { norbital_id: string; name: string };
				requestor_subordinates: Record<string, unknown>[];
			};
			collection: { id: string; name: string };
	  }
	| {
			type: 'delete';
			scope: {
				original_record: Record<string, unknown>;
				requestor: Record<string, unknown>;
				organization: { norbital_id: string; name: string };
				requestor_subordinates: Record<string, unknown>[];
			};
			collection: { id: string; name: string };
	  }
	| {
			type: 'view';
			scope: {
				record: Record<string, unknown>;
				requestor: Record<string, unknown>;
				organization: { norbital_id: string; name: string };
				requestor_subordinates: Record<string, unknown>[];
			};
			collection: { id: string; name: string };
			approval_request?: Record<string, unknown>;
			event?: unknown;
	  };

export type CollectionHookReturn = Promise<Record<string, unknown>>;
