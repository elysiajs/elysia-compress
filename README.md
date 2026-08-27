# @elysia/compress

Response compression for Elysia. The plugin wraps the final `Response`, so it
works with normal routes, errors, `404` responses, streams, and existing
`mapResponse` hooks.

## Install

```bash
bun add @elysia/compress
```

## Use

```typescript
import { Elysia } from 'elysia'
import { compress } from '@elysia/compress'

new Elysia()
    .use(compress())
    .get('/', () => 'hello world '.repeat(200))
    .listen(3000)
```

The defaults offer Brotli, Zstandard, gzip, and deflate in that order. The
client can change the order with `Accept-Encoding` quality values.

```typescript
compress({
    encodings: ['br', 'zstd', 'gzip'],
    threshold: 1024,
    stream: true,
    types: (type) => type.startsWith('text/'),
    options: {
        gzip: { level: 6 }
    }
})
```

| Option | Default | Meaning |
| --- | --- | --- |
| `default` | `true` | Compress every route by default. Set to `false` to compress only routes that opt in with the `compress` macro. |
| `encodings` | `['br', 'zstd', 'gzip', 'deflate']` | Server preference order. Unsupported codecs are removed. |
| `threshold` | `1024` | Minimum size for known or buffered bodies. |
| `stream` | `true` | Compress chunked responses. |
| `types` | Common text and web formats | Receives a lowercase content type without parameters. |
| `options` | `{}` | Per-encoding Brotli, Zstandard, gzip, or deflate options. |

The default types are `text/*`, JSON, JavaScript, XML, SVG, and WebAssembly.
Responses without a usable `Content-Type` are skipped, except plain Elysia
strings on Bun. Bun does not expose their inferred type before serialization,
so the plugin treats a missing type as text unless the first 1 KiB contains a
NUL byte. Set `Content-Type` on raw byte responses.

## Behavior

The plugin does not compress:

- `HEAD` responses
- statuses `204`, `205`, `206`, and `304`
- bodies below `threshold`
- responses with `Content-Encoding`
- responses with `Cache-Control: no-transform`
- server-sent events
- content types rejected by `types`
- chunked responses when `stream` is `false`

Compressed responses get `Content-Encoding` and `Vary: Accept-Encoding`.
The plugin removes stale length and range headers and weakens strong ETags.

The plugin consumes a buffered response's body directly instead of cloning
it, for speed. If a handler reuses the same `Response` instance across
requests, hand it out as `cached.clone()` on every request, or mark the
retained instance once with Elysia's `borrow()` (`import { borrow } from
'elysia'`) so core clones it per request instead. An unmarked, reused
`Response` whose body has already been read fails loudly with core's
"Cannot reuse a consumed Response across requests" error on the next
request — it does not silently serve stale or corrupted content.

`threshold` cannot predict the final size of a live stream, so it applies only
to a declared `Content-Length` or a buffered body. Streaming compression has no
`Content-Length`; buffered bodies use one-shot compression.
Buffered bodies larger than 1 MiB are compressed through the streaming codec
instead of the blocking one-shot, to keep the event loop responsive; the
response stays correct, and total time for that single response may be
marginally higher.

The plugin uses `app.wrap()`. Any wrapper disables Elysia static response
promotion for the app because the final response now depends on each request.

## Per-route opt-in/opt-out

Set `default: false` to compress nothing by default, then opt individual routes
in with the `compress` macro. The macro goes in the hook argument, which comes
*before* the handler:

```typescript
new Elysia()
    .use(compress({ default: false }))
    // route(path, HOOK, handler) — the macro lives in the hook, not the handler
    .get('/', { compress: true }, () => 'hello world '.repeat(200))
    .get('/status', () => 'ok') // not compressed, default is false
    .listen(3000)
```

With `default: true` (the default), use the same macro to exclude a route instead:

```typescript
new Elysia()
    .use(compress())
    .get('/stream', { compress: false }, () => streamThatShouldNotBeGzipped())
```

A route excluded from compression is returned untouched, without a `Vary`
header, since it never varies its response on `Accept-Encoding`.

`.mount()`ed fetch handlers are a foreign boundary — Elysia rebuilds the
`Request` object before handing it to a mounted app, so the `compress` macro's
per-request marker never reaches it. A mounted app must register its own
`compress()` if it wants compression.

On Elysia `2.0.0-beta.6` and earlier, registering `compress()` after a
function-shaped async plugin such as `elysia/auto-head`'s `autoHead()` threw
`Macro compress can only run in sync plugin` at startup — an Elysia core
`#useFn` bug, fixed in core after beta.6. On fixed versions the two orders
behave identically; on beta.6 and earlier, register `compress()` first.

## Security

Do not compress a response that contains secrets and reflects request input.
The compressed size can leak the secret through a BREACH-style attack. Set the
standard `no-transform` cache directive on that response:

```typescript
app.get('/secret', ({ query, set }) => {
    set.headers['cache-control'] = 'private, no-transform'

    return { echo: query.q, token: session.token }
})
```

This works on every response path. It does not depend on a route macro or hook
order.
