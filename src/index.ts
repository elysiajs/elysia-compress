import { Elysia } from 'elysia/base'

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
	 **/
	streams?: boolean

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

const ASSUMED_TYPE =
	new Response('').headers.get('content-type') === null
		? 'text/plain;charset=utf-8'
		: null

const defaultCompressible = (type: string) =>
	type.startsWith('text/') ||
	type === 'application/json' ||
	type.endsWith('+json') ||
	type.includes('javascript') ||
	type === 'application/xml' ||
	type.endsWith('+xml') ||
	type === 'application/wasm'

const normalizeType = (value: string) =>
	value.split(';', 1)[0].trim().toLowerCase()

const looksBinary = (bytes: Uint8Array) => {
	const end = Math.min(bytes.byteLength, NUL_SNIFF_LIMIT)

	for (let i = 0; i < end; i++) if (bytes[i] === 0) return true

	return false
}

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
	const allowStreams = options.streams !== false
	const available = (options.encodings ?? DEFAULT_ENCODINGS).filter(
		(encoding) => codecs[encoding]
	)

	const perRoute = new WeakMap<Request, boolean>()

	const apply = (
		request: Request,
		response: Response
	) => {
		const route = perRoute.get(request)

		if (route === false || (!byDefault && route !== true)) return response
		if (request.method === 'HEAD' || !(response instanceof Response))
			return response
		if ([204, 205, 206, 304].includes(response.status)) return response

		const headers = response.headers

		if (headers.has('content-encoding')) return response
		if (
			headers.get('cache-control')?.toLowerCase().includes('no-transform')
		)
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

		const encoding = negotiate(
			request.headers.get('accept-encoding'),
			available
		) as CompressEncoding | null

		if (encoding === null) return withVary(response)

		const declaredLength = Number(headers.get('content-length'))
		if (
			headers.has('content-length') &&
			Number.isFinite(declaredLength) &&
			declaredLength < threshold
		)
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

		let cloned: Response

		try {
			cloned = response.clone()
		} catch {
			return response
		}

		return cloned
			.arrayBuffer()
			.then((buffer) => {
				const bytes = new Uint8Array(buffer)

				if (!declaredType && looksBinary(bytes)) return response
				if (bytes.byteLength < threshold) return withVary(response)

				const oneShot = oneShots[encoding] as
					| OneShot<CompressEncoding>
					| undefined

				if (oneShot)
					return rebuild(
						oneShot(bytes, options.options?.[encoding]),
						cloned.headers
					)

				return rebuild(
					pipe(
						new Response(bytes).body!,
						codec(options.options?.[encoding])
					),
					cloned.headers
				)
			})
			.catch(() => response)
	}

	return new Elysia({ name: '@elysia/compress' })
		.wrap((handle) => (request, ...rest) => {
			const response = handle(request, ...rest)

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
