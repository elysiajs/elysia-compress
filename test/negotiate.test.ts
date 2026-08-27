import { describe, expect, it } from 'bun:test'

import { negotiate } from '../src/negotiate'

const available = ['br', 'gzip', 'deflate'] as const

describe('negotiate', () => {
	it.each([
		['br;q=0.5, gzip;q=0.9', 'gzip'],
		['br;q=0, gzip;q=1', 'gzip'],
		['gzip;q=0, *;q=1', 'br'],
		['identity;q=1, gzip;q=0.5', null],
		['identity, gzip', 'gzip'],
		['gzip;q=1.5, br;q=1', 'br'],
		['gzip;q=0garbage', 'gzip'],
		['gzip;q=0=garbage', 'gzip'],
		['GZIP;Q=0.9', 'gzip'],
		['foo', null],
		['', null]
	] as const)('negotiates %s as %s', (header, expected) => {
		expect(negotiate(header, available)).toBe(expected)
	})

	it('handles missing headers and explicit refusal', () => {
		expect(negotiate(null, available)).toBeNull()
		expect(negotiate(undefined, available)).toBeNull()
		expect(negotiate('identity;q=0, *;q=0', available)).toBeNull()
	})
})
