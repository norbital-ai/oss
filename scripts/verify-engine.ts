/**
 * Consolidated verification of the reclamation engine.
 *   A–E  analytic audit: answers computable by hand
 *   F–K  generality: sites the engine has never seen, plus invariances
 *   L    simulation: design levers move volume through the same integrator
 */
import { stitch } from '../src/lib/reclamation/stitch.js';
import { buildSurfaces, integrateSite } from '../src/lib/reclamation/solids.js';
import { applySimulation, baseSimulation } from '../src/lib/reclamation/simulation.js';
import { buildEstimate, DEFAULT_LEVERS, unpricedMessage } from '../src/lib/reclamation/cost.js';
import { extractSections, Ledger, type RawDocument } from '../src/lib/reclamation/extract.js';

type P = [number, number];
const enc = new TextEncoder();
function profileFixture(body: string): string {
	const rows = body.trim().split(/\r?\n/);
	const header =
		rows
			.shift()
			?.split(',')
			.map((value) => value.trim()) ?? [];
	const profiles: Record<string, [number, number, string][]> = {};
	for (const row of rows) {
		const values = row.split(',').map((value) => value.trim());
		const read = (name: string) => values[header.indexOf(name)];
		const profile = read('profile') || 'section-1';
		const station = Number(read('station_m'));
		const level = Number(read('z_cd_m'));
		if (!Number.isFinite(station) || !Number.isFinite(level)) continue;
		(profiles[profile] ??= []).push([station, level, read('layer') || 'grade']);
	}
	return JSON.stringify({ profiles });
}
const doc = (kind: RawDocument['kind'], fileName: string, body: string): RawDocument => {
	const sectionFixture =
		kind === 'cross_section' && /^(?:profile,)?station_m,z_cd_m,layer/m.test(body);
	return {
		kind,
		assetId: null,
		fileName,
		mimeType: null,
		bytes: enc.encode(sectionFixture ? profileFixture(body) : body),
		sha256: 'x'.repeat(64)
	};
};
const flatBed = (x0: number, x1: number, y0: number, y1: number, sp: number, z: number) => {
	const rows = ['X Y Z'];
	for (let y = y0; y <= y1; y += sp) for (let x = x0; x <= x1; x += sp) rows.push(`${x} ${y} ${z}`);
	return rows.join('\n');
};
const xyz = (
	b: { x0: number; x1: number; y0: number; y1: number },
	sp: number,
	f: (x: number, y: number) => number
) => {
	const rows = ['X Y Z'];
	for (let y = b.y0; y <= b.y1; y += sp)
		for (let x = b.x0; x <= b.x1; x += sp) rows.push(`${x} ${y} ${f(x, y).toFixed(3)}`);
	return rows.join('\n');
};
const plan = (o: Record<string, unknown>) => JSON.stringify(o);
const ringOf = (r: readonly P[]) => [[...r, r[0]]];

