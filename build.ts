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
