## 0.10.0

OMP 18.13.2 → 18.13.3.

- Новые настройки на русском: 3 — Строки свёрнутой карточки советника (`display.advisorCollapsedLines`), Обход цепочки при ограничении частоты запросов (`retry.rateLimitWalksChain`), xd:// Уведомления о монтировании (`tools.xdevNotices`).
- Покрытие: 18.6.1 398/398, 18.8.0 404/404, 18.8.4 404/404, 18.8.7 410/410, 18.12.6 419/419, 18.13.1 421/421, 18.13.2 423/423, 18.13.3 426/426. [Полный список](https://github.com/narimanisakhanov-creator/omp-settings-ru/blob/v0.10.0/upgrade-report.md).

## 0.9.0

OMP 18.13.1 → 18.13.2.

- Новые настройки на русском: 2 — Управление режимом расширений (`extensionHandlers.modeControl`), Возобновление области рабочего дерева (`session.worktreeScope`).
- Обновлены переводы изменившихся настроек: 1 — Автоматическое возобновление (`autoResume`).
- Покрытие: 18.6.1 398/398, 18.8.0 404/404, 18.8.4 404/404, 18.8.7 410/410, 18.12.6 419/419, 18.13.1 421/421, 18.13.2 423/423. [Полный список](https://github.com/narimanisakhanov-creator/omp-settings-ru/blob/v0.9.0/upgrade-report.md).

## 0.8.0

OMP 18.12.6 → 18.13.1.

- Новые настройки на русском: 2 — Пробуждать режим печати по результатам заданий (`async.printWake`), Ограниченные папки (`tools.restrictedFolders`).
- Обновлены переводы изменившихся настроек: 1 — Предотвращение сна (`power.sleepPrevention`).
- Покрытие: 18.6.1 398/398, 18.8.0 404/404, 18.8.4 404/404, 18.8.7 410/410, 18.12.6 419/419, 18.13.1 421/421. [Полный список](https://github.com/narimanisakhanov-creator/omp-settings-ru/blob/v0.8.0/upgrade-report.md).

## 0.7.1

OMP 18.8.7 → 18.12.6.

- Новые настройки на русском: 11 — Минимальная важность заметки советника для продолжения (`advisor.continueSeverity`), Виджеты выполняющихся заданий в реальном времени (`async.widgets`), Предсказания Composer (`composer.predictions`), Резервный режим фонового ввода компьютера (`computer.backgroundFallback`); ещё 7.
- Обновлены переводы изменившихся настроек: 15 — Тайм-аут ask (`ask.timeout`), Автоматическое использование сбросов Claude (`claudeResets.autoRedeem`), Автоматическое использование сохранённых сбросов Codex (`codexResets.autoRedeem`), Задержка уплотнения в простое (`compaction.idleTimeoutSeconds`); ещё 11.
- Больше не доступны в OMP 18.12.6: 2 настройки; исторические переводы сохранены.
- Покрытие: 18.6.1 398/398, 18.8.0 404/404, 18.8.4 404/404, 18.8.7 410/410, 18.12.6 419/419. [Полный список](https://github.com/narimanisakhanov-creator/omp-settings-ru/blob/v0.7.1/upgrade-report.md).

## 0.7.0

- Добавлена проверенная поддержка OMP 18.12.6; исторические переводы сохранены.

# изменения

## [0.6.1](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.6.1) — 2026-10-24

- хост-пакеты объявлены необязательными peer-зависимостями: плагин больше не тянет в свой payload копию хоста и её нативные модули, а использует штатный runtime-реестр OMP; это убирает разрешение `@oh-my-pi/pi-natives` из реестра в свежем home, из-за которого prepublication smoke падал на Linux без prebuilt-бинаря.
- prepublication gate снова устанавливает именно проверенный draft-каталог (`--catalog`) нативным хостом до promote; source-режим как замена убран.
- тест configured extension roots конфигурирует корень через CLI хоста и читает настройку в обеих формах ответа (`array` и `{value}`), поэтому матрица 18.8.0/18.8.4 снова зелёная.

- при fail-closed остановке перевода `translate.log` вкладывается в blocked-артефакт вместе с причиной; successful candidate bundle по-прежнему не содержит файлов вне манифеста.
- глоссарий различает уровни заметок советника: `concern` переводится как «замечание», а не «проблема»; translator prompt требует использовать глоссы без замены синонимами.
- independent reviewer отключён: модель-ревьюер не вызывается, `semanticReview` фиксируется как `disabled` в `candidate.json`, `proof.json` и `variant-review.json`, новые варианты не получают verdict и comparison, а `unreviewed-*` для них не считается провалом. Исторические `independently-confirmed` строки сохраняют свои comparison/evidence и продолжают проверяться; строгая схема, hashes, provenance и native gates не меняются. Semantic-ошибка нового перевода может уйти в выпуск.
- verify использует read-only `GITHUB_TOKEN` только для metadata OMP release, поэтому анонимный GitHub API rate limit больше не блокирует проверку; candidate subprocess получают secret-free окружение.

## [0.6.0](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.6.0) — 2026-10-24

- стабильность проверок: устранены гонки в тестовых фикстурах измерения (общий cleanup удалял чужие root/registry), liveness-сэмплинг больше не смешивает argv завершившегося процесса с переиспользованным PID, а `prepareToolRoot` выполняет ровно одну установку без маскирующих повторов; полный `bun run check` проходит подряд без флаки.
- гигиена репозитория: снимки хостов перенесены байт-в-байт в `test/fixtures/host-snapshots/` через единый модуль путей, `baseline/` и прочие внутренние артефакты больше не отслеживаются Git; добавлена регрессия на совпадение sha256 снимков с `supported-hosts.json`.
- полный эффективный русский каталог материализован в `ru-catalog.json`: 410 путей, 424 варианта и 1269 платформенных идентичностей; сохранены исторические display hashes, macOS completion, все варианты `title.icons` и `tools.xdev`. Статический maintenance gate читает только строгий JSON, проверяет сохранность платформ/наблюдений и source-aware маркеры всех display-полей.
- сопровождение перенесено в GitHub Actions с отдельными fresh runners discover/prepare/translate/verify/publish: модель получает только проверенные JSON-данные, а privileged publisher не исполняет candidate code. Каталог, review content, commit, bundle и patch связаны с originating run/attempt и точными SHA-256.
- локальный controller/Orca/journal/precheck/report transport и его obsolete тесты удалены; `maintenance:actions` — единственная production-оркестрация, ручной pinned updater и внешний PTY smoke сохранены.
- конечная version×platform матрица, исторические source/translation identity, exact-head CI и scoped PAT identity остаются обязательными gates. Версия плагина — следующий minor; PR хранит machine-readable identity для наблюдения merge/tag/release recovery без force refs. Production dispatch не выполнялся.
- выпуск разделён на read-only proof и privileged job: release принимает только tag ref `vX.Y.Z`, проверяет dereferenced commit, package version, originating run и immutable artifact id/attempt, а draft догружает только отсутствующие assets и отказывает конфликтующим/чужим. marketplace-index сначала read-only перепроверяет успешный release run, assets и native distribution smoke на draft-каталоге, затем отдельный promote на trusted `main` вызывает существующий publisher и доказывает `latest`/`latest/download/marketplace.json`; forced refs и переписывание тегов не используются.
- снимки метаданных хоста перенесены в отслеживаемый `test/fixtures/host-snapshots/` байт-в-байт: `sha256` в `supported-hosts.json` не изменились, покрытие/drift/кандидатный pipeline читают и пишут только этот каталог через `scripts/maintenance/paths.ts`. `baseline/` остаётся локальным каталогом ручного экспорта и игнорируется Git вместе с `.hiro/`, `.triage/`, `.orca/` и временными файлами; `.gitignore` не закрывает `src/`, `test/`, `scripts/`, `docs/`, `.github/` и конфиги.
- статическая регрессия `test/host-snapshots.test.ts` сверяет набор снимков с манифестом, пересчитывает `sha256` каждого файла и требует, чтобы allowlist кандидата ссылался ровно на канонический каталог.


## [0.5.0](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.5.0) — 2026-10-10

- канал marketplace переведён на ассет выпуска: каталог `marketplace.json` лежит третьим asset GitHub Release, стабильный URL — `releases/latest/download/marketplace.json`; ветки `marketplace` и `stable` в схеме больше не участвуют, и ни один workflow не пишет ref и не открывает PR.
- выпуск стал двухшаговым: `release.yml` по тегу создаёт **draft** release с архивом, `SHA256SUMS` и каталогом; `marketplace-index.yml` дожидается успешного exact-commit прогона `check` для commit тега, перепроверяет скачанные байты assets (digest из API и локальный пересчёт sha256), читает identity обслуженного `releases/latest` и применяет monotonic-правило, после чего продвигает draft и повторно проверяет уже опубликованный выпуск. Провал загрузки отменяет promotion, а не публикует выпуск без каталога; повторный прогон после продвижения идемпотентен.
- `scripts/marketplace-catalog.ts` / `scripts/marketplace-index.ts`: добавлены ожидание exact-commit прогона, pre-publication проверка draft-каталога, чтение identity обслуженного канала и promotion через `PATCH /releases/{id}` с типизированным boolean; рукописный каталог так не публикуется.
- удалён PR-контроллер upgrade-веток (`scripts/maintenance/github.ts`, `orca.ts`, `state.ts`, `automation.ts` и его тест); `scripts/maintenance.ts` — ручной pinned updater с явным `--accepted`/named `--profile` для активации, `maintenance.config.json` сведён к `schemaVersion`/`repository`/`requiredCheckPlatforms`.
- `upstream-watch.yml` больше не создаёт ветки и PR: кандидат публикуется как run artifact и step summary для ручного применения; `.github/dependabot.yml` держит `open-pull-requests-limit: 0`, поэтому `dependabot/*` ветки не появляются.
- уточнена лицензионная запись: из репозитория удалены неверные сторонние notice, а `LICENSE` и `scripts/check-release.ts` проверяют авторство проекта. если у проекта появятся сторонние компоненты, их обязательства оформляются отдельно.
- README, FAQ и руководство сопровождения описывают установку по тегу `v0.5.0`, каталог как asset выпуска и переход со старого каталога через `marketplace remove` → `add` → `update` (состояние плагина сохраняется; `uninstall` для перехода не годится).

- `scripts/panel-search.ts` + `scripts/distribution-session.ts` / `scripts/smoke-installed-worker.ts`: ожидание поиска настроек опирается на собственный счётчик панели (`1 match`), а не на глиф указателя или предполагаемое исходное значение — список ранжируется на каждый символ, а подтверждённый Glyph Protocol поднимает отрисованный пресет сессии (значение настройки не меняется), где указатель уже не `❯`, поэтому Enter мог изменить другую настройку и провалить native smoke; шаг читает показанное значение и проверяет сам переключатель и возврат.
- `scripts/smoke-panel-worker.ts`: инвариант закреплён в обязательном гейте `smoke:panel` — для каждого префикса запроса и каждого отрисованного пресета ожидание срабатывает только при ровно одном совпадении, затем булева настройка реально переключается и возвращается, а enum-набор глифов переключается на точный следующий вариант при каждом исходном значении (`unicode`/`nerd`/`ascii`) и возвращается к исходному.
- `scripts/distribution-smoke.ts`: отчёт native-сессии больше не теряется — падение дочернего процесса сообщает код выхода, stderr и разобранный JSON-отчёт (провалившиеся шаги с деталями, ошибка, фрагмент экрана), поэтому имя шага переживает усечение вывода.
- `test/artifact-binding.test.ts`, `test/host-matrix.test.ts`: тесты с подпроцессами и загрузкой нативных хостов получают явный бюджет времени, как остальные тесты этого класса; на загруженных runner они превышали умолчание bun в 5 с (локально ~2.2 с и ~1.4 с), из-за чего обязательные `check (windows-2025, …)` падали по таймауту без единого проваленного утверждения (прогоны 38009000882 и 38012235000).
- `scripts/distribution-smoke.ts`: цель обязательна и явна — без `--source` или `--catalog <path>` и при одновременных двух режимах команда завершается ошибкой `smoke-target-required`/`smoke-target-conflict` до создания профиля, вместо молчаливой проверки устаревшего выпуска по hardcoded default; каталог читается до создания профиля, отсутствующий или битый файл завершается исходной ошибкой чтения/парсинга без fallback на старый выпуск.
- `bun.lock`: peer-диапазон workspace синхронизирован с `package.json` без изменения разрешённого графа — изменены только две записи `peerDependencies` workspace (`18.8.7` добавлен к `18.6.1 || 18.8.0 || 18.8.4`), `devDependencies` и `packages` семантически идентичны, версии зависимостей не менялись.
- документация: README сокращён до пользовательского маршрута, единственный новый `docs/maintenance.md` собирает контракты сопровождения (распространение и auto, обновление источников, автоматизация, выпуск), `CONTRIBUTING.md` оставляет участие и три уровня доказательств совместимости; исторические `.kiro` specs и лишний снимок удалены из current tree, роль EN/поискового кадров уточнена в `docs/screenshots.md`.

## [0.4.0](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.4.0) — 2026-10-10

- второй канал того же `omp.extensions` — нативный marketplace OMP рядом с npm-managed GitHub; одновременно загружается одна копия, `private:true` сохранён, npm registry publication отсутствует.
- индекс каталога `.omp-plugin/marketplace.json` публикуется отдельной веткой и закрепляет release commit полным `source.sha` и тегом `source.ref`; `main` и `stable` не являются источником пакета.
- `scripts/marketplace-catalog.ts` / `scripts/marketplace-index.ts`: до любой записи живой выпуск перепроверяется по annotated tag → commit, успешному exact-commit workflow `check` и digest assets archive/`SHA256SUMS`; публикация индекса монотонна и идемпотентна, понижение версии и перезапись конфликтующего индекса отклоняются.
- `.github/workflows/marketplace-index.yml` запускается после успешного выпуска и прогоняет оба нативных канала по целевому каталогу до обычного fast-forward push только ветки индекса.
- `scripts/switch-channel.ts`: state-preserving смена канала с типизированной проверкой lock до удаления, приватным backup собственной записи, переносом `null`/`[]` features и disabled-state без изменения чужих ключей; при сбое install частично поставленный канал удаляется и восстанавливается исходный.
- `scripts/distribution-smoke.ts`: native proof обоих каналов — точный SHA/load path, отказ на коллизии имени и недоступном SHA, обе миграции канала, панель (поиск/bool/enum/языковой цикл) и реальный `off/notify/auto` на owned stale каталоге; `--source` проверяет текущий checkout.
- `marketplace.autoUpdate=auto` — только явный общий opt-in OMP для всех marketplace-плагинов пользователя и активного проекта, не настройка расширения; он не заменяет SHA256SUMS/ReleasePin gate и не гарантирует установку при сетевой ошибке.
- README/FAQ явно отделяют глобальный opt-in auto от SHA256SUMS/ReleasePin gate и предупреждают о state loss при uninstall; установка описана для обоих каналов, `main` не назван источником пакета.

## [0.3.1](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.3.1) — 2026-10-09

- поддержка OMP 18.8.7: 410 настроек (было 404), +6 новых, 2 изменившихся описания, 0 удалённых; все исторические варианты 18.6.1/18.8.0/18.8.4 сохранены.
- добавлены baseline 18.8.7 для Windows, Linux и macOS; Windows-метаданные сверены с реальным установленным хостом 18.8.7 (drift 0, покрытие 410/410), Linux/macOS — по независимому экспорту исходников.
- `tools.xdev`: описание 18.8.7 уточнено — помимо устройств запись разрешена только во временное пространство `local://`; прежняя формулировка про отклонение записей в файловую систему остаётся вариантом для 18.6.1–18.8.4.
- `worktree.onExit`: предупреждение режима `remove` явно называет удаление игнорируемых Git файлов (например, `.env`).
- контроллер сопровождения: `--policy-digest --repo <селектор> --checkout <абсолютный checkout>` печатает хеш принятой политики из `origin/main`; рецепт в prompt агента теперь называет канонический checkout, а не полагается на CWD свежего рабочего каталога.
- проверка lockfile больше не считает доверенными произвольные `npm:`-алиасы хоста: поддеревья сеются только от канонических `omp-host-<версия>` из принятого lockfile и от алиаса кандидата.
- независимые чтения GitHub в `observePr` идут одной параллельной группой, поэтому precheck укладывается в 30 секунд; внешняя задержка GitHub по-прежнему завершается отказом, а не обходом гейта.

## [0.3.0](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.3.0) — 2026-10-09

- восстановлены варианты перевода для проверенных исходников нескольких версий OMP; выбор основан на точном пути, хеше исходного текста и платформе.
- снимки README заменены настоящими кадрами `/settings` в изолированном профиле; заявленная установленная проверка по-прежнему ограничена Windows x64 / OMP 18.8.4.
- CI перед тестами готовит закреплённую версию upstream OMP из dev-зависимости; тег выпуска плагина не используется как версия хоста.
- перенос `stable` теперь допускает только обычное продвижение при существующем указателе-предке.
- извлечение исходных метаданных для не-нативных платформ больше не загружает чужой нативный аддон: реестр инициализируется под реальной платформой запуска, а ветка запрошенной платформы берётся из исходников.

релиз v0.3.0 опубликован: тег `v0.3.0` → коммит `2b2bcd1e25b59128b4f5198c4dab46eadd1b3a4f`; архив `omp-settings-ru-0.3.0.tgz` (96371 bytes, sha256 `a6b025dd234ee7abb953188c26b7b7e9827e83d607286c0fab980bfc07bc6588`) и `SHA256SUMS`; ветка `stable` указывает на тот же коммит. exact-SHA CI `check` прогон 37929676487 завершился успешно по всем девяти парам версия/платформа.

## [0.2.0](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.2.0) — 2026-10-07

- обновлённая поддержка OMP 18.8.0: 404 настройки (было 398), +6 новых, 10 изменившихся описаний, 0 удалённых;
- добавлены baseline 18.8.0 для Windows, Linux и macOS; метаданные настроек Linux (`.settings`) эквивалентны Windows, macOS дополнительно содержит вариант `apple` у `spelling.autocomplete`;
- фикстуры доменных тестов и текст отказа обновлены на 18.8.0; smoke штатной панели теперь печатает фактическую версию хоста;
- docs: скриншоты панели из одноразового профиля, faq, русский глоссарий терминов, страница архитектуры;
- гигиена: editorconfig, gitattributes, CODEOWNERS, dependabot для actions, нормы поведения;
- CI: job hygiene с проверкой ссылок и секрет-сканом (gitleaks);
- скрипт `scripts/upgrade-host.ts`: обновляет пины `@oh-my-pi/*`, lockfile, экспортирует baseline новой версии и печатает drift-отчёт в `upgrade-report.md`;
- `.github/workflows/upstream-watch.yml`: ежедневная проверка upstream, при новой версии — PR `upgrade: OMP <version>` с baseline для Windows/Linux/macOS и отчётом;
- `.github/workflows/release.yml`: по тегу `v*` — `bun run check`, архив + `SHA256SUMS`, GitHub Release и сдвиг ветки `stable`;
- поддержка новых версий хоста не заявляется до ручной проверки установленной панели.

### фактически проверено

`bun run check` завершился с exit 0: typecheck, 45 доменных тестов, покрытие 404/404, drift 0, smoke расширения (404 настройки, 5445 мутаций, failureCount 0), smoke штатной панели с печатью реальной версии хоста 18.8.0 и release:check (22 файла, без срабатываний). baseline 18.8.0 подготовлены для Windows, Linux и macOS; метаданные настроек Linux (`.settings`) эквивалентны Windows, darwin добавляет вариант `apple` у `spelling.autocomplete`. фикстуры и текст отказа обновлены на 18.8.0.

не проверено: ручной запуск установленной панели на 18.8.0 (интерактивный TUI) и прогон macOS.

релиз v0.2.0 опубликован: архив `omp-settings-ru-0.2.0.tgz` (89134 bytes) и `SHA256SUMS`; ветка `stable` указывает на коммит тега `98986767a2caea9eb9b1725a0b3f4f2137caaae1`.

## [0.1.0](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.1.0) — 2026-10-06

### исторически проверено в 0.1.0

проверки ниже относятся к выпуску 0.1.0 и сохранены как исторический отчёт.

- отдельное расширение русского перевода штатного `/settings` OMP 18.6.1: 398 настроек, описания, предупреждения и статические варианты.
- `/settings-language ru|en` и выбор без аргументов; язык не сохраняется в конфиг. основной сессии принадлежит перевод; дочерний shutdown его не снимает.
- SHA-256 исходных метаданных, неизвестный/изменившийся источник остаётся английским. безопасный отказ при несовместимости, полный план дескрипторов и восстановление с защитой сторонних изменений.
- незавершённый rollback сохраняет recovery handle; en и main shutdown повторяют восстановление вместо ложного сообщения об успехе.
- динамические клавиши сохраняются через проверенные шаблоны; отображаемые options отделены от общих метаданных команд.
- закреплены Bun 1.3.14, TypeScript 5.9.2 и host baseline 18.6.1; добавлены покрытие/drift, smoke реестра и изолированный smoke штатной панели, CI Windows/Linux.

