import * as THREE from "three";

// Rule: render only block particles within data region (no background dots).
// Hierarchy (discrete k): always render a regular 100×100 grid, but each block represents a larger
// integer "unit" as k grows. When k crosses +4 orders, one block effectively represents a whole
// previous 100×100 grid (10^4). This creates the requested “100×100 → 1粒子 → 100×100…” loop.

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

const NEG_RGB = { r: 125, g: 211, b: 252 }; // light blue
const POS_RGB = { r: 244, g: 114, b: 182 }; // light pink

export class ParticleBlocks {
	private canvas: HTMLCanvasElement;
	private renderer: THREE.WebGLRenderer;
	private scene: THREE.Scene;
	private camera: THREE.OrthographicCamera;

	private meshNeg: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
	private meshPos: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

	private rafId: number | null = null;
	private destroyed = false;

	private width = 1;
	private height = 1;
	private params: BlockParams | null = null;
	private ripples: Ripple[] = [];

	private layoutDirty = true;

	// cached per-instance base transforms
	private negBases: Array<{ x: number; y: number; s: number }> = [];
	private posBases: Array<{ x: number; y: number; s: number }> = [];

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

		this.scene = new THREE.Scene();
		// Use a conventional pixel space: x=[0..w], y=[0..h] with y up.
		// We'll store ripple/layout coordinates in DOM space (y down) and flip at render time.
		this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
		this.camera.position.set(0, 0, 1);

		const geo = new THREE.PlaneGeometry(1, 1);
		const alphaTex = makeRoundedAlphaTexture();
		const matNeg = new THREE.MeshBasicMaterial({
			color: new THREE.Color(NEG_RGB.r / 255, NEG_RGB.g / 255, NEG_RGB.b / 255),
			transparent: true,
			opacity: 0.5, // <= 0.5
			depthTest: false,
			depthWrite: false,
		});
		if (alphaTex) {
			matNeg.alphaMap = alphaTex;
			matNeg.alphaTest = 0.02;
			matNeg.needsUpdate = true;
		}
		const matPos = new THREE.MeshBasicMaterial({
			color: new THREE.Color(POS_RGB.r / 255, POS_RGB.g / 255, POS_RGB.b / 255),
			transparent: true,
			opacity: 0.5, // <= 0.5
			depthTest: false,
			depthWrite: false,
		});
		if (alphaTex) {
			matPos.alphaMap = alphaTex;
			matPos.alphaTest = 0.02;
			matPos.needsUpdate = true;
		}

		// capacity upper bound per side: 10k blocks is fine
		this.meshNeg = new THREE.InstancedMesh(geo, matNeg, 10000);
		this.meshPos = new THREE.InstancedMesh(geo, matPos, 10000);
		this.meshNeg.frustumCulled = false;
		this.meshPos.frustumCulled = false;
		this.scene.add(this.meshNeg, this.meshPos);

