import { Elysia } from 'elysia'

import { compress } from '../src/index'
import { negotiate } from '../src/negotiate'

// --- methodology ---------------------------------------------------------
// 2000-iteration warmup per scenario, then 7 batches of 2000 iterations.
// Each batch's ops/sec is elapsed-time based; the reported number is the
// median batch, which is more resistant to a single GC-pause outlier than
// a mean would be. Bun.gc(true) runs between scenarios so one scenario's
// garbage doesn't bias the next one's timing.

const WARMUP = 2000
const BATCH_SIZE = 2000
const BATCHES = 7

interface Result {
	name: string
	opsPerSec: number
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]
}

const run = async (name: string, fn: () => unknown): Promise<Result> => {
	for (let i = 0; i < WARMUP; i++) await fn()

	const batchOps: number[] = []

	for (let batch = 0; batch < BATCHES; batch++) {
		const start = Bun.nanoseconds()

		for (let i = 0; i < BATCH_SIZE; i++) await fn()

		const elapsedSeconds = (Bun.nanoseconds() - start) / 1e9
		batchOps.push(BATCH_SIZE / elapsedSeconds)
	}

	Bun.gc(true)

	return { name, opsPerSec: median(batchOps) }
}

// --- scenario fixtures ----------------------------------------------------

const skipApp = new Elysia()
	.use(compress())
	.get(
		'/img',
		() =>
			new Response(new Uint8Array(2048), {
				headers: { 'content-type': 'image/png' }
			})
	)

// ~2KB JSON body
const jsonBody2k = { data: 'x'.repeat(1985) }
const gzipApp = new Elysia().use(compress()).get('/json', () => jsonBody2k)

// ~60KB JSON body
const jsonBody60k = { data: 'x'.repeat(59989) }
const zstdApp = new Elysia().use(compress()).get('/big', () => jsonBody60k)

// 100B text, below the default 1024B threshold
const tinyText = 'x'.repeat(100)
const tinyApp = new Elysia().use(compress()).get('/tiny', () => tinyText)

const skipRequest = () =>
	new Request('http://localhost/img', {
		headers: { 'accept-encoding': 'gzip' }
	})

const gzipRequest = () =>
	new Request('http://localhost/json', {
		headers: { 'accept-encoding': 'gzip' }
	})

const zstdRequest = () =>
	new Request('http://localhost/big', {
		headers: { 'accept-encoding': 'zstd' }
	})

const tinyRequest = () =>
	new Request('http://localhost/tiny', {
		headers: { 'accept-encoding': 'gzip' }
	})

// consume the body so the buffered lanes actually finish their work, same
// as a real client would
const consume = async (response: Response) => {
	if (response.body) await response.arrayBuffer()
}

// four realistic Accept-Encoding strings, cycled one per call so each
// iteration is a single negotiate() call — comparable in scale to the
// other scenarios' "one request = one op"
const NEGOTIATE_AVAILABLE = ['br', 'zstd', 'gzip', 'deflate'] as const
const NEGOTIATE_HEADERS = [
	'gzip, deflate, br, zstd', // Chrome
	'gzip, deflate, br', // Safari
	'br;q=1.0, gzip;q=0.8, *;q=0.1',
	''
]

let negotiateCursor = 0

const negotiateOnce = () => {
	const header = NEGOTIATE_HEADERS[negotiateCursor % NEGOTIATE_HEADERS.length]
	negotiateCursor++
	return negotiate(header || null, NEGOTIATE_AVAILABLE)
}

const formatOps = (ops: number) => Math.round(ops).toLocaleString('en-US')

const main = async () => {
	const results: Result[] = []

	results.push(
		await run('a) skip (image/png passthrough)', async () => {
			await consume(await skipApp.handle(skipRequest()))
		})
	)

	results.push(
		await run('b) buffered gzip (2KB json)', async () => {
			await consume(await gzipApp.handle(gzipRequest()))
		})
	)

	results.push(
		await run('c) buffered zstd (60KB json)', async () => {
			await consume(await zstdApp.handle(zstdRequest()))
		})
	)

	results.push(
		await run('d) under-threshold (100B text, withVary)', async () => {
			await consume(await tinyApp.handle(tinyRequest()))
		})
	)

	results.push(await run('e) negotiate() isolated', () => negotiateOnce()))

	// --- memory delta check on scenario (b) --------------------------------
	Bun.gc(true)
	const heapBefore = process.memoryUsage().heapUsed

	for (let i = 0; i < 20000; i++)
		await consume(await gzipApp.handle(gzipRequest()))

	Bun.gc(true)
	const heapAfter = process.memoryUsage().heapUsed
	const heapDeltaKB = (heapAfter - heapBefore) / 1024

	// --- report --------------------------------------------------------------
	const nameWidth = Math.max(...results.map((r) => r.name.length)) + 2

	console.log('')
	console.log(`${'scenario'.padEnd(nameWidth)}ops/sec`)
	console.log('-'.repeat(nameWidth + 14))

	for (const r of results)
		console.log(`${r.name.padEnd(nameWidth)}${formatOps(r.opsPerSec)}`)

	console.log('')
	console.log(
		`heap delta after 20,000 extra iterations of (b), post-gc: ${
			heapDeltaKB >= 0 ? '+' : ''
		}${heapDeltaKB.toFixed(1)} KB`
	)
}

await main()
