# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-28

### Changed (breaking)

- The exported `IEverygrid` type no longer lists internal `_`-prefixed members. They were never
  part of the API; code that read them through the type needs a cast.

### Fixed

- Destroying a grid (unmount, `resetAutoInit`) while it is still loading no longer leaves work
  behind: the engine Worker is terminated even if it was still starting, streaming downloads are
  cancelled, late timers and progress callbacks no longer re-render into the removed container,
  and the lazy-refresh IntersectionObserver is disconnected.
- In-flight engine requests now settle when the Worker is terminated or crashes instead of hanging
  forever; an intentional destroy stays quiet in the console.
- A WASM initialisation failure is reported back instead of leaving grid creation pending.
- Sort-only paging: rows without the sort column were dropped from pages (the last pages came back
  short or empty); they now follow the sorted rows, as in filtered views.
- Very large page numbers no longer overflow the page offset in the engine.
- Removing many rows at once is linear instead of quadratic.
- `resetAutoInit` also cancels pending unmounts from the React hook.

### Removed

- Debug `console.log` output on engine start and on stream completion.
- An empty `everygrid-config.json` that shipped in the package by accident.

## [0.1.0] … [0.4.9]

Released without changelog entries; see the git history.

## [0.0.1] - 2026-05-10

### Added

- Default grid configuration and sample data.
- Placeholder component for empty grid states.
- Dedicated component for Excel popup logic.
- Project infrastructure and documentation.

### Changed

- Simplified grid initialization.
- Enhanced information display in the main Application.
