// Caller-minted ids: a page or host mints a uuidv7, and a release admits it only near its own clock.
const DAY = 86_400_000;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A caller-minted id is a uuidv7 whose timestamp is within 24 h of the host clock, either side. */
export function uuidv7_within(id: string, nowMs: number): boolean {
	return V7.test(id) && Math.abs(nowMs - parseInt(id.slice(0, 8) + id.slice(9, 13), 16)) <= DAY;
}
/** A fresh uuidv7 (RFC 9562): 48 bits of Unix milliseconds, version 7, variant 10, the rest random. */
export function uuidv7(nowMs: number = Date.now()): string {
	const b = crypto.getRandomValues(new Uint8Array(16));
	for (let i = 0; i < 6; i++) b[i] = Math.floor(nowMs / 2 ** (8 * (5 - i))) & 0xff;
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70);
	view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
	const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
