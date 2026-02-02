import * as THREE from "three";

type Ripple = { x: number; y: number; start: number };
type MaskParams = { width: number; height: number; midX: number; ballAx: number; ballBx: number };

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

	setMask(params: MaskParams) {
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
	private midX = 0.5;
	private ballAx = 0.5;
	private ballBx = 0.5;
	private particles: Array<{ x: number; y: number; seed: number }> = [];

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

	setMask(params: MaskParams) {
		this.midX = params.midX;
		this.ballAx = params.ballAx;
		this.ballBx = params.ballBx;
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
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.canvas.width = Math.floor(this.width * dpr);
		this.canvas.height = Math.floor(this.height * dpr);
		this.canvas.style.width = "100%";
		this.canvas.style.height = "100%";
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.rebuildParticles();
	}

	destroy() {
		this.destroyed = true;
		if (this.rafId != null) cancelAnimationFrame(this.rafId);
	}

	private start() {
		const loop = () => {
			if (this.destroyed) return;
			const t = performance.now() / 1000;
			this.ripples = this.ripples.filter((r) => t - r.start < 2.0);
			this.draw(t);
			this.rafId = requestAnimationFrame(loop);
		};
		this.rafId = requestAnimationFrame(loop);
	}

	private rebuildParticles() {
		const spacing = clampInt(Math.round(Math.min(this.width, this.height) / 34), 7, 14);
		const xs = Math.max(1, Math.floor(this.width / spacing));
		const ys = Math.max(1, Math.floor(this.height / spacing));
		this.particles = [];
		for (let y = 0; y < ys; y++) {
			for (let x = 0; x < xs; x++) {
				this.particles.push({
					x: x * spacing + spacing * 0.5,
					y: y * spacing + spacing * 0.5,
					seed: (x * 928371 + y * 1237) % 997,
				});
			}
		}
	}

	private maskAt(x: number) {
		const edge = 14;
		const intervalMask = (a: number, b: number) => {
			const lo = Math.min(a, b);
			const hi = Math.max(a, b);
			const m1 = smoothstep(lo, lo + edge, x);
			const m2 = 1 - smoothstep(hi - edge, hi, x);
			return m1 * m2;
		};
		const mask = Math.max(intervalMask(this.midX, this.ballAx), intervalMask(this.midX, this.ballBx));
		// faint center band so it never looks "broken"
		const moved = Math.abs(this.ballAx - this.midX) + Math.abs(this.ballBx - this.midX);
		const band = Math.exp(-Math.abs(x - this.midX) / 120) * 0.10 * (1 - smoothstep(0, 10, moved));
		return Math.max(mask, band);
	}

	private draw(time: number) {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.width, this.height);
		for (const p of this.particles) {
			const mask = this.maskAt(p.x);
			if (mask <= 0.001) continue;
			const side = p.x >= this.midX ? 1 : 0;
			let wave = 0;
			for (const r of this.ripples) {
				const dt = time - r.start;
				if (dt < 0) continue;
				const dx = p.x - r.x;
				const dy = p.y - r.y;
				const d = Math.hypot(dx, dy);
				const w = Math.sin(d * 0.10 - dt * 7.0);
				const env = Math.exp(-dt * 1.35) * Math.exp(-d * 0.02);
				wave += w * env;
			}

			const baseA = 0.18;
			const glow = clamp(Math.abs(wave), 0, 1) * 0.22;
			let a = mask * (baseA + glow);
			if (a > 0.5) a = 0.5;

			const color = side === 1 ? `rgba(236,72,153,${a})` : `rgba(139,92,246,${a})`;
			ctx.fillStyle = color;
			const size = 1.8 + ((p.seed % 10) / 10) * 1.4 + clamp(wave, 0, 1) * 1.8;
			ctx.beginPath();
			ctx.arc(p.x, p.y + wave * 3.5, size, 0, Math.PI * 2);
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
	canvas.style.mixBlendMode = "screen";
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
	private midX = 0.5;
	private ballAx = 0.5;
	private ballBx = 0.5;

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
			size: 6,
			map,
			transparent: true,
			opacity: 0.45, // <= 0.5
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

	setMask(params: MaskParams) {
		this.midX = params.midX;
		this.ballAx = params.ballAx;
		this.ballBx = params.ballBx;
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
		const edge = 14;
		const intervalMask = (x: number, a: number, b: number) => {
			const lo = Math.min(a, b);
			const hi = Math.max(a, b);
			const m1 = smoothstep(lo, lo + edge, x);
			const m2 = 1 - smoothstep(hi - edge, hi, x);
			return m1 * m2;
		};

		const moved = Math.abs(this.ballAx - this.midX) + Math.abs(this.ballBx - this.midX);

		const cool = { r: 139 / 255, g: 92 / 255, b: 246 / 255 };
		const warm = { r: 236 / 255, g: 72 / 255, b: 153 / 255 };

		for (let i = 0; i < this.basePositions.length; i += 3) {
			const x = this.basePositions[i];
			const y0 = this.basePositions[i + 1];

			const mask = Math.max(intervalMask(x, this.midX, this.ballAx), intervalMask(x, this.midX, this.ballBx));
			const band = Math.exp(-Math.abs(x - this.midX) / 120) * 0.10 * (1 - smoothstep(0, 10, moved));
			const m = Math.max(mask, band);

			let wave = 0;
			for (let r = 0; r < this.ripples.length; r++) {
				const rr = this.ripples[r];
				const dt = time - rr.start;
				if (dt < 0) continue;
				const dx = x - rr.x;
				const dy = y0 - rr.y;
				const d = Math.hypot(dx, dy);
				const w = Math.sin(d * 0.10 - dt * 7.0);
				const env = Math.exp(-dt * 1.35) * Math.exp(-d * 0.02);
				wave += w * env;
			}

			const jitter = (this.seeds[i / 3] - 0.5) * 0.8;
			this.positions[i] = x + jitter;
			this.positions[i + 1] = y0 + wave * 3.5;
			this.positions[i + 2] = 0;

			const side = x >= this.midX ? 1 : 0;
			const base = side ? warm : cool;
			const intensity = m * (0.55 + clamp(Math.abs(wave), 0, 1) * 0.45);
			this.colors[i] = base.r * intensity;
			this.colors[i + 1] = base.g * intensity;
			this.colors[i + 2] = base.b * intensity;
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
