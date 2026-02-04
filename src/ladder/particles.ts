import * as THREE from "three";

// Rule: render only block particles within data region (no background dots).
// Hierarchy (discrete k): always render a regular 100×100 grid, but each block represents a larger
// integer "unit" as k grows. When k crosses +4 orders, one block effectively represents a whole
// previous 100×100 grid (10^4). This creates the requested “100×100 → 1粒子 → 100×100…” loop.

// Ripple coords are in pixel space with y-up (to match the orthographic camera space).
type Ripple = { x: number; y: number; start: number };

export type BlockParams = {
	width: number;
	height: number;
	k: number;
	midX: number;
	ballAx: number;
	ballBx: number;
	valueA: number;
	valueB: number;
};

// More saturated, kid-friendly colors (still soft).
const NEG_RGB = { r: 56, g: 189, b: 248 }; // sky-400
const POS_RGB = { r: 251, g: 113, b: 133 }; // rose-400

export class ParticleBlocks {
	private canvasGL: HTMLCanvasElement;
	private canvas2D: HTMLCanvasElement;
	private mode: "webgl" | "2d" = "webgl";
	private ctx2d: CanvasRenderingContext2D | null = null;
	private dpr2d = 1;
	private contextLost = false;
	private ripplesEnabled = true;
	private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
	private checkedBlackFrame = false;
	private renderer: THREE.WebGLRenderer;
	private scene: THREE.Scene;
	private camera: THREE.OrthographicCamera;
	private stage: THREE.Group;
	private fields: Array<{
		group: THREE.Group;
		negBase: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
		negActive: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
		posBase: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
		posActive: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
		baseOpacity: number;
		activeOpacity: number;
	}>;
	private activeField = 0;
	private kTransition:
		| null
		| {
				fromField: number;
				toField: number;
				singleField: boolean;
				dir: 1 | -1;
				startMs: number;
				durMs: number;
				fromParams: BlockParams;
				toParams: BlockParams;
		  } = null;

	private rafId: number | null = null;
	private needsFrame = true;
	private destroyed = false;

	private width = 1;
	private height = 1;
	private params: BlockParams | null = null;
	private ripples: Ripple[] = [];

	private layoutDirty = true;
	private renderedOnce = false;

	// Smooth “zoom” transition across discrete k steps (child-friendly).
	// Implemented as a looping 10× cross-zoom between consecutive k levels.
	private kAnimDurMs = 360;

	// cached per-instance base transforms
	private negBases: Array<{ x: number; y: number; s: number }> = [];
	private posBases: Array<{ x: number; y: number; s: number }> = [];
	private lastNegCount = 0;
	private lastPosCount = 0;

	// Layout meta for local hit→grid mapping (approx).
	private layoutMeta: null | { cell: number; padAxis: number; oy: number } = null;

	// Track which base instances were deformed by ripples so we can restore them.
	private dirtyNeg = new Int32Array(10000);
	private dirtyPos = new Int32Array(10000);
	private dirtyNegLen = 0;
	private dirtyPosLen = 0;
	private dirtyNegMark = new Uint8Array(10000);
	private dirtyPosMark = new Uint8Array(10000);
	private lastRippleDeformMs = 0;

	// Ripple model (traveling wavefront).
	private rippleSpeedPx = 520; // px/s
	private rippleBandPx = 140; // thickness of the main ring
	private rippleDecay = 0.75; // time decay
	private perf = {
		lowEnd: false,
		maxPixelRatio: 2,
		rippleMaxCells: 120,
		rippleStride: 1,
		activeRippleMax: 4000,
	};

