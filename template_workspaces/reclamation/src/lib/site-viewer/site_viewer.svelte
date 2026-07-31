<script lang="ts">
	import { Bound, Inline } from '@norbital-ai/ui/layout';
	import { onDestroy } from 'svelte';
	import { watch } from 'runed';
	import { tessellate } from './geometry-worker.js';
	import type {
		SiteSurfaces,
		SiteViewerProps,
		SurfaceMesh,
		ThreeCamera,
		ThreeControls,
		ThreeMaterial,
		ThreeModule,
		ThreeObject3D,
		ThreeRenderer
	} from './site_viewer.types.js';

	let { model, label, visible, renderCellM, onLayers, onStats }: SiteViewerProps = $props();

	/**
	 * Vertical exaggeration.
	 *
	 * A reclamation site is three kilometres across and twenty metres tall. Drawn
	 * true to scale it is a sheet of paper — the relief is a third of a percent of
	 * the width, so a correct render looks flat and tells you nothing. Every
	 * marine and civil viewer exaggerates the vertical for inspection; this does
	 * the same, and says so, because an exaggerated section must never be read as
	 * the drawn one.
	 */
	let exaggeration = $state(1);
	const EXAGGERATIONS = [1, 3, 5, 10, 20] as const;

	const runtime: Promise<
		[
			ThreeModule,
			{ OrbitControls: new (camera: ThreeCamera, element: HTMLElement) => ThreeControls }
		]
	> = Promise.all([
		import(/* @vite-ignore */ 'https://esm.sh/three@0.185.1'),
		import(/* @vite-ignore */ 'https://esm.sh/three@0.185.1/examples/jsm/controls/OrbitControls.js')
	]);

	type Stage = {
		THREE: ThreeModule;
		renderer: ThreeRenderer;
		scene: ThreeObject3D & { background: { set(value: number | string): unknown } | null };
		camera: ThreeCamera;
		controls: ThreeControls;
		group: ThreeObject3D;
		materials: ThreeMaterial[];
		frame: number;
	};

	let container = $state<HTMLDivElement | null>(null);
	let status = $state<'idle' | 'building' | 'ready' | { error: string }>('idle');
	let surfaces = $state<SiteSurfaces | null>(null);
	let stage: Stage | null = null;

	const isVisible = (id: string): boolean => visible?.[id] ?? true;

	/**
	 * Rebuild the surfaces whenever the model identity changes.
	 *
	 * The worker is created per build and terminated after it answers: a stitch is
	 * an occasional event, and a resident worker holding a copy of the survey grid
	 * is not worth the memory.
	 */
	async function buildSurfaces(current: typeof model): Promise<void> {
		status = 'building';
		try {
			const built = await tessellate(current, renderCellM);
			surfaces = built;
			onLayers?.(
				built.meshes.map((mesh) => ({
					id: mesh.id,
					label: mesh.label,
					color: `#${mesh.color.toString(16).padStart(6, '0')}`,
					triangles: mesh.indices.length / 3
				}))
			);
			onStats?.({
				vertexCount: built.vertexCount,
				triangleCount: built.triangleCount,
				renderCellM: built.renderCellM
			});
			if (stage) applySurfaces(stage, built);
			status = 'ready';
		} catch (error) {
			status = { error: error instanceof Error ? error.message : String(error) };
		}
	}

	function readCssColor(name: string, fallback: string): string {
		if (typeof document === 'undefined') return fallback;
		const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		return value || fallback;
	}

	async function mountStage(node: HTMLDivElement): Promise<void> {
		const [THREE, { OrbitControls }] = await runtime;
		const renderer = new THREE.WebGLRenderer({
			antialias: true,
			powerPreference: 'high-performance'
		});
		renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
		renderer.setSize(node.clientWidth || 1, node.clientHeight || 1);
		renderer.setClearColor(readCssColor('--color-background', '#f2f1ed'), 1);
		node.appendChild(renderer.domElement);
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(
			45,
			(node.clientWidth || 1) / (node.clientHeight || 1),
			1,
			200_000
		);
		const controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.maxPolarAngle = Math.PI / 2.02;

		scene.add(new THREE.HemisphereLight(0xdfe7ef, 0x39433b, 1.05));
		const sun = new THREE.DirectionalLight(0xffffff, 1.6);
		sun.position.set(1, 2, 1);
		scene.add(sun);
		scene.add(new THREE.AmbientLight(0xffffff, 0.25));

		const group = new THREE.Group();
		// Engineering frame (X alongshore, Y seaward, Z up) → the renderer's Y-up frame.
		// After this rotation the group's local Z is world up, so scaling local Z is
		// exactly the vertical exaggeration.
		group.rotation.x = -Math.PI / 2;
		group.scale.z = exaggeration;
		scene.add(group);

		stage = { THREE, renderer, scene, camera, controls, group, materials: [], frame: 0 };
		if (surfaces) applySurfaces(stage, surfaces);

		const observer = new ResizeObserver(() => {
			if (!stage) return;
			const width = node.clientWidth || 1;
			const height = node.clientHeight || 1;
			stage.renderer.setSize(width, height);
			stage.camera.aspect = width / height;
			stage.camera.updateProjectionMatrix();
		});
		observer.observe(node);
		resizeObserver = observer;

		const tick = (): void => {
			if (!stage) return;
			stage.frame = requestAnimationFrame(tick);
			stage.controls.update();
			stage.renderer.render(stage.scene, stage.camera);
		};
		tick();
	}

	function applySurfaces(current: Stage, next: SiteSurfaces): void {
		const { THREE, group } = current;
		group.traverse((object) => {
			const mesh = object as { geometry?: { dispose(): void } };
			mesh.geometry?.dispose();
		});
		for (const material of current.materials) material.dispose();
		current.materials = [];
		group.clear();

		for (const mesh of next.meshes) {
			group.add(createMesh(THREE, current, mesh));
		}
		for (const cut of next.cuts) {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(cut.points, 3));
			const material = new THREE.LineBasicMaterial({ color: 0xf0a94b });
			current.materials.push(material);
			const line = new THREE.Line(geometry, material);
			line.name = `cut:${cut.id}`;
			line.renderOrder = 3;
			group.add(line);
		}
		frameCamera(current, next);
	}

	/**
	 * Depth bias for surfaces that genuinely share a level.
	 *
	 * The platform, the adjacent works, and any existing land are all finished to
	 * the same design level, so they are exactly coplanar and the depth buffer has
	 * no basis to choose between them — the result is the stippled, flickering
	 * mottle of z-fighting. Biasing the *depth test* rather than moving the
	 * geometry keeps every level honest while giving the renderer a stable order:
	 * the works read on top, context behind them, water behind that.
	 */
	const DEPTH_BIAS: Record<string, number> = {
		platform: 0,
		crest: 0,
		armor: 0,
		existing_land: 2,
		context: 3,
		sea: 4
	};

	function createMesh(THREE: ThreeModule, current: Stage, source: SurfaceMesh) {
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
		geometry.setAttribute('normal', new THREE.BufferAttribute(source.normals, 3));
		geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
		geometry.computeBoundingSphere();
		const bias = DEPTH_BIAS[source.id] ?? 1;
		const material = new THREE.MeshStandardMaterial({
			color: source.color,
			roughness: source.id === 'sea' ? 0.15 : 0.95,
			metalness: 0,
			transparent: source.opacity < 1,
			opacity: source.opacity,
			side: source.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
			polygonOffset: bias !== 0,
			polygonOffsetFactor: bias,
			polygonOffsetUnits: bias
		});
		current.materials.push(material);
		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = source.id;
		mesh.visible = isVisible(source.id);
		mesh.renderOrder = source.id === 'sea' ? 2 : source.id === 'structure' ? 1 : 0;
		return mesh;
	}

	function frameCamera(current: Stage, next: SiteSurfaces): void {
		const { bounds } = next;
		const centreX = (bounds.minX + bounds.maxX) / 2;
		const centreY = (bounds.minY + bounds.maxY) / 2;
		// Heights are drawn exaggerated, so the camera has to frame the exaggerated
		// extent or the solid climbs out of view as the factor rises.
		const centreZ = ((bounds.minZ + bounds.maxZ) / 2) * exaggeration;
		const radius =
			Math.max(
				bounds.maxX - bounds.minX,
				bounds.maxY - bounds.minY,
				(bounds.maxZ - bounds.minZ) * exaggeration
			) / 2;
		const distance = Math.max(radius * 2.1, 100);
		current.controls.target.set(centreX, centreZ, -centreY);
		current.camera.position.set(
			centreX - distance * 0.55,
			centreZ + distance * 0.55,
			-centreY + distance * 0.7
		);
		current.camera.near = Math.max(0.5, distance / 5000);
		current.camera.far = distance * 20;
		current.camera.updateProjectionMatrix();
		current.controls.minDistance = radius * 0.05;
		current.controls.maxDistance = distance * 6;
		current.controls.update();
	}

	/**
	 * Named viewpoints.
	 *
	 * Orbiting to a square-on elevation by hand is fiddly and never quite square,
	 * which matters when the whole point is comparing a face against a drawing.
	 * Plan looks straight down; the elevations look along an axis, where the
	 * exaggerated relief actually reads.
	 */
	const VIEWS = ['iso', 'plan', 'north', 'east'] as const;
	type ViewId = (typeof VIEWS)[number];
	const VIEW_LABEL: Record<ViewId, string> = {
		iso: 'Iso',
		plan: 'Plan',
		north: 'North',
		east: 'East'
	};
	let view = $state<ViewId>('iso');

	function applyView(next: ViewId): void {
		view = next;
		if (!stage || !surfaces) return;
		const { bounds } = surfaces;
		const centreX = (bounds.minX + bounds.maxX) / 2;
		const centreY = (bounds.minY + bounds.maxY) / 2;
		const centreZ = ((bounds.minZ + bounds.maxZ) / 2) * exaggeration;
		const radius =
			Math.max(
				bounds.maxX - bounds.minX,
				bounds.maxY - bounds.minY,
				(bounds.maxZ - bounds.minZ) * exaggeration
			) / 2;
		const distance = Math.max(radius * 2.1, 100);
		stage.controls.target.set(centreX, centreZ, -centreY);
		const at = {
			// Straight down, nudged off true vertical so the orbit controls keep a
			// usable up-vector instead of gimbal-locking.
			plan: [centreX, centreZ + distance, -centreY + distance * 0.001],
			north: [centreX, centreZ + distance * 0.12, -centreY + distance],
			east: [centreX + distance, centreZ + distance * 0.12, -centreY],
			iso: [centreX - distance * 0.55, centreZ + distance * 0.55, -centreY + distance * 0.7]
		}[next];
		stage.camera.position.set(at[0], at[1], at[2]);
		stage.camera.updateProjectionMatrix();
		stage.controls.update();
	}

	function setExaggeration(next: number): void {
		exaggeration = next;
		if (!stage) return;
		stage.group.scale.z = next;
		// Re-aim the *current* viewpoint. Reframing to the default here would throw
		// away the angle someone just lined up, which is the one thing they were
		// changing the exaggeration to look at.
		applyView(view);
	}

	let resizeObserver: ResizeObserver | null = null;

	watch(
		() => container,
		(node) => {
			if (!node || stage) return;
			void mountStage(node);
		}
	);
	watch(
		() => [model, renderCellM] as const,
		([current]) => {
			if (current) void buildSurfaces(current);
		}
	);
	// Visibility is applied to the live scene rather than rebuilding anything:
	// toggling a layer must never cost a re-tessellation.
	watch(
		() => visible,
		() => {
			stage?.group.traverse((object) => {
				if (object.name && !object.name.startsWith('cut:')) {
					object.visible = isVisible(object.name);
				}
			});
		}
	);

	onDestroy(() => {
		resizeObserver?.disconnect();
		if (!stage) return;
		cancelAnimationFrame(stage.frame);
		stage.controls.dispose();
		stage.group.traverse((object) => {
			const mesh = object as { geometry?: { dispose(): void } };
			mesh.geometry?.dispose();
		});
		for (const material of stage.materials) material.dispose();
		stage.renderer.dispose();
		stage.renderer.domElement.remove();
		stage = null;
	});
