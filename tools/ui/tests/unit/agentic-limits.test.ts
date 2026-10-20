import { parseAgenticTimeLimitMs, parseAgenticTurnLimit } from '$lib/utils';
import { describe, expect, it } from 'vitest';

/**
 * Tests for the agentic loop-limit parsers (context-enhance/07 D1/D2).
 *
 * `parseAgenticTurnLimit`  — `NaN` → fallback; `<= 0` → unlimited (Infinity);
 *                            `> 0` → rounded integer.
 * `parseAgenticTimeLimitMs` — `NaN` / `<= 0` → 0 (unlimited); `> 0` →
 *                            `value × unitMultiplier × 1000`; invalid unit → `m`.
 */

describe('parseAgenticTurnLimit', () => {
	it('returns the fallback for NaN-ish inputs', () => {
		expect(parseAgenticTurnLimit('abc', 10)).toBe(10);
		expect(parseAgenticTurnLimit(null, 10)).toBe(10);
		expect(parseAgenticTurnLimit(undefined, 10)).toBe(10);
		expect(parseAgenticTurnLimit(NaN, 42)).toBe(42);
	});

	it('treats zero and negative values as unlimited (Infinity) — D1', () => {
		expect(parseAgenticTurnLimit(0, 10)).toBe(Number.POSITIVE_INFINITY);
		expect(parseAgenticTurnLimit(-1, 10)).toBe(Number.POSITIVE_INFINITY);
		expect(parseAgenticTurnLimit(-5, 10)).toBe(Number.POSITIVE_INFINITY);
		expect(parseAgenticTurnLimit('-3', 10)).toBe(Number.POSITIVE_INFINITY);
	});

	it('rounds positive values to the nearest integer', () => {
		expect(parseAgenticTurnLimit(1, 10)).toBe(1);
		expect(parseAgenticTurnLimit(10, 10)).toBe(10);
		expect(parseAgenticTurnLimit(10.2, 10)).toBe(10);
		expect(parseAgenticTurnLimit(10.5, 10)).toBe(11);
		expect(parseAgenticTurnLimit(10.7, 10)).toBe(11);
	});

	it('accepts numeric strings', () => {
		expect(parseAgenticTurnLimit('5', 10)).toBe(5);
		expect(parseAgenticTurnLimit('0', 10)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe('parseAgenticTimeLimitMs', () => {
	it('returns 0 (unlimited) for NaN-ish and non-positive values — D2/D4', () => {
		expect(parseAgenticTimeLimitMs(0, 'm')).toBe(0);
		expect(parseAgenticTimeLimitMs(-5, 'm')).toBe(0);
		expect(parseAgenticTimeLimitMs('abc', 'm')).toBe(0);
		expect(parseAgenticTimeLimitMs(null, 'm')).toBe(0);
		expect(parseAgenticTimeLimitMs(undefined, 'm')).toBe(0);
	});

	it('applies the seconds multiplier (×1000)', () => {
		expect(parseAgenticTimeLimitMs(1, 's')).toBe(1_000);
		expect(parseAgenticTimeLimitMs(30, 's')).toBe(30_000);
	});

	it('applies the minutes multiplier (×60_000)', () => {
		expect(parseAgenticTimeLimitMs(1, 'm')).toBe(60_000);
		expect(parseAgenticTimeLimitMs(5, 'm')).toBe(300_000);
	});

	it('applies the hours multiplier (×3_600_000)', () => {
		expect(parseAgenticTimeLimitMs(1, 'h')).toBe(3_600_000);
		expect(parseAgenticTimeLimitMs(2, 'h')).toBe(7_200_000);
	});

	it('supports decimal values', () => {
		expect(parseAgenticTimeLimitMs(0.5, 'm')).toBe(30_000);
		expect(parseAgenticTimeLimitMs(1.5, 'h')).toBe(5_400_000);
	});

	it('falls back to minutes for unknown / missing units — D2', () => {
		expect(parseAgenticTimeLimitMs(1, 'x')).toBe(60_000);
		expect(parseAgenticTimeLimitMs(1, '')).toBe(60_000);
		expect(parseAgenticTimeLimitMs(1, undefined)).toBe(60_000);
		expect(parseAgenticTimeLimitMs(1, null)).toBe(60_000);
	});

	it('normalises the unit case-insensitively', () => {
		expect(parseAgenticTimeLimitMs(1, 'S')).toBe(1_000);
		expect(parseAgenticTimeLimitMs(1, 'M')).toBe(60_000);
		expect(parseAgenticTimeLimitMs(1, 'H')).toBe(3_600_000);
	});

	it('accepts numeric strings', () => {
		expect(parseAgenticTimeLimitMs('5', 's')).toBe(5_000);
		expect(parseAgenticTimeLimitMs('0', 'm')).toBe(0);
	});
});
