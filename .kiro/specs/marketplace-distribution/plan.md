# npm-managed и marketplace: план реализации

Статус: реализация и локальные owned-fixture проверки разрешены. Запрещены личный профиль/личный `auto`, npm registry publish, remote push/release, удаление неизвестных файлов.

## 1. Требования

1. Два альтернативных канала одного пакета `omp-settings-ru`: npm-managed GitHub install и нативный OMP marketplace. Одинаковые `name`, версия, `omp.extensions`, runtime; одновременно загружается одна копия. Без сайта-магазина, своего updater, сетевого runtime, параллельного discovery.
2. Marketplace каталог привязывает выпуск к полному commit SHA и `ref: v<version>`; публикует только успешно опубликованные и проверенные выпуски. Движущаяся ветка не источник пакета.
3. `marketplace.autoUpdate=auto` — только явный opt-in, общая настройка хоста (все marketplace-плагины пользователя и активного проекта), не настройка расширения. Установка и код перевода её не включают.
4. Обновление и смена канала сохраняют host settings, plugin settings, disabled-state, features и чужие записи. Нативное удаление стирает own state; uninstall/install не выдавать за сохраняющую миграцию.
5. Сохранить все четыре версии OMP (**18.6.1, 18.8.0, 18.8.4, 18.8.7**), три платформы baseline и точные peers. Реестр, native startup, панель и опубликованный артефакт — раздельные доказательства.
6. Сокращать README/FAQ/описания, не меняя смысл настроек, чисел, предупреждений и destructive actions. Сохранить MIT/атрибуцию.
7. Очистка — только после поимённого inventory и проверки ссылок; неизвестные/пользовательские файлы сохранять. `node_modules`, Git history, чужие профили/конфиги вне очистки.
8. `private: true` сохранить. npm registry publication, аккаунт/токен и отдельное разрешение в контракте отсутствуют. Ничего не публиковать и не обещать автоматическое включение в сторонние каталоги.

## 2. Проверенные факты

- База: `main`, HEAD `4665e6d72635751d03b784d1b02dc107f38071a4`; ignored `.tools/`, `dist/`, `node_modules/`, `upgrade-report.md`, пустой `.smoke/`. Правки делает worker-агент в этом checkout; пользователь (director) и ревьюер — read-only.
- [package.json](../../../package.json): `0.3.1`, `private:true`, `omp.extensions:["./src/index.ts"]`, allowlist `files`, четыре точных host alias. [README](../../../README.md) предлагает `omp plugin install github:narimanisakhanov-creator/omp-settings-ru#v0.3.1`.
- Живой `omp --version` = `omp/18.8.7`; `omp plugin --help` подтверждает `marketplace`, `discover`, `upgrade`, `--scope`, `--json`.
- GitHub API: [v0.3.1 release](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.3.1) published, not draft/prerelease; assets `omp-settings-ru-0.3.1.tgz`, `SHA256SUMS`; tag object `794ae4a8e928cba208c0a4f8cd3a2a0ccd8df0a7` targets HEAD, unsigned. API archive digest `827fdbd287e48796d6a56bc106a1e91c49c304e33210863fe2fc6fef1335d12e` — метаданные, не локальная проверка байтов. `stable` — тот же commit.
- [release.yml](../../../.github/workflows/release.yml): tag/version → fixed native host → `check` → `npm pack`/SHA256SUMS → GitHub Release → ancestry-checked продвижение `stable`; npm registry publish отсутствует. [check.yml](../../../.github/workflows/check.yml): динамическая host/OS matrix, fixed executable, domain suite, package/panel smoke, native receipt, hygiene.
- [supported-hosts.json](../../../baseline/supported-hosts.json) и публичные документы различают четыре source registry версии и только 18.8.4/18.8.7 Windows full-panel evidence; старые receipts не переиспользовать как доказательство новых каналов.

## 3. Реальные контракты OMP (установленный 18.8.7, `node_modules/omp-host-1887/src/`)

