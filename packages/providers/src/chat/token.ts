/** One connection's app token, refreshed once for concurrent callers. */
export function tokenCache(load: () => Promise<{ readonly token: string; readonly ttl: number }>) {
	let cached: { readonly token: string; readonly until: number } | undefined;
	let loading: Promise<string> | undefined;
	let generation = 0;
	return {
		get: (): Promise<string> => {
			if (cached !== undefined && Date.now() < cached.until) return Promise.resolve(cached.token);
			if (loading !== undefined) return loading;
			const started = generation;
			loading = load()
				.then(({ token, ttl }) => {
					if (generation === started) cached = { token, until: Date.now() + ttl };
					return token;
				})
				.finally(() => {
					if (generation === started) loading = undefined;
				});
			return loading;
		},
		invalidate: () => {
			generation++;
			cached = undefined;
			loading = undefined;
		}
	};
}
