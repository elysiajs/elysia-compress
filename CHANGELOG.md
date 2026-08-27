# Unreleased
Feature:
- cap one-shot buffered compression at 1 MiB; larger bodies compress through the streaming codec so the event loop stays responsive
- consume buffered response bodies directly instead of always cloning; a `Response` reused across requests must be marked with Elysia's `borrow()` (unmarked reuse now fails loudly via core's reuse guard instead of silently cloning)

# 2.0.0-beta.1 - 27 Aug 2026
Feature:
- init
