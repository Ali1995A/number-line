import * as THREE from "three";

type Ripple = { x: number; y: number; start: number };

export class ParticleField {
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
	private midX = 0.5;
	private ballAx = 0.5;
	private ballBx = 0.5;

	constructor(private host: HTMLElement) {
		const canvas = document.createElement("canvas");
		canvas.className = "nl-particles";
		canvas.style.position = "absolute";
		canvas.style.inset = "0";
		canvas.style.width = "100%";
		canvas.style.height = "100%";
		canvas.style.pointerEvents = "none";
		canvas.style.borderRadius = "16px";

		// insert as first child so DOM ticks/balls render above it
		host.prepend(canvas);

		this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

		this.scene = new THREE.Scene();
		this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
		this.camera.position.set(0, 0, 1);

		this.material = new THREE.ShaderMaterial({
			transparent: true,
			depthTest: false,
			depthWrite: false,
			uniforms: {
				uResolution: { value: new THREE.Vector2(1, 1) },
				uTime: { value: 0 },
				uMidX: { value: 0.5 },
				uBallAx: { value: 0.5 },
				uBallBx: { value: 0.5 },
				uCool: { value: new THREE.Color("#3B82F6") },
				uWarm: { value: new THREE.Color("#F97316") },
				uRipplePos: { value: Array.from({ length: 8 }, () => new THREE.Vector2(-9999, -9999)) },
				uRippleStart: { value: new Float32Array(8) },
				uRippleCount: { value: 0 },
			},
			vertexShader: `
				uniform vec2 uResolution;
				uniform float uTime;
				uniform float uMidX;
				uniform float uBallAx;
				uniform float uBallBx;
				uniform vec2 uRipplePos[8];
				uniform float uRippleStart[8];
				uniform int uRippleCount;

				attribute vec3 position;

				varying float vMask;
				varying float vSide;
				varying float vRipple;

				float intervalMask(float x, float a, float b) {
					float lo = min(a, b);
					float hi = max(a, b);
					// soft edges: 10px fade
					float edge = 10.0;
					float m1 = smoothstep(lo, lo + edge, x);
					float m2 = 1.0 - smoothstep(hi - edge, hi, x);
					return m1 * m2;
				}

				void main() {
					float x = position.x;
					float y = position.y;

					float maskA = intervalMask(x, uMidX, uBallAx);
					float maskB = intervalMask(x, uMidX, uBallBx);
					vMask = max(maskA, maskB);
					vSide = step(uMidX, x); // 0: cool, 1: warm

					// ripple signal
					float ripple = 0.0;
					for(int i=0;i<8;i++){
						if(i>=uRippleCount) break;
						float t = uTime - uRippleStart[i];
						if(t < 0.0) continue;
						float d = distance(vec2(x,y), uRipplePos[i]);
						float wave = sin(d * 0.085 - t * 6.0);
						float env = exp(-t * 1.6) * exp(-d * 0.015);
						ripple += wave * env;
					}
					vRipple = ripple;

					// to clip space (pixel coords -> NDC)
					float ndcX = (x / uResolution.x) * 2.0 - 1.0;
					float ndcY = 1.0 - (y / uResolution.y) * 2.0;
					gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);

					float baseSize = 1.7;
					float sizeJitter = fract(sin(dot(vec2(x,y), vec2(12.9898,78.233))) * 43758.5453);
					float rippleSize = max(0.0, vRipple) * 1.4;
					gl_PointSize = (baseSize + sizeJitter * 1.2 + rippleSize) * (uResolution.y / 520.0);
				}
			`,
			fragmentShader: `
				precision highp float;

				uniform vec3 uCool;
				uniform vec3 uWarm;

				varying float vMask;
				varying float vSide;
				varying float vRipple;

				void main() {
					// round point
					vec2 p = gl_PointCoord.xy * 2.0 - 1.0;
					float r2 = dot(p,p);
					if(r2 > 1.0) discard;
					float soft = smoothstep(1.0, 0.0, r2);

					vec3 base = mix(uCool, uWarm, vSide);
					// ripple brightens slightly
					float glow = clamp(vRipple, 0.0, 0.9);
					vec3 color = mix(base, vec3(1.0), glow * 0.25);

					float alpha = vMask * soft * (0.10 + glow * 0.10);
					gl_FragColor = vec4(color, alpha);
				}
			`,
		});

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
		this.points = new THREE.Points(geometry, this.material);
		this.scene.add(this.points);

		this.resize();
		this.start();
	}

	setMask(params: { width: number; height: number; midX: number; ballAx: number; ballBx: number }) {
		this.width = Math.max(1, Math.floor(params.width));
		this.height = Math.max(1, Math.floor(params.height));
		this.midX = params.midX;
		this.ballAx = params.ballAx;
		this.ballBx = params.ballBx;
		this.material.uniforms.uMidX.value = this.midX;
		this.material.uniforms.uBallAx.value = this.ballAx;
		this.material.uniforms.uBallBx.value = this.ballBx;
	}

	addRipple(x: number, y: number) {
		const now = performance.now() / 1000;
		this.pushRipple({ x, y, start: now });
		// mirrored across 0-axis (vertical center line)
		this.pushRipple({ x: this.width - x, y, start: now });
	}

	private pushRipple(r: Ripple) {
		this.ripples.push(r);
		// keep last 8
		if (this.ripples.length > 8) this.ripples.splice(0, this.ripples.length - 8);
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

	private rebuildParticles() {
		// density tuned for iPad: ~12k-18k points
		const spacing = Math.max(10, Math.round(Math.min(this.width, this.height) / 26));
		const xs = Math.floor(this.width / spacing);
		const ys = Math.floor(this.height / spacing);
		const count = Math.max(1, xs * ys);
		const arr = new Float32Array(count * 3);
		let i = 0;
		for (let y = 0; y < ys; y++) {
			for (let x = 0; x < xs; x++) {
				const px = x * spacing + (spacing * 0.5);
				const py = y * spacing + (spacing * 0.5);
				arr[i++] = px;
				arr[i++] = py;
				arr[i++] = 0;
			}
		}
		this.points.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
		this.points.geometry.computeBoundingSphere();
	}

	private start() {
		const loop = () => {
			if (this.destroyed) return;
			const t = performance.now() / 1000;
			this.material.uniforms.uTime.value = t;

			// prune old ripples
			this.ripples = this.ripples.filter((r) => t - r.start < 1.8);
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

	destroy() {
		this.destroyed = true;
		if (this.rafId != null) cancelAnimationFrame(this.rafId);
		this.rafId = null;
		this.renderer.dispose();
		this.points.geometry.dispose();
		this.material.dispose();
	}
}

