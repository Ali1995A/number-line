import * as THREE from "three";

type Ripple = { x: number; y: number; start: number };

export class ParticleRipples {
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

	constructor(
		private host: HTMLElement,
		private beforeEl?: Element,
	) {
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

		if (this.beforeEl) host.insertBefore(canvas, this.beforeEl);
		else host.appendChild(canvas);

		this.renderer = new THREE.WebGLRenderer({
			canvas,
			alpha: true,
			antialias: true,
			powerPreference: "low-power",
		});
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

		this.scene = new THREE.Scene();
		this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
		this.camera.position.set(0, 0, 1);

		this.material = new THREE.ShaderMaterial({
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
				uCool: { value: new THREE.Color("#8B5CF6") }, // violet
				uWarm: { value: new THREE.Color("#EC4899") }, // pink
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

				float hash(vec2 p) {
					return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
				}

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

					float maskA = intervalMask(x, uMidX, uBallAx);
					float maskB = intervalMask(x, uMidX, uBallBx);
					float mask = max(maskA, maskB);
					vMask = mask;
					vSide = step(uMidX, x); // 0 violet(neg), 1 pink(pos)

					// wave accumulator (no dynamic break for WebGL1 compatibility)
					float w = 0.0;
					for (int i = 0; i < 8; i++) {
						if (i >= uRippleCount) {
							// keep loop, just skip
						}
						if (i >= uRippleCount) continue;

						float t = uTime - uRippleStart[i];
						if (t < 0.0) continue;

						vec2 rp = uRipplePos[i];
						float d = distance(vec2(x, y), rp);
						// radial ripple
						float wave = sin(d * 0.10 - t * 7.0);
						float env = exp(-t * 1.35) * exp(-d * 0.020);
						w += wave * env;
					}
					vWave = w;

					// subtle jitter to avoid rigid grid
					float jx = (hash(vec2(x, y)) - 0.5) * 0.8;
					float jy = (hash(vec2(y, x)) - 0.5) * 0.8;

					float amp = clamp(abs(vWave), 0.0, 1.0) * 4.0;
					float yy = y + jy + vWave * amp;
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

					float w = clamp(vWave * 0.6, -1.0, 1.0);
					vec3 color = base + vec3(max(0.0, w)) * 0.10;

					// IMPORTANT: alpha must not exceed 0.5
					float alpha = vMask * soft * (0.22 + clamp(abs(vWave), 0.0, 1.0) * 0.18);
					alpha = clamp(alpha, 0.0, 0.5);
					gl_FragColor = vec4(color, alpha);
				}
			`,
		});

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
		this.points = new THREE.Points(geometry, this.material);
		this.points.frustumCulled = false;
		this.scene.add(this.points);

		this.resize();
		this.start();
	}

	setMask(params: { width: number; height: number; midX: number; ballAx: number; ballBx: number }) {
		this.width = Math.max(1, Math.floor(params.width));
		this.height = Math.max(1, Math.floor(params.height));
		this.material.uniforms.uMidX.value = params.midX;
		this.material.uniforms.uBallAx.value = params.ballAx;
		this.material.uniforms.uBallBx.value = params.ballBx;
	}

	addRipple(x: number, y: number) {
		const now = performance.now() / 1000;
		this.pushRipple({ x, y, start: now });
		// mirrored across 0-axis (vertical center line)
		this.pushRipple({ x: this.width - x, y, start: now });
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
		this.rafId = null;
		this.renderer.dispose();
		this.points.geometry.dispose();
		this.material.dispose();
	}

	private start() {
		const loop = () => {
			if (this.destroyed) return;
			const t = performance.now() / 1000;
			this.material.uniforms.uTime.value = t;

			// keep last 8 ripples, and drop older than 2s
			this.ripples = this.ripples.filter((r) => t - r.start < 2.0);
			if (this.ripples.length > 8) this.ripples.splice(0, this.ripples.length - 8);

			this.material.uniforms.uRippleCount.value = this.ripples.length;
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
		// Keep it visible and cheap on iPad: a few thousand points
		const spacing = clampInt(Math.round(Math.min(this.width, this.height) / 36), 7, 14);
		const xs = Math.max(1, Math.floor(this.width / spacing));
		const ys = Math.max(1, Math.floor(this.height / spacing));
		const count = xs * ys;

		const arr = new Float32Array(count * 3);
		let i = 0;
		for (let y = 0; y < ys; y++) {
			for (let x = 0; x < xs; x++) {
				const px = x * spacing + spacing * 0.5;
				const py = y * spacing + spacing * 0.5;
				arr[i++] = px;
				arr[i++] = py;
				arr[i++] = 0;
			}
		}
		this.points.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
		this.points.geometry.computeBoundingSphere();
	}

	private pushRipple(r: Ripple) {
		this.ripples.push(r);
	}
}

function clampInt(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

