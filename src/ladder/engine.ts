import { INumberLineOptions, ITickMarkLabelStrategy, NumberLine } from "../../lib/number-line";

export interface LadderEngine {
	numberLine: NumberLine;
	width: number;
	k: number;
	maxAbsValue: number;
	unitValue: number;
}

export function createLadderEngine(k: number, width: number): LadderEngine {
	const safeWidth = Math.max(1, Math.floor(width));
	const maxAbsValue = Math.pow(10, k);
	// make ticks feel "finer": represent range [-10^k, +10^k] as 20 units across the viewport
	// => unitValue = 10^(k-1), unitLength = width/20
	const unitValue = k === 0 ? 0.1 : Math.pow(10, k - 1);
	const unitLength = safeWidth / 20;

	const labelStrategy: ITickMarkLabelStrategy = {
		labelFor: (value) => {
			const half = maxAbsValue / 2;
			const eps = Math.max(1e-9, unitValue / 10);
			const isClose = (a: number, b: number) => Math.abs(a - b) <= eps;
			if (isClose(value, 0) || isClose(Math.abs(value), half) || isClose(Math.abs(value), maxAbsValue)) return "1";
			return null;
		},
	};

	const options: INumberLineOptions = {
		// classic: major at 0, mid at 5, minors elsewhere
		pattern: [3, 1, 1, 1, 1, 2, 1, 1, 1, 1],
		// lock unitLength so pixel spacing stays stable; show [-10^k, +10^k] across full width
		breakpointLowerbound: unitLength,
		breakpointUpperBound: unitLength,
		zoomPeriod: 1,
		zoomFactor: unitValue,
		labelStrategy,
		initialMagnification: 0,
		initialDisplacement: 0,
	};

	const numberLine = new NumberLine(options);
	// Map values exactly: x=0 => -10^k, x=width/2 => 0, x=width => +10^k
	numberLine.panTo(-safeWidth / 2);

	return {
		numberLine,
		width: safeWidth,
		k,
		maxAbsValue,
		unitValue,
	};
}
