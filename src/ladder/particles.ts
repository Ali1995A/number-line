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
		// no-op (fallback renderer uses analytical dot grid)
	}

	private draw(time: number) {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.width, this.height);
		const bottomPad = 80;
		const topPad = 14;
		const areaTop = topPad;
		const areaHeight = Math.max(60, this.height - bottomPad - topPad);

		// 100x100循环：每 4 个 k 完成一次 10000 容量的点阵填满
		const level = this.k === 0 ? 0 : Math.floor((this.k - 1) / 4);
		const base = Math.pow(10, 4 * level); // 每个点代表的数值
		const maxDots = Math.pow(10, this.k - 4 * level); // 1/10/100/1000/10000

		const grid = dotGridDims(maxDots);
		const drawRegion = (ballX: number, rawValue: number, side: "neg" | "pos") => {
			const start = Math.min(this.midX, ballX);
			const end = Math.max(this.midX, ballX);
			const regionW = Math.max(0, end - start);
			if (regionW < 24) return;

			const marginX = 14;
			const marginY = 10;
			const gx = start + marginX;
			const gy = areaTop + marginY;
			const gw = Math.max(1, regionW - marginX * 2);
			const gh = Math.max(1, areaHeight - marginY * 2);

			const cellW = gw / grid.cols;
			const cellH = gh / grid.rows;
			const dotR = clamp(Math.min(cellW, cellH) * 0.28, 1.3, 5.5);

			const absValue = Math.abs(Math.round(rawValue));
			const filled = clampInt(Math.floor(absValue / base), 0, maxDots);

			// aesthetic: faint empty dots + stronger filled dots
			const emptyAlpha = 0.12;
			const filledAlphaBase = 0.38; // <=0.5
			const filledAlphaWave = 0.12; // <=0.5 total

			const rgb = side === "pos" ? POS_RGB : NEG_RGB;
			const emptyColor = `rgba(${rgb.r},${rgb.g},${rgb.b},${emptyAlpha})`;
			const filledColor = (a: number) => `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;

			// draw group boundaries (10x10) only when grid is "big"
			if (grid.cols >= 100 || grid.rows >= 100) {
				ctx.save();
				ctx.strokeStyle = "rgba(15,23,42,0.06)";
				ctx.lineWidth = 1;
				for (let c = 10; c < grid.cols; c += 10) {
					const x = gx + c * cellW;
					ctx.beginPath();
					ctx.moveTo(x, gy);
					ctx.lineTo(x, gy + gh);
					ctx.stroke();
				}
				for (let r = 10; r < grid.rows; r += 10) {
					const y = gy + r * cellH;
					ctx.beginPath();
					ctx.moveTo(gx, y);
					ctx.lineTo(gx + gw, y);
					ctx.stroke();
				}
				ctx.restore();
			}

			// ripple rings (visible but alpha <= 0.5), clipped to region
			if (this.ripples.length) {
				ctx.save();
				ctx.beginPath();
				ctx.rect(gx, gy, gw, gh);
				ctx.clip();
				for (const r of this.ripples) {
					const dt = time - r.start;
					if (dt < 0) continue;
					const radius = dt * 140;
					if (radius > Math.max(this.width, this.height) * 1.4) continue;
					const fade = Math.exp(-dt * 1.1);
					const a = clamp(0.28 * fade, 0, 0.5);
					if (a <= 0.01) continue;
					ctx.strokeStyle = filledColor(a);
					ctx.lineWidth = 2;
					ctx.beginPath();
					ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
					ctx.stroke();
				}
				ctx.restore();
			}

			// empty dots (fast path)
			ctx.fillStyle = emptyColor;
			for (let i = 0; i < grid.capacity; i++) {
				const col = i % grid.cols;
				const row = Math.floor(i / grid.cols);
				if (row >= grid.rows) break;
				const px = gx + (col + 0.5) * cellW;
				const py = gy + (row + 0.5) * cellH;
				ctx.beginPath();
				ctx.arc(px, py, dotR, 0, Math.PI * 2);
				ctx.fill();
			}

			// filled dots with ripple highlight + gentle displacement
			for (let i = 0; i < filled; i++) {
				const col = i % grid.cols;
				const row = Math.floor(i / grid.cols);
				const px = gx + (col + 0.5) * cellW;
				const py0 = gy + (row + 0.5) * cellH;

				let wave = 0;
				for (const r of this.ripples) {
					const dt = time - r.start;
					if (dt < 0) continue;
					const dx = px - r.x;
					const dy = py0 - r.y;
					const d = Math.hypot(dx, dy);
					const w = Math.sin(d * 0.075 - dt * 5.2);
					const env = Math.exp(-dt * 0.95) * Math.exp(-d * 0.012);
					wave += w * env;
				}

				const a = clamp(filledAlphaBase + clamp(Math.abs(wave), 0, 1) * filledAlphaWave, 0, 0.5);
				ctx.fillStyle = filledColor(a);
				const py = py0 + wave * 8.0;
				const rr = dotR + clamp(wave, 0, 1) * 1.4;
				ctx.beginPath();
				ctx.arc(px, py, rr, 0, Math.PI * 2);
				ctx.fill();
			}

			// label hint (small, subtle): what each dot means in this level
			ctx.save();
			ctx.fillStyle = "rgba(15,23,42,0.36)";
			ctx.font = "12px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial";
			const label = base === 1 ? "1/点" : `${formatPower(base)}/点`;
			ctx.fillText(label, gx + 2, gy + gh + 16);
			ctx.restore();
		};

		drawRegion(this.ballAx, this.valueA, this.valueA >= 0 ? "pos" : "neg");
		drawRegion(this.ballBx, this.valueB, this.valueB >= 0 ? "pos" : "neg");
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
		const grid = dotGridDims(maxDots);

		const regionFor = (ballX: number) => {
			const start = Math.min(this.midX, ballX);
			const end = Math.max(this.midX, ballX);
			return { start, end, w: Math.max(0, end - start) };
		};
		const rA = regionFor(this.ballAx);
		const rB = regionFor(this.ballBx);

		const signA = Math.sign(this.valueA) >= 0 ? "pos" : "neg";
		const signB = Math.sign(this.valueB) >= 0 ? "pos" : "neg";
		const rgbA = signA === "pos" ? POS_RGB : NEG_RGB;
		const rgbB = signB === "pos" ? POS_RGB : NEG_RGB;

		const filledA = clampInt(Math.floor(Math.abs(Math.round(this.valueA)) / base), 0, maxDots);
		const filledB = clampInt(Math.floor(Math.abs(Math.round(this.valueB)) / base), 0, maxDots);

		const marginX = 14;
		const marginY = 10;

		const gridEval = (x: number, y: number, region: { start: number; w: number }, filled: number) => {
			if (region.w < 24) return { m: 0, idx: 0, inGrid: false };
			const gx = region.start + marginX;
			const gy = areaTop + marginY;
			const gw = Math.max(1, region.w - marginX * 2);
			const gh = Math.max(1, areaHeight - marginY * 2);
			if (x < gx || x > gx + gw || y < gy || y > gy + gh) return { m: 0, idx: 0, inGrid: false };

			const u = (x - gx) / gw;
			const v = (y - gy) / gh;
			const col = clampInt(Math.floor(u * grid.cols), 0, grid.cols - 1);
			const row = clampInt(Math.floor(v * grid.rows), 0, grid.rows - 1);
			const idx = row * grid.cols + col;
			const inGrid = idx < grid.capacity;
			const m = inGrid ? (idx < filled ? 1 : 0.25) : 0;
			return { m, idx, inGrid };
		};

		for (let i = 0; i < this.basePositions.length; i += 3) {
			const x0 = this.basePositions[i];
			const y0 = this.basePositions[i + 1];

			// evaluate membership for either region
			const ga = gridEval(x0, y0, rA, filledA);
			const gb = gridEval(x0, y0, rB, filledB);

			const useB = gb.m > ga.m;
			const m = useB ? gb.m : ga.m;
			const rgb = useB ? rgbB : rgbA;

			// always keep a faint center band (so user never thinks it's "gone")
			const band = Math.exp(-Math.abs(x0 - this.midX) / 220) * 0.16;
			const mm = Math.max(m, band);

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
			const seed = this.seeds[i / 3] || 0.5;
			const drift = Math.sin(time * 0.9 + seed * 9.0) * 0.9;
			const jitter = (seed - 0.5) * 0.9;

			this.positions[i] = x0 + jitter;
			this.positions[i + 1] = y0 + wave * 7.5 + drift * 0.6;
			this.positions[i + 2] = 0;

			const intensity = clamp(mm * (0.72 + clamp(Math.abs(wave), 0, 1) * 0.55), 0, 1);
			this.colors[i] = clamp((rgb.r / 255) * intensity, 0, 1);
			this.colors[i + 1] = clamp((rgb.g / 255) * intensity, 0, 1);
			this.colors[i + 2] = clamp((rgb.b / 255) * intensity, 0, 1);
		}

		const geom = this.points.geometry as THREE.BufferGeometry;
		(geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
		(geom.attributes.color as THREE.BufferAttribute).needsUpdate = true;
	}

	private rebuildParticles() {
		const area = this.width * this.height;
		const desired = 3800;
		const spacing = clampInt(Math.round(Math.sqrt(area / desired)), 9, 18);
		const xs = Math.max(1, Math.floor(this.width / spacing));
		const ys = Math.max(1, Math.floor(this.height / spacing));
		const count = xs * ys;

		this.basePositions = new Float32Array(count * 3);
		this.positions = new Float32Array(count * 3);
		this.colors = new Float32Array(count * 3);
		this.seeds = new Float32Array(count);

		let i = 0;
		let s = 0;
		for (let y = 0; y < ys; y++) {
			for (let x = 0; x < xs; x++) {
				const px = x * spacing + spacing * 0.5;
				const py = y * spacing + spacing * 0.5;
				this.basePositions[i] = px;
				this.basePositions[i + 1] = py;
				this.basePositions[i + 2] = 0;
				this.positions[i] = px;
				this.positions[i + 1] = py;
				this.positions[i + 2] = 0;
				this.colors[i] = 0;
				this.colors[i + 1] = 0;
				this.colors[i + 2] = 0;
				this.seeds[s++] = ((x * 928371 + y * 1237) % 997) / 997;
				i += 3;
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
