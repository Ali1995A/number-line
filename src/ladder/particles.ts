import * as THREE from "three";

type Ripple = { x: number; y: number; start: number };

export class ParticleRipples {
	private impl: WebGLImpl | Canvas2DImpl;

	constructor(
		private host: HTMLElement,
		private beforeEl?: Element,
	) {
		try {
			this.impl = new WebGLImpl(host, beforeEl);
		} catch {
			this.impl = new Canvas2DImpl(host, beforeEl);
		}
	}

	setMask(params: { width: number; height: number; midX: number; ballAx: number; ballBx: number }) {
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

function clampInt(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

type MaskParams = { width: number; height: number; midX: number; ballAx: number; ballBx: number };

class WebGLImpl {
	private renderer: THREE.WebGLRenderer;
	private scene: THREE.Scene;
	private camera: THREE.OrthographicCamera;
	private material: THREE.ShaderMaterial;
	private points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
	private ripples: Ripple[] = [];
	private rafId: number | null = null;
	private destroyed = false;
	private width = 1;
	private height = 1;

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

		this.material = makeShaderMaterial();
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
		this.points = new THREE.Points(geometry, this.material);
		this.points.frustumCulled = false;
		this.scene.add(this.points);

		this.resize();
		this.start();
	}

	setMask(params: MaskParams) {
		this.material.uniforms.uMidX.value = params.midX;
		this.material.uniforms.uBallAx.value = params.ballAx;
		this.material.uniforms.uBallBx.value = params.ballBx;
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
		this.material.uniforms.uResolution.value.set(this.width, this.height);

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
		this.renderer.dispose();
		this.points.geometry.dispose();
		this.material.dispose();
	}

	private start() {
		const loop = () => {
			if (this.destroyed) return;
			const t = performance.now() / 1000;
			this.material.uniforms.uTime.value = t;
			this.ripples = this.ripples.filter((r) => t - r.start < 2.0);
			this.material.uniforms.uRippleCount.value = Math.min(this.ripples.length, 8);

			const pos = this.material.uniforms.uRipplePos.value as THREE.Vector2[];
			const start = this.material.uniforms.uRippleStart.value as Float32Array;
			for (let i = 0; i < 8; i++) {
				if (i < this.ripples.length) {
					pos[i].set(this.ripples[i].x, this.ripples[i].y);
					start[i] = this.ripples[i].start;
				} else {
					pos[i].set(-9999, -9999);
					start[i] = 0;
				}
			}

			this.renderer.render(this.scene, this.camera);
			this.rafId = requestAnimationFrame(loop);
		};
		this.rafId = requestAnimationFrame(loop);
	}

	private rebuildParticles() {
		const spacing = clampInt(Math.round(Math.min(this.width, this.height) / 36), 7, 14);
		const xs = Math.max(1, Math.floor(this.width / spacing));
		const ys = Math.max(1, Math.floor(this.height / spacing));
		const count = xs * ys;
		const arr = new Float32Array(count * 3);
		let i = 0;
		for (let y = 0; y < ys; y++) {
			for (let x = 0; x < xs; x++) {
				arr[i++] = x * spacing + spacing * 0.5;
				arr[i++] = y * spacing + spacing * 0.5;
				arr[i++] = 0;
			}
		}
		this.points.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
		this.points.geometry.computeBoundingSphere();
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

function makeShaderMaterial() {
	return new THREE.ShaderMaterial({
		transparent: true,
		blending: THREE.AdditiveBlending,
		depthTest: false,
		depthWrite: false,
		uniforms: {
			uResolution: { value: new THREE.Vector2(1, 1) },
			uTime: { value: 0 },
			uMidX: { value: 0.5 },
			uBallAx: { value: 0.5 },
			uBallBx: { value: 0.5 },
			uCool: { value: new THREE.Color("#8B5CF6") },
			uWarm: { value: new THREE.Color("#EC4899") },
			uRipplePos: { value: Array.from({ length: 8 }, () => new THREE.Vector2(-9999, -9999)) },
			uRippleStart: { value: new Float32Array(8) },
			uRippleCount: { value: 0 },
		},
		vertexShader: `
			precision mediump float;
			uniform vec2 uResolution;
			uniform float uTime;
			uniform float uMidX;
			uniform float uBallAx;
			uniform float uBallBx;
			uniform vec2 uRipplePos[8];
			uniform float uRippleStart[8];
			uniform int uRippleCount;

			varying float vMask;
			varying float vSide;
			varying float vWave;

			float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
			float intervalMask(float x, float a, float b) {
				float lo = min(a, b);
				float hi = max(a, b);
				float edge = 14.0;
				float m1 = smoothstep(lo, lo + edge, x);
				float m2 = 1.0 - smoothstep(hi - edge, hi, x);
				return m1 * m2;
			}

			void main() {
				float x = position.x;
				float y = position.y;

				float mask = max(intervalMask(x, uMidX, uBallAx), intervalMask(x, uMidX, uBallBx));
				// faint center band so it never looks "broken"
				float moved = abs(uBallAx - uMidX) + abs(uBallBx - uMidX);
				float band = exp(-abs(x - uMidX) / 120.0) * 0.10 * (1.0 - smoothstep(0.0, 10.0, moved));
				vMask = max(mask, band);
				vSide = step(uMidX, x);

				float w = 0.0;
				for (int i = 0; i < 8; i++) {
					if (i >= uRippleCount) {
						// no break (WebGL1)
					}
					if (i >= uRippleCount) continue;
					float t = uTime - uRippleStart[i];
					if (t < 0.0) continue;
					float d = distance(vec2(x, y), uRipplePos[i]);
					float wave = sin(d * 0.10 - t * 7.0);
					float env = exp(-t * 1.35) * exp(-d * 0.020);
					w += wave * env;
				}
				vWave = w;

				float jx = (hash(vec2(x, y)) - 0.5) * 0.8;
				float jy = (hash(vec2(y, x)) - 0.5) * 0.8;
				float yy = y + jy + vWave * 3.5;
				float xx = x + jx;

				float ndcX = (xx / uResolution.x) * 2.0 - 1.0;
				float ndcY = 1.0 - (yy / uResolution.y) * 2.0;
				gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);

				float base = 2.2 + hash(vec2(x, y)) * 1.3;
				float bump = clamp(vWave, 0.0, 1.0) * 2.0;
				gl_PointSize = (base + bump) * 1.6;
			}
		`,
		fragmentShader: `
			precision mediump float;
			uniform vec3 uCool;
			uniform vec3 uWarm;
			varying float vMask;
			varying float vSide;
			varying float vWave;
			void main() {
				vec2 p = gl_PointCoord * 2.0 - 1.0;
				float r2 = dot(p, p);
				if (r2 > 1.0) discard;
				float soft = smoothstep(1.0, 0.0, r2);
				vec3 base = mix(uCool, uWarm, vSide);
				float glow = clamp(abs(vWave), 0.0, 1.0);
				vec3 color = base + vec3(max(0.0, vWave)) * 0.10;
				float alpha = vMask * soft * (0.22 + glow * 0.18);
				alpha = clamp(alpha, 0.0, 0.5);
				gl_FragColor = vec4(color, alpha);
			}
		`,
	});
}
