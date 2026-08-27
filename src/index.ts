import { Elysia } from 'elysia'
import { isBorrowedResponse } from 'elysia/adapter/response-ownership'
import {
	codecs,
	load,
	oneShots,
	type BrotliOptions,
	type Codec,
	type CompressEncoding,
	type OneShot,
	type ZlibOptions,
	type ZstdOptions
} from './codecs'
import { negotiate } from './negotiate'

export type { BrotliOptions, CompressEncoding, ZlibOptions, ZstdOptions }

export interface CompressOptions {
	/**
	 * Compress every route by default. When false, only routes opting in via
	 * the `compress` macro are compressed.
	 *
	 * @default true
	 **/
	default?: boolean

	/**
	 * Encodings offered in server-preference order
	 **/
	encodings?: CompressEncoding[]

	/**
	 * The minimum byte size for a response to be compressed
	 *
	 * @default 1024
	 **/
	threshold?: number

	/**
	 * Return true for content types that should be compressed
	 **/
	types?: (contentType: string) => boolean

	/**
	 * Compress chunked responses
	 *
	 * @default true
	 **/
	stream?: boolean

	/**
	 * per-encoding compression options
	 **/
	options?: {
		br?: BrotliOptions
		gzip?: ZlibOptions
		deflate?: ZlibOptions
		zstd?: ZstdOptions
	}
}

const DEFAULT_ENCODINGS: CompressEncoding[] = ['br', 'zstd', 'gzip', 'deflate']
const NUL_SNIFF_LIMIT = 1024
const NO_TRANSFORM = /no-transform/i
const ONE_SHOT_LIMIT = 1 << 20

const ASSUMED_TYPE =
	new Response('').headers.get('content-type') === null
		? 'text/plain;charset=utf-8'
		: null

const defaultCompressible = (type: string) =>
	type.startsWith('text/') ||
	type === 'application/json' ||
	type.endsWith('+json') // ||
// type.includes('javascript') ||
// type === 'application/xml' ||
// type.endsWith('+xml') ||
// type === 'application/wasm'

const normalizeType = (value: string) => {
	const separator = value.indexOf(';')

	return (separator === -1 ? value : value.slice(0, separator))
		.trim()
		.toLowerCase()
}

const looksBinary = (bytes: Uint8Array) =>
	bytes.subarray(0, NUL_SNIFF_LIMIT).indexOf(0) !== -1

const varyWithAcceptEncoding = (headers: Headers) => {
	const vary = headers.get('vary')

	if (vary === '*') return null
	if (!vary) return 'Accept-Encoding'
	if (
		vary
			.split(',')
			.some((value) => value.trim().toLowerCase() === 'accept-encoding')
	)
		return null

	return `${vary}, Accept-Encoding`
}

const withVary = (response: Response) => {
	const vary = varyWithAcceptEncoding(response.headers)

	if (vary === null) return response

	try {
		response.headers.set('vary', vary)

		return response
	} catch {
		const headers = new Headers(response.headers)
		headers.set('vary', vary)

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		})
	}
}

const compressedHeaders = (
	headers: Headers,
	encoding: string,
	assumeType: boolean
) => {
	try {
		headers.set('content-encoding', encoding)
	} catch {
		// clone() preserves the immutable guard on fetch-derived responses
		headers = new Headers(headers)
		headers.set('content-encoding', encoding)
	}

	headers.delete('content-length')
	headers.delete('content-range')
	headers.delete('accept-ranges')
	headers.delete('transfer-encoding')

	if (assumeType && ASSUMED_TYPE) headers.set('content-type', ASSUMED_TYPE)

	const etag = headers.get('etag')
	if (etag && !etag.startsWith('W/')) headers.set('etag', `W/${etag}`)

	const vary = varyWithAcceptEncoding(headers)
	if (vary !== null) headers.set('vary', vary)

	return headers
}

const pipe = (
	source: ReadableStream<Uint8Array>,
	codec: ReadableWritablePair<Uint8Array, Uint8Array>
) => {
	const abort = new AbortController()
	const reader = codec.readable.getReader()
	let output: ReadableStreamDefaultController<Uint8Array>

	const result = new ReadableStream<Uint8Array>({
		start(controller) {
			output = controller
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read()

				if (done) controller.close()
				else controller.enqueue(value)
			} catch (error) {
				abort.abort(error)
				controller.error(error)
			}
		},
		async cancel(reason) {
			abort.abort(reason)
			await reader.cancel(reason)
		}
	})

	void source
		.pipeTo(codec.writable, { signal: abort.signal })
		.catch((error) => {
			if (!abort.signal.aborted) output.error(error)
		})

	return result
}

