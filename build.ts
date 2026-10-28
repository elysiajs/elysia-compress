import { build } from 'tsdown'

await build({
	clean: true,
	outDir: 'dist',
	entry: ['src/index.ts'],
	cjsDefault: false,
	target: 'node22',
	format: ['esm', 'cjs'],
	minify: false,
	dts: true,
	outExtensions(c) {
		return {
			dts: '.d.ts',
			js: c.format === 'es' ? '.mjs' : '.js'
		}
	}
})

const declarations = await Bun.file('dist/index.d.ts').text()
if (
	/node:|\bBuffer\b|\bNodeJS\b|["'](?:zlib|stream)["']|types="node"/.test(
		declarations
	)
)
	throw new Error('Public declarations must not expose Node.js types')
