import * as THREE from "three";

type Ripple = { x: number; y: number; start: number };
type MaskParams = { width: number; height: number; midX: number; ballAx: number; ballBx: number };
type MaskParamsV2 = MaskParams & { k: number; valueA: number; valueB: number };

// Color spec: negative = light blue, positive = light pink
const NEG_RGB = { r: 125, g: 211, b: 252 }; // sky-300
const POS_RGB = { r: 244, g: 114, b: 182 }; // pink-400

export class ParticleRipples {
	private impl: WebGLPointsImpl | Canvas2DImpl;

	constructor(private host: HTMLElement, private beforeEl?: Element) {
		if (canUseWebGL()) {
			try {
				this.impl = new WebGLPointsImpl(host, beforeEl);
				return;
			} catch {
				// fall through to 2D
			}
		}
		this.impl = new Canvas2DImpl(host, beforeEl);
	}

	setMask(params: MaskParamsV2) {
		this.impl.setMask(params);
	}

	addRipple(x: number, y: number) {
		this.impl.addRipple(x, y);
	}

	resize() {
		this.impl.resize();
	}

	destroy() {
		this.impl.destroy();
	}
}

class Canvas2DImpl {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private ripples: Ripple[] = [];
	private rafId: number | null = null;
	private destroyed = false;
	private width = 1;
	private height = 1;
	private k = 0;
	private midX = 0.5;
	private ballAx = 0.5;
	private ballBx = 0.5;
	private valueA = 0;
	private valueB = 0;
	private dirty = true;
	private points: Array<{ x: number; y: number }> = [];
	private spacing = 14;
	private cols = 1;
	private rows = 1;

	constructor(private host: HTMLElement, private beforeEl?: Element) {
		this.canvas = makeCanvas();
		if (this.beforeEl) host.insertBefore(this.canvas, this.beforeEl);
		else host.appendChild(this.canvas);

		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("2d context not available");
		this.ctx = ctx;

		this.resize();
		this.start();
	}

	setMask(params: MaskParamsV2) {
		this.k = params.k;
		this.midX = params.midX;
		this.ballAx = params.ballAx;
		this.ballBx = params.ballBx;
		this.valueA = params.valueA;
		this.valueB = params.valueB;
		this.dirty = true;
	}

	addRipple(x: number, y: number) {
		const now = performance.now() / 1000;
		this.ripples.push({ x, y, start: now }, { x: this.width - x, y, start: now });
		if (this.ripples.length > 16) this.ripples.splice(0, this.ripples.length - 16);
		this.dirty = true;
	}

	resize() {
		const rect = this.host.getBoundingClientRect();
		this.width = Math.max(1, Math.floor(rect.width));
		this.height = Math.max(1, Math.floor(rect.height));
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.canvas.width = Math.floor(this.width * dpr);
		this.canvas.height = Math.floor(this.height * dpr);
		this.canvas.style.width = "100%";
		this.canvas.style.height = "100%";
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.rebuildParticles();
		this.dirty = true;
	}

	destroy() {
		this.destroyed = true;
		if (this.rafId != null) cancelAnimationFrame(this.rafId);
	}

	private start() {
		const loop = () => {
			if (this.destroyed) return;
			const t = performance.now() / 1000;
			const before = this.ripples.length;
			this.ripples = this.ripples.filter((r) => t - r.start < 2.0);
			const hasRipples = this.ripples.length > 0 || before > 0;
			if (hasRipples || this.dirty) {
				this.draw(t);
				this.dirty = false;
			}
			this.rafId = requestAnimationFrame(loop);
		};
		this.rafId = requestAnimationFrame(loop);
	}

	private rebuildParticles() {
		const bottomPad = 80;
		const topPad = 14;
		const areaTop = topPad;
		const areaHeight = Math.max(60, this.height - bottomPad - topPad);

		// regular lattice (no random scatter)
		this.spacing = clampInt(Math.round(Math.min(this.width, areaHeight) / 30), 10, 18);
		this.cols = Math.max(1, Math.floor(this.width / this.spacing));
		this.rows = Math.max(1, Math.floor(areaHeight / this.spacing));

		this.points = [];
		for (let row = 0; row < this.rows; row++) {
			for (let col = 0; col < this.cols; col++) {
				this.points.push({
					x: (col + 0.5) * this.spacing,
					y: areaTop + (row + 0.5) * this.spacing,
				});
			}
		}
	}

	private draw(time: number) {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.width, this.height);
		const bottomPad = 80;
		const topPad = 14;
		const areaTop = topPad;
		const areaHeight = Math.max(60, this.height - bottomPad - topPad);

