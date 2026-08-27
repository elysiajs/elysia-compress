const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/

export const negotiate = (
	header: string | null | undefined,
	available: readonly string[]
): string | null => {
	if (!header) return null

	const requested = new Map<string, number>()
	let wildcard: number | undefined

	for (const directive of header.split(',')) {
		const [rawName, ...parameters] = directive.split(';')
		const name = rawName.trim().toLowerCase()

		if (!name) continue

		let q = 1

		for (const parameter of parameters) {
			const separator = parameter.indexOf('=')

			if (separator === -1) continue

			const key = parameter.slice(0, separator).trim().toLowerCase()
			const raw = parameter.slice(separator + 1).trim()

			if (key === 'q' && Q_VALUE.test(raw)) q = Number.parseFloat(raw)
		}

		if (name === '*') wildcard = q
		else requested.set(name, q)
	}

	let best: string | null = null
	let bestQ = 0

	for (const encoding of available) {
		const q = requested.get(encoding) ?? wildcard

		if (q === undefined || q <= bestQ) continue

		best = encoding
		bestQ = q
	}

	const identityQ = requested.get('identity') ?? wildcard

	return best !== null && identityQ !== undefined && identityQ > bestQ
		? null
		: best
}