		this.resize();
		this.start();
	}

	set(params: BlockParams) {
		this.params = params;
		this.width = Math.max(1, Math.floor(params.width));
		this.height = Math.max(1, Math.floor(params.height));
		this.layoutDirty = true;
	}

	addRipple(x: number, y: number) {
		const now = performance.now() / 1000;
		this.ripples.push({ x, y, start: now }, { x: this.width - x, y, start: now });
		if (this.ripples.length > 16) this.ripples.splice(0, this.ripples.length - 16);
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
	}

	destroy() {
		this.destroyed = true;
		if (this.rafId != null) cancelAnimationFrame(this.rafId);
		this.rafId = null;
		this.meshNeg.geometry.dispose();
		this.meshPos.geometry.dispose();
		this.meshNeg.material.dispose();
		this.meshPos.material.dispose();
		this.renderer.dispose();
	}

	private start() {
		const loop = () => {
			if (this.destroyed) return;
			const t = performance.now() / 1000;
			this.ripples = this.ripples.filter((r) => t - r.start < 2.0);
			this.renderFrame(t);
			this.rafId = requestAnimationFrame(loop);
		};
		this.rafId = requestAnimationFrame(loop);
	}

	private renderFrame(time: number) {
		if (!this.params) {
			this.meshNeg.count = 0;
			this.meshPos.count = 0;
			this.renderer.render(this.scene, this.camera);
			return;
		}

		if (this.layoutDirty) this.rebuildLayout();

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

		for (let i = 0; i < this.negBases.length; i++) {
			const b = this.negBases[i];
			const w = waveAt(b.x, b.y);
			const scale = b.s * (1 + clamp(w, -0.55, 0.75));
			tmp.position.set(b.x, this.height - b.y, 0);
			tmp.scale.set(scale, scale, 1);
			tmp.updateMatrix();
			this.meshNeg.setMatrixAt(i, tmp.matrix);
		}
		this.meshNeg.instanceMatrix.needsUpdate = true;

		for (let i = 0; i < this.posBases.length; i++) {
			const b = this.posBases[i];
			const w = waveAt(b.x, b.y);
			const scale = b.s * (1 + clamp(w, -0.55, 0.75));
			tmp.position.set(b.x, this.height - b.y, 0);
			tmp.scale.set(scale, scale, 1);
			tmp.updateMatrix();
			this.meshPos.setMatrixAt(i, tmp.matrix);
		}
		this.meshPos.instanceMatrix.needsUpdate = true;

		this.renderer.render(this.scene, this.camera);
	}

	private rebuildLayout() {
		this.layoutDirty = false;
		this.negBases = [];
		this.posBases = [];
		if (!this.params) return;

		const { midX, ballAx, ballBx, valueA, valueB, k } = this.params;

		const bottomPad = 84;
		const topPad = 14;
		const regionTop = topPad;
		const regionH = Math.max(60, this.height - bottomPad - topPad);

		// Unit value per block:
		// - k <= 4: 1 block = 1 (integer-only; ignores decimals)
		// - each +1 k: unit ×10 (keeps max blocks <= 10^4)
		// - when k crosses +4: one block effectively becomes “one 100×100 grid” of the previous cycle
		const unitPow = Math.max(0, k - 4);
		const unitValue = Math.pow(10, unitPow);
		const maxBlocks = 10000; // 100×100
		const calcFilled = (v: number) => clampInt(Math.floor(Math.abs(Math.trunc(v)) / unitValue), 0, maxBlocks);

		const buildSide = (ballX: number, v: number) => {
			const start = Math.min(midX, ballX);
			const end = Math.max(midX, ballX);
			const w = Math.max(0, end - start);
			if (w < 28) return;

			const marginX = 14;
			const marginY = 12;
			const gx = start + marginX;
			const gy = regionTop + marginY;
			const gw = Math.max(1, w - marginX * 2);
			const gh = Math.max(1, regionH - marginY * 2);

			// Visual: fixed regular 100×100 array, with stronger boundaries every 10×10 chunk.
			const dim = 100;
			const chunk = 10;
			const gaps = dim / chunk - 1; // 9
			const gapFrac = 0.65; // gap size as a fraction of cell
			const cell = Math.max(2.1, Math.min(gw / (dim + gaps * gapFrac), gh / (dim + gaps * gapFrac)));
			const gapPx = cell * gapFrac;
			const s = Math.max(1.6, cell * 0.82);

			const filled = calcFilled(v);
			if (filled <= 0) return;

			const rightward = ballX >= midX;
			const isPos = v >= 0;

			// Fill order: column by distance from 0, then row (top->bottom)
			for (let i = 0; i < filled; i++) {
				const col = i % dim;
				const row = Math.floor(i / dim);
				const colGap = Math.floor(col / chunk);
				const rowGap = Math.floor(row / chunk);
				const xLocal = (col + 0.5) * cell + colGap * gapPx;
				const yLocal = (row + 0.5) * cell + rowGap * gapPx;
				const x = rightward ? gx + xLocal : gx + (dim * cell + gaps * gapPx) - xLocal;
				const y = gy + yLocal;

				const atChunkEdge = col % chunk === 0 || row % chunk === 0;
				const s2 = atChunkEdge ? s * 0.74 : s;
				(isPos ? this.posBases : this.negBases).push({ x, y, s: s2 });
				if (this.posBases.length >= 10000 || this.negBases.length >= 10000) break;
			}
		};

		buildSide(ballAx, valueA);
		buildSide(ballBx, valueB);

		this.meshNeg.count = Math.min(this.negBases.length, 10000);
		this.meshPos.count = Math.min(this.posBases.length, 10000);
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