const results: { name: string; ok: boolean; note: string }[] = [];
const check = (name: string, ok: boolean, note: string) => {
	results.push({ name, ok, note });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${note}`);
};
const run = (docs: Record<string, RawDocument>, overrides?: unknown, settings?: unknown) =>
	stitch({
		documents: docs as never,
		...(overrides ? { overrides: overrides as never } : {}),
		...(settings ? { settings: settings as never } : {})
	});
const fillOf = (r: ReturnType<typeof stitch>) => r.metrics.placedVolumeM3;

/* ---------- A. square pad vs calculus ---------- */
{
	const L = 1200,
		D = 12,
		P0 = 5,
		N = 3,
		R = (P0 + D) * N,
		H = P0 + D;
	const exact =
		((4 * H) / R) * ((L * R * R) / 2 - (2 * R ** 3) / 3) +
		4 * H * (L * (L / 2) - (L / 2) ** 2 - (L * R - R * R));
	const square: P[] = [
		[0, 0],
		[L, 0],
		[L, L],
		[0, L]
	];
	const sec = [
		'station_m,z_cd_m,layer',
		`0,${-D},toe`,
		`${R},${P0},crest_seaward`,
		`${L},${P0},platform`
	].join('\n');
	for (const cell of [4, 2, 1]) {
		const r = run(
			{
				floor_plan: doc(
					'floor_plan',
					'p.json',
					plan({ works_outline: square, seaward_edges: ringOf(square) })
				),
				bathymetry: doc('bathymetry', 'b.xyz', flatBed(-200, L + 200, -200, L + 200, 25, -D)),
				cross_section: doc('cross_section', 's.json', sec)
			},
			{ dimensionsM: { armorThickness: 0 }, seawardFaceKind: 'caisson' },
			{ integrationCellM: cell, maxCells: 4e6 }
		);
		const err = Math.abs(fillOf(r) - exact) / exact;
		check(
			`A. square pad vs calculus @ ${cell} m`,
			err < (cell <= 2 ? 0.004 : 0.01),
			`${(fillOf(r) / 1e6).toFixed(4)} vs ${(exact / 1e6).toFixed(4)} Mm³ — ${(err * 100).toFixed(3)}%`
		);
	}
}

/* ---------- B. substrate partition ---------- */
{
	const L = 900,
		D = 14,
		P0 = 6,
		R = (P0 + D) * 3;
	const square: P[] = [
		[0, 0],
		[L, 0],
		[L, L],
		[0, L]
	];
	const sec = [
		'station_m,z_cd_m,layer',
		`0,${-D},toe`,
		`${R},${P0},crest_seaward`,
		`${R + 20},${P0},armor_crest`,
		`${R + 40},${P0},crest_landward`,
		`${L},${P0},platform`
	].join('\n');
	const r = run(
		{
			floor_plan: doc(
				'floor_plan',
				'p.json',
				plan({ works_outline: square, seaward_edges: ringOf(square) })
			),
			bathymetry: doc('bathymetry', 'b.xyz', flatBed(-200, L + 200, -200, L + 200, 25, -D)),
			cross_section: doc('cross_section', 's.json', sec)
		},
		{ dimensionsM: { armorThickness: 1.5 } },
		{ integrationCellM: 2, maxCells: 4e6 }
	);
	const q = (id: string) => r.quantities.find((e) => e.substrate === id)?.quantity ?? 0;
	const parts =
		q('rock_armor') + q('sand_fill') + q('dredged_fill') + q('sand_key') + q('dredged_rock');
	const err = Math.abs(parts - r.metrics.placedVolumeM3) / r.metrics.placedVolumeM3;
	check(
		'B. substrates partition the solid',
		err < 5e-6,
		`Σ substrates ${(parts / 1e6).toFixed(6)} vs placed ${(r.metrics.placedVolumeM3 / 1e6).toFixed(6)} Mm³ — ${(err * 100).toExponential(2)}%`
	);
}

/* ---------- C. armour = t x true sloped area ---------- */
{
	const L = 1500,
		D = 15,
		P0 = 5,
		N = 3,
		R = (P0 + D) * N,
		t = 1.5;
	const slant = Math.sqrt(1 + (1 / N) ** 2);
	const exactArea = 4 * (L * R - R * R) * slant;
	const square: P[] = [
		[0, 0],
		[L, 0],
		[L, L],
		[0, L]
	];
	const sec = [
		'station_m,z_cd_m,layer',
		`0,${-D},toe`,
		`${R},${P0},crest_seaward`,
		`${L},${P0},platform`
	].join('\n');
	const r = run(
		{
			floor_plan: doc(
				'floor_plan',
				'p.json',
				plan({ works_outline: square, seaward_edges: ringOf(square) })
			),
			bathymetry: doc('bathymetry', 'b.xyz', flatBed(-300, L + 300, -300, L + 300, 25, -D)),
			cross_section: doc('cross_section', 's.json', sec)
		},
		{ dimensionsM: { armorThickness: t } },
		{ integrationCellM: 1.5, maxCells: 6e6 }
	);
	const armour = r.quantities.find((e) => e.substrate === 'rock_armor')?.quantity ?? 0;
	const fabric = r.quantities.find((e) => e.substrate === 'geofabric')?.quantity ?? 0;
	check(
		'C. armour = thickness x true sloped area',
		Math.abs(armour - t * exactArea) / (t * exactArea) < 0.02,
		`${Math.round(armour).toLocaleString()} vs ${Math.round(t * exactArea).toLocaleString()} m³`
	);
	check(
		'C. geofabric = true sloped area',
		Math.abs(fabric - exactArea) / exactArea < 0.02,
		`${Math.round(fabric).toLocaleString()} vs ${Math.round(exactArea).toLocaleString()} m²`
	);
}

/* ---------- D. footprint = shoelace ---------- */
{
	const ring: P[] = [];
	for (let i = 0; i < 24; i++) {
		const a = (i / 24) * Math.PI * 2;
		ring.push([1000 + 600 * Math.cos(a), 1000 + 420 * Math.sin(a)]);
	}
	let sl = 0;
	for (let i = 0; i < ring.length; i++) {
		const [x0, y0] = ring[i];
		const [x1, y1] = ring[(i + 1) % ring.length];
		sl += x0 * y1 - x1 * y0;
	}
	sl = Math.abs(sl) / 2;
	const r = run(
		{
			floor_plan: doc(
				'floor_plan',
				'p.json',
				plan({ works_outline: ring, seaward_edges: ringOf(ring) })
			),
			bathymetry: doc('bathymetry', 'b.xyz', flatBed(200, 1800, 400, 1600, 20, -10)),
			cross_section: doc(
				'cross_section',
				's.json',
				['station_m,z_cd_m,layer', '0,-10,toe', '30,4,crest_seaward', '900,4,platform'].join('\n')
			)
		},
		{ dimensionsM: { armorThickness: 1 } },
		{ integrationCellM: 1.5, maxCells: 6e6 }
	);
	const err = Math.abs(r.metrics.worksFootprintM2 - sl) / sl;
	check(
		'D. footprint = shoelace area',
		err < 0.005,
		`${Math.round(r.metrics.worksFootprintM2).toLocaleString()} vs ${Math.round(sl).toLocaleString()} m² — ${(err * 100).toFixed(3)}%`
	);
}

/* ---------- E. curved bed integrated, not averaged ---------- */
{
	const L = 1000,
		P0 = 4;
	const rows = ['X Y Z'];
	for (let y = -100; y <= L + 100; y += 10)
		for (let x = -100; x <= L + 100; x += 10) {
			const t = (Math.min(Math.max(x, 0), L) - 500) / 500;
			rows.push(`${x} ${y} ${(-8 - 6 * (1 - t * t)).toFixed(4)}`);
		}
	const square: P[] = [
		[0, 0],
		[L, 0],
		[L, L],
		[0, L]
	];
	const exact = L * ((P0 + 8) * L + 6 * (L - L / 3));
	const prism = L * L * (P0 + 8 + 3);
	const r = run(
		{
			floor_plan: doc(
				'floor_plan',
				'p.json',
				plan({ works_outline: square, seaward_edges: ringOf(square) })
			),
			bathymetry: doc('bathymetry', 'b.xyz', rows.join('\n')),
			cross_section: doc(
				'cross_section',
				's.json',
				['station_m,z_cd_m,layer', '0,-14,toe', `0,${P0},quay_crest`, `${L},${P0},platform`].join(
					'\n'
				)
			)
		},
		{ seawardFaceKind: 'caisson', dimensionsM: { armorThickness: 0 } },
		{ integrationCellM: 2, maxCells: 4e6 }
	);
	const err = Math.abs(fillOf(r) - exact) / exact;
	check(
		'E. curved bed integrated, not averaged',
		err < 0.01,
		`${(fillOf(r) / 1e6).toFixed(4)} vs ${(exact / 1e6).toFixed(4)} Mm³ — ${(err * 100).toFixed(3)}% (mid-depth prism would be ${(((prism - exact) / exact) * 100).toFixed(1)}% out)`
	);
}

/* ---------- F. calibration gate ---------- */
{
	const ring: P[] = [];
	for (let i = 0; i < 48; i++) {
		const a = (i / 48) * Math.PI * 2;
		ring.push([1000 + 400 * Math.cos(a), 1000 + 400 * Math.sin(a)]);
	}
	const bed = xyz({ x0: 400, x1: 1600, y0: 400, y1: 1600 }, 20, () => -12);
	let msg = '';
	try {
		run({
			floor_plan: doc('floor_plan', 'p.json', plan({ works_outline: ring })),
			bathymetry: doc('bathymetry', 'b.xyz', bed),
			cross_section: doc(
				'cross_section',
				's.json',
				['station_m,z_cd_m,layer', '0,-12,grade', '36,6,grade', '400,6,grade'].join('\n')
			)
		});
	} catch (e) {
		msg = e instanceof Error ? e.message : String(e);
	}
	check(
		'F. uncalibrated drawings are refused',
		msg.includes('cannot be deduced') &&
			msg.includes('toe') &&
			msg.includes('platform') &&
			msg.includes('seaward_edges'),
		'one message names the toe, platform and seaward-edge shortfalls'
	);

	const r = run(
		{
			floor_plan: doc(
				'floor_plan',
				'p.json',
				plan({ works_outline: ring, seaward_edges: ringOf(ring) })
			),
			bathymetry: doc('bathymetry', 'b.xyz', bed),
			cross_section: doc(
				'cross_section',
				's.json',
				['station_m,z_cd_m,layer', '0,-12,toe', '36,6,crest_seaward', '400,6,platform'].join('\n')
			)
		},
		{ dimensionsM: { armorThickness: 1 } }
	);
	check(
		'F. the same site, calibrated, builds',
		fillOf(r) > 0 && buildSurfaces(r.model).triangleCount > 0,
		`${(fillOf(r) / 1e6).toFixed(2)} Mm³`
	);
}

/* ---------- G. rotation + translation invariance ---------- */
{
	const base: P[] = [
		[0, 0],
		[900, 0],
		[900, 300],
		[1600, 300],
		[1600, 900],
		[0, 900]
	];
	const sec = [
		'station_m,z_cd_m,layer',
		'0,-14,toe',
		'42,5,crest_seaward',
		'62,5,crest_landward',
		'500,5,platform'
	].join('\n');
	const bedAt = (x: number, y: number) => -14 + 0.002 * x + 0.001 * y;
	const ang = (37 * Math.PI) / 180,
		cos = Math.cos(ang),
		sin = Math.sin(ang),
		sx = 48000,
		sy = -31000;
	const fwd = (p: P): P => [p[0] * cos - p[1] * sin + sx, p[0] * sin + p[1] * cos + sy];
	const inv = (x: number, y: number): P => {
		const dx = x - sx,
			dy = y - sy;
		return [dx * cos + dy * sin, -dx * sin + dy * cos];
	};
	const build = (
		t: ((p: P) => P) | null,
		b: { x0: number; x1: number; y0: number; y1: number }
	) => {
		const o = t ? base.map(t) : base;
		return run(
			{
				floor_plan: doc(
					'floor_plan',
					'p.json',
					plan({ works_outline: o, seaward_edges: ringOf(o) })
				),
				bathymetry: doc(
					'bathymetry',
					'b.xyz',
					xyz(b, 15, (x, y) => {
						const i = t ? inv(x, y) : [x, y];
						return bedAt(i[0], i[1]);
					})
				),
				cross_section: doc('cross_section', 's.json', sec)
			},
			{ dimensionsM: { armorThickness: 1.5 } }
		);
	};
	const a = build(null, { x0: -200, x1: 1800, y0: -200, y1: 1100 });
	const b = build(fwd, { x0: 46500, x1: 49800, y0: -31400, y1: -29000 });
	const d = Math.abs(fillOf(b) - fillOf(a)) / fillOf(a);
	check(
		'G. rotation 37° + 48 km translation',
		d < 0.02,
		`${(fillOf(a) / 1e6).toFixed(3)} vs ${(fillOf(b) / 1e6).toFixed(3)} Mm³ — ${(d * 100).toFixed(2)}%`
	);
	const arm = (r: typeof a) =>
		r.quantities.find((q) => q.substrate === 'rock_armor')?.quantity ?? 0;
	check(
		'G. armour is orientation-free',
		Math.abs(arm(b) - arm(a)) / arm(a) < 0.03,
		`${((Math.abs(arm(b) - arm(a)) / arm(a)) * 100).toFixed(2)}%`
	);
}

/* ---------- H. foreign vocabulary ---------- */
{
	const outline: P[] = [
		[0, 0],
		[1200, 0],
		[1200, 600],
		[0, 600]
	];
	const sec = [
		'profile,station_m,z_cd_m,layer',
		'S1,-15,-19,trench_bottom',
		'S1,0,-16,revetment_foot',
		'S1,48,4,shoulder_out',
		'S1,68,4,shoulder_in',
		'S1,300,4,yard_level'
	].join('\n');
	const docs = {
		floor_plan: doc(
			'floor_plan',
			'p.json',
			plan({
				works_outline: outline,
				seaward_edges: [
					[
						[0, 0],
						[1200, 0]
					]
				]
			})
		),
		bathymetry: doc(
			'bathymetry',
			'b.xyz',
			xyz({ x0: -100, x1: 1300, y0: -100, y1: 700 }, 20, () => -16)
		),
		cross_section: doc('cross_section', 's.json', sec)
	};
	let refused = false;
	try {
		run(docs);
	} catch {
		refused = true;
	}
	const r = run(docs, {
		profileLayers: {
			toe: ['revetment_foot'],
			internal: ['trench_bottom'],
			platform: ['yard_level']
		},
		dimensionsM: { armorThickness: 1.2 }
	});
	check(
		'H. foreign vocabulary via profileLayers',
		fillOf(r) > 0 && refused,
		`${(fillOf(r) / 1e6).toFixed(3)} Mm³, and the unmapped run was refused`
	);
	check(
		'H. layer classification reported',
		r.report.layerClassification?.find((e) => e.layer === 'trench_bottom')?.role === 'internal',
		'trench_bottom read as internal'
	);
}

/* ---------- I. comb of finger piers ---------- */
{
	const outline: P[] = [
		[0, 0],
		[400, 0],
		[400, 400],
		[2000, 400],
		[2000, 700],
		[400, 700],
		[400, 1100],
		[2000, 1100],
		[2000, 1400],
		[400, 1400],
		[400, 1800],
		[0, 1800]
	];
	const sec = [
		'profile,station_m,z_cd_m,layer',
		'N,0,-18,toe',
		'N,0,5.5,quay_crest',
		'N,30,5.5,caisson_landward',
		'N,400,5.5,platform',
		'M,0,-20,toe',
		'M,0,5.5,quay_crest',
		'M,30,5.5,caisson_landward',
		'M,400,5.5,platform',
		'S,0,-22,toe',
		'S,0,5.5,quay_crest',
		'S,30,5.5,caisson_landward',
		'S,400,5.5,platform'
	].join('\n');
	const r = run({
		floor_plan: doc(
			'floor_plan',
			'p.json',
			plan({
				works_outline: outline,
				seaward_edges: ringOf(outline),
				section_cuts: {
					N: {
						profile: 'N',
						line: [
							[200, 1750],
							[200, 1500]
						]
					},
					M: {
						profile: 'M',
						line: [
							[1200, 750],
							[1200, 1050]
						]
					},
					S: {
						profile: 'S',
						line: [
							[1200, 350],
							[1200, 100]
						]
					}
				}
			})
		),
		bathymetry: doc(
			'bathymetry',
			'b.xyz',
			xyz({ x0: -200, x1: 2200, y0: -200, y1: 2000 }, 20, (x) => -8 - 0.006 * x)
		),
		cross_section: doc('cross_section', 's.json', sec)
	});
	check(
		'I. comb plan, three sections, blended',
		fillOf(r) > 0 && r.report.assumptions.some((a) => a.id === 'linear-morph-between-sections'),
		`${(fillOf(r) / 1e6).toFixed(2)} Mm³, ${buildSurfaces(r.model).triangleCount.toLocaleString()} triangles`
	);
}

/* ---------- J. fuzz ---------- */
{
	let ok = 0,
		refused = 0;
	for (let seed = 0; seed < 40; seed++) {
		const n = 6 + (seed % 9),
			ring: P[] = [];
		for (let i = 0; i < n; i++) {
			const a = (i / n) * Math.PI * 2,
				rad = 250 + (((seed * 97 + i * 41) % 100) / 100) * 500;
			ring.push([1500 + rad * Math.cos(a), 1500 + rad * Math.sin(a)]);
		}
		const toe = -6 - (seed % 14),
			plat = 3 + (seed % 5);
		const sec = [
			'station_m,z_cd_m,layer',
			`0,${toe},toe`,
			`${(plat - toe) * 3},${plat},crest_seaward`,
			`${(plat - toe) * 3 + 20},${plat},crest_landward`,
			`900,${plat},platform`
		].join('\n');
		try {
			const r = run(
				{
					floor_plan: doc(
						'floor_plan',
						'p.json',
						plan({ works_outline: ring, seaward_edges: ringOf(ring) })
					),
					bathymetry: doc('bathymetry', 'b.xyz', flatBed(500, 2500, 500, 2500, 25, toe - 1)),
					cross_section: doc('cross_section', 's.json', sec)
				},
				{ dimensionsM: { armorThickness: 1 } }
			);
			if (fillOf(r) > 0) ok += 1;
		} catch (e) {
			if (e instanceof Error && e.message.length > 30) refused += 1;
		}
	}
	check(
		'J. fuzz over 40 arbitrary star polygons',
		ok + refused === 40 && ok >= 38,
		`${ok} built, ${refused} refused with a reason, 0 crashed`
	);
}

/* ---------- K. cost matrix completeness ---------- */
{
	const L = 800,
		D = 10,
		P0 = 4,
		R = (P0 + D) * 3;
	const square: P[] = [
		[0, 0],
		[L, 0],
		[L, L],
		[0, L]
	];
	const sec = [
		'station_m,z_cd_m,layer',
		`0,${-D},toe`,
		`${R},${P0},crest_seaward`,
		`${L},${P0},platform`
	].join('\n');
	const r = run(
		{
			floor_plan: doc(
				'floor_plan',
				'p.json',
				plan({ works_outline: square, seaward_edges: ringOf(square) })
			),
			bathymetry: doc('bathymetry', 'b.xyz', flatBed(-200, L + 200, -200, L + 200, 25, -D)),
			cross_section: doc('cross_section', 's.json', sec)
		},
		{ dimensionsM: { armorThickness: 1.2 } }
	);

	const partial = buildEstimate({
		quantities: r.quantities,
		metrics: r.metrics,
		rates: [{ substrate: 'sand_fill', unit: 'm3', rate: 45, currency: 'SGD' }],
		levers: DEFAULT_LEVERS,
		currency: 'SGD'
	});
	check(
		'K. missing rates are an error, not a zero',
		unpricedMessage(partial) !== null && partial.unpricedSubstrates.length > 0,
		`flagged ${partial.unpricedSubstrates.join(', ')}`
	);

	const full = buildEstimate({
		quantities: r.quantities,
		metrics: r.metrics,
		levers: DEFAULT_LEVERS,
		currency: 'SGD',
		rates: (
			[
				'rock_armor',
				'geofabric',
				'dredged_rock',
				'sand_key',
				'sand_fill',
				'dredged_fill',
				'pvd'
			] as const
		).map((substrate) => ({ substrate, unit: 'm3' as const, rate: 50, currency: 'SGD' }))
	});
	check(
		'K. a complete matrix prices cleanly',
		unpricedMessage(full) === null && full.total > 0,
		`total ${Math.round(full.total).toLocaleString()} SGD across ${full.lines.length} lines`
	);
}

/* ---------- L. design simulation moves volume ---------- */
{
	const L = 1000,
		D = 12,
		P0 = 5,
		R = (P0 + D) * 3;
	const square: P[] = [
		[0, 0],
		[L, 0],
		[L, L],
		[0, L]
	];
	const sec = [
		'station_m,z_cd_m,layer',
		`-20,${-D - 3},sand_key`,
		`-6,${-D - 3},sand_key`,
		`0,${-D},toe`,
		`${R},${P0},crest_seaward`,
		`${R + 2},${P0},armor_crest`,
		`${L},${P0},platform`
	].join('\n');
	const r = run(
		{
			floor_plan: doc(
				'floor_plan',
				'p.json',
				plan({ works_outline: square, seaward_edges: ringOf(square) })
			),
			bathymetry: doc('bathymetry', 'b.xyz', flatBed(-300, L + 300, -300, L + 300, 25, -D)),
			cross_section: doc('cross_section', 's.json', sec)
		},
		{ dimensionsM: { armorThickness: 1.5 } },
		{ integrationCellM: 2, maxCells: 4e6 }
	);

	const base = baseSimulation(r.model);
	const raised = integrateSite(applySimulation(r.model, { ...base, platformOffsetM: 1 }));
	const gain = raised.metrics.placedVolumeM3 - r.metrics.placedVolumeM3;
	// Raising the whole works 1 m adds roughly one metre over the footprint.
	const expected = r.metrics.worksFootprintM2 * 1;
	check(
		'L. +1 m platform adds ~1 m of fill over the footprint',
		Math.abs(gain - expected) / expected < 0.25,
		`+${Math.round(gain).toLocaleString()} m³ vs ~${Math.round(expected).toLocaleString()} m³ expected`
	);

	const thicker = integrateSite(applySimulation(r.model, { ...base, armorThicknessM: 3 }));
	const a1 = r.quantities.find((q) => q.substrate === 'rock_armor')?.quantity ?? 0;
	const a2 = thicker.quantities.find((q) => q.substrate === 'rock_armor')?.quantity ?? 0;
	check(
		'L. doubling armour thickness doubles armour volume',
		Math.abs(a2 / a1 - 2) < 0.02,
		`${Math.round(a1).toLocaleString()} → ${Math.round(a2).toLocaleString()} m³ (×${(a2 / a1).toFixed(3)})`
	);

	const deeper = integrateSite(applySimulation(r.model, { ...base, subGradeOffsetM: -2 }));
	const k1 = r.quantities.find((q) => q.substrate === 'sand_key')?.quantity ?? 0;
	const k2 = deeper.quantities.find((q) => q.substrate === 'sand_key')?.quantity ?? 0;
	check(
		'L. deepening the sand key invert digs more',
		k2 > k1 * 1.3,
		`${Math.round(k1).toLocaleString()} → ${Math.round(k2).toLocaleString()} m³ at 2 m deeper`
	);
}

/* ---------- M. authored CAD section identity and entity boundaries ---------- */
{
	const cad = [
		'0',
		'SECTION',
		'2',
		'ENTITIES',
		'0',
		'LINE',
		'8',
		'SECTION_1-1__toe',
		'10',
		'0',
		'20',
		'-15',
		'11',
		'61.5',
		'21',
		'5.5',
		'0',
		'LINE',
		'8',
		'SECTION_4-4__tbund',
		'10',
		'0',
		'20',
		'-9',
		'11',
		'42',
		'21',
		'4.8',
		'0',
		'ENDSEC',
		'0',
		'EOF'
	].join('\n');
	const extracted = extractSections(doc('cross_section', 'sections.dxf', cad), new Ledger());
	check(
		'M. CAD layers identify sections automatically',
		Object.keys(extracted.profiles).join(',') === '1-1,4-4',
		`decoded ${Object.keys(extracted.profiles).join(' and ')}`
	);
	check(
		'M. CAD entity boundaries survive extraction',
		extracted.profiles['1-1'][0].segmentId === extracted.profiles['1-1'][1].segmentId &&
			extracted.profiles['1-1'][0].layer === 'toe',
		'one authored LINE remains one render segment with its semantic layer'
	);
}

/* ------- N. a plotted tender sheet is placed from its own callouts ------- */
{
	/**
	 * The sheet under test is deliberately awkward, because real ones are: two
	 * sections at different plotting scales, sitting at different places on the
	 * page, with a sheet border across the lot and a note that states a level
	 * without being drawn at it.
	 */
	const entities: string[] = [];
	const line = (layer: string, x0: number, y0: number, x1: number, y1: number): void => {
		entities.push(
			'0',
			'LINE',
			'8',
			layer,
			'10',
			String(x0),
			'20',
			String(y0),
			'11',
			String(x1),
			'21',
			String(y1)
		);
	};
	const text = (layer: string, x: number, y: number, value: string): void => {
		entities.push(
			'0',
			'TEXT',
			'8',
			layer,
			'10',
			String(x),
			'20',
			String(y),
			'40',
			'2.5',
			'1',
			value
		);
	};

	// Sheet border: spans everything, and must not fuse the two sections.
	entities.push('0', 'LWPOLYLINE', '8', 'C-SHET-BRDR', '90', '5', '70', '0');
	for (const [x, y] of [
		[10, 10],
		[830, 10],
		[830, 580],
		[10, 580],
		[10, 10]
	]) {
		entities.push('10', String(x), '20', String(y));
	}

	// Section A-A, plotted 1:500 (2 mm per metre), origin at (100, 400).
	const a = (station: number, level: number): [number, number] => [
		100 + station * 2,
		400 + level * 2
	];
	line('C-REVT-TOE', ...a(0, -17), ...a(67.5, 5.5));
	line('C-REVT-CRST', ...a(67.5, 5.5), ...a(87.5, 5.5));
	line('C-REVT-PLAT', ...a(87.5, 5.5), ...a(160, 5.5));
	text('C-ANNO-LEVL', ...a(120, 5.5), 'FINAL PLATFORM LEVEL +5.5m CD');
	text('C-ANNO-LEVL', ...a(30, -17), 'TOE OF REVETMENT -17.0m CD');
	text('C-ANNO-LEVL', ...a(120, 0), 'UP TO 0.0m CD (INTERIM LEVEL)');
	// A sentence that mentions a level while sitting nowhere near it.
	text('C-ANNO-TEXT', ...a(20, -30), 'OR HIGHER THAN -17.0m CD AS STIPULATED');
	text('C-ANNO-TEXT', ...a(40, -8), '1V : 3H');
	text('C-ANNO-TITL', ...a(0, -36), 'SECTION A - A : TYPICAL REVETMENT');

	// Section B-B, plotted 1:1000 (1 mm per metre), origin at (150, 150).
	const b = (station: number, level: number): [number, number] => [150 + station, 150 + level];
	line('C-BUND-FACE', ...b(0, -12), ...b(72, 5.5));
	line('C-BUND-CRST', ...b(72, 5.5), ...b(172, 5.5));
	text('C-ANNO-LEVL', ...b(120, 5.5), 'FINAL PLATFORM LEVEL +5.5m CD');
	text('C-ANNO-LEVL', ...b(120, 0), 'UP TO 0.0m CD (INTERIM LEVEL)');
	text('C-ANNO-TITL', ...b(0, -30), 'SECTION B - B : ACROSS EXISTING BUND');

	const sheet = ['0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF'].join(
		'\n'
	);
	const read = extractSections(doc('cross_section', 'tender-sheet.dxf', sheet), new Ledger());
	const ids = Object.keys(read.profiles).sort().join(',');
	check(
		'N. sections on a sheet are found by their titles',
		ids === 'A-A,B-B',
		`grouped into ${ids || 'nothing'}`
	);

	const calibration = new Map((read.calibrations ?? []).map((entry) => [entry.id, entry]));
	const aa = calibration.get('A-A');
	const bb = calibration.get('B-B');
	check(
		'N. each section recovers its own plotting scale',
		aa?.plottingScale === 500 && bb?.plottingScale === 1000,
		`A-A 1:${aa?.plottingScale}, B-B 1:${bb?.plottingScale} from one sheet`
	);
	check(
		'N. a note that states a level is not mistaken for one',
		aa !== undefined && aa.calloutsSeen === 4 && aa.calloutsUsed === 3 && aa.residualM < 1e-6,
		`${aa?.calloutsUsed} of ${aa?.calloutsSeen} callouts agreed, residual ${aa?.residualM.toFixed(6)} m`
	);

	const toe = read.profiles['A-A'].find((point) => point.layer === 'toe');
	// `C-REVT-CRST` is resolved to the canonical `crest` role, not left as `crst`.
	const crest = read.profiles['A-A'].filter((point) => point.layer === 'crest');
	check(
		'N. plotted geometry comes back on station and level',
		toe !== undefined &&
			Math.abs(toe.stationM) < 1e-6 &&
			Math.abs(toe.zCdM + 17) < 1e-6 &&
			crest.length > 0 &&
			Math.abs(Math.min(...crest.map((point) => point.stationM)) - 67.5) < 1e-6,
		'toe at station 0.0 / -17.00 m CD, crest at station 67.5 — the drawn values'
	);
}

console.log('');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
