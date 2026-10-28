import { describe, expect, it } from 'bun:test'
import zlib from 'node:zlib'

import { borrow, Elysia, type AnyElysia } from 'elysia'
import { autoHead } from 'elysia/auto-head'
import { websocket } from 'elysia/websocket'
import { staticPlugin } from '@elysia/static'

import { compress } from '../src/index'

type Handleable = {
	handle: (url: string | Request, options?: RequestInit) => Promise<Response>
}

const body = 'hello elysia '.repeat(300)
const row =
	JSON.stringify({
		id: 12345,
		name: 'compression fixture',
		values: [1, 2, 3, 4, 5],
		active: true
	}) + '\n'
const smallBody = row.repeat(Math.floor(((1 << 20) - 1) / row.length))
const largeBody = row.repeat(Math.ceil(((1 << 20) + 1) / row.length))

const request = (
	app: Handleable,
	path = '/',
	acceptEncoding?: string,
	init: RequestInit = {}
) =>
	app.handle(
		new Request(`http://localhost${path}`, {
			...init,
			headers: {
				...init.headers,
				...(acceptEncoding
					? { 'accept-encoding': acceptEncoding }
					: {})
			}
		})
	)

const decode = async (response: Response) => {
	const bytes = Buffer.from(await response.arrayBuffer())

	switch (response.headers.get('content-encoding')) {
		case 'br':
			return zlib.brotliDecompressSync(bytes).toString()
		case 'zstd':
			return zlib.zstdDecompressSync(bytes).toString()
		case 'gzip':
			return zlib.gunzipSync(bytes).toString()
		case 'deflate':
			return zlib.inflateSync(bytes).toString()
		default:
			return bytes.toString()
	}
}

