// Caller-minted ids: a page or host mints a uuidv7, and a release admits it only near its own clock.
const DAY = 86_400_000;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A caller-minted id is a uuidv7 whose timestamp is within 24 h of the host clock, either side. */
export function uuidv7_within(id: string, nowMs: number): boolean {
	return V7.test(id) && Math.abs(nowMs - parseInt(id.slice(0, 8) + id.slice(9, 13), 16)) <= DAY;
}
let lastMs = -1;
let seq = 0;
let lastExplicitMs = -1;
let explicitSeq = 0;

/** A fresh uuidv7 (RFC 9562): 48 bits of Unix milliseconds, version 7, monotonic 12-bit sub-ms counter, variant 10, 62 bits random. */
export function uuidv7(nowMs?: number): string {
	const b = crypto.getRandomValues(new Uint8Array(16));
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const seed10 = ((view.getUint8(6) & 0x03) << 8) | view.getUint8(7);
	let ms = nowMs ?? Date.now();
	let randA: number;
	if (nowMs === undefined) {
		if (ms <= lastMs) {
			seq = (seq + 1) & 0x0fff;
			if (seq === 0) lastMs += 1;
			ms = lastMs;
		} else {
			lastMs = ms;
			// Start in the low 10 bits so bursts up to 3,072 ids/ms stay within the same millisecond.
			seq = seed10;
		}
		randA = seq;
	} else {
		if (ms === lastExplicitMs) {
			explicitSeq = (explicitSeq + 1) & 0x0fff;
		} else {
			lastExplicitMs = ms;
			explicitSeq = seed10;
		}
		randA = explicitSeq;
	}
	for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
	view.setUint8(6, 0x70 | ((randA >>> 8) & 0x0f));
	view.setUint8(7, randA & 0xff);
	view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
	const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