| Контракт | Источник | Решение |
| --- | --- | --- |
| catalog | `marketplace/types.ts`: required `name`, `owner.name`, `plugins`; каталог в `.omp-plugin/marketplace.json` | Один `.omp-plugin/marketplace.json`; валидатор проверяет, что запись сохранилась после native parsing |
| pin | `marketplace/source-resolver.ts`: `github`/`url` → `vcs.clone(url, dir, {refName: source.ref, sha: source.sha})` | Полный SHA + release ref; ref сам по себе не immutable |
| runtime registration | `marketplace/manager.ts`: package name из `package.json`; кеш, junction/symlink в `plugins/node_modules`, запись в `omp-plugins.lock.json` | Отдельный `.omp-plugin/plugin.json` не нужен; TS entry не копировать |
| extension loading | `plugins/loader.ts`: dependencies ∪ runtime links → `package.json.omp` → `resolvePluginExtensionPaths`; project shadows user | Реальная загрузка `./src/index.ts` через native registration; не подменять `-e`/`--plugin-dir`/`plugin link` |
| collision | `marketplace/manager.ts` отклоняет npm/link package с тем же runtime name; loader дедуплицирует по package name | Один канал; перед сменой проверить user/project и explicit roots; не обходить `--force` |
| npm-managed | `plugins/manager.ts` распознаёт GitHub spec и запускает `bun install` | Пакетный путь с GitHub source, не npm registry |
| update | `marketplace/manager.ts`: refresh после 24 ч, semver/inequality, force reinstall | Semver монотонна; SHA меняется только с новой version; manual refresh для немедленной проверки |
| auto | `marketplace-auto-update.ts`: default `notify`; startup background, stale refresh, `checkForUpdates`, `upgradeAllPlugins`; ошибки подавляются (`catch {}`) | Не обещать SHA256SUMS/ReleasePin gate, атомарность всех plugins, hot reload или успех при сетевой ошибке |
| state | `plugins/runtime-config.ts` → `{plugins: Record<name, PluginRuntimeState>, settings: Record<name, unknown>}`; reinstall сохраняет disabled/features/settings, uninstall удаляет own | Upgrade ≠ смена канала; migration — targeted restore own key, без перезаписи чужих |

Первичные upstream refs:

