import * as THREE from "three";
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
	private canvas: HTMLCanvasElement;
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

	constructor(private host: HTMLElement, private beforeEl?: Element) {
		this.canvas = document.createElement("canvas");
		this.canvas.className = "nl-particles";
		this.canvas.style.position = "absolute";
		this.canvas.style.inset = "0";
		this.canvas.style.width = "100%";
		this.canvas.style.height = "100%";
		this.canvas.style.pointerEvents = "none";
		this.canvas.style.zIndex = "1";
		this.canvas.style.borderRadius = "16px";

		if (this.beforeEl) host.insertBefore(this.canvas, this.beforeEl);
		else host.appendChild(this.canvas);

		this.renderer = new THREE.WebGLRenderer({
			canvas: this.canvas,
			alpha: true,
			antialias: true,
			powerPreference: "low-power",
		});
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		// Make colors pop correctly on iPad/Safari (sRGB output).
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;

		this.scene = new THREE.Scene();
		// Use a conventional pixel space: x=[0..w], y=[0..h] with y up.
		// DOM input events use y-down; we convert in addRipple().
		this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
		this.camera.position.set(0, 0, 1);

		const geo = new THREE.PlaneGeometry(1, 1);
		const alphaTex = makeRoundedAlphaTexture();

		this.stage = new THREE.Group();
		this.scene.add(this.stage);

		const makeField = () => {
			const group = new THREE.Group();
			const baseOpacity = 0.22;
			const activeOpacity = 0.5;

			const matNegBase = new THREE.MeshBasicMaterial({
				color: new THREE.Color(NEG_RGB.r / 255, NEG_RGB.g / 255, NEG_RGB.b / 255),
				transparent: true,
				opacity: baseOpacity,
				depthTest: false,
				depthWrite: false,
			});
			const matNegActive = new THREE.MeshBasicMaterial({
				color: new THREE.Color(NEG_RGB.r / 255, NEG_RGB.g / 255, NEG_RGB.b / 255),
				transparent: true,
				opacity: activeOpacity,
				depthTest: false,
				depthWrite: false,
			});
			const matPosBase = new THREE.MeshBasicMaterial({
				color: new THREE.Color(POS_RGB.r / 255, POS_RGB.g / 255, POS_RGB.b / 255),
				transparent: true,
				opacity: baseOpacity,
				depthTest: false,
				depthWrite: false,
			});
			const matPosActive = new THREE.MeshBasicMaterial({
				color: new THREE.Color(POS_RGB.r / 255, POS_RGB.g / 255, POS_RGB.b / 255),
				transparent: true,
				opacity: activeOpacity,
				depthTest: false,
				depthWrite: false,
			});

			if (alphaTex) {
				for (const mat of [matNegBase, matNegActive, matPosBase, matPosActive]) {
					mat.alphaMap = alphaTex;
					mat.alphaTest = 0.02;
					mat.needsUpdate = true;
				}
			}

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
			this.fields[0].group.visible = true;
			this.fields[1].group.visible = false;
			this.kTransition = null;
			this.layoutDirty = true;
			this.requestFrame();
			return;
		}

		if (kChanged) {
			const nowMs = performance.now();
			const dir = (params.k > this.params.k ? 1 : -1) as 1 | -1;
			const fromField = this.activeField;
			const toField = 1 - fromField;
			this.kTransition = {
				fromField,
				toField,
				dir,
				startMs: nowMs,
				durMs: this.kAnimDurMs,
				fromParams: this.params,
				toParams: params,
			};
			this.fields[toField].group.visible = true;
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
		const now = performance.now() / 1000;
		const yUp = this.height - y;
		this.ripples.push({ x, y: yUp, start: now }, { x: this.width - x, y: yUp, start: now });
		if (this.ripples.length > 16) this.ripples.splice(0, this.ripples.length - 16);
		this.requestFrame();
	}

	resize() {
		const rect = this.host.getBoundingClientRect();
		this.width = Math.max(1, Math.floor(rect.width));
		this.height = Math.max(1, Math.floor(rect.height));
		this.renderer.setSize(this.width, this.height, false);
		this.camera.left = 0;
		this.camera.right = this.width;
		this.camera.top = this.height;
		this.camera.bottom = 0;
		this.camera.updateProjectionMatrix();
		this.layoutDirty = true;
		this.requestFrame();
	}

	destroy() {
		this.destroyed = true;
		if (this.rafId != null) cancelAnimationFrame(this.rafId);
		this.rafId = null;
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
			this.ripples = this.ripples.filter((r) => t - r.start < 2.0);
			this.renderFrame(t);

			// Continue animating only while ripples are alive, a layout update comes in, or a k transition runs.
			if (this.ripples.length > 0 || this.layoutDirty || this.kTransition) {
				this.needsFrame = true;
				this.rafId = requestAnimationFrame(loop);
			}
		};
		this.rafId = requestAnimationFrame(loop);
	}

	private renderFrame(time: number) {
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

		const hasRipples = this.ripples.length > 0;
		const waveAt = (x: number, y: number) => {
			let wave = 0;
			for (const r of this.ripples) {
				const dt = time - r.start;
				if (dt < 0) continue;
				const dx = x - r.x;
				const dy = y - r.y;
				const d = Math.hypot(dx, dy);
				const w = Math.sin(d * 0.07 - dt * 8.2);
				const env = Math.exp(-dt * 0.85) * Math.exp(-d * 0.012);
				wave += w * env;
			}
			return wave;
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
			const tmp = new THREE.Object3D();

			for (let i = 0; i < negCount; i++) {
				const b = this.negBases[i];
				const w = waveAt(midX + b.x * scale, midY + b.y * scale);
				const s = b.s * (1 + clamp(w, -0.55, 0.75));
				tmp.position.set(b.x, b.y, 0);
				tmp.scale.set(s, s, 1);
				tmp.updateMatrix();
				field.negActive.setMatrixAt(i, tmp.matrix);
			}
			field.negActive.instanceMatrix.needsUpdate = true;

			for (let i = 0; i < posCount; i++) {
				const b = this.posBases[i];
				const w = waveAt(midX + b.x * scale, midY + b.y * scale);
				const s = b.s * (1 + clamp(w, -0.55, 0.75));
				tmp.position.set(b.x, b.y, 0);
				tmp.scale.set(s, s, 1);
				tmp.updateMatrix();
				field.posActive.setMatrixAt(i, tmp.matrix);
			}
			field.posActive.instanceMatrix.needsUpdate = true;
		};

		if (this.kTransition) {
			const tr = this.kTransition;
			const t = clamp((nowMs - tr.startMs) / tr.durMs, 0, 1);
			const e = this.easeInOutCubic(t);
			const fromScale = Math.pow(10, -tr.dir * e);
			const toScale = Math.pow(10, tr.dir * (1 - e));

			const fromField = this.fields[tr.fromField];
			const toField = this.fields[tr.toField];

			fromField.group.visible = true;
			toField.group.visible = true;
			fromField.group.scale.set(fromScale, fromScale, 1);
			toField.group.scale.set(toScale, toScale, 1);

			setFieldAlpha(fromField, 1 - e);
			setFieldAlpha(toField, e);

			// Ease active counts to avoid “popping” while scaling.
			const fromCountsFull = applyCounts(fromField, tr.fromParams);
			const toCountsFull = applyCounts(toField, tr.toParams);
			const fromCounts = {
				negCount: fromCountsFull.negCount,
				posCount: fromCountsFull.posCount,
			};
			const toCounts = {
				negCount: clampInt(Math.round(toCountsFull.negCount * e), 0, 10000),
				posCount: clampInt(Math.round(toCountsFull.posCount * e), 0, 10000),
			};
			toField.negActive.count = toCounts.negCount;
			toField.posActive.count = toCounts.posCount;
			this.lastNegCount = toCounts.negCount;
			this.lastPosCount = toCounts.posCount;

			updateRippleMatrices(fromField, fromScale, fromCounts.negCount, fromCounts.posCount);
			updateRippleMatrices(toField, toScale, toCounts.negCount, toCounts.posCount);

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

		this.renderer.render(this.scene, this.camera);
		this.renderedOnce = true;
	}

	private rebuildLayout() {
		this.layoutDirty = false;
		this.negBases = [];
		this.posBases = [];
		if (!this.params) return;

		const { midX } = this.params;

		const bottomPad = 84;
		const topPad = 14;
		const regionTop = topPad;
		const regionH = Math.max(60, this.height - bottomPad - topPad);

		const marginX = 14;
		const marginY = 12;

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

			// Choose cell size primarily from height (so spacing is stable). We intentionally
			// allow the field to extend beyond the side width — it gets clipped by overflow,
			// which sells the “infinite canvas” feeling and avoids empty bands near the axis.
			const cell = Math.max(2.2, gh / (dim + gaps * gapFrac));
			const gapPx = cell * gapFrac;
			const s = Math.max(1.6, cell * 0.84);

			const fieldH = dim * cell + gaps * gapPx;
			const oy = gy + Math.max(0, (gh - fieldH) / 2);

			// Small padding so particles don't overlap the 0-line / badge.
			const padAxis = Math.max(8, marginX);

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

function makeRoundedAlphaTexture() {
	const canvas = document.createElement("canvas");
	canvas.width = 64;
	canvas.height = 64;
	const ctx = canvas.getContext("2d");
	if (!ctx) return undefined;

	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.fillStyle = "rgba(255,255,255,1)";

	const pad = 4;
	const x = pad;
	const y = pad;
	const w = canvas.width - pad * 2;
	const h = canvas.height - pad * 2;
	const r = 14;

	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
	ctx.fill();

	const tex = new THREE.CanvasTexture(canvas);
	tex.wrapS = THREE.ClampToEdgeWrapping;
	tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.minFilter = THREE.LinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.needsUpdate = true;
	return tex;
}