		// Fill ratio: per 4 k levels we complete one 10^4 cycle (100x100 concept)
		const level = this.k === 0 ? 0 : Math.floor((this.k - 1) / 4);
		const base = Math.pow(10, 4 * level);
		const cap = Math.pow(10, this.k - 4 * level); // 1/10/100/1000/10000

		const ratioFor = (rawValue: number) => {
			const absValue = Math.abs(Math.round(rawValue));
			const filled = clampInt(Math.floor(absValue / base), 0, cap);
			return cap <= 0 ? 0 : filled / cap;
		};

		const regionFor = (ballX: number) => {
			const start = Math.min(this.midX, ballX);
			const end = Math.max(this.midX, ballX);
			return { start, end, w: Math.max(0, end - start) };
		};

		const rA = regionFor(this.ballAx);
		const rB = regionFor(this.ballBx);
		const ratioA = ratioFor(this.valueA);
		const ratioB = ratioFor(this.valueB);

		const colorFor = (side: "neg" | "pos", a: number) => {
			const rgb = side === "pos" ? POS_RGB : NEG_RGB;
			return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;
		};

		const inAreaY = (y: number) => y >= areaTop && y <= areaTop + areaHeight;
		const localRank = (x: number, y: number, region: { start: number; end: number; w: number }, outwardFromMid: boolean) => {
			const w = Math.max(1, region.w);
			const localCols = Math.max(1, Math.floor(w / this.spacing));
			const row = clampInt(Math.floor((y - areaTop) / this.spacing), 0, this.rows - 1);
			let u = outwardFromMid ? (x - this.midX) / w : (this.midX - x) / w;
			u = clamp(u, 0, 0.999999);
			const col = clampInt(Math.floor(u * localCols), 0, localCols - 1);
			return (row * localCols + col) / (this.rows * localCols);
		};

		for (const p of this.points) {
			if (!inAreaY(p.y)) continue;
			const inA = rA.w >= 24 && p.x >= rA.start && p.x <= rA.end;
			const inB = rB.w >= 24 && p.x >= rB.start && p.x <= rB.end;
			if (!inA && !inB) continue;

			const useB = inB && (!inA || Math.abs(p.x - this.ballBx) < Math.abs(p.x - this.ballAx));
			const ratio = useB ? ratioB : ratioA;
			const ballX = useB ? this.ballBx : this.ballAx;
			const outward = ballX >= this.midX;
			const region = useB ? rB : rA;
			const rank = localRank(p.x, p.y, region, outward);
			if (rank > ratio) continue; // no empty-dot wallpaper

			const side = (useB ? this.valueB : this.valueA) >= 0 ? "pos" : "neg";

			let wave = 0;
			for (const r of this.ripples) {
				const dt = time - r.start;
				if (dt < 0) continue;
				const dx = p.x - r.x;
				const dy = p.y - r.y;
				const d = Math.hypot(dx, dy);
				const w = Math.sin(d * 0.070 - dt * 6.2);
				const env = Math.exp(-dt * 0.9) * Math.exp(-d * 0.012);
				wave += w * env;
			}

			const a = clamp(0.22 + clamp(Math.abs(wave), 0, 1) * 0.28, 0, 0.5);
			ctx.fillStyle = colorFor(side, a);

			const size = 1.8 + clamp(wave, 0, 1) * 2.4;
			ctx.beginPath();
			ctx.arc(p.x, p.y + wave * 8.0, size, 0, Math.PI * 2);
			ctx.fill();
		}
	}
}

function smoothstep(edge0: number, edge1: number, x: number) {
	const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
	return t * t * (3 - 2 * t);
}

function clamp(v: number, lo: number, hi: number) {
	return Math.min(Math.max(v, lo), hi);
}

function makeCanvas() {
	const canvas = document.createElement("canvas");
	canvas.className = "nl-particles";
	canvas.style.position = "absolute";
	canvas.style.inset = "0";
	canvas.style.width = "100%";
	canvas.style.height = "100%";
	canvas.style.pointerEvents = "none";
	canvas.style.zIndex = "1";
	canvas.style.mixBlendMode = "normal";
	canvas.style.borderRadius = "16px";
	return canvas;
}

class WebGLPointsImpl {
	private renderer: THREE.WebGLRenderer;
	private scene: THREE.Scene;
	private camera: THREE.OrthographicCamera;
	private material: THREE.PointsMaterial;
	private points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
	private ripples: Ripple[] = [];
	private rafId: number | null = null;
	private destroyed = false;
	private width = 1;
	private height = 1;
	private k = 0;
	private midX = 0.5;
	private ballAx = 0.5;
	private ballBx = 0.5;
	private valueA = 0;
	private valueB = 0;

	private basePositions: Float32Array = new Float32Array(0);
	private positions: Float32Array = new Float32Array(0);
	private colors: Float32Array = new Float32Array(0);
	private seeds: Float32Array = new Float32Array(0);
	private spacing = 14;
	private cols = 1;
	private rows = 1;

