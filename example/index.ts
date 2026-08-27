import { Elysia } from 'elysia'
import { compress } from '../src/index'

new Elysia()
	.use(compress())
	.get('/', 'hello world '.repeat(200))
	.get('/json', () => ({ hello: 'world'.repeat(200) }))
	.get('/secret', ({ query, set }) => {
		set.headers['cache-control'] = 'private, no-transform'

		return { echo: query.q, token: 'super-secret-token' }
	})
	.listen(3000)