</script>

<Bound size="full" clip class="relative">
	<div
		bind:this={container}
		class="h-full w-full"
		aria-label={label ?? 'Reclamation site model'}
	></div>

	{#if status === 'building' || status === 'idle'}
		<Inline
			align="center"
			justify="center"
			class="absolute inset-0 bg-background/70 text-sm text-muted-foreground"
		>
			Tessellating the stitched solid…
		</Inline>
	{:else if typeof status === 'object'}
		<Inline
			align="center"
			justify="center"
			class="absolute inset-0 bg-background/85 px-6 text-center text-sm text-destructive"
		>
			{status.error}
		</Inline>
	{/if}

	{#if surfaces && status === 'ready'}
		<div
			class="absolute right-3 bottom-3 flex items-center gap-2 rounded-md border bg-background/85 px-2 py-1 text-tiny text-muted-foreground shadow-xs backdrop-blur"
		>
			<div class="flex divide-x rounded border" role="group" aria-label="Viewpoint">
				{#each VIEWS as id (id)}
					<button
						type="button"
						class={[
							'px-1.5 py-0.5',
							view === id ? 'bg-brand/15 font-medium text-foreground' : 'hover:bg-muted'
						]}
						aria-pressed={view === id}
						onclick={() => applyView(id)}
					>
						{VIEW_LABEL[id]}
					</button>
				{/each}
			</div>
			<span aria-hidden="true">·</span>
			<span class="font-medium">Vertical</span>
			<div class="flex divide-x rounded border" role="group" aria-label="Vertical exaggeration">
				{#each EXAGGERATIONS as factor (factor)}
					<button
						type="button"
						class={[
							'px-1.5 py-0.5 tabular-nums',
							exaggeration === factor ? 'bg-brand/15 font-medium text-foreground' : 'hover:bg-muted'
						]}
						aria-pressed={exaggeration === factor}
						onclick={() => setExaggeration(factor)}
					>
						×{factor}
					</button>
				{/each}
			</div>
			<span aria-hidden="true">·</span>
			<span class="tabular-nums">
				{surfaces.triangleCount.toLocaleString()} tri · {surfaces.renderCellM.toFixed(1)} m
			</span>
		</div>
		{#if exaggeration !== 1}
			<p
				class="absolute top-3 left-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-tiny font-medium text-amber-700 shadow-xs backdrop-blur dark:text-amber-300"
			>
				Heights ×{exaggeration} — not to scale
			</p>
		{/if}
	{/if}
</Bound>