describe('compress', () => {
	it('compresses buffered responses and negotiates the requested codec', async () => {
		const app = new Elysia()
			.use(compress())
			.get('/text', () => body)
			.get('/json', () => ({ body }))

		for (const encoding of ['br', 'gzip', 'deflate']) {
			const response = await request(app, '/text', encoding)

			expect(response.headers.get('content-encoding')).toBe(encoding)
			expect(response.headers.get('vary')).toBe('Accept-Encoding')
			expect(await decode(response)).toBe(body)
		}

		const json = await request(app, '/json', 'gzip')
		expect(JSON.parse(await decode(json))).toEqual({ body })

		const preferred = await request(
			app,
			'/text',
			'br;q=0.5, gzip;q=0.9'
		)
		expect(preferred.headers.get('content-encoding')).toBe('gzip')

		const plain = await request(app, '/text')
		expect(plain.headers.get('content-encoding')).toBeNull()
		expect(plain.headers.get('vary')).toBe('Accept-Encoding')
		expect(await plain.text()).toBe(body)
	})

	it('compresses buffered responses with zstd', async () => {
		const app = new Elysia().use(compress()).get('/', () => body)
		const response = await request(app, '/', 'zstd')

		expect(response.headers.get('content-encoding')).toBe('zstd')
		expect(await decode(response)).toBe(body)
	})

	it('compresses chunked responses with zstd', async () => {
		const app = new Elysia()
			.use(compress())
			.get(
				'/',
				() =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(
									new TextEncoder().encode(body)
								)
								controller.close()
							}
						}),
						{
							headers: {
								'content-type': 'text/plain',
								'transfer-encoding': 'chunked'
							}
						}
					)
			)
		const response = await request(app, '/', 'zstd')

		expect(response.headers.get('content-encoding')).toBe('zstd')
		expect(await decode(response)).toBe(body)
	})

	// zstd is several times faster than br at a similar ratio
	it('prefers zstd to br by default', async () => {
		const app = new Elysia().use(compress()).get('/', () => body)
		const response = await request(app, '/', 'br, zstd')

		expect(response.headers.get('content-encoding')).toBe('zstd')
		expect(await decode(response)).toBe(body)
	})

	it('falls back to br for clients without zstd', async () => {
		const app = new Elysia().use(compress()).get('/', () => body)
		const response = await request(app, '/', 'gzip, deflate, br')

		expect(response.headers.get('content-encoding')).toBe('br')
		expect(await decode(response)).toBe(body)
	})

	it('serves configured zstd to wildcard clients', async () => {
		const app = new Elysia()
			.use(compress({ encodings: ['zstd'] }))
			.get('/', () => body)
		const response = await request(app, '/', '*')

		expect(response.headers.get('content-encoding')).toBe('zstd')
		expect(await decode(response)).toBe(body)
	})

	it('accepts zstd options', async () => {
		const app = new Elysia()
			.use(
				compress({
					options: {
						zstd: {
							params: {
								[zlib.constants.ZSTD_c_compressionLevel]: 19
							}
						}
					}
				})
			)
			.get('/', () => body)
		const response = await request(app, '/', 'zstd')

		expect(response.headers.get('content-encoding')).toBe('zstd')
		expect(await decode(response)).toBe(body)
	})

	it('types options by encoding', () => {
		compress({
			options: {
				gzip: {
					// @ts-expect-error gzip does not accept quality
					quality: 4
				}
			}
		})
	})

	it('skips responses that must not be transformed', async () => {
		const app = new Elysia()
			.use(compress({ threshold: 0 }))
			.head('/head', () => body)
			.get(
				'/encoded',
				() =>
					new Response(body, {
						headers: {
							'content-type': 'text/plain',
							'content-encoding': 'identity'
						}
					})
			)
			.get(
				'/private',
				() =>
					new Response(body, {
						headers: {
							'content-type': 'text/plain',
							'cache-control': 'private, no-transform'
						}
					})
			)
			.get(
				'/image',
				() =>
					new Response(new Uint8Array(2048), {
						headers: { 'content-type': 'image/png' }
					})
			)
			.get(
				'/events',
				() =>
					new Response('data: hello\n\n', {
						headers: { 'content-type': 'text/event-stream' }
					})
			)

		const head = await request(app, '/head', 'gzip', { method: 'HEAD' })
		expect(head.headers.get('content-encoding')).toBeNull()

		const encoded = await request(app, '/encoded', 'gzip')
		expect(encoded.headers.get('content-encoding')).toBe('identity')

		for (const path of ['/private', '/image', '/events']) {
			const response = await request(app, path, 'gzip')
			expect(response.headers.get('content-encoding')).toBeNull()
		}

		for (const status of [204, 205, 206, 304]) {
			const statusApp = new Elysia().use(compress({ threshold: 0 })).get(
				'/',
				() =>
					new Response(body, {
						status,
						headers: { 'content-type': 'text/plain' }
					})
			)
			const response = await request(statusApp, '/', 'gzip')

			expect(response.status).toBe(status)
			expect(response.headers.get('content-encoding')).toBeNull()
		}
	})

	it('uses no-transform as the per-response security opt-out', async () => {
		const app = new Elysia().use(compress()).get('/secret', ({ set }) => {
			set.headers['cache-control'] = 'private, no-transform'

			return body
		})
		const response = await request(app, '/secret', 'gzip')

		expect(response.headers.get('content-encoding')).toBeNull()
		expect(await response.text()).toBe(body)
	})

	it('applies the threshold without reading a declared short body', async () => {
		let pulled = false
		const app = new Elysia().use(compress()).get(
			'/',
			() =>
				new Response(
					new ReadableStream(
						{
							pull(controller) {
								pulled = true
								controller.enqueue(new TextEncoder().encode('tiny'))
								controller.close()
							}
						},
						{ highWaterMark: 0 }
					),
					{
						headers: {
							'content-type': 'text/plain',
							'content-length': '4'
						}
					}
				)
		)
		const response = await request(app, '/', 'gzip')

		expect(pulled).toBe(false)
		expect(response.headers.get('content-encoding')).toBeNull()
		expect(await response.text()).toBe('tiny')
		expect(pulled).toBe(true)
	})

	it('compresses streams unless stream is false', async () => {
		const stream = () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(body))
						controller.close()
					}
				}),
				{
					headers: {
						'content-type': 'text/plain',
						'transfer-encoding': 'Chunked'
					}
				}
			)

		const enabled = new Elysia().use(compress()).get('/', stream)
		const compressed = await request(enabled, '/', 'gzip')
		expect(compressed.headers.get('content-encoding')).toBe('gzip')
		expect(await decode(compressed)).toBe(body)

		const disabled = new Elysia()
			.use(compress({ stream: false }))
			.get('/', stream)
		const plain = await request(disabled, '/', 'gzip')
		expect(plain.headers.get('content-encoding')).toBeNull()
		expect(await plain.text()).toBe(body)
	})

	it('rebuilds response metadata for the compressed representation', async () => {
		const app = new Elysia().use(compress()).get(
			'/',
			() =>
				new Response(body, {
					status: 201,
					statusText: 'Created',
					headers: {
						'content-type': 'text/plain',
						'content-length': `${body.length}`,
						'content-range': 'bytes 0-1/2',
						'accept-ranges': 'bytes',
						'transfer-encoding': 'identity',
						etag: '"abc"',
						vary: 'Origin',
						'x-kept': 'yes'
					}
				})
		)
		const response = await request(app, '/', 'gzip')

		expect(response.status).toBe(201)
		expect(response.statusText).toBe('Created')
		expect(response.headers.get('content-encoding')).toBe('gzip')
		expect(response.headers.get('content-length')).toBeNull()
		expect(response.headers.get('content-range')).toBeNull()
		expect(response.headers.get('accept-ranges')).toBeNull()
		expect(response.headers.get('transfer-encoding')).toBeNull()
		expect(response.headers.get('etag')).toBe('W/"abc"')
		expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding')
		expect(response.headers.get('x-kept')).toBe('yes')
		expect(await decode(response)).toBe(body)
	})

	// borrow() is the sanctioned way to reuse a Response instance across
	// requests: core clones it fresh per request (the borrowed clone isn't
	// itself in the borrowed set, so compress consumes it directly instead
	// of cloning a second time), leaving the original's body untouched.
	it('keeps a borrowed cached Response reusable', async () => {
		const cached = borrow(
			new Response(body, {
				headers: { 'content-type': 'text/plain' }
			})
		)
		const app = new Elysia().use(compress()).get('/', () => cached)

		for (const encoding of ['gzip', 'br', 'gzip']) {
			const response = await request(app, '/', encoding)

			expect(response.headers.get('content-encoding')).toBe(encoding)
			expect(await decode(response)).toBe(body)
		}

		expect(cached.bodyUsed).toBe(false)
	})

	// Without borrow(), core hands compress the SAME instance every request
	// (owned=true, not explicitly borrowed → no defensive clone at the
	// core layer either). compress consumes it directly on request 1; core's
	// own reuse guard then throws on request 2 rather than silently serving
	// stale or corrupted content. If this test starts passing, someone
	// reintroduced clone-by-default and quietly ate the perf win.
	it('surfaces an error on the second request for an unborrowed cached Response', async () => {
		const cached = new Response(body, {
			headers: { 'content-type': 'text/plain' }
		})
		const app = new Elysia().use(compress()).get('/', () => cached)

		const first = await request(app, '/', 'gzip')
		expect(first.headers.get('content-encoding')).toBe('gzip')
		expect(await decode(first)).toBe(body)

		const second = await request(app, '/', 'gzip')
		expect(second.status).toBe(500)
	})

	it('compresses error, not-found, and mapped responses', async () => {
		const app = new Elysia()
			.mapResponse(({ responseValue }) => {
				if (typeof responseValue === 'string')
					return new Response(responseValue, {
						headers: {
							'content-type': 'text/plain',
							'x-mapped': 'yes'
						}
					})
			})
			.use(compress({ threshold: 0 }))
			.get('/ok', () => body)
			.get('/error', () => {
				throw new Error(body)
			})

		const mapped = await request(app, '/ok', 'gzip')
		expect(mapped.headers.get('x-mapped')).toBe('yes')
		expect(await decode(mapped)).toBe(body)

		for (const path of ['/error', '/missing']) {
			const response = await request(app, path, 'gzip')
			expect(response.headers.get('content-encoding')).toBe('gzip')
			expect(await decode(response)).not.toBe('')
		}
	})

	it('supports a custom type predicate, codec order, and codec options', async () => {
		const app = new Elysia()
			.use(
				compress({
					encodings: ['gzip'],
					types: (type) => type === 'image/png',
					options: { gzip: { level: 1 } }
				})
			)
			.get(
				'/',
				() =>
					new Response(new TextEncoder().encode(body), {
						headers: { 'content-type': 'image/png' }
					})
			)
		const response = await request(app, '/', 'br, gzip')

		expect(response.headers.get('content-encoding')).toBe('gzip')
		expect(await decode(response)).toBe(body)
	})

	it('preserves Content-Type on skipped socket responses', async () => {
		const routes = (app: AnyElysia) =>
			app
				.get('/text', () => body)
				.get('/bytes', () => new Response(new Uint8Array(2048).fill(65)))

		const baseline = routes(new Elysia()).listen(0)
		const withPlugin = routes(new Elysia().use(compress())).listen(0)

		try {
			for (const path of ['/text', '/bytes']) {
				const headers = { 'accept-encoding': 'identity' }
				const plain = await fetch(
					`http://localhost:${baseline.server!.port}${path}`,
					{ headers }
				)
				const wrapped = await fetch(
					`http://localhost:${withPlugin.server!.port}${path}`,
					{ headers }
				)

				expect(wrapped.headers.get('content-type')).toBe(
					plain.headers.get('content-type')
				)
			}
		} finally {
			baseline.stop()
			withPlugin.stop()
		}
	})

	it('flushes streams and cancels a stalled producer on disconnect', async () => {
		let cancelled = false
		const app = new Elysia()
			.use(compress())
			.get(
				'/',
				() =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(
									new TextEncoder().encode(body)
								)
							},
							cancel() {
								cancelled = true
							}
						}),
						{
							headers: {
								'content-type': 'text/plain',
								'transfer-encoding': 'chunked'
							}
						}
					)
			)
			.listen(0)
		const controller = new AbortController()

		try {
			const response = await fetch(
				`http://localhost:${app.server!.port}/`,
				{
					headers: { 'accept-encoding': 'gzip' },
					signal: controller.signal
				}
			)
			const reader = response.body!.getReader()

			expect(response.headers.get('content-encoding')).toBe('gzip')
			expect((await reader.read()).done).toBe(false)
			controller.abort()

			for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(10)
			expect(cancelled).toBe(true)
		} finally {
			app.stop()
		}
	})

	it('propagates a streaming source error without hanging', async () => {
		const app = new Elysia().use(compress()).get(
			'/',
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(body))
							setTimeout(
								() => controller.error(new Error('stream failed')),
								10
							)
						}
					}),
					{
						headers: {
							'content-type': 'text/plain',
							'transfer-encoding': 'chunked'
						}
					}
				)
		)
		const response = await request(app, '/', 'gzip')
		const outcome = await Promise.race([
			response.arrayBuffer().then(
				() => 'completed',
				() => 'failed'
			),
			Bun.sleep(500).then(() => 'timeout')
		])

		expect(outcome).toBe('failed')
	})

	it('composes with auto-head when compress is registered first', async () => {
		const app = new Elysia().use(compress()).use(autoHead())
		app.get('/', () => body)

		expect(app.modules).resolves.toBeUndefined()

		const get = await request(app, '/', 'gzip')
		expect(get.headers.get('content-encoding')).toBe('gzip')

		const head = await request(app, '/', 'gzip', { method: 'HEAD' })
		expect(head.headers.get('content-encoding')).toBeNull()
		expect(head.body).toBeNull()
	})

	// Order-independence: through beta.6, this order tripped Elysia core's
	// "Macro compress can only run in sync plugin" guard in #useFn
	it('composes with auto-head when compress is registered second', async () => {
		const app = new Elysia().use(autoHead()).use(compress())
		app.get('/', () => body)

		expect(app.modules).resolves.toBeUndefined()

		const get = await request(app, '/', 'gzip')
		expect(get.headers.get('content-encoding')).toBe('gzip')

		const head = await request(app, '/', 'gzip', { method: 'HEAD' })
		expect(head.headers.get('content-encoding')).toBeNull()
		expect(head.body).toBeNull()
	})

	it('compresses static files served by @elysia/static', async () => {
		const app = new Elysia()
			.use(staticPlugin({ assets: 'test/public', prefix: '/public' }))
			.use(compress())

		expect(app.modules).resolves.toBeUndefined()

		const response = await request(app, '/public/large.txt', 'gzip')
		const fixture = await Bun.file('test/public/large.txt').text()

		expect(response.headers.get('content-encoding')).toBe('gzip')
		expect(response.headers.get('content-type')).toBe(
			'text/plain;charset=utf-8'
		)

		const etag = response.headers.get('etag')
		if (etag) expect(etag.startsWith('W/')).toBe(true)

		expect(await decode(response)).toBe(fixture)
	})

	it('does not compress any route when default is false', async () => {
		const app = new Elysia()
			.use(compress({ default: false }))
			.get('/', () => body)
		const response = await request(app, '/', 'gzip')

		expect(response.headers.get('content-encoding')).toBeNull()
		expect(response.headers.get('vary')).toBeNull()
		expect(await response.text()).toBe(body)
	})

	it('compresses a route that opts in via the compress macro when default is false', async () => {
		const app = new Elysia()
			.use(compress({ default: false }))
			.get('/', { compress: true }, () => body)
		const response = await request(app, '/', 'gzip')

		expect(response.headers.get('content-encoding')).toBe('gzip')
		expect(await decode(response)).toBe(body)
	})

	it('skips a route that opts out via the compress macro by default', async () => {
		const app = new Elysia()
			.use(compress())
			.get('/', { compress: false }, () => body)
		const response = await request(app, '/', 'gzip')

		expect(response.headers.get('content-encoding')).toBeNull()
		expect(response.headers.get('vary')).toBeNull()
		expect(await response.text()).toBe(body)
	})

	it('compresses a static-content route that opts in via the compress macro when default is false', async () => {
		const app = new Elysia()
			.use(compress({ default: false }))
			.get('/', { compress: true }, body)
		const response = await request(app, '/', 'gzip')

		expect(response.headers.get('content-encoding')).toBe('gzip')
		expect(await decode(response)).toBe(body)
	})

	it('round trips oversized buffered bodies with each codec', async () => {
		const app = new Elysia().use(compress()).get('/', () => largeBody)
		for (const encoding of ['zstd', 'br', 'gzip', 'deflate']) {
			const response = await request(app, '/', encoding)
			expect(response.headers.get('content-encoding')).toBe(encoding)
			expect(await decode(response)).toBe(largeBody)
		}
	})

	it('keeps oversized compression off the event loop', async () => {
		for (const [content, expected] of [
			[smallBody, true],
			[largeBody, false]
		] as const) {
			const app = new Elysia().use(compress()).get('/', () => content)
			let settled = false
			const pending = request(app, '/', 'gzip').then((response) =>
				response.arrayBuffer()
			)
			pending.finally(() => {
				settled = true
			}).catch(() => {})
			// Large compression must let other event-loop work proceed.
			for (let i = 0; i < 1000 && !settled; i++) await null
			expect(settled).toBe(expected)
			expect(zlib.gunzipSync(Buffer.from(await pending)).toString()).toBe(
				content
			)
		}
	})

	it('serves original bytes when buffered compression exceeds its output limit', async () => {
		for (const content of [smallBody, largeBody]) {
			const app = new Elysia()
				.use(compress({ options: { gzip: { maxOutputLength: 16 } } }))
				.get('/', () => content)
			const response = await request(app, '/', 'gzip')
			expect(response.status).toBe(200)
			expect(response.headers.get('content-encoding')).toBeNull()
			expect(response.headers.get('vary')).toContain('Accept-Encoding')
			expect(response.headers.get('content-type')).toBe(
				'text/plain;charset=utf-8'
			)
			expect(await response.text()).toBe(content)
		}
	})

	it('pins Brotli quality for oversized bodies', async () => {
		const app = new Elysia().use(compress()).get('/', () => largeBody)
		const response = await request(app, '/', 'br')
		const output = await response.arrayBuffer()
		const expected = zlib.brotliCompressSync(Buffer.from(largeBody), {
			params: {
				[zlib.constants.BROTLI_PARAM_QUALITY]: 4,
				[zlib.constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(largeBody)
			}
		})
		expect(output.byteLength).toBe(expected.byteLength)
		expect(output.byteLength).not.toBe(
			zlib.brotliCompressSync(Buffer.from(largeBody), {
				params: {
					[zlib.constants.BROTLI_PARAM_QUALITY]: 11,
					[zlib.constants.BROTLI_PARAM_SIZE_HINT]:
						Buffer.byteLength(largeBody)
				}
			}).byteLength
		)
		expect(zlib.brotliDecompressSync(Buffer.from(output)).toString()).toBe(
			largeBody
		)
	})

	it('honors gzip options for oversized bodies', async () => {
		const app = new Elysia()
			.use(compress({
				options: { gzip: { level: 9 } }
			}))
			.get('/', () => largeBody)
		const response = await request(app, '/', 'gzip')
		const output = await response.arrayBuffer()
		const expected = zlib.gzipSync(Buffer.from(largeBody), {
			level: 9
		})
		expect(output.byteLength).toBe(expected.byteLength)
		expect(output.byteLength).not.toBe(
			zlib.gzipSync(Buffer.from(largeBody)).byteLength
		)
		expect(zlib.gunzipSync(Buffer.from(output)).toString()).toBe(
			largeBody
		)
	})

	// A `.wrap()` registered after compress() composes closer to the handler
	// (compress() registered its own wrap first via `.use()`, so it's the
	// outer layer; this one sees the pre-compression Response compress
	// itself will act on). A plain mapper-constructed response isn't
	// borrowed, so compress must consume it directly instead of cloning —
	// this is the only way to observe that from the outside, since the
	// compressed output looks identical either way. For the borrow() lane,
	// core hands compress a fresh clone (never the borrowed original, so
	// isBorrowedResponse reads false on it too) — that clone is what gets
	// consumed, while the original stays untouched for the next request.
	it('consumes an owned response directly but clones a borrowed one at the core layer', async () => {
		const capture = (bucket: Response[]) =>
			(handle: (request: Request, server?: unknown) => unknown) =>
				(request: Request, server?: unknown) => {
					const result = handle(request, server)

					if (result instanceof Promise)
						return result.then((response) => {
							if (response instanceof Response) bucket.push(response)
							return response
						})

					if (result instanceof Response) bucket.push(result)
					return result
				}

		const fresh: Response[] = []
		const freshApp = new Elysia()
			.use(compress())
			.wrap(capture(fresh) as never)
			.get('/', () => body)

		const freshResponse = await request(freshApp, '/', 'gzip')
		expect(freshResponse.headers.get('content-encoding')).toBe('gzip')
		expect(fresh[0]?.bodyUsed).toBe(true)

		const cachedBucket: Response[] = []
		const cached = borrow(
			new Response(body, {
				headers: { 'content-type': 'text/plain' }
			})
		)
		const cachedApp = new Elysia()
			.use(compress())
			.wrap(capture(cachedBucket) as never)
			.get('/', () => cached)

		const cachedResponse = await request(cachedApp, '/', 'gzip')
		expect(cachedResponse.headers.get('content-encoding')).toBe('gzip')
		// what the spy saw is core's fresh per-request clone, not `cached`
		expect(cachedBucket[0]).not.toBe(cached)
		expect(cachedBucket[0]?.bodyUsed).toBe(true)
		expect(cached.bodyUsed).toBe(false)
	})

	it('serves a short owned body with the assumed content-type pinned', async () => {
		const app = new Elysia().use(compress()).get('/', () => 'tiny')
		const response = await request(app, '/', 'gzip')

		expect(response.headers.get('content-encoding')).toBeNull()
		expect(response.headers.get('content-type')).toBe(
			'text/plain;charset=utf-8'
		)
		expect(await response.text()).toBe('tiny')
	})

	it('serves an owned binary body byte-identical without compressing it', async () => {
		const bytes = new Uint8Array(2048).fill(65)
		bytes[10] = 0 // NUL byte trips the binary sniff

		const app = new Elysia().use(compress()).get('/', () => bytes)
		const response = await request(app, '/', 'gzip')

		expect(response.headers.get('content-encoding')).toBeNull()
		const received = new Uint8Array(await response.arrayBuffer())
		expect(received).toEqual(bytes)
	})

	it('does not touch WebSocket messages', async () => {
		const app = new Elysia()
			.use(websocket())
			.use(compress())
			.ws('/ws', {
				message(ws, message) {
					ws.send(message)
				}
			})
			.listen(0)
		const socket = new WebSocket(
			`ws://${app.server!.hostname}:${app.server!.port}/ws`
		)

		try {
			await new Promise<void>((resolve, reject) => {
				socket.onopen = () => resolve()
				socket.onerror = reject
			})

			const echoed = new Promise<MessageEvent>((resolve) => {
				socket.onmessage = resolve
			})
			socket.send(body)

			expect((await echoed).data).toBe(body)
		} finally {
			socket.close()
			app.stop()
		}
	})
})
