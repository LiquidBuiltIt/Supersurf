# WebDrive

Browser agent benchmark for real, hostile DOM patterns.

**Status:** v0.1 foundation — 3 challenges, score-only harness.

## Install

```bash
npm install -g webdrive
```

## Usage

```bash
webdrive serve --port 3737              # Serve challenges at http://localhost:3737
webdrive score predictions.jsonl        # Score a predictions file
webdrive config list                    # View config
```

See `docs/superpowers/plans/2026-05-11-webdrive-v0.1-foundation.md` for the build spec.
