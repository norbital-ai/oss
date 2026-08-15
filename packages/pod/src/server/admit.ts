import { currentPodCallOrNull, withPodCallField } from './pod-call.js';

/**
 * Headers the host may still strip at the HTTP edge. The guest never reads these.
 *
 * Clients cannot set them: the HTTP adapter strips them. Admit is an argument to `dispatch`.
 */
export const ADMIT_TIMEOUT_HEADER = 'x-norbital-timeout-ms';
export const ADMIT_DEADLINE_HEADER = 'x-norbital-deadline-at';

/**
 * One admitted function: the host's timeout and the instant the clock started.
 *
 * `timeoutMs` is host policy. Core uses 2_000. The reference self-host reads `pod.host.ts`.
 * One admit is one shot: the payload finishes in `timeoutMs` or the function fails.
 */
export type PodAdmit = {
	readonly timeoutMs: number;
	readonly deadlineAt: number;
};

let testAdmit: PodAdmit | null | undefined;

/**
 * Milliseconds left on the current admit, or `null` when no host admitted this call.
 *
 * A missing admit means an in-process test or a path that is not a billed function. Bulk
 * writers then take the whole caller batch instead of inventing a Pod-side 2_000 ms contract.
 */
function activeAdmit(): PodAdmit | null {
	return currentPodCallOrNull()?.admit ?? testAdmit ?? null;
}

export function remainingMs(): number | null {
	const admit = activeAdmit();
	if (!admit) return null;
	return Math.max(0, admit.deadlineAt - Date.now());
}

/** The admit the host attached to this call, if any. */
export function currentAdmit(): PodAdmit | null {
	return activeAdmit();
}

/**
 * Parse the host's admit headers. Returns `null` when either value is missing or not a
 * positive integer — the guest then runs without a visible budget rather than guessing one.
 *
 * HTTP host edge only. The isolate bundle must not call this.
 */
export function parseAdmitHeaders(headers: Headers): PodAdmit | null {
	const timeoutMs = positiveInteger(headers.get(ADMIT_TIMEOUT_HEADER));
	const deadlineAt = positiveInteger(headers.get(ADMIT_DEADLINE_HEADER));
	if (timeoutMs == null || deadlineAt == null) return null;
	return { timeoutMs, deadlineAt };
}

/** Headers a host attaches so an HTTP edge can recover a budget it already started. */
export function admitHeaders(admit: PodAdmit): Record<string, string> {
	return {
		[ADMIT_TIMEOUT_HEADER]: String(admit.timeoutMs),
		[ADMIT_DEADLINE_HEADER]: String(admit.deadlineAt)
	};
}

/**
 * Build an admit from a host timeout. The clock starts now, matching Core's
 * `#admitInvocation` (queue and boot happen before this).
 */
export function startAdmit(timeoutMs: number): PodAdmit {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
		throw new Error('Host timeoutMs must be a positive integer');
	}
	return { timeoutMs, deadlineAt: Date.now() + timeoutMs };
}

/** Parse admit headers from a plain record (no Fetch Request). HTTP host edge only. */
export function parseAdmitHeaderRecord(headers: Record<string, string>): PodAdmit | null {
	const get = (name: string) => {
		const direct = headers[name];
		if (direct != null) return direct;
		const lower = name.toLowerCase();
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === lower) return value;
		}
		return null;
	};
	const timeoutMs = positiveInteger(get(ADMIT_TIMEOUT_HEADER));
	const deadlineAt = positiveInteger(get(ADMIT_DEADLINE_HEADER));
	if (timeoutMs == null || deadlineAt == null) return null;
	return { timeoutMs, deadlineAt };
}

/** Run `fn` under the host's admit so `remainingMs()` is visible to guest code. */
export function runWithAdmit<T>(admit: PodAdmit | null, fn: () => T): T {
	if (currentPodCallOrNull()) {
		return withPodCallField('admit', admit, fn) as T;
	}
	const previous = testAdmit;
	testAdmit = admit;
	try {
		const result = fn();
		if (result && typeof Reflect.get(Object(result), 'then') === 'function') {
			return Promise.resolve(result).finally(() => {
				testAdmit = previous;
			}) as T;
		}
		testAdmit = previous;
		return result;
	} catch (error) {
		testAdmit = previous;
		throw error;
	}
}

function positiveInteger(value: string | null): number | null {
	if (value == null || value.trim() === '') return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return null;
	return parsed;
}
