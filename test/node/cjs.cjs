if ('Bun' in globalThis) throw new Error('Expected Node.js')

const { compress } = require('@elysia/compress')

if (typeof compress !== 'function') throw new Error('CommonJS export failed')
