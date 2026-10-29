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

export type AsyncOneShot<Encoding extends CompressEncoding = CompressEncoding> =
	(
		data: Uint8Array,
		options?: OptionsByEncoding[Encoding]
	) => Promise<Uint8Array>

const codecs: Partial<{
	[Encoding in CompressEncoding]: Codec<Encoding>
}> = {}

const oneShots: Partial<{
	[Encoding in CompressEncoding]: OneShot<Encoding>
}> = {}

const asyncOneShots: Partial<{
	[Encoding in CompressEncoding]: AsyncOneShot<Encoding>
}> = {}

const names = {
	gzip: 'gzip',
	deflate: 'deflate',
	br: 'brotliCompress',
	zstd: 'zstdCompress'
} as const

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

	const hasCompressionStream = typeof runtime.CompressionStream === 'function'

	for (const encoding of ['gzip', 'deflate'] as const) {
		const create =
			zlib?.[encoding === 'gzip' ? 'createGzip' : 'createDeflate']

		if (create && toWeb)
			codecs[encoding] = (options) =>
				toWeb(
					create({ ...options, flush: zlib.constants.Z_SYNC_FLUSH })
				)
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
		const { BROTLI_PARAM_QUALITY, BROTLI_PARAM_SIZE_HINT } = zlib.constants
		const oneShotOptions = (
			encoding: CompressEncoding,
			data: Uint8Array,
			options?: OptionsByEncoding[CompressEncoding]
		) => {
			if (encoding !== 'br') return options
			const { params, ...rest } = (options ?? {}) as BrotliOptions
			return {
				...rest,
				params: {
					[BROTLI_PARAM_QUALITY]: 4,
					[BROTLI_PARAM_SIZE_HINT]: data.byteLength,
					...params
				}
			}
		}

		for (const encoding of Object.keys(names) as CompressEncoding[]) {
			const name = names[encoding]

			if (typeof zlib[`${name}Sync`] === 'function')
				oneShots[encoding] = (data, options) => {
					// Bun natives take no options; use them only for defaults
					if (options === undefined) {
						if (encoding === 'gzip' && runtime.Bun?.gzipSync)
							return runtime.Bun.gzipSync(data)

						if (
							encoding === 'zstd' &&
							runtime.Bun?.zstdCompressSync
						)
							return runtime.Bun.zstdCompressSync(data)
					}

					return zlib[`${name}Sync`](
						data,
						oneShotOptions(encoding, data, options)
					)
				}

			if (typeof zlib[name] === 'function')
				asyncOneShots[encoding] = (data, options) =>
					new Promise((resolve, reject) => {
						zlib[name](
							data,
							oneShotOptions(encoding, data, options),
							(error: Error | null, result: Uint8Array) => {
								if (error) reject(error)
								else resolve(result)
							}
						)
					})
		}
	}
}

export { asyncOneShots, codecs, oneShots }