export const compress = (options: CompressOptions = {}) => {
	load()

	const threshold = options.threshold ?? 1024
	const byDefault = options.default !== false
	const compressible = options.types ?? defaultCompressible
	const allowStreams = options.stream !== false
	const available = (options.encodings ?? DEFAULT_ENCODINGS).filter(
		(encoding) => codecs[encoding]
	)

	const perRoute = new WeakMap<Request, boolean>()
	const negotiated = new Map<string, string | null>()

	const apply = (request: Request, response: Response) => {
		const route = perRoute.get(request)

		if (route === false || (!byDefault && route !== true)) return response
		if (request.method === 'HEAD' || !(response instanceof Response))
			return response

		const status = response.status
		if (
			status === 204 ||
			status === 205 ||
			status === 206 ||
			status === 304
		)
			return response

		const headers = response.headers
		if (headers.has('content-encoding')) return response

		const cacheControl = headers.get('cache-control')
		if (cacheControl !== null && NO_TRANSFORM.test(cacheControl))
			return response

		const declaredType = headers.get('content-type')
		const type = declaredType ? normalizeType(declaredType) : ASSUMED_TYPE

		if (
			type === null ||
			type === 'text/event-stream' ||
			!compressible(type)
		)
			return response

		const streaming = !!headers
			.get('transfer-encoding')
			?.toLowerCase()
			.includes('chunked')

		if (streaming && !allowStreams) return response

		const acceptEncoding = request.headers.get('accept-encoding')
		let encoding: CompressEncoding | null

		if (acceptEncoding === null) encoding = null
		else {
			const cached = negotiated.get(acceptEncoding)

			if (cached !== undefined)
				encoding = cached as CompressEncoding | null
			else {
				encoding = negotiate(
					acceptEncoding,
					available
				) as CompressEncoding | null

				// ponytail: bounded, clear-on-full beats LRU bookkeeping here
				if (negotiated.size >= 500) negotiated.clear()
				negotiated.set(acceptEncoding, encoding)
			}
		}

		if (encoding === null) return withVary(response)

		// content-length is guarded by runtime
		const declaredLength = Number(headers.get('content-length'))
		if (headers.has('content-length') && declaredLength < threshold)
			return withVary(response)

		if (response.body === null) return response

		const codec = codecs[encoding] as Codec<CompressEncoding>
		const rebuild = (
			body: ReadableStream<Uint8Array> | Uint8Array,
			headers: Headers
		) =>
			new Response(body as BodyInit, {
				status: response.status,
				statusText: response.statusText,
				headers: compressedHeaders(headers, encoding, !declaredType)
			})

		if (streaming)
			return rebuild(
				pipe(response.body, codec(options.options?.[encoding])),
				new Headers(response.headers)
			)

		const owned = !isBorrowedResponse(response)
		const rebuildOwnedBytes = (bytes: Uint8Array) =>
			new Response(bytes as BodyInit, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			})

		let source: Response

		if (owned || !response.bodyUsed) source = response
		else return response

		return source
			.arrayBuffer()
			.then((buffer) => {
				const bytes = new Uint8Array(buffer)

				if (!declaredType && looksBinary(bytes))
					return owned ? rebuildOwnedBytes(bytes) : response

				if (bytes.byteLength < threshold) {
					if (!owned) return withVary(response)

					const bailout = rebuildOwnedBytes(bytes)
					if (!declaredType && ASSUMED_TYPE)
						bailout.headers.set('content-type', ASSUMED_TYPE)

					return withVary(bailout)
				}

				const oneShot = oneShots[encoding] as
					| OneShot<CompressEncoding>
					| undefined

				if (oneShot && bytes.byteLength <= ONE_SHOT_LIMIT)
					return rebuild(
						oneShot(bytes, options.options?.[encoding]),
						source.headers
					)

				return rebuild(
					pipe(
						new Response(bytes).body!,
						codec(options.options?.[encoding])
					),
					source.headers
				)
			})
			.catch(() => response)
	}

	return new Elysia({ name: '@elysia/compress' })
		.wrap((handle) => (request, server) => {
			const response = handle(request, server)

			return response instanceof Promise
				? response.then((resolved) => apply(request, resolved))
				: apply(request, response)
		})
		.macro({
			compress: (enabled: boolean) => ({
				transform({ request }) {
					perRoute.set(request, enabled)
				}
			})
		})
}

export default compress
