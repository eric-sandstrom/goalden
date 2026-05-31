# Changelog

## [1.9.0](https://github.com/eric-sandstrom/goalden/compare/v1.8.0...v1.9.0) (2026-05-31)


### Features

* material symbols icons, logo favicon, and matches polish ([#49](https://github.com/eric-sandstrom/goalden/issues/49)) ([00deab0](https://github.com/eric-sandstrom/goalden/commit/00deab02a77427404c8913f357494c5d98f53975))

## [1.8.0](https://github.com/eric-sandstrom/goalden/compare/v1.7.2...v1.8.0) (2026-05-31)


### Features

* activation-driven match ingest with unfolded live detail ([#46](https://github.com/eric-sandstrom/goalden/issues/46)) ([5c965f2](https://github.com/eric-sandstrom/goalden/commit/5c965f2c9edc1a08dfd54c686504a61cd1fb0d3b))

## [1.7.2](https://github.com/eric-sandstrom/goalden/compare/v1.7.1...v1.7.2) (2026-05-31)


### Bug Fixes

* stabilise match-detail rendering (no layout shift, no software-renderer jank) ([#44](https://github.com/eric-sandstrom/goalden/issues/44)) ([8e73640](https://github.com/eric-sandstrom/goalden/commit/8e7364032c0ea4cb058bb70e6135f5a0170ebb87))

## [1.7.1](https://github.com/eric-sandstrom/goalden/compare/v1.7.0...v1.7.1) (2026-05-31)


### Improvements

* cut Firestore reads in the football-data pollers ([#41](https://github.com/eric-sandstrom/goalden/issues/41)) ([5fd9d01](https://github.com/eric-sandstrom/goalden/commit/5fd9d01b4a81a1887cf201ecf67656482172ceba))

## [1.7.0](https://github.com/eric-sandstrom/goalden/compare/v1.6.0...v1.7.0) (2026-05-31)


### Features

* pin match-detail header height and always show all tabs ([#38](https://github.com/eric-sandstrom/goalden/issues/38)) ([6344b71](https://github.com/eric-sandstrom/goalden/commit/6344b713a56ac5b0ddef8f114349b596916d4998))

## [1.6.0](https://github.com/eric-sandstrom/goalden/compare/v1.5.0...v1.6.0) (2026-05-31)


### Features

* fade the match detail in/out instead of side-sliding ([#37](https://github.com/eric-sandstrom/goalden/issues/37)) ([599c61b](https://github.com/eric-sandstrom/goalden/commit/599c61b615f03f7905ba83eb39632c53bc8567d5))

## [1.5.0](https://github.com/eric-sandstrom/goalden/compare/v1.4.0...v1.5.0) (2026-05-31)


### Features

* live match detail (line-ups, events, head2head) ([#34](https://github.com/eric-sandstrom/goalden/issues/34)) ([7161532](https://github.com/eric-sandstrom/goalden/commit/7161532492fefb1558313869bab5fab6a6fd3be2))

## [1.4.0](https://github.com/eric-sandstrom/goalden/compare/v1.3.1...v1.4.0) (2026-05-31)


### Features

* shared-element view transitions from match list to detail ([#32](https://github.com/eric-sandstrom/goalden/issues/32)) ([19419f6](https://github.com/eric-sandstrom/goalden/commit/19419f6b62119d01230f514dff9f5e2d317ef147))

## [1.3.1](https://github.com/eric-sandstrom/goalden/compare/v1.3.0...v1.3.1) (2026-05-30)


### Bug Fixes

* split fixture-detail to clear component-style budget ([#30](https://github.com/eric-sandstrom/goalden/issues/30)) ([0312697](https://github.com/eric-sandstrom/goalden/commit/03126976c267eef9e651914dd7877a6f9c0891f5))

## [1.3.0](https://github.com/eric-sandstrom/goalden/compare/v1.2.0...v1.3.0) (2026-05-30)


### Features

* **fixture-detail:** rich match-detail design — scoreboard, events, pitch line-ups ([#28](https://github.com/eric-sandstrom/goalden/issues/28)) ([935338c](https://github.com/eric-sandstrom/goalden/commit/935338caeb5ba64d5eefb917cb892bbbfd27b5c9))

## [1.2.0](https://github.com/eric-sandstrom/goalden/compare/v1.1.1...v1.2.0) (2026-05-30)


### Features

* **fixture-detail:** add /match/:fdid view with on-demand football-data detail ([#24](https://github.com/eric-sandstrom/goalden/issues/24)) ([687b629](https://github.com/eric-sandstrom/goalden/commit/687b629c796c53f5f6567c252d25e382b7b01930))


### Improvements

* **routing:** rename /predict to /matches, nest detail at /matches/:id ([#26](https://github.com/eric-sandstrom/goalden/issues/26)) ([fd0256b](https://github.com/eric-sandstrom/goalden/commit/fd0256b75b010fc601d7e69375dc7e9a964f86f1))

## [1.1.1](https://github.com/eric-sandstrom/goalden/compare/v1.1.0...v1.1.1) (2026-05-30)


### Bug Fixes

* **fixtures:** reconcile live matches stuck past the poll window ([#22](https://github.com/eric-sandstrom/goalden/issues/22)) ([5645268](https://github.com/eric-sandstrom/goalden/commit/5645268135c154230b125bcbb14f587a1d69d766))

## [1.1.0](https://github.com/eric-sandstrom/goalden/compare/v1.0.2...v1.1.0) (2026-05-30)


### Features

* **predict:** live match clock/status on rows and 90-minute scoring ([#20](https://github.com/eric-sandstrom/goalden/issues/20)) ([ea062a4](https://github.com/eric-sandstrom/goalden/commit/ea062a4638d3f55d3a19b21575b3fcb5c8c620c7))

## [1.0.2](https://github.com/eric-sandstrom/goalden/compare/v1.0.1...v1.0.2) (2026-05-30)


### Bug Fixes

* resolve team-detail for non-world-cup teams via direct doc read ([#18](https://github.com/eric-sandstrom/goalden/issues/18)) ([ecd3068](https://github.com/eric-sandstrom/goalden/commit/ecd3068136bac330859ee59097093ecd1cc3f74b))

## [1.0.1](https://github.com/eric-sandstrom/goalden/compare/v1.0.0...v1.0.1) (2026-05-30)


### Bug Fixes

* award points for non-world-cup matches and backfill missed scoring ([#16](https://github.com/eric-sandstrom/goalden/issues/16)) ([3f47c9e](https://github.com/eric-sandstrom/goalden/commit/3f47c9e1a297eaf262a0f0bf3124b593b3214ada))

## 1.0.0

* Added a "What's new" change log to the update prompt
