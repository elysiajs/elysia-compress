export type CompressEncoding = 'br' | 'gzip' | 'deflate' | 'zstd'

export interface ZlibOptions {
	/** compression level. */
	level?: number

	/** compression window size. */
	windowBits?: number

	/** memory usage level. */
	memLevel?: number

	/** compression strategy. */
	strategy?: number

	/** output chunk size in bytes. */
	chunkSize?: number

	/** preset compression dictionary. */
	dictionary?: Uint8Array

	/** maximum one-shot output size in bytes. */
	maxOutputLength?: number
}

export interface BrotliOptions {
	/** output chunk size in bytes. */
	chunkSize?: number

	/** maximum one-shot output size in bytes. */
	maxOutputLength?: number

	/** brotli parameters keyed by their numeric constants. */
	params?: Record<number, number>
}

export interface ZstdOptions {
	/** output chunk size in bytes. */
	chunkSize?: number

	/** maximum one-shot output size in bytes. */
	maxOutputLength?: number

	/** zstandard parameters keyed by their numeric constants. */
	params?: Record<number, number>
}

interface OptionsByEncoding {
	br: BrotliOptions
	gzip: ZlibOptions
	deflate: ZlibOptions
	zstd: ZstdOptions
}

export type Codec<Encoding extends CompressEncoding = CompressEncoding> = (
	options?: OptionsByEncoding[Encoding]
) => ReadableWritablePair<Uint8Array, Uint8Array>

export type OneShot<Encoding extends CompressEncoding = CompressEncoding> = (
	data: Uint8Array,
	options?: OptionsByEncoding[Encoding]
) => Uint8Array

const codecs: Partial<{
	[Encoding in CompressEncoding]: Codec<Encoding>
}> = {}

const oneShots: Partial<{
	[Encoding in CompressEncoding]: OneShot<Encoding>
}> = {}

let loaded = false

export const load = () => {
	if (loaded) return
	loaded = true

	const runtime = globalThis as any
	const zlib = runtime.process?.getBuiltinModule?.('node:zlib')
	const Duplex = runtime.process?.getBuiltinModule?.('node:stream')?.Duplex
	const toWeb = Duplex?.toWeb as
		| ((duplex: any) => ReadableWritablePair<Uint8Array, Uint8Array>)
		| undefined
	const hasCompressionStream =
		typeof runtime.CompressionStream === 'function'

	for (const encoding of ['gzip', 'deflate'] as const) {
		const create =
			zlib?.[encoding === 'gzip' ? 'createGzip' : 'createDeflate']

		if (create && toWeb)
			codecs[encoding] = (options) =>
				toWeb(create({ ...options, flush: zlib.constants.Z_SYNC_FLUSH }))
		else if (hasCompressionStream)
			codecs[encoding] = () => new runtime.CompressionStream(encoding)
	}

	if (zlib && toWeb) {
		const { BROTLI_PARAM_QUALITY } = zlib.constants

		codecs.br = (options = {}) => {
			const { params, ...rest } = options

			return toWeb(
				zlib.createBrotliCompress({
					...rest,
					flush: zlib.constants.BROTLI_OPERATION_FLUSH,
					params: {
						[BROTLI_PARAM_QUALITY]: 4,
						...params
					}
				})
			)
		}
	}

	if (zlib?.createZstdCompress && toWeb)
		codecs.zstd = (options) =>
			toWeb(
				zlib.createZstdCompress({
					...options,
					flush: zlib.constants.ZSTD_e_flush
				})
			)

	if (zlib) {
		oneShots.gzip = (data, options) =>
			options === undefined && runtime.Bun?.gzipSync
				? runtime.Bun.gzipSync(data)
				: zlib.gzipSync(data, options)

		oneShots.deflate = (data, options) => zlib.deflateSync(data, options)

		const { BROTLI_PARAM_QUALITY, BROTLI_PARAM_SIZE_HINT } = zlib.constants

		oneShots.br = (data, options = {}) => {
			const { params, ...rest } = options

			return zlib.brotliCompressSync(data, {
				...rest,
				params: {
					[BROTLI_PARAM_QUALITY]: 4,
					[BROTLI_PARAM_SIZE_HINT]: data.byteLength,
					...params
				}
			})
		}

		if (zlib.zstdCompressSync)
			oneShots.zstd = (data, options) =>
				options === undefined && runtime.Bun?.zstdCompressSync
					? runtime.Bun.zstdCompressSync(data)
					: zlib.zstdCompressSync(data, options)
	}
}

export { codecs, oneShots }