	constructor(private host: HTMLElement, private beforeEl?: Element) {
		const canvas = makeCanvas();
		if (this.beforeEl) host.insertBefore(canvas, this.beforeEl);
		else host.appendChild(canvas);

		this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

		this.scene = new THREE.Scene();
		this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
		this.camera.position.set(0, 0, 1);

		const map = makeDotTexture();
		this.material = new THREE.PointsMaterial({
			size: 10,
			map,
			transparent: true,
			opacity: 0.5, // <= 0.5 (global cap)
			vertexColors: true,
			blending: THREE.AdditiveBlending,
			depthTest: false,
			depthWrite: false,
			sizeAttenuation: false,
		});

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
		geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
		this.points = new THREE.Points(geometry, this.material);
		this.points.frustumCulled = false;
		this.scene.add(this.points);

		this.resize();
		this.start();
	}

	setMask(params: MaskParamsV2) {
		this.k = params.k;
		this.midX = params.midX;
		this.ballAx = params.ballAx;
		this.ballBx = params.ballBx;
		this.valueA = params.valueA;
		this.valueB = params.valueB;
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
		this.camera.top = 0;
		this.camera.bottom = this.height;
		this.camera.updateProjectionMatrix();

		this.rebuildParticles();
	}

	destroy() {
		this.destroyed = true;
		if (this.rafId != null) cancelAnimationFrame(this.rafId);
		this.material.map?.dispose();
		this.material.dispose();
		this.points.geometry.dispose();
		this.renderer.dispose();
	}

	private start() {
		const loop = () => {
			if (this.destroyed) return;
			const t = performance.now() / 1000;
			this.ripples = this.ripples.filter((r) => t - r.start < 2.0);
			this.tick(t);
			this.renderer.render(this.scene, this.camera);
			this.rafId = requestAnimationFrame(loop);
		};
		this.rafId = requestAnimationFrame(loop);
	}

