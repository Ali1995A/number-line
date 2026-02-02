export interface StepperOptions {
	stepMs: number;
}

export class DiscreteStepper {
	private rafId: number | null = null;
	private running = false;
	private currentK = 0;
	private targetK = 0;
	private lastStepAt = 0;
	private stepMs = 320;

	constructor(
		initialK: number,
		private onStep: (nextK: number) => void,
		options?: Partial<StepperOptions>,
	) {
		this.currentK = initialK;
		this.targetK = initialK;
		if (options?.stepMs != null) this.stepMs = options.stepMs;
	}

	setStepMs(stepMs: number) {
		this.stepMs = Math.max(0, Math.floor(stepMs));
	}

	getCurrentK() {
		return this.currentK;
	}

	cancel() {
		this.running = false;
		if (this.rafId != null) cancelAnimationFrame(this.rafId);
		this.rafId = null;
	}

	requestTo(targetK: number) {
		this.targetK = targetK;
		if (this.running) return;
		this.running = true;
		this.lastStepAt = performance.now();
		const tick = (t: number) => {
			if (!this.running) return;
			const dir = Math.sign(this.targetK - this.currentK);
			if (dir === 0) {
				this.running = false;
				this.rafId = null;
				return;
			}
			if (t - this.lastStepAt >= this.stepMs) {
				this.currentK = this.currentK + dir;
				this.onStep(this.currentK);
				this.lastStepAt = t;
			}
			this.rafId = requestAnimationFrame(tick);
		};
		this.rafId = requestAnimationFrame(tick);
	}
}

