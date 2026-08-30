/** The live-query window and visible slice for one zero-based collection page. */
export function collectionTablePageWindow(
	pageIndex: number,
	pageSize: number
): Readonly<{
	limit: number;
	start: number;
	end: number;
}> {
	const index = Math.max(0, Math.trunc(pageIndex));
	const size = Math.max(1, Math.trunc(pageSize));
	return {
		limit: (index + 1) * size,
		start: index * size,
		end: (index + 1) * size
	};
}

/** Selects the visible page from the live growing window. */
export function collectionTablePageRows<Row>(
	rows: readonly Row[] | undefined,
	window: Readonly<{ start: number; end: number }>
): readonly Row[] | undefined {
	return rows?.slice(window.start, window.end);
}
