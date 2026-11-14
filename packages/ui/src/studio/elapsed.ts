/** A running step's elapsed time as `m:ss`. */
export const elapsed_text = (ms: number) => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