| OMP | commit | ссылка |
| --- | --- | --- |
| 18.6.1 | `2a2c6dcbbb558c0f8145f67f28b3370984f2bf60` | [native marketplace manager](https://github.com/can1357/oh-my-pi/blob/2a2c6dcbbb558c0f8145f67f28b3370984f2bf60/packages/coding-agent/src/extensibility/plugins/marketplace/manager.ts) |
| 18.8.0 | `4ef97c8826ee012829a3e756b693a2a16a414f47` | [loader](https://github.com/can1357/oh-my-pi/blob/4ef97c8826ee012829a3e756b693a2a16a414f47/packages/coding-agent/src/extensibility/plugins/loader.ts) |
| 18.8.4 | `40e9368ef0458fd9073329cdff4174895f91bc6b` | [loader](https://github.com/can1357/oh-my-pi/blob/40e9368ef0458fd9073329cdff4174895f91bc6b/packages/coding-agent/src/extensibility/plugins/loader.ts) |
| 18.8.7 | `f261ed9faf16b61880b544f599876bface4ded0d` | [catalog types](https://github.com/can1357/oh-my-pi/blob/f261ed9faf16b61880b544f599876bface4ded0d/packages/coding-agent/src/extensibility/plugins/marketplace/types.ts), [auto](https://github.com/can1357/oh-my-pi/blob/f261ed9faf16b61880b544f599876bface4ded0d/packages/coding-agent/src/extensibility/plugins/marketplace-auto-update.ts), [setting](https://github.com/can1357/oh-my-pi/blob/f261ed9faf16b61880b544f599876bface4ded0d/packages/coding-agent/src/modes/settings.ts) |

Контрактные проверки выполнены по реально установленным файлам `node_modules/omp-host-1887/src/`; ссылки фиксируют разрешённый commit, а не дополнительные runtime результаты.

## 4. Решение

- **Индекс:** отдельная ветка `marketplace` этого репозитория публикует только `.omp-plugin/marketplace.json`; source объекта — независимый `{source:"github", repo, ref:"v<version>", sha:<full>}`. Создавать только после release/tag/assets/bytes и channel smokes; не использовать `main`/`stable` или `source:"./"`.
- **Публикация:** `release.yml` сохраняет свои гейты; `marketplace-index.yml` принимает tag/check-run (dispatch) или успешный `release` (workflow_run), резолвит tag и exact-commit `check` через API, гоняет native channel smoke по целевому каталогу и делает обычный fast-forward push только index branch. Решение publish/downgrade/conflict/identical — общая функция, покрытая доменным тестом на реальном owned Git.
- **Установка:** README команды npm-managed (`github:...#v<release>`) и marketplace (`marketplace add <raw catalog url>`, `install omp-settings-ru@omp-settings-ru`); opt-in auto отдельной командой с показом текущего значения и возвратом к прежнему `off/notify/auto`. Личный config не читать/не менять.
- **Смена канала:** не автоматическая и не runtime. `scripts/switch-channel.ts` с explicit channel/scope/profile/executable: типизированно проверяет lock до разрушения, бэкапит own запись (`flag:"wx"`), удаляет только выбранную собственную install, ставит альтернативу, targeted restore own state; при сбое восстанавливает исходный канал и его state, иначе сообщает точный backup и recovery.

## 5. Файлы и порядок

1. `scripts/marketplace-catalog.ts` — генерация/валидация native-compatible каталога + `decideMarketplaceIndexPublish` (monotonic/idempotent/conflict).
2. `test/artifact-binding.test.ts` — доменные проверки publish-decision (реальный owned Git), catalog/release gate, config boundary миграции. Отдельный marketplace test-файл не создавать.
3. `scripts/switch-channel.ts` — типизированная граница конфига до разрушения, rollback/recovery при сбое install.
4. `scripts/distribution-smoke.ts`, `scripts/distribution-session.ts` — native proof обоих каналов: точный SHA/load path, отсутствие дубля registration, панель (поиск/bool/enum/языковой цикл), обе миграции, реальный startup auto на owned stale каталоге (два настоящих release, второй plugin и disabled-copy). Сетевой GitHub-путь — отдельный, не выдавать за offline.
5. `.github/workflows/marketplace-index.yml` — workflow_run + dispatch, native smoke по целевому каталогу, безопасный index push.
6. `README.md`, `CONTRIBUTING.md`, `docs/faq.md`, `CHANGELOG.md`, `package.json` scripts.
7. Cleanup §7 — только поимённо, после сохранения доказательств.

## 6. Критерии готовности

- [ ] `bun run check`, `bun run matrix:check`, package dry-run/hygiene проходят финальный source; существующие domain-тесты восстановления/ownership не ухудшены.
- [ ] Native `plugin install` ставит точный npm-managed release и marketplace source; `--version`, manifest version, resolved commit/content hash, scope, load path; реальный OMP без `-e`/link/plugin-dir грузит перевод и команду один раз.
- [ ] Панель каждого канала: RU labels/описания/статичные options/warnings, русский поиск, безопасный bool/enum с возвратом технического значения, ru/en/ru, новый RU startup; после native uninstall новая обычная сессия English.
- [ ] Migration npm→marketplace→npm сохраняет JSON types, disabled, `enabledFeatures` (`null`/`[]`/значения), чужие host/plugin keys; нет двух physical roots/двойного command registration; collision не затирает предыдущую install.
- [ ] Реальный auto: disposable profile, старый immutable release, owned served catalog A→B из двух настоящих commits; `auto` внутри disposable обновляет, `off/notify` не ставят B; второй plugin подтверждает общую область; disabled/features/settings сохранены.
- [ ] Failure: недоступный source/invalid SHA не выдаёт success; предыдущая install/настройки проверены по bytes/state; offline не превращать в passing auto; фиксировать version/SHA/state before/after, не только exit code.
- [ ] Release pipeline не публикует index при провале pre-release/check/assets; два конкурирующих release не понижают version; повторная публикация идемпотентна; index native parsing оставляет ровно нужную entry.
- [ ] Docs команды выполнены в disposable profile; говорят npm-managed GitHub, не npm registry; auto предупреждение без SHA256SUMS/ReleasePin. Все четыре source variants/peers сохранены.

## 7. Кандидаты очистки

Полный набор кандидатов; остальные `.tools` объекты unknown и защищены. Удаление только точного пути после: происхождение известно → нет нужных consumers/links → уникальное сохранено с SHA/mapping → восстановимость/дубликат проверены → путь одобрен. Package allowlist уже исключает `.tools/.kiro/dist/test/baseline`; размер/возраст не причина. Без `git clean` и rewrite history.

| Кандидат | Происхождение / ссылки | Действие |
| --- | --- | --- |
| `.tools/_syntaxcheck.js`, `.tools/_syntaxcheck2.js` | Generated Bun bundle 18.8.4; оба SHA `7968b03ab369e329d52632c8226ff724581dc38294dce8b9a4204ec3575d2160`; ignored | Один сохранён; `.tools/_syntaxcheck2.js` удалён как точный дубликат после проверки ссылок (оставшийся `.tools/_syntaxcheck.js` не тронут) |
| `.tools/matrix-native-probe.ts`, `.tools/matrix-resolve-check.ts`, `.tools/alias-lock-probe.ts` | Диагностики matrix/alias, ignored; consumers не установлены | Предложить archive, **не delete** по имени/возрасту |
| `.tools/presentation-readme-preview.html`, `.tools/presentation-readme-desktop.png`, `.tools/settings-ru-live-provisional.png` | Локальные presentation artifacts; публичный README использует другой PNG | Private archive с hashes; удаление только после доказательства дубликата |
| `.tools/maintenance-evidence.installed-host.json`, `.tools/maintenance-evidence.installed-host-1887.json` | Ссылки `baseline/supported-hosts.json:69,79` | Оставить (unique support provenance) |
| `.tools/maintenance-evidence.capture-details.md` | Ссылка `docs/screenshots.md:26` | Сохранить; перенос только с сохранённым SHA и обновлением ссылки |
| `.tools/maintenance-evidence.design.md`, `.tools/maintenance-evidence.implementation.md`, `.tools/orca-capture-proof.json`, `.tools/orca-worker-start-core-design.json` | Ссылки старых `.kiro/specs/automatic-maintenance/{design,tasks}.md` и recorded-envelope test | Preserve/archive с mapping |
| `.tools/audit-scratch/`, `.tools/release-audit/` | Ignored subtrees с package extractions, archives, native receipts, logs, scans и собственным smoke-home config | Только закрытая инвентаризация/архивация, не рекурсивное удаление |
| `.tools/prompts/`, `.tools/docs-draft/`, `.tools/maintenance-evidence.d/`, `.tools/watcher-18.8.4-baselines/`, `.tools/watcher-18.8.4-prepared/` | Ignored drafts/provenance/source copies; часть связана с maintenance | Только inventory/archive |
| `dist/release-notes.md`, `dist/SHA256SUMS`, `dist/omp-settings-ru-0.1.0.tgz`, `.tools/omp-settings-ru-0.2.0.tgz` | Старые release artifacts, вне allowlist | Сначала hash-сверка с GitHub releases и сохранение notes/scan |
| `upgrade-report.md` | Generated; writer `scripts/upgrade-host.ts:88`; имя используют CONTRIBUTING/workflow/test | Сохранить исторический вывод перед изменением |
| `.smoke/` | Пустой ignored directory | Оставить |
| `docs/screenshots/settings-ru-live-final.png` | Tracked; полный provenance не установлен | Сохранить, предложить архив/объяснение |

**Не кандидаты:** остальные `.tools` файлы, действующие specs, 12 baseline files/registry, runtime translations, scripts/test/maintenance policy, публичные три PNG, лицензии.

## 8. Границы

Реализация и owned disposable-fixture install/smoke разрешены. Перед каждым destructive/remote действием — отдельное разрешение (личный profile/config/auto, npm publish, remote push/release, unknown cleanup). Коммиты не выполнять; после изменений проверить `git status` и сохранить чужие изменения. Роль редактора: worker-агент правит файлы в этом checkout; пользователь — director (read-only), ревьюер — read-only.
