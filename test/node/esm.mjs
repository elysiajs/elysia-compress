import http from 'node:http'
import zlib from 'node:zlib'

import { Elysia } from 'elysia'
import { compress } from '@elysia/compress'

if ('Bun' in globalThis) throw new Error('Expected Node.js')

const body = 'hello world '.repeat(200)
const app = new Elysia()
	.use(compress())
	.get('/', () => body)
	.get('/bytes', () => new Response(new Uint8Array(2048).fill(65)))

const compressed = await app.handle(
	new Request('http://localhost/', {
		headers: { 'accept-encoding': 'gzip' }
	})
)

if (compressed.headers.get('content-encoding') !== 'gzip')
	throw new Error('Node gzip compression failed')

const decoded = zlib
	.gunzipSync(Buffer.from(await compressed.arrayBuffer()))
	.toString()

if (decoded !== body) throw new Error('Node gzip round trip failed')

const largeBody = (
	JSON.stringify({
		id: 12345,
		name: 'compression fixture',
		values: [1, 2, 3, 4, 5],
		active: true
	}) + '\n'
).repeat(15000)
const largeApp = new Elysia().use(compress()).get('/', () => largeBody)
for (const [encoding, decompress] of [
	['zstd', zlib.zstdDecompressSync],
	['br', zlib.brotliDecompressSync],
	['gzip', zlib.gunzipSync],
	['deflate', zlib.inflateSync]
]) {
	if (!decompress) continue
	const response = await largeApp.handle(
		new Request('http://localhost/', {
			headers: { 'accept-encoding': encoding }
		})
	)
	if (response.headers.get('content-encoding') !== encoding)
		throw new Error(`Node ${encoding} compression failed`)
	if (
		decompress(Buffer.from(await response.arrayBuffer())).toString() !==
		largeBody
	)
		throw new Error(`Node ${encoding} round trip failed`)
}

const limitedApp = new Elysia()
	.use(compress({ options: { gzip: { maxOutputLength: 16 } } }))
	.get('/', () => largeBody)
const limited = await limitedApp.handle(
	new Request('http://localhost/', {
		headers: { 'accept-encoding': 'gzip' }
	})
)
if (
	limited.status !== 200 ||
	limited.headers.has('content-encoding') ||
	!limited.headers.get('vary')?.includes('Accept-Encoding') ||
	(await limited.text()) !== largeBody
)
	throw new Error('Node oversized compression fallback failed')

const levelApp = new Elysia()
	.use(compress({ options: { gzip: { level: 1 } } }))
	.get('/', () => largeBody)
const levelResponse = await levelApp.handle(
	new Request('http://localhost/', {
		headers: { 'accept-encoding': 'gzip' }
	})
)
const levelOutput = Buffer.from(await levelResponse.arrayBuffer())
const expectedLevel = zlib.gzipSync(Buffer.from(largeBody), { level: 1 })
if (
	levelOutput.length !== expectedLevel.length ||
	levelOutput.length === zlib.gzipSync(Buffer.from(largeBody)).length ||
	zlib.gunzipSync(levelOutput).toString() !== largeBody
)
	throw new Error('Node oversized gzip level failed')

const bytes = await app.handle(
	new Request('http://localhost/bytes', {
		headers: { 'accept-encoding': 'gzip' }
	})
)

if (bytes.headers.has('content-encoding'))
	throw new Error('Node compressed a response without Content-Type')

// undici's fetch-derived Response has immutable Headers, so compressedHeaders'
// headers.set('content-encoding') throw path must fall back to new Headers(headers).
// content-length is set explicitly so the upstream response isn't chunked
// (chunked responses take compress's streaming path, which already rebuilds
// headers via `new Headers()` and would never reach the immutable-headers catch).
const upstreamBody = 'upstream text '.repeat(200)
const upstreamServer = http.createServer((_req, res) => {
	res.writeHead(200, {
		'content-type': 'text/plain',
		'content-length': Buffer.byteLength(upstreamBody)
	})
	res.end(upstreamBody)
})

await new Promise((resolve) => upstreamServer.listen(0, resolve))
const upstreamPort = upstreamServer.address().port

const upstreamApp = new Elysia()
	.use(compress())
	.get('/upstream', async () =>
		await fetch(`http://127.0.0.1:${upstreamPort}/`)
	)

const upstreamResponse = await upstreamApp.handle(
	new Request('http://localhost/upstream', {
		headers: { 'accept-encoding': 'gzip' }
	})
)

if (upstreamResponse.headers.get('content-encoding') !== 'gzip')
	throw new Error(
		'Node gzip compression of immutable fetch-derived headers failed'
	)

const upstreamDecoded = zlib
	.gunzipSync(Buffer.from(await upstreamResponse.arrayBuffer()))
	.toString()

if (upstreamDecoded !== upstreamBody)
	throw new Error('Node gzip round trip of immutable fetch response failed')

upstreamServer.close()
