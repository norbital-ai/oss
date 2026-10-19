/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF, LF or CR rows; a trailing newline adds no row. */
export function csvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [],
		cell = '',
		quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') {
			row.push(cell);
			cell = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else cell += ch;
	}
	if (cell !== '' || row.length > 0) rows.push([...row, cell]);
	return rows;
}
