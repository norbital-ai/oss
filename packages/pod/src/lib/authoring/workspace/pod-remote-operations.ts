import type { AnyDBQueryConfig } from 'drizzle-orm';
import type { TApprovalRequestStepAction } from '@norbital-ai/platform-utils/system/types';
import type { TGeolocation } from '$lib/authoring/builtin/custom_types.js';

/** Pod-owned operations used by tenant collection UI. These are intentionally not part of workspace `api`. */
export type PodRemoteOperations = {
	readonly exportPipeline: (input: {
		readonly collection_name: string;
		readonly record_ids?: string[];
		readonly with?: AnyDBQueryConfig['with'];
		readonly where?: AnyDBQueryConfig['where'];
		readonly limit?: number;
		readonly bypass_secret?: string;
	}) => Promise<unknown>;
	readonly importPipeline: (input: {
		readonly collection_name: string;
		readonly import_data: unknown;
		readonly bypass_secret?: string;
	}) => Promise<unknown>;
	readonly autocompleteGeolocation: (input: string) => Promise<TGeolocation[]>;
	/**
	 * Send a message to the workspace agent.
	 *
	 * Returns the run so a follow-up can continue the same conversation, and the session so the caller
	 * can read the transcript — which arrives as ordinary synced `chat_message` rows rather than through
	 * a stream of its own.
	 */
	readonly agentChat: (input: { readonly message: string; readonly runId?: string }) => Promise<{
		readonly runId: string;
		readonly chatId: string | null;
		readonly text: string;
	}>;
	/** Begin a live turn and return before provider tokens are produced. */
	readonly agentChatStart: (input: {
		readonly message: string;
		readonly runId?: string;
		readonly model?: string;
	}) => Promise<{
		readonly runId: string;
		readonly chatId: string;
		readonly accepted: true;
	}>;
	/**
	 * What the host will run, and which model it picks when a turn names none.
	 *
	 * `null` from a host that offers no choice — which is not the same as an empty catalog, and is why
	 * a picker is absent rather than empty on such a host.
	 */
	readonly agentModels: () => Promise<{
		readonly defaultModel: string;
		readonly options: readonly {
			readonly id: string;
			readonly label: string;
			readonly canonicalSlug: string;
		}[];
	} | null>;
	readonly renderStaticMap: (input: {
		readonly markers: readonly {
			readonly latitude: number;
			readonly longitude: number;
			readonly label?: string;
			readonly tone?: 'default' | 'alert';
		}[];
	}) => Promise<{
		readonly mimeType: 'image/png' | 'image/jpeg';
		readonly dataBase64: string;
		readonly markerPositions?: readonly {
			readonly x: number;
			readonly y: number;
		}[];
	}>;
	readonly processApprovalRequestAction?: (input: {
		readonly approval_request_id: string;
		readonly action: TApprovalRequestStepAction;
		readonly comments: string | null;
		readonly isSupercede: boolean;
	}) => Promise<unknown>;
	readonly withdrawApprovalRequest?: (input: {
		readonly approval_request_id: string;
	}) => Promise<unknown>;
};