	constructor(private host: HTMLElement, private beforeEl?: Element) {
		this.perf = detectPerf();
		this.canvasGL = document.createElement("canvas");
		this.canvasGL.className = "nl-particles";
		this.canvasGL.style.position = "absolute";
		this.canvasGL.style.inset = "0";
		this.canvasGL.style.width = "100%";
		this.canvasGL.style.height = "100%";
		this.canvasGL.style.pointerEvents = "none";
		this.canvasGL.style.zIndex = "1";
		// Avoid extra clip/overdraw on iPad; the host already has overflow-hidden + rounded corners.
		this.canvasGL.style.borderRadius = "0px";

		// 2D canvas is created up-front (so it always has a 2D context) and is shown only in fallback.
		this.canvas2D = document.createElement("canvas");
		this.canvas2D.className = "nl-particles";
		this.canvas2D.style.cssText = this.canvasGL.style.cssText;
		this.canvas2D.style.zIndex = "1";
		this.canvas2D.style.pointerEvents = "none";
		this.canvas2D.style.display = "none";
		this.canvas2D.style.background = "#ffffff";
		this.ctx2d = this.canvas2D.getContext("2d", { alpha: false, desynchronized: true }) as any;

		if (this.beforeEl) {
			host.insertBefore(this.canvasGL, this.beforeEl);
			host.insertBefore(this.canvas2D, this.beforeEl);
		} else {
			host.appendChild(this.canvasGL);
			host.appendChild(this.canvas2D);
		}

		// Some Chrome (especially incognito) + certain GPU/driver combos can fail WebGL silently and show a black canvas.
		// We explicitly create the context and fall back to 2D canvas if WebGL is unavailable or lost.
		const powerPreference = this.perf.lowEnd ? "low-power" : "high-performance";
		const glAttrs: WebGLContextAttributes = {
			alpha: false,
			antialias: !this.perf.lowEnd,
			depth: false,
			stencil: false,
			premultipliedAlpha: false,
			preserveDrawingBuffer: false,
			powerPreference: powerPreference as any,
		};

		const gl =
			(this.canvasGL.getContext("webgl2", glAttrs as any) as WebGL2RenderingContext | null) ||
			(this.canvasGL.getContext("webgl", glAttrs as any) as WebGLRenderingContext | null);
		this.gl = gl;

		this.canvasGL.addEventListener(
			"webglcontextlost",
			(e) => {
				e.preventDefault();
				this.contextLost = true;
				// Switch to 2D fallback so users don't see a black screen.
				this.enable2DFallback();
			},
			{ passive: false },
		);

		if (!gl) {
			this.enable2DFallback();
			this.resize();
			this.requestFrame();
			return;
		}

		// Note: on some desktop Chrome/GPU combos, alpha:true canvas may present as a black surface.
		// We render onto an opaque canvas and clear to white for consistent visuals + better perf.
		this.renderer = new THREE.WebGLRenderer({
			canvas: this.canvasGL,
			context: gl as any,
			alpha: false,
			antialias: !this.perf.lowEnd,
			precision: this.perf.lowEnd ? "mediump" : "highp",
			depth: false,
			stencil: false,
			powerPreference,
		});
		this.renderer.sortObjects = false;
		this.renderer.setClearColor(0xffffff, 1);
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.perf.maxPixelRatio));
		// Make colors pop correctly on iPad/Safari (sRGB output).
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;

		this.scene = new THREE.Scene();
		// Use a conventional pixel space: x=[0..w], y=[0..h] with y up.
		// DOM input events use y-down; we convert in addRipple().
		this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
		this.camera.position.set(0, 0, 1);

		const geo = new THREE.PlaneGeometry(1, 1);

		this.stage = new THREE.Group();
		this.scene.add(this.stage);

		const makeField = () => {
			const group = new THREE.Group();
			// Fully opaque per request (kids prefer bold, clean colors).
			const baseOpacity = 1.0;
			const activeOpacity = 1.0;

			const matNegBase = new THREE.MeshBasicMaterial({
				color: new THREE.Color(NEG_RGB.r / 255, NEG_RGB.g / 255, NEG_RGB.b / 255),
				opacity: baseOpacity,
				transparent: true,
				blending: THREE.NormalBlending,
				depthTest: false,
				depthWrite: false,
			});
			const matNegActive = new THREE.MeshBasicMaterial({
				color: new THREE.Color(NEG_RGB.r / 255, NEG_RGB.g / 255, NEG_RGB.b / 255),
				opacity: activeOpacity,
				transparent: true,
				blending: THREE.NormalBlending,
				depthTest: false,
				depthWrite: false,
			});
			const matPosBase = new THREE.MeshBasicMaterial({
				color: new THREE.Color(POS_RGB.r / 255, POS_RGB.g / 255, POS_RGB.b / 255),
				opacity: baseOpacity,
				transparent: true,
				blending: THREE.NormalBlending,
				depthTest: false,
				depthWrite: false,
			});
			const matPosActive = new THREE.MeshBasicMaterial({
				color: new THREE.Color(POS_RGB.r / 255, POS_RGB.g / 255, POS_RGB.b / 255),
				opacity: activeOpacity,
				transparent: true,
				blending: THREE.NormalBlending,
				depthTest: false,
				depthWrite: false,
			});

			const negBase = new THREE.InstancedMesh(geo, matNegBase, 10000);
			const negActive = new THREE.InstancedMesh(geo, matNegActive, 10000);
			const posBase = new THREE.InstancedMesh(geo, matPosBase, 10000);
			const posActive = new THREE.InstancedMesh(geo, matPosActive, 10000);

			for (const m of [negBase, negActive, posBase, posActive]) m.frustumCulled = false;
			group.add(negBase, posBase, negActive, posActive);

			return { group, negBase, negActive, posBase, posActive, baseOpacity, activeOpacity };
		};

		this.fields = [makeField(), makeField()];
		this.stage.add(this.fields[0].group, this.fields[1].group);
		this.fields[1].group.visible = false;

		this.resize();
		this.requestFrame();
	}

	setRipplesEnabled(enabled: boolean) {
		this.ripplesEnabled = enabled;
		if (!enabled) {
			this.ripples = [];
			this.dirtyNegMark.fill(0);
			this.dirtyPosMark.fill(0);
			this.dirtyNegLen = 0;
			this.dirtyPosLen = 0;
		}
		this.requestFrame();
	}

	areRipplesEnabled() {
		return this.ripplesEnabled;
	}

	private enable2DFallback() {
		this.mode = "2d";
		this.canvasGL.style.display = "none";
		this.canvas2D.style.display = "block";
		// Make sure fallback is not black.
		this.canvas2D.style.background = "#ffffff";
		this.gl = null;
		this.resize();
	}

	force2D() {
		if (this.mode === "2d") return;
		this.enable2DFallback();
	}

	getMode() {
		return this.mode;
	}

	// Best-effort: some Chrome/GPU paths present a black WebGL surface with no errors.
	// Use a tiny 2D probe to sample the *presented* WebGL canvas.
	probePresentedBlack() {
		try {
			if (this.mode !== "webgl") return false;
			if (this.width <= 0 || this.height <= 0) return false;
			const x = Math.max(0, Math.min(this.width - 1, Math.floor(this.width / 2)));
			const y = Math.max(0, Math.min(this.height - 1, Math.floor(this.height / 2)));
			const probe = document.createElement("canvas");
			probe.width = 1;
			probe.height = 1;
			const pctx = probe.getContext("2d", { alpha: false });
			if (!pctx) return false;
			pctx.drawImage(this.canvasGL, x, y, 1, 1, 0, 0, 1, 1);
			const d = pctx.getImageData(0, 0, 1, 1).data;
			return d[0] < 8 && d[1] < 8 && d[2] < 8;
		} catch {
			return true;
		}
	}

	set(params: BlockParams) {
		const nextW = Math.max(1, Math.floor(params.width));
		const nextH = Math.max(1, Math.floor(params.height));
		const sizeChanged = nextW !== this.width || nextH !== this.height;
		const kChanged = !this.params || this.params.k !== params.k;

		if (!this.params) {
			this.params = params;
			this.width = nextW;
			this.height = nextH;
			this.activeField = 0;
			if (this.mode === "webgl") {
				this.fields[0].group.visible = true;
				this.fields[1].group.visible = false;
			}
			this.kTransition = null;
			this.layoutDirty = true;
			this.requestFrame();
			return;
		}

		if (kChanged) {
			const nowMs = performance.now();
			const dir = (params.k > this.params.k ? 1 : -1) as 1 | -1;
			const fromField = this.activeField;
			// Low-end iPad: avoid rendering two full fields during transition (massive overdraw).
			const singleField = this.perf.lowEnd;
			const toField = singleField ? fromField : 1 - fromField;
			this.kTransition = {
				fromField,
				toField,
				singleField,
				dir,
				startMs: nowMs,
				durMs: this.kAnimDurMs,
				fromParams: this.params,
				toParams: params,
			};
			if (this.mode === "webgl") {
				this.fields[toField].group.visible = true;
				if (!singleField) this.fields[fromField].group.visible = true;
			}
		}

		this.params = params;
		// If we're mid-transition and the caller updates values (dragging), keep the target side in sync.
		if (this.kTransition && params.k === this.kTransition.toParams.k) {
			this.kTransition.toParams = params;
		}
		this.width = nextW;
		this.height = nextH;

		// Only rebuild the field layout if size changed (k transition uses a pure 10× loop).
		this.layoutDirty = this.layoutDirty || sizeChanged;
		this.requestFrame();
	}

	addRipple(x: number, y: number) {
		if (!this.ripplesEnabled) return;
		const now = performance.now() / 1000;
		const yUp = this.height - y;
		this.ripples.push({ x, y: yUp, start: now }, { x: this.width - x, y: yUp, start: now });
		const maxRipples = this.perf.lowEnd ? 8 : 16;
		if (this.ripples.length > maxRipples) this.ripples.splice(0, this.ripples.length - maxRipples);
		this.requestFrame();
	}

	resize() {
		const rect = this.host.getBoundingClientRect();
		this.width = Math.max(1, Math.floor(rect.width));
		this.height = Math.max(1, Math.floor(rect.height));
		if (this.mode === "webgl") {
			this.renderer.setSize(this.width, this.height, false);
			this.camera.left = 0;
			this.camera.right = this.width;
			this.camera.top = this.height;
			this.camera.bottom = 0;
			this.camera.updateProjectionMatrix();
		} else if (this.mode === "2d") {
			const dpr = Math.min(window.devicePixelRatio || 1, this.perf.lowEnd ? 1 : 2);
			this.dpr2d = dpr;
			this.canvas2D.width = Math.max(1, Math.floor(this.width * dpr));
			this.canvas2D.height = Math.max(1, Math.floor(this.height * dpr));
			if (this.ctx2d) this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
		this.layoutDirty = true;
		this.requestFrame();
	}

	destroy() {
		this.destroyed = true;
		if (this.rafId != null) cancelAnimationFrame(this.rafId);
		this.rafId = null;
		if (this.mode === "webgl") {
			for (const f of this.fields) {
				f.negBase.geometry.dispose();
				f.negActive.geometry.dispose();
				f.posBase.geometry.dispose();
				f.posActive.geometry.dispose();
				f.negBase.material.dispose();
				f.negActive.material.dispose();
				f.posBase.material.dispose();
				f.posActive.material.dispose();
			}
			this.renderer.dispose();
		}
	}

	private requestFrame() {
		if (this.destroyed) return;
		this.needsFrame = true;
		if (this.rafId != null) return;
		const loop = () => {
			this.rafId = null;
			if (this.destroyed) return;
			if (!this.needsFrame) return;
			this.needsFrame = false;

			const t = performance.now() / 1000;
			const diag = Math.hypot(this.width, this.height);
			const life = diag / this.rippleSpeedPx + 1.2; // long enough to reach edges + settle
			this.ripples = this.ripples.filter((r) => t - r.start < life);
			this.renderFrame(t);

			// Continue animating only while ripples are alive, we need to restore deformations,
			// a layout update comes in, or a k transition runs.
			if (this.ripples.length > 0 || this.dirtyNegLen > 0 || this.dirtyPosLen > 0 || this.layoutDirty || this.kTransition) {
				this.needsFrame = true;
				this.rafId = requestAnimationFrame(loop);
			}
		};
		this.rafId = requestAnimationFrame(loop);
	}

	private renderFrame(time: number) {
		if (this.mode !== "webgl") {
			this.renderFrame2D(time);
			return;
		}
		// If WebGL is alive but presenting black in some Chrome (incognito) situations,
		// detect once and fall back to 2D to avoid a blank demo.
		if (!this.checkedBlackFrame && this.gl && this.width > 0 && this.height > 0) {
			this.checkedBlackFrame = true;
			// Check after the browser has had a chance to present (rAF twice is more reliable than microtask).
			requestAnimationFrame(() => {
				requestAnimationFrame(() => this.checkBlackFrameOnce());
			});
		}
		if (!this.params) {
			for (const f of this.fields) {
				f.negBase.count = 0;
				f.posBase.count = 0;
				f.negActive.count = 0;
				f.posActive.count = 0;
			}
			this.renderer.render(this.scene, this.camera);
			return;
		}

		if (this.layoutDirty) this.rebuildLayout();

		const nowMs = time * 1000;
		const midX = this.params.midX;
		const midY = this.height * 0.5; // y-up center
		this.stage.position.set(midX, midY, 0);

		const hasRipples = this.ripplesEnabled && this.ripples.length > 0;
		const waveAt = (x: number, y: number) => {
			// Traveling wavefront (ring) that expands until it exits the container.
			if (!this.ripplesEnabled) return 0;
			let wave = 0;
			for (const r of this.ripples) {
				const dt = time - r.start;
				if (dt < 0) continue;
				const dx = x - r.x;
				const dy = y - r.y;
				const d = Math.hypot(dx, dy);

				const radius = this.rippleSpeedPx * dt;
				const band = this.rippleBandPx;
				const u = d - radius;

				// Envelope centered on the ring, with gentle time decay.
				const ringEnv = Math.exp(-(u * u) / (2 * band * band));
				const timeEnv = Math.exp(-dt * this.rippleDecay);
				const distEnv = 1 / Math.sqrt(1 + d * 0.012);

				// Oscillation along the wavefront.
				const freq = 0.11;
				const phase = -dt * 10.5;
				const w = Math.sin(u * freq + phase);

				wave += w * ringEnv * timeEnv * distEnv;
			}
			return wave;
		};

		const restoreBaseIfNeeded = () => {
			if (hasRipples) return;
			if (this.dirtyNegLen === 0 && this.dirtyPosLen === 0) return;

			const tmp = new THREE.Object3D();
			for (const f of this.fields) {
				for (let i = 0; i < this.dirtyNegLen; i++) {
					const idx = this.dirtyNeg[i];
					const b = this.negBases[idx];
					tmp.position.set(b.x, b.y, 0);
					tmp.scale.set(b.s, b.s, 1);
					tmp.updateMatrix();
					f.negBase.setMatrixAt(idx, tmp.matrix);
					f.negActive.setMatrixAt(idx, tmp.matrix);
				}
				for (let i = 0; i < this.dirtyPosLen; i++) {
					const idx = this.dirtyPos[i];
					const b = this.posBases[idx];
					tmp.position.set(b.x, b.y, 0);
					tmp.scale.set(b.s, b.s, 1);
					tmp.updateMatrix();
					f.posBase.setMatrixAt(idx, tmp.matrix);
					f.posActive.setMatrixAt(idx, tmp.matrix);
				}
				f.negBase.instanceMatrix.needsUpdate = true;
				f.posBase.instanceMatrix.needsUpdate = true;
				f.negActive.instanceMatrix.needsUpdate = true;
				f.posActive.instanceMatrix.needsUpdate = true;
			}

			this.dirtyNegMark.fill(0);
			this.dirtyPosMark.fill(0);
			this.dirtyNegLen = 0;
			this.dirtyPosLen = 0;
		};

		const applyCounts = (field: (typeof this.fields)[number], p: BlockParams) => {
			const unitPow = Math.max(0, p.k - 4);
			const unitValue = Math.pow(10, unitPow);
			const negValue = Math.min(p.valueA, p.valueB, 0);
			const posValue = Math.max(p.valueA, p.valueB, 0);
			const negCount = clampInt(Math.floor(Math.abs(Math.trunc(negValue)) / unitValue), 0, 10000);
			const posCount = clampInt(Math.floor(Math.abs(Math.trunc(posValue)) / unitValue), 0, 10000);
			field.negActive.count = negCount;
			field.posActive.count = posCount;
			return { negCount, posCount };
		};

		const setFieldAlpha = (field: (typeof this.fields)[number], a: number) => {
			const base = clamp(a, 0, 1) * field.baseOpacity;
			const active = clamp(a, 0, 1) * field.activeOpacity;
			(field.negBase.material as THREE.MeshBasicMaterial).opacity = base;
			(field.posBase.material as THREE.MeshBasicMaterial).opacity = base;
			(field.negActive.material as THREE.MeshBasicMaterial).opacity = active;
			(field.posActive.material as THREE.MeshBasicMaterial).opacity = active;
		};

		const updateRippleMatrices = (
			field: (typeof this.fields)[number],
			scale: number,
			negCount: number,
			posCount: number,
		) => {
			if (!hasRipples) return;
			// On low-end iPad, avoid per-instance updates for huge active counts.
			if (this.perf.lowEnd && (negCount + posCount) > this.perf.activeRippleMax) return;
			const tmp = new THREE.Object3D();

			// Low-end: only update a local window around the wavefront (not all active instances).
			if (this.perf.lowEnd && this.layoutMeta) {
				const now = performance.now();
				if (now - this.lastRippleDeformMs < 34) return; // ~30fps ripple deformation on low-end
				this.lastRippleDeformMs = now;

				const midX = this.params?.midX ?? this.width / 2;
				const midY = this.height * 0.5;
				const { cell, padAxis, oy } = this.layoutMeta;
				const y0 = this.height * 0.5 - oy;

				const deform = (
					idx: number,
					base: { x: number; y: number; s: number },
					mesh: THREE.InstancedMesh,
				) => {
					const w = waveAt(midX + base.x * scale, midY + base.y * scale);
					const s = base.s * (1 + clamp(w, -0.70, 1.05));
					tmp.position.set(base.x, base.y, 0);
					tmp.scale.set(s, s, 1);
					tmp.updateMatrix();
					mesh.setMatrixAt(idx, tmp.matrix);
				};

				for (const r of this.ripples) {
					const dt = time - r.start;
					if (dt < 0) continue;
					const radius = this.rippleSpeedPx * dt;
					const band = this.rippleBandPx;
					const maxRange = radius + band;
					const radiusCells = clampInt(
						Math.ceil((maxRange / Math.max(1e-3, scale)) / cell) + 2,
						6,
						this.perf.rippleMaxCells,
					);

					const lx = (r.x - midX) / Math.max(1e-3, scale);
					const ly = (r.y - midY) / Math.max(1e-3, scale);
					const side = lx >= 0 ? "pos" : "neg";
					const ax = Math.abs(lx);
					const colCenter = clampInt(Math.floor((ax - padAxis) / cell), 0, 99);
					const rowCenter = clampInt(Math.floor((y0 - ly) / cell), 0, 99);
					const colMin = clampInt(colCenter - radiusCells, 0, 99);
					const colMax = clampInt(colCenter + radiusCells, 0, 99);
					const rowMin = clampInt(rowCenter - radiusCells, 0, 99);
					const rowMax = clampInt(rowCenter + radiusCells, 0, 99);

					const stride = this.perf.rippleStride;
					const band2 = band * 2.2;
					if (side === "neg") {
						for (let row = rowMin; row <= rowMax; row += stride) {
							for (let col = colMin; col <= colMax; col += stride) {
								const idx = row * 100 + col;
								if (idx >= negCount) continue;
								const b = this.negBases[idx];
								const dx = midX + b.x * scale - r.x;
								const dy = midY + b.y * scale - r.y;
								const d2 = dx * dx + dy * dy;
								const rMin = radius - band2;
								const rMax = radius + band2;
								const rMin2 = rMin * rMin;
								const rMax2 = rMax * rMax;
								if (d2 < rMin2 || d2 > rMax2) continue;
								if (this.dirtyNegMark[idx] === 0) {
									this.dirtyNegMark[idx] = 1;
									this.dirtyNeg[this.dirtyNegLen++] = idx;
								}
								deform(idx, b, field.negActive);
							}
						}
						field.negActive.instanceMatrix.needsUpdate = true;
					} else {
						for (let row = rowMin; row <= rowMax; row += stride) {
							for (let col = colMin; col <= colMax; col += stride) {
								const idx = row * 100 + col;
								if (idx >= posCount) continue;
								const b = this.posBases[idx];
								const dx = midX + b.x * scale - r.x;
								const dy = midY + b.y * scale - r.y;
								const d2 = dx * dx + dy * dy;
								const rMin = radius - band2;
								const rMax = radius + band2;
								const rMin2 = rMin * rMin;
								const rMax2 = rMax * rMax;
								if (d2 < rMin2 || d2 > rMax2) continue;
								if (this.dirtyPosMark[idx] === 0) {
									this.dirtyPosMark[idx] = 1;
									this.dirtyPos[this.dirtyPosLen++] = idx;
								}
								deform(idx, b, field.posActive);
							}
						}
						field.posActive.instanceMatrix.needsUpdate = true;
					}
				}
				return;
			}

			for (let i = 0; i < negCount; i++) {
				const b = this.negBases[i];
				const w = waveAt(midX + b.x * scale, midY + b.y * scale);
				const s = b.s * (1 + clamp(w, -0.70, 1.05));
				tmp.position.set(b.x, b.y, 0);
				tmp.scale.set(s, s, 1);
				tmp.updateMatrix();
				field.negActive.setMatrixAt(i, tmp.matrix);
				if (this.dirtyNegMark[i] === 0) {
					this.dirtyNegMark[i] = 1;
					this.dirtyNeg[this.dirtyNegLen++] = i;
				}
			}
			field.negActive.instanceMatrix.needsUpdate = true;

			for (let i = 0; i < posCount; i++) {
				const b = this.posBases[i];
				const w = waveAt(midX + b.x * scale, midY + b.y * scale);
				const s = b.s * (1 + clamp(w, -0.70, 1.05));
				tmp.position.set(b.x, b.y, 0);
				tmp.scale.set(s, s, 1);
				tmp.updateMatrix();
				field.posActive.setMatrixAt(i, tmp.matrix);
				if (this.dirtyPosMark[i] === 0) {
					this.dirtyPosMark[i] = 1;
					this.dirtyPos[this.dirtyPosLen++] = i;
				}
			}
			field.posActive.instanceMatrix.needsUpdate = true;
		};

		if (this.kTransition) {
			const tr = this.kTransition;
			const t = clamp((nowMs - tr.startMs) / tr.durMs, 0, 1);
			const e = this.easeInOutCubic(t);
			// Exact 10× loop, no "flash" pulse — feels like a real zoom.
			// Use raw `t` for scale so the 10× change feels physically consistent (log-linear).
			const fromScale = Math.pow(10, -tr.dir * t);
			const toScale = Math.pow(10, tr.dir * (1 - t));

			const fromField = this.fields[tr.fromField];
			const toField = this.fields[tr.toField];

			// Interpolate counts so “how many blocks” stays continuous through the step.
			const mix = smoothstep(0.22, 0.78, e);
			const fromCountsFull = applyCounts(fromField, tr.fromParams);
			const toCountsFull = applyCounts(toField, tr.toParams);
			const interpCounts = {
				negCount: clampInt(
					Math.round(fromCountsFull.negCount + (toCountsFull.negCount - fromCountsFull.negCount) * mix),
					0,
					10000,
				),
				posCount: clampInt(
					Math.round(fromCountsFull.posCount + (toCountsFull.posCount - fromCountsFull.posCount) * mix),
					0,
					10000,
				),
			};

			if (tr.singleField) {
				// Low-end: single-field mode — no cross-fade (avoids 2× overdraw).
				fromField.group.visible = true;
				fromField.group.scale.set(fromScale, fromScale, 1);
				setFieldAlpha(fromField, 1);
				fromField.negActive.count = interpCounts.negCount;
				fromField.posActive.count = interpCounts.posCount;
				this.lastNegCount = interpCounts.negCount;
				this.lastPosCount = interpCounts.posCount;

				updateRippleMatrices(fromField, fromScale, interpCounts.negCount, interpCounts.posCount);
				this.deformBaseLocally(fromField, fromScale, waveAt, time);

				this.renderer.render(this.scene, this.camera);
				this.renderedOnce = true;

				if (t >= 1) {
					this.kTransition = null;
					fromField.group.scale.set(1, 1, 1);
					applyCounts(fromField, tr.toParams);
				}
				if (this.kTransition) this.requestFrame();
				return;
			}

			fromField.group.visible = true;
			toField.group.visible = true;
			fromField.group.scale.set(fromScale, fromScale, 1);
			toField.group.scale.set(toScale, toScale, 1);

			// Keep particles visually solid: cross-fade only in a short middle window.
			setFieldAlpha(fromField, 1 - mix);
			setFieldAlpha(toField, mix);

			toField.negActive.count = interpCounts.negCount;
			toField.posActive.count = interpCounts.posCount;
			this.lastNegCount = interpCounts.negCount;
			this.lastPosCount = interpCounts.posCount;

			updateRippleMatrices(fromField, fromScale, fromCountsFull.negCount, fromCountsFull.posCount);
			updateRippleMatrices(toField, toScale, interpCounts.negCount, interpCounts.posCount);

			// Also deform the *base* field locally so ripples are visible everywhere (not just “active count”).
			this.deformBaseLocally(fromField, fromScale, waveAt, time);
			this.deformBaseLocally(toField, toScale, waveAt, time);

			this.renderer.render(this.scene, this.camera);
			this.renderedOnce = true;

			if (t >= 1) {
				this.activeField = tr.toField;
				this.kTransition = null;
				const other = this.fields[1 - this.activeField];
				other.group.visible = false;
				other.group.scale.set(1, 1, 1);
				setFieldAlpha(other, 0);

				const active = this.fields[this.activeField];
				active.group.scale.set(1, 1, 1);
				setFieldAlpha(active, 1);
				applyCounts(active, tr.toParams);
			}

			// keep running while transition is active
			if (this.kTransition) this.requestFrame();
			return;
		}

		// No k transition: show one stable field at scale=1.
		const active = this.fields[this.activeField];
		const other = this.fields[1 - this.activeField];
		active.group.visible = true;
		other.group.visible = false;
		active.group.scale.set(1, 1, 1);
		setFieldAlpha(active, 1);

		const counts = applyCounts(active, this.params);
		this.lastNegCount = counts.negCount;
		this.lastPosCount = counts.posCount;
		updateRippleMatrices(active, 1, counts.negCount, counts.posCount);
		this.deformBaseLocally(active, 1, waveAt, time);
		restoreBaseIfNeeded();

		this.renderer.render(this.scene, this.camera);
		this.renderedOnce = true;
	}

	private checkBlackFrameOnce() {
		if (this.mode !== "webgl") return;
		try {
			const x = Math.max(0, Math.min(this.width - 1, Math.floor(this.width / 2)));
			const y = Math.max(0, Math.min(this.height - 1, Math.floor(this.height / 2)));

			// Prefer sampling the *presented* pixel via drawImage (matches what users see).
			const probe = document.createElement("canvas");
			probe.width = 1;
			probe.height = 1;
			const pctx = probe.getContext("2d", { alpha: false });
			if (pctx) {
				pctx.drawImage(this.canvasGL, x, y, 1, 1, 0, 0, 1, 1);
				const d = pctx.getImageData(0, 0, 1, 1).data;
				if (d[0] < 8 && d[1] < 8 && d[2] < 8) {
					this.enable2DFallback();
					this.requestFrame();
					return;
				}
			}

			// Fallback: sample from WebGL back buffer.
			const gl = this.gl;
			if (!gl) return;
			const px = new Uint8Array(4);
			gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
			if (px[0] < 8 && px[1] < 8 && px[2] < 8) {
				this.enable2DFallback();
				this.requestFrame();
			}
		} catch {
			// If readPixels fails for any reason, prefer fallback over black.
			this.enable2DFallback();
			this.requestFrame();
		}
	}

	private renderFrame2D(time: number) {
		const ctx = this.ctx2d;
		if (!ctx) return;
		if (!this.params) {
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, this.width, this.height);
			return;
		}
		if (this.layoutDirty) this.rebuildLayout();

		const p = this.params;
		const midX = p.midX;
		const midY = this.height * 0.5;

		// Background
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, this.width, this.height);

		const unitPow = Math.max(0, p.k - 4);
		const unitValue = Math.pow(10, unitPow);
		const negValue = Math.min(p.valueA, p.valueB, 0);
		const posValue = Math.max(p.valueA, p.valueB, 0);
		const baseNegCount = clampInt(Math.floor(Math.abs(Math.trunc(negValue)) / unitValue), 0, 10000);
		const basePosCount = clampInt(Math.floor(Math.abs(Math.trunc(posValue)) / unitValue), 0, 10000);

		const drawSquares = (
			bases: Array<{ x: number; y: number; s: number }>,
			count: number,
			color: string,
			alpha: number,
			scale: number,
		) => {
			ctx.globalAlpha = alpha;
			ctx.fillStyle = color;
			for (let i = 0; i < bases.length; i++) {
				const b = bases[i];
				const wx = midX + b.x * scale;
				const wyUp = midY + b.y * scale;
				const sy = this.height - wyUp;
				const s = b.s * scale;
				ctx.fillRect(wx - s * 0.5, sy - s * 0.5, s, s);
			}
			ctx.globalAlpha = 1;

			ctx.globalAlpha = 0.95;
			for (let i = 0; i < Math.min(count, bases.length); i++) {
				const b = bases[i];
				const wx = midX + b.x * scale;
				const wyUp = midY + b.y * scale;
				const sy = this.height - wyUp;
				const s = b.s * scale;
				ctx.fillRect(wx - s * 0.5, sy - s * 0.5, s, s);
			}
			ctx.globalAlpha = 1;
		};

		// Simple 10× scaling for transitions.
		let scale = 1;
		let negCount = baseNegCount;
		let posCount = basePosCount;
		if (this.kTransition) {
			const tr = this.kTransition;
			const t = clamp((time * 1000 - tr.startMs) / tr.durMs, 0, 1);
			const e = this.easeInOutCubic(t);
			const mix = smoothstep(0.22, 0.78, e);
			scale = Math.pow(10, -tr.dir * t);

			const unitPowTo = Math.max(0, tr.toParams.k - 4);
			const unitValueTo = Math.pow(10, unitPowTo);
			const negValueTo = Math.min(tr.toParams.valueA, tr.toParams.valueB, 0);
			const posValueTo = Math.max(tr.toParams.valueA, tr.toParams.valueB, 0);
			const toNeg = clampInt(Math.floor(Math.abs(Math.trunc(negValueTo)) / unitValueTo), 0, 10000);
			const toPos = clampInt(Math.floor(Math.abs(Math.trunc(posValueTo)) / unitValueTo), 0, 10000);
			negCount = clampInt(Math.round(baseNegCount + (toNeg - baseNegCount) * mix), 0, 10000);
			posCount = clampInt(Math.round(basePosCount + (toPos - basePosCount) * mix), 0, 10000);
			if (t >= 1) this.kTransition = null;
		}

		drawSquares(this.negBases, negCount, "rgb(56,189,248)", 0.22, scale);
		drawSquares(this.posBases, posCount, "rgb(251,113,133)", 0.22, scale);

		// Ripple fallback disabled when ripples are disabled.
		if (this.ripplesEnabled && this.ripples.length > 0) {
			ctx.save();
			for (const r of this.ripples) {
				const dt = time - r.start;
				if (dt < 0) continue;
				const radius = this.rippleSpeedPx * dt;
				ctx.globalAlpha = 0.65 * Math.exp(-dt * 0.7);
				ctx.strokeStyle = "rgba(255,255,255,0.95)";
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.arc(r.x, this.height - r.y, radius, 0, Math.PI * 2);
				ctx.stroke();
			}
			ctx.restore();
		}

		if (this.kTransition || (this.ripplesEnabled && this.ripples.length > 0)) this.requestFrame();
	}

	private rebuildLayout() {
		this.layoutDirty = false;
		this.negBases = [];
		this.posBases = [];
		if (!this.params) return;

		const { midX } = this.params;

		// Fill the whole axis container (no empty bands). Overlay (ticks/labels/balls) sits above.
		const regionTop = 0;
		const regionH = Math.max(1, this.height);

		const marginX = 14;
		const marginY = 0;

		const gy = regionTop + marginY;
		const gh = Math.max(1, regionH - marginY * 2);

		const buildFieldFromAxis = (
			into: Array<{ x: number; y: number; s: number }>,
			side: "left" | "right",
		) => {
			// Full regular field: fixed 100×100, with visible 10×10 boundaries.
			const dim = 100;
			const chunk = 10;
			const gaps = dim / chunk - 1; // 9
			const gapFrac = 0.65;

			const sideW = side === "left" ? midX : Math.max(1, this.width - midX);
			const padAxis = Math.max(8, marginX);

			// Choose a cell size that fills the container in at least one dimension.
			// If it overflows the other dimension, it will be clipped by overflow-hidden,
			// which makes the field feel “infinite” while avoiding blank margins.
			const denom = dim + gaps * gapFrac;
			const cellH = gh / denom;
			const cellW = Math.max(1, sideW - padAxis) / denom;
			const cell = Math.max(2.2, cellH, cellW);
			const gapPx = cell * gapFrac;
			const s = Math.max(1.6, cell * 0.84);

			// No vertical centering gap — start from top and tile through height.
			const oy = gy;

			// Save for ripple-local deformation mapping (same for both sides since midX splits evenly).
			this.layoutMeta = { cell, padAxis, oy };

			for (let row = 0; row < dim; row++) {
				for (let colFill = 0; colFill < dim; colFill++) {
					const colGap = Math.floor(colFill / chunk);
					const rowGap = Math.floor(row / chunk);
					const dx = padAxis + (colFill + 0.5) * cell + colGap * gapPx;
					const xDom = side === "left" ? midX - dx : midX + dx;
					const yDom = oy + (row + 0.5) * cell + rowGap * gapPx;

					const atChunkEdge = colFill % chunk === 0 || row % chunk === 0;
					const s2 = atChunkEdge ? s * 0.74 : s;

					const yUp = this.height - yDom;
					// Local coords relative to canvas center, y-up.
					into.push({ x: xDom - midX, y: yUp - this.height * 0.5, s: s2 });
					if (into.length >= 10000) return;
				}
			}
		};

		buildFieldFromAxis(this.negBases, "left");
		buildFieldFromAxis(this.posBases, "right");

		if (this.mode !== "webgl") return;

		// Bake static matrices to both fields. Active meshes reuse these unless a ripple is animating.
		const tmp = new THREE.Object3D();
		for (const f of this.fields) {
			for (let i = 0; i < this.negBases.length; i++) {
				const b = this.negBases[i];
				tmp.position.set(b.x, b.y, 0);
				tmp.scale.set(b.s, b.s, 1);
				tmp.updateMatrix();
				f.negBase.setMatrixAt(i, tmp.matrix);
				f.negActive.setMatrixAt(i, tmp.matrix);
			}
			for (let i = 0; i < this.posBases.length; i++) {
				const b = this.posBases[i];
				tmp.position.set(b.x, b.y, 0);
				tmp.scale.set(b.s, b.s, 1);
				tmp.updateMatrix();
				f.posBase.setMatrixAt(i, tmp.matrix);
				f.posActive.setMatrixAt(i, tmp.matrix);
			}

			f.negBase.count = Math.min(this.negBases.length, 10000);
			f.posBase.count = Math.min(this.posBases.length, 10000);
			f.negBase.instanceMatrix.needsUpdate = true;
			f.posBase.instanceMatrix.needsUpdate = true;
			f.negActive.instanceMatrix.needsUpdate = true;
			f.posActive.instanceMatrix.needsUpdate = true;
		}
	}

	private deformBaseLocally(
		field: (typeof this.fields)[number],
		fieldScale: number,
		waveAt: (x: number, y: number) => number,
		timeSec: number,
	) {
		if (this.ripples.length === 0 || !this.layoutMeta) return;

		const midX = this.params?.midX ?? this.width / 2;
		const midY = this.height * 0.5;
		const { cell, padAxis, oy } = this.layoutMeta;

		// Compute affected grid window per ripple, update only those indices.
		const y0 = this.height * 0.5 - oy; // approx inversion constant

		const tmp = new THREE.Object3D();
		const deform = (idx: number, base: { x: number; y: number; s: number }, mesh: THREE.InstancedMesh) => {
			const w = waveAt(midX + base.x * fieldScale, midY + base.y * fieldScale);
			// Smaller amplitude for base grid (so it doesn't overpower active count).
			const s = base.s * (1 + clamp(w, -0.40, 0.70));
			tmp.position.set(base.x, base.y, 0);
			tmp.scale.set(s, s, 1);
			tmp.updateMatrix();
			mesh.setMatrixAt(idx, tmp.matrix);
		};

		for (const r of this.ripples) {
			const dt = timeSec - r.start;
			if (dt < 0) continue;
			const radius = this.rippleSpeedPx * dt;
			const band = this.rippleBandPx;
			const maxRange = radius + band;
			const radiusCells = clampInt(
				Math.ceil((maxRange / Math.max(1e-3, fieldScale)) / cell) + 2,
				6,
				this.perf.rippleMaxCells,
			);

			// Convert ripple center to local coords (relative center) for index estimation.
			const lx = (r.x - midX) / Math.max(1e-3, fieldScale);
			const ly = (r.y - midY) / Math.max(1e-3, fieldScale);

			// Right side (positive): lx > 0. Left side (negative): lx < 0.
			const side = lx >= 0 ? "pos" : "neg";
			const ax = Math.abs(lx);
			const colCenter = clampInt(Math.floor((ax - padAxis) / cell), 0, 99);
			const rowCenter = clampInt(Math.floor((y0 - ly) / cell), 0, 99);

			const colMin = clampInt(colCenter - radiusCells, 0, 99);
			const colMax = clampInt(colCenter + radiusCells, 0, 99);
			const rowMin = clampInt(rowCenter - radiusCells, 0, 99);
			const rowMax = clampInt(rowCenter + radiusCells, 0, 99);

			const stride = this.perf.rippleStride;
			const band2 = band * 2.2;
			if (side === "neg") {
				for (let row = rowMin; row <= rowMax; row += stride) {
					for (let col = colMin; col <= colMax; col += stride) {
						const idx = row * 100 + col;
						// Only deform the current wavefront band (keeps perf good as it expands).
						const b = this.negBases[idx];
						const dx = midX + b.x * fieldScale - r.x;
						const dy = midY + b.y * fieldScale - r.y;
						const d2 = dx * dx + dy * dy;
						const rMin = radius - band2;
						const rMax = radius + band2;
						const rMin2 = rMin * rMin;
						const rMax2 = rMax * rMax;
						if (d2 < rMin2 || d2 > rMax2) continue;
						if (this.dirtyNegMark[idx] === 0) {
							this.dirtyNegMark[idx] = 1;
							this.dirtyNeg[this.dirtyNegLen++] = idx;
						}
						deform(idx, b, field.negBase);
					}
				}
				field.negBase.instanceMatrix.needsUpdate = true;
			} else {
				for (let row = rowMin; row <= rowMax; row += stride) {
					for (let col = colMin; col <= colMax; col += stride) {
						const idx = row * 100 + col;
						const b = this.posBases[idx];
						const dx = midX + b.x * fieldScale - r.x;
						const dy = midY + b.y * fieldScale - r.y;
						const d2 = dx * dx + dy * dy;
						const rMin = radius - band2;
						const rMax = radius + band2;
						const rMin2 = rMin * rMin;
						const rMax2 = rMax * rMax;
						if (d2 < rMin2 || d2 > rMax2) continue;
						if (this.dirtyPosMark[idx] === 0) {
							this.dirtyPosMark[idx] = 1;
							this.dirtyPos[this.dirtyPosLen++] = idx;
						}
						deform(idx, b, field.posBase);
					}
				}
				field.posBase.instanceMatrix.needsUpdate = true;
			}
		}

		// Keep animating while ripples are alive.
		if (this.ripples.length > 0 && timeSec) this.requestFrame();
	}

	private easeInOutCubic(t: number) {
		return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
	}
}

function clamp(v: number, lo: number, hi: number) {
	return Math.min(Math.max(v, lo), hi);
}

function clampInt(v: number, lo: number, hi: number) {
	return Math.min(Math.max(v, lo), hi);
}

function detectPerf() {
	const ua = (navigator.userAgent || "").toLowerCase();
	const isIPad = ua.includes("ipad") || (ua.includes("macintosh") && "ontouchend" in document);
	const cores = (navigator as any).hardwareConcurrency || 4;
	const lowEnd = isIPad && cores <= 2;
	return {
		lowEnd,
		// iPad Pro 1st gen (A9X) benefits hugely from lower pixel ratio.
		maxPixelRatio: lowEnd ? 1 : 1.5,
		// Limit ripple deformation window size and sampling density.
		rippleMaxCells: lowEnd ? 40 : 110,
		rippleStride: lowEnd ? 4 : 1,
		// Skip per-instance active ripple when the active set is huge.
		activeRippleMax: lowEnd ? 900 : 4000,
	};
}

function smoothstep(edge0: number, edge1: number, x: number) {
	const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
	return t * t * (3 - 2 * t);
}
