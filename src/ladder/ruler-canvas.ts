import type { LadderEngine } from "./engine";

export type RulerRenderParams = {
	width: number;
	height: number;
	fullNumber: boolean;
	k: number;
	engine: LadderEngine;
	transition?: {
		fromK: number;
		toK: number;
		ease: number; // eased progress 0..1
		t: number; // raw progress 0..1
		fromEngine: LadderEngine;
		toEngine: LadderEngine;
	};
	formatValue: (value: number, full: boolean, k: number) => string;
	lowEnd: boolean;
};

export class RulerCanvas {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private dpr = 1;
	private lowEnd = false;

	constructor(private host: HTMLElement, private beforeEl?: Element) {
		this.canvas = document.createElement("canvas");
		this.canvas.className = "nl-ruler-canvas";
		this.canvas.style.position = "absolute";
		this.canvas.style.inset = "0";
		this.canvas.style.width = "100%";
		this.canvas.style.height = "100%";
		this.canvas.style.pointerEvents = "none";
		this.canvas.style.zIndex = "2";

		if (this.beforeEl) host.insertBefore(this.canvas, this.beforeEl);
		else host.appendChild(this.canvas);

		const ctx = this.canvas.getContext("2d", { alpha: true, desynchronized: true });
		if (!ctx) throw new Error("2D canvas not supported");
		this.ctx = ctx;
	}

	setLowEnd(lowEnd: boolean) {
		this.lowEnd = lowEnd;
		this.resize();
	}

	resize() {
		const rect = this.host.getBoundingClientRect();
		this.dpr = Math.min(window.devicePixelRatio || 1, this.lowEnd ? 1 : 2);
		this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
		this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
		this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
	}

	render(p: RulerRenderParams) {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, p.width, p.height);

		const drawAxesLayer = (engine: LadderEngine, kForLabels: number, alpha: number, scale: number) => {
			const midX = p.width / 2;
			const yBase = p.height - 52;
			const topPad = 56;
			const leftPad = 18;

			// Scale around the number-line origin (0 at center, baseline at bottom).
			ctx.save();
			ctx.globalAlpha = alpha;
			ctx.translate(midX, yBase);
			ctx.scale(scale, scale);
			ctx.translate(-midX, -yBase);

			// Horizontal baseline
			ctx.lineWidth = 2;
			ctx.strokeStyle = "rgba(15, 23, 42, 0.28)";
			ctx.beginPath();
			ctx.moveTo(0, yBase + 0.5);
			ctx.lineTo(p.width, yBase + 0.5);
			ctx.stroke();

			const max = kForLabels === 0 ? 1 : Math.pow(10, kForLabels);
			const half = max / 2;
			const ticks = [
				{ v: -max, major: true },
				{ v: -half, major: false },
				{ v: 0, major: true },
				{ v: half, major: false },
				{ v: max, major: true },
			];

			// Labels & ticks: minimal set (avoids "fog" while staying kid-friendly).
			ctx.font = "700 13px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.lineWidth = 4; // stroke halo only around text (not a global veil)
			ctx.strokeStyle = "rgba(255,255,255,1)";
			ctx.fillStyle = "rgba(30, 41, 59, 0.92)";

			for (const t of ticks) {
				const x = valueToX(engine, t.v);
				const h = t.major ? 44 : 30;
				ctx.strokeStyle = t.major ? "rgba(15, 23, 42, 0.52)" : "rgba(15, 23, 42, 0.36)";
				ctx.lineWidth = t.major ? 2 : 1;
				ctx.beginPath();
				ctx.moveTo(x + 0.5, yBase);
				ctx.lineTo(x + 0.5, yBase - h);
				ctx.stroke();

				const label = p.formatValue(t.v, p.fullNumber, kForLabels);
				// text halo without blur
				ctx.lineWidth = 5;
				ctx.strokeStyle = "rgba(255,255,255,0.98)";
				ctx.strokeText(label, x, yBase + 20);
				ctx.fillStyle = "rgba(30, 41, 59, 0.95)";
				ctx.fillText(label, x, yBase + 20);
			}

			// Vertical axis: bottom-origin (0 at baseline), no negative values.
			const vBaseY = yBase;
			const vTopY = clamp(topPad, 0, p.height);
			const usable = Math.max(90, vBaseY - vTopY);
			ctx.strokeStyle = "rgba(15, 23, 42, 0.24)";
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.moveTo(midX + 0.5, vTopY);
			ctx.lineTo(midX + 0.5, vBaseY);
			ctx.stroke();

			const yFor = (v: number) => vBaseY - clamp(v / max, 0, 1) * usable;
			const vTicks = [
				{ v: 0, major: true },
				{ v: half, major: false },
				{ v: max, major: true },
			];

			ctx.textAlign = "left";
			for (const t of vTicks) {
				const y = yFor(t.v);
				const len = t.major ? 14 : 10;
				ctx.strokeStyle = t.major ? "rgba(15, 23, 42, 0.44)" : "rgba(15, 23, 42, 0.30)";
				ctx.lineWidth = t.major ? 2 : 1;
				ctx.beginPath();
				ctx.moveTo(midX - len, y + 0.5);
				ctx.lineTo(midX + len, y + 0.5);
				ctx.stroke();

				const label = p.formatValue(t.v, p.fullNumber, kForLabels);
				ctx.lineWidth = 5;
				ctx.strokeStyle = "rgba(255,255,255,0.98)";
				ctx.strokeText(label, midX + len + 10, y);
				ctx.fillStyle = "rgba(30, 41, 59, 0.95)";
				ctx.fillText(label, midX + len + 10, y);
			}

			// Simple Y-axis title
			ctx.save();
			ctx.translate(leftPad, vTopY + 12);
			ctx.font = "700 12px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial";
			ctx.fillStyle = "rgba(100, 116, 139, 0.95)";
			ctx.fillText("数量", 0, 0);
			ctx.restore();

			ctx.restore();
		};

		if (p.transition) {
			const dir = Math.sign(p.transition.toK - p.transition.fromK) || 1;
			const t = p.transition.t;
			const ease = p.transition.ease;
			// Scale uses raw `t` for a stronger “real 10× zoom” feel.
			const fromScale = Math.pow(10, -dir * t);
			const toScale = Math.pow(10, dir * (1 - t));
			const mix = smoothstep(0.22, 0.78, ease);

			drawAxesLayer(p.transition.fromEngine, p.transition.fromK, 1 - mix, fromScale);
			drawAxesLayer(p.transition.toEngine, p.transition.toK, mix, toScale);
		} else {
			drawAxesLayer(p.engine, p.k, 1, 1);
		}
	}
}

function clamp(v: number, lo: number, hi: number) {
	return Math.min(Math.max(v, lo), hi);
}

function valueToX(engine: LadderEngine, value: number) {
	const ratio = engine.numberLine.unitLength / engine.numberLine.unitValue;
	return value * ratio - engine.numberLine.displacement;
}

function smoothstep(edge0: number, edge1: number, x: number) {
	const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
	return t * t * (3 - 2 * t);
}
