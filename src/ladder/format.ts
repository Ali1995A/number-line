export type DisplayMode = "friendly" | "full";

function groupDigits(digits: string): string {
	const out: string[] = [];
	for (let i = digits.length; i > 0; i -= 3) {
		out.push(digits.slice(Math.max(0, i - 3), i));
	}
	return out.reverse().join(",");
}

export function formatFullSigned(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	if (value === 0) return "0";
	const sign = value < 0 ? "-" : "+";
	const abs = Math.abs(value);
	if (Number.isInteger(abs) && abs >= 1e6) {
		const rounded = BigInt(Math.round(abs));
		return `${sign}${groupDigits(rounded.toString())}`;
	}
	if (Number.isInteger(abs)) return `${sign}${abs.toFixed(0)}`;
	return `${sign}${abs.toFixed(2).replace(/\.?0+$/, "")}`;
}

export function pow10BigInt(k: number): bigint {
	if (!Number.isInteger(k) || k < 0) throw new Error(`k must be a non-negative integer, got ${k}`);
	let out = 1n;
	for (let i = 0; i < k; i++) out *= 10n;
	return out;
}

export function formatFriendlyBigInt(value: bigint): string {
	const negative = value < 0n;
	let abs = negative ? -value : value;

	const YI = 100000000n; // 10^8
	const WAN_YI = 1000000000000n; // 10^12
	const YI_YI = 10000000000000000n; // 10^16

	let core: string;
	if (abs === 0n) {
		core = "0";
	} else if (abs >= YI_YI) {
		const q = abs / YI_YI;
		core = `${q.toString()} 亿亿/京`;
	} else if (abs >= WAN_YI) {
		const q = abs / WAN_YI;
		core = `${q.toString()} 万亿`;
	} else if (abs >= YI) {
		const q = abs / YI;
		core = `${q.toString()} 亿`;
	} else if (abs >= 10000n) {
		const q = abs / 10000n;
		core = `${q.toString()} 万`;
	} else {
		core = abs.toString();
	}

	return negative ? `-${core}` : core;
}

export function formatFriendlyNumber(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	if (value === 0) return "0";
	const negative = value < 0;
	const abs = Math.abs(value);
	const rounded = abs >= 1 ? abs.toFixed(0) : abs.toFixed(2).replace(/\.?0+$/, "");
	return negative ? `-${rounded}` : rounded;
}

export function formatScaleLabel(k: number): string {
	const pow = pow10BigInt(k);
	const friendly = formatFriendlyBigInt(pow);
	return `当前尺度：10^${k}${friendly === "1" ? "" : `（${friendly}）`}`;
}
