/** Minimal inbound request view for guest dispatch — not the Fetch Request ABI. */
export type CallRequest = {
	readonly url: string;
	readonly method: string;
	readonly headers: { get(name: string): string | null };
	json(): Promise<unknown>;
	text(): Promise<string>;
};

export type CallRequestInput = {
	readonly method: string;
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly bodyText: string | null;
};

/** Case-insensitive lookup on a plain header record. */
export function headerLookup(headers: Record<string, string>, name: string): string | null {
	const direct = headers[name];
	if (direct != null) return direct;
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return null;
}

/** Build a CallRequest from host-written dispatch fields. */
export function createCallRequest(input: CallRequestInput): CallRequest {
	const bodyText = input.bodyText ?? '';
	return {
		url: input.url,
		method: input.method,
		headers: {
			get: (name) => headerLookup(input.headers, name)
		},
		async json() {
			if (!bodyText) return null;
			return JSON.parse(bodyText) as unknown;
		},
		async text() {
			return bodyText;
		}
	};
}

/** Read a real Fetch request into dispatch fields for the self-host HTTP adapter. */
export async function readFetchRequest(request: Request): Promise<CallRequestInput> {
	const headers: Record<string, string> = {};
	request.headers.forEach((value, name) => {
		headers[name] = value;
	});
	const bodyText =
		request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
	return {
		method: request.method,
		url: request.url,
		headers,
		bodyText
	};
}
