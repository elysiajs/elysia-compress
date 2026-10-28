
# 2.0.0-rc.0 - 20 Oct 2026
Change:
- Add support for Elysia 2.0

# Unreleased
Feature:
- prefer zstd over br by default (`['zstd', 'br', 'gzip', 'deflate']`); zstd compresses several times faster at a similar ratio, br remains the fallback for clients without zstd
- compress buffered bodies larger than 1 MiB with zlib's async one-shot to keep the event loop responsive
- consume buffered response bodies directly instead of always cloning; a `Response` reused across requests must be marked with Elysia's `borrow()` (unmarked reuse now fails loudly via core's reuse guard instead of silently cloning)

Fix:
- serve the original buffered body when compression fails, including when `maxOutputLength` is exceeded

# 2.0.0-beta.1 - 27 Aug 2026
Feature:
- init