	private tick(time: number) {
		const bottomPad = 80;
		const topPad = 14;
		const areaTop = topPad;
		const areaHeight = Math.max(60, this.height - bottomPad - topPad);

		const level = this.k === 0 ? 0 : Math.floor((this.k - 1) / 4);
		const base = Math.pow(10, 4 * level);
		const maxDots = Math.pow(10, this.k - 4 * level);

		const regionFor = (ballX: number) => {
			const start = Math.min(this.midX, ballX);
			const end = Math.max(this.midX, ballX);
			return { start, end, w: Math.max(0, end - start) };
		};
		const rA = regionFor(this.ballAx);
		const rB = regionFor(this.ballBx);

		const ratioFor = (rawValue: number) => {
			const absValue = Math.abs(Math.round(rawValue));
			const filled = clampInt(Math.floor(absValue / base), 0, maxDots);
			return maxDots <= 0 ? 0 : filled / maxDots;
		};
		const ratioA = ratioFor(this.valueA);
		const ratioB = ratioFor(this.valueB);

		for (let i = 0; i < this.basePositions.length; i += 3) {
			const x0 = this.basePositions[i];
			const y0 = this.basePositions[i + 1];

			const inA = rA.w >= 24 && x0 >= rA.start && x0 <= rA.end && y0 >= areaTop && y0 <= areaTop + areaHeight;
			const inB = rB.w >= 24 && x0 >= rB.start && x0 <= rB.end && y0 >= areaTop && y0 <= areaTop + areaHeight;
			if (!inA && !inB) {
				this.colors[i] = 0;
				this.colors[i + 1] = 0;
				this.colors[i + 2] = 0;
				continue;
			}

			const useB = inB && (!inA || Math.abs(x0 - this.ballBx) < Math.abs(x0 - this.ballAx));
			const ratio = useB ? ratioB : ratioA;
			const seed = this.seeds[i / 3] || 0.5;
			const ballX = useB ? this.ballBx : this.ballAx;
			const outward = ballX >= this.midX;
			const region = useB ? rB : rA;
			const regionW = Math.max(1, region.w);
			const localCols = Math.max(1, Math.floor(regionW / this.spacing));
			const row = clampInt(Math.floor((y0 - areaTop) / this.spacing), 0, this.rows - 1);
			let u = outward ? (x0 - this.midX) / regionW : (this.midX - x0) / regionW;
			u = clamp(u, 0, 0.999999);
			const col = clampInt(Math.floor(u * localCols), 0, localCols - 1);
			const rank = (row * localCols + col) / (this.rows * localCols);
			if (rank > ratio) {
				this.colors[i] = 0;
				this.colors[i + 1] = 0;
				this.colors[i + 2] = 0;
				continue;
			}

			const rgb = (useB ? this.valueB : this.valueA) >= 0 ? POS_RGB : NEG_RGB;

			let wave = 0;
			for (let r = 0; r < this.ripples.length; r++) {
				const rr = this.ripples[r];
				const dt = time - rr.start;
				if (dt < 0) continue;
				const dx = x0 - rr.x;
				const dy = y0 - rr.y;
				const d = Math.hypot(dx, dy);
				const w = Math.sin(d * 0.075 - dt * 5.2);
				const env = Math.exp(-dt * 0.95) * Math.exp(-d * 0.012);
				wave += w * env;
			}

			// subtle drift so it reads as "particles", not a flat wallpaper
			// subtle drift so it reads as "particles", but keep lattice feel
			const drift = Math.sin(time * 0.9 + seed * 9.0) * 0.35;
			const jitter = (seed - 0.5) * 0.35;

			this.positions[i] = x0 + jitter;
			this.positions[i + 1] = y0 + wave * 7.5 + drift * 0.6;
			this.positions[i + 2] = 0;

			const intensity = clamp(0.70 + clamp(Math.abs(wave), 0, 1) * 0.55, 0, 1);
			this.colors[i] = clamp((rgb.r / 255) * intensity, 0, 1);
			this.colors[i + 1] = clamp((rgb.g / 255) * intensity, 0, 1);
			this.colors[i + 2] = clamp((rgb.b / 255) * intensity, 0, 1);
		}

		const geom = this.points.geometry as THREE.BufferGeometry;
		(geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
		(geom.attributes.color as THREE.BufferAttribute).needsUpdate = true;
	}

	private rebuildParticles() {
		const bottomPad = 80;
		const topPad = 14;
		const areaTop = topPad;
		const areaHeight = Math.max(60, this.height - bottomPad - topPad);

		// regular lattice (no random scatter)
		this.spacing = clampInt(Math.round(Math.min(this.width, areaHeight) / 30), 10, 18);
		this.cols = Math.max(1, Math.floor(this.width / this.spacing));
		this.rows = Math.max(1, Math.floor(areaHeight / this.spacing));
		const count = this.cols * this.rows;

		this.basePositions = new Float32Array(count * 3);
		this.positions = new Float32Array(count * 3);
		this.colors = new Float32Array(count * 3);
		this.seeds = new Float32Array(count);

		let p = 0;
		for (let row = 0; row < this.rows; row++) {
			for (let col = 0; col < this.cols; col++) {
				const px = (col + 0.5) * this.spacing;
				const py = areaTop + (row + 0.5) * this.spacing;
				const i = p * 3;
				this.basePositions[i] = px;
				this.basePositions[i + 1] = py;
				this.basePositions[i + 2] = 0;
				this.positions[i] = px;
				this.positions[i + 1] = py;
				this.positions[i + 2] = 0;
				this.colors[i] = 0;
				this.colors[i + 1] = 0;
				this.colors[i + 2] = 0;
				// deterministic seed from lattice index (0..1), used only for micro drift
				this.seeds[p] = count <= 1 ? 0.5 : p / (count - 1);
				p++;
			}
		}

		const geom = new THREE.BufferGeometry();
		geom.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
		geom.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
		geom.computeBoundingSphere();
		this.points.geometry.dispose();
		this.points.geometry = geom;
	}
}

function makeDotTexture() {
	const size = 64;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	g.addColorStop(0, "rgba(255,255,255,1)");
	g.addColorStop(0.45, "rgba(255,255,255,0.65)");
	g.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);
	const tex = new THREE.CanvasTexture(canvas);
	tex.needsUpdate = true;
	return tex;
}

function canUseWebGL() {
	try {
		const c = document.createElement("canvas");
		const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
		return !!gl;
	} catch {
		return false;
	}
}

function clampInt(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

function dotGridDims(maxDots: number) {
	// maxDots is one of: 1,10,100,1000,10000
	if (maxDots >= 10000) return { cols: 100, rows: 100, capacity: 10000 };
	if (maxDots >= 1000) return { cols: 100, rows: 10, capacity: 1000 };
	if (maxDots >= 100) return { cols: 10, rows: 10, capacity: 100 };
	if (maxDots >= 10) return { cols: 10, rows: 1, capacity: 10 };
	return { cols: 1, rows: 1, capacity: 1 };
}

function formatPower(n: number) {
	if (n === 10000) return "10^4";
	if (n === 100000000) return "10^8";
	const k = Math.round(Math.log10(n));
	if (Number.isFinite(k) && Math.pow(10, k) === n) return `10^${k}`;
	return String(n);
}

function mulberry32(seed: number) {
	let t = seed >>> 0;
	return function () {
		t += 0x6d2b79f5;
		let x = Math.imul(t ^ (t >>> 15), 1 | t);
		x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

function hash32(s: string) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
