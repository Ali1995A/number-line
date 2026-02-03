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
	private root: THREE.Group;

	private meshNegBase: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
	private meshNegActive: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
	private meshPosBase: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
	private meshPosActive: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

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
	private kAnimFrom = 0;
	private kAnimTo = 0;
	private kAnimStart = 0;
	private kAnimDurMs = 340;

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

		this.root = new THREE.Group();
		this.scene.add(this.root);

		const geo = new THREE.PlaneGeometry(1, 1);
		const alphaTex = makeRoundedAlphaTexture();
		const matNegBase = new THREE.MeshBasicMaterial({
			color: new THREE.Color(NEG_RGB.r / 255, NEG_RGB.g / 255, NEG_RGB.b / 255),
			transparent: true,
			opacity: 0.22, // clearer inactive grid (<= 0.5)
			depthTest: false,
			depthWrite: false,
		});
		const matNegActive = new THREE.MeshBasicMaterial({
			color: new THREE.Color(NEG_RGB.r / 255, NEG_RGB.g / 255, NEG_RGB.b / 255),
			transparent: true,
			opacity: 0.5, // <= 0.5 (max allowed)
			depthTest: false,
			depthWrite: false,
		});
		if (alphaTex) {
			matNegBase.alphaMap = alphaTex;
			matNegBase.alphaTest = 0.02;
			matNegBase.needsUpdate = true;
			matNegActive.alphaMap = alphaTex;
			matNegActive.alphaTest = 0.02;
			matNegActive.needsUpdate = true;
		}
		const matPosBase = new THREE.MeshBasicMaterial({
			color: new THREE.Color(POS_RGB.r / 255, POS_RGB.g / 255, POS_RGB.b / 255),
			transparent: true,
			opacity: 0.22, // clearer inactive grid (<= 0.5)
			depthTest: false,
			depthWrite: false,
		});
		const matPosActive = new THREE.MeshBasicMaterial({
			color: new THREE.Color(POS_RGB.r / 255, POS_RGB.g / 255, POS_RGB.b / 255),
			transparent: true,
			opacity: 0.5, // <= 0.5 (max allowed)
			depthTest: false,
			depthWrite: false,
		});
		if (alphaTex) {
			matPosBase.alphaMap = alphaTex;
			matPosBase.alphaTest = 0.02;
			matPosBase.needsUpdate = true;
			matPosActive.alphaMap = alphaTex;
			matPosActive.alphaTest = 0.02;
			matPosActive.needsUpdate = true;
		}

		// capacity upper bound per side: 10k blocks is fine
		this.meshNegBase = new THREE.InstancedMesh(geo, matNegBase, 10000);
		this.meshNegActive = new THREE.InstancedMesh(geo, matNegActive, 10000);
		this.meshPosBase = new THREE.InstancedMesh(geo, matPosBase, 10000);
		this.meshPosActive = new THREE.InstancedMesh(geo, matPosActive, 10000);

		for (const m of [this.meshNegBase, this.meshNegActive, this.meshPosBase, this.meshPosActive]) {
			m.frustumCulled = false;
		}

		// Draw inactive first, then active on top.
		this.root.add(this.meshNegBase, this.meshPosBase, this.meshNegActive, this.meshPosActive);

		this.resize();
		this.requestFrame();
	}

	set(params: BlockParams) {
		const nextW = Math.max(1, Math.floor(params.width));
		const nextH = Math.max(1, Math.floor(params.height));
		const sizeChanged = nextW !== this.width || nextH !== this.height;
		const kChanged = !this.params || this.params.k !== params.k;

		if (kChanged) {
			const now = performance.now();
			const currentK = this.getAnimatedK(now);
			this.kAnimFrom = currentK;
			this.kAnimTo = params.k;
			this.kAnimStart = now;
		}

		this.params = params;
		this.width = nextW;
		this.height = nextH;

		// Only rebuild the field layout if size or k changed; otherwise curtain reveal is just a cull window.
		this.layoutDirty = this.layoutDirty || sizeChanged || kChanged;
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
		this.meshNegBase.geometry.dispose();
		this.meshNegActive.geometry.dispose();
		this.meshPosBase.geometry.dispose();
		this.meshPosActive.geometry.dispose();
		this.meshNegBase.material.dispose();
		this.meshNegActive.material.dispose();
		this.meshPosBase.material.dispose();
		this.meshPosActive.material.dispose();
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

			// Continue animating only while ripples are alive (or a layout update comes in).
			if (this.ripples.length > 0 || this.layoutDirty) {
				this.needsFrame = true;
				this.rafId = requestAnimationFrame(loop);
			}
		};
		this.rafId = requestAnimationFrame(loop);
	}

	private renderFrame(time: number) {
		if (!this.params) {
			this.meshNegBase.count = 0;
			this.meshPosBase.count = 0;
			this.meshNegActive.count = 0;
			this.meshPosActive.count = 0;
			this.renderer.render(this.scene, this.camera);
			return;
		}

		if (this.layoutDirty) this.rebuildLayout();

		const nowMs = time * 1000;
		const kAnimated = this.getAnimatedK(nowMs);
		const kTarget = this.params.k;
		// Map k to a gentle visual zoom so each discrete k±1 feels “alive”.
		// Larger k -> slightly tighter (zoomed-out) particle field.
		const scaleFor = (k: number) => Math.pow(10, -k * 0.035);
		const prog = this.kAnimStart > 0 ? clamp((nowMs - this.kAnimStart) / this.kAnimDurMs, 0, 1) : 1;
		const pulse = 1 + 0.10 * Math.sin(Math.PI * prog);
		const fieldScale = scaleFor(kAnimated) * pulse;

		// Apply smooth zoom to the whole particle field around the center.
		const midX = this.params.midX;
		const midYUp = this.height * 0.5;
		this.root.position.set(midX, midYUp, 0);
		this.root.scale.set(fieldScale, fieldScale, 1);

		// Value → active particle count. Each particle represents a power-of-10 unit.
		// Max is 100×100 = 10k.
		const unitPow = Math.max(0, this.params.k - 4);
		const unitValue = Math.pow(10, unitPow);
		const negValue = Math.min(this.params.valueA, this.params.valueB, 0);
		const posValue = Math.max(this.params.valueA, this.params.valueB, 0);
		const targetNegCount = clampInt(Math.floor(Math.abs(Math.trunc(negValue)) / unitValue), 0, 10000);
		const targetPosCount = clampInt(Math.floor(Math.abs(Math.trunc(posValue)) / unitValue), 0, 10000);

		// When no ripples, we only need to change mesh.count (matrices already baked).
		const hasRipples = this.ripples.length > 0;
		this.meshNegActive.count = targetNegCount;
		this.meshPosActive.count = targetPosCount;
		this.lastNegCount = targetNegCount;
		this.lastPosCount = targetPosCount;

		if (!hasRipples) {
			this.renderer.render(this.scene, this.camera);
			this.renderedOnce = true;
			if (Math.abs(kAnimated - kTarget) > 1e-3) this.requestFrame();
			return;
		}

		const waveAt = (x: number, y: number) => {
			let wave = 0;
			for (const r of this.ripples) {
				const dt = time - r.start;
				if (dt < 0) continue;
				const dx = x - r.x;
				const dy = y - r.y;
				const d = Math.hypot(dx, dy);
				// Stronger / clearer ripples (still lightweight CPU-side)
				const w = Math.sin(d * 0.07 - dt * 8.2);
				const env = Math.exp(-dt * 0.85) * Math.exp(-d * 0.012);
				wave += w * env;
			}
			return wave;
		};

		const tmp = new THREE.Object3D();

		// Ripple animation: only update the active instances (count may be < 10k).
		for (let i = 0; i < targetNegCount; i++) {
			const b = this.negBases[i];
			const w = waveAt(midX + b.x * fieldScale, midYUp + b.y * fieldScale);
			const s = b.s * (1 + clamp(w, -0.55, 0.75));
			tmp.position.set(b.x, b.y, 0);
			tmp.scale.set(s, s, 1);
			tmp.updateMatrix();
			this.meshNegActive.setMatrixAt(i, tmp.matrix);
		}
		this.meshNegActive.instanceMatrix.needsUpdate = true;

		for (let i = 0; i < targetPosCount; i++) {
			const b = this.posBases[i];
			const w = waveAt(midX + b.x * fieldScale, midYUp + b.y * fieldScale);
			const s = b.s * (1 + clamp(w, -0.55, 0.75));
			tmp.position.set(b.x, b.y, 0);
			tmp.scale.set(s, s, 1);
			tmp.updateMatrix();
			this.meshPosActive.setMatrixAt(i, tmp.matrix);
		}
		this.meshPosActive.instanceMatrix.needsUpdate = true;

		this.renderer.render(this.scene, this.camera);
		this.renderedOnce = true;

		// Keep animating while k is transitioning.
		if (Math.abs(kAnimated - kTarget) > 1e-3) this.requestFrame();
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

		const buildField = (
			start: number,
			end: number,
			into: Array<{ x: number; y: number; s: number }>,
			side: "left" | "right",
		) => {
			const w = Math.max(0, end - start);
			if (w < 24) return;

			const gx = start + marginX;
			const gw = Math.max(1, w - marginX * 2);

			// Full regular field: fixed 100×100, with visible 10×10 boundaries.
			const dim = 100;
			const chunk = 10;
			const gaps = dim / chunk - 1; // 9
			const gapFrac = 0.65;

			const cell = Math.max(2.1, Math.min(gw / (dim + gaps * gapFrac), gh / (dim + gaps * gapFrac)));
			const gapPx = cell * gapFrac;
			const s = Math.max(1.6, cell * 0.82);

			const fieldW = dim * cell + gaps * gapPx;
			const fieldH = dim * cell + gaps * gapPx;

			const ox = gx + Math.max(0, (gw - fieldW) / 2);
			const oy = gy + Math.max(0, (gh - fieldH) / 2);

			for (let row = 0; row < dim; row++) {
				for (let colFill = 0; colFill < dim; colFill++) {
					// Ensure the fill order starts near the 0-axis for both sides.
					const colIndex = side === "left" ? dim - 1 - colFill : colFill;
					const colGap = Math.floor(colIndex / chunk);
					const rowGap = Math.floor(row / chunk);
					const xDom = ox + (colIndex + 0.5) * cell + colGap * gapPx;
					const yDom = oy + (row + 0.5) * cell + rowGap * gapPx;
					const atChunkEdge = colIndex % chunk === 0 || row % chunk === 0;
					const s2 = atChunkEdge ? s * 0.74 : s;

					// Store local coords relative to center, in y-up space.
					const yUp = this.height - yDom;
					into.push({ x: xDom - midX, y: yUp - this.height * 0.5, s: s2 });
					if (into.length >= 10000) return;
				}
			}
		};

		buildField(0, midX, this.negBases, "left");
		buildField(midX, this.width, this.posBases, "right");

		// Bake static matrices once. Active mesh reuses these unless a ripple is animating.
		const tmp = new THREE.Object3D();
		for (let i = 0; i < this.negBases.length; i++) {
			const b = this.negBases[i];
			tmp.position.set(b.x, b.y, 0);
			tmp.scale.set(b.s, b.s, 1);
			tmp.updateMatrix();
			this.meshNegBase.setMatrixAt(i, tmp.matrix);
			this.meshNegActive.setMatrixAt(i, tmp.matrix);
		}
		for (let i = 0; i < this.posBases.length; i++) {
			const b = this.posBases[i];
			tmp.position.set(b.x, b.y, 0);
			tmp.scale.set(b.s, b.s, 1);
			tmp.updateMatrix();
			this.meshPosBase.setMatrixAt(i, tmp.matrix);
			this.meshPosActive.setMatrixAt(i, tmp.matrix);
		}
		this.meshNegBase.count = Math.min(this.negBases.length, 10000);
		this.meshPosBase.count = Math.min(this.posBases.length, 10000);
		this.meshNegBase.instanceMatrix.needsUpdate = true;
		this.meshPosBase.instanceMatrix.needsUpdate = true;
		this.meshNegActive.instanceMatrix.needsUpdate = true;
		this.meshPosActive.instanceMatrix.needsUpdate = true;
	}

	private getAnimatedK(nowMs: number) {
		// If we never animated yet, snap to target.
		if (this.kAnimStart <= 0) return this.kAnimTo;
		const t = clamp((nowMs - this.kAnimStart) / this.kAnimDurMs, 0, 1);
		const e = this.easeInOutCubic(t);
		return this.kAnimFrom + (this.kAnimTo - this.kAnimFrom) * e;
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
