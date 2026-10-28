# сопровождение: распространение, источники, автоматизация, выпуск

runbook для сопровождающего: эти действия могут скачивать, устанавливать и публиковать.
это не runtime плагина — код перевода работает офлайн на живых метаданных хоста.
границы runtime описаны в [SECURITY.md](../SECURITY.md); участие и проверки — в [CONTRIBUTING.md](../CONTRIBUTING.md); термины — в [glossary.md](glossary.md).

## распространение и auto

`private:true` остаётся: релиз публикуется как GitHub release с архивом и `SHA256SUMS`, публикации в npm registry нет. Каталог marketplace — ассет `marketplace.json` внутри выпуска. `main` — единственная постоянная ветвь; hosted maintenance создаёт только собственную временную `upgrade/omp-<version>` и PR. Runtime перевода сети не получает.

выпуск идёт в два шага. `.github/workflows/release.yml` принимает push тега `vX.Y.Z` и `workflow_dispatch` на tag ref: тег обязателен, annotated tag dereferences в commit, checkout идёт на этот точный SHA с `persist-credentials: false`, `package.json` этого commit обязан совпасть с версией тега. Read-only job без write token прогоняет `bun run check` на нативном хосте и складывает в один artifact архив, `SHA256SUMS`, `marketplace.json` из dereferenced commit (`bun scripts/marketplace-catalog.ts --build --version <version> --commit <sha> --output <file>`) и манифест ассетов. Отдельный privileged job на свежем runner исполняет только код принятого `main`: он проверяет originating run (репозиторий, `.github/workflows/release.yml`, событие, success, tag из `head_branch` и dereferenced SHA), неизменяемый artifact id и attempt, выведенный из самого имени artifact, хеши скачанных байтов и ancestry release commit к `main`, затем создаёт **draft** release. Draft не является `latest`, поэтому каталог нельзя увидеть в отрыве от остальных ассетов.

`.github/workflows/marketplace-index.yml` запускается после release и дожидается успешного exact-commit прогона `check` для merge/main SHA, который доказал принятие изменений; `check.yml` не запускается на тегах, поэтому tag check не является отдельным required gate. Read-only prepublish job работает без write-capable секрета: `prepublish-source` доказывает успешный release run на точном tag SHA, успех job `draft` текущего attempt и единственный artifact, после чего prepublish связывает `release.json` с репозиторием, тегом, версией, commit, run и attempt и пересчитывает hashes.

проверка каталога и канала:

```text
bun scripts/marketplace-catalog.ts --validate --tag v<version> --check-run <run-id> --catalog <downloaded marketplace.json>
bun scripts/marketplace-catalog.ts --served
bun scripts/marketplace-catalog.ts --wait-check-run --tag v<version> --timeout-ms 1800000
bun scripts/marketplace-catalog.ts --generate --tag v<version> --check-run <run-id> --output <catalog.json>
```

`--validate` сверяет каталог с живым выпуском, `--served` печатает identity обслуженного канала, `--wait-check-run` ждёт прогон, `--generate` собирает каталог из живого выпуска. Команда dereferences annotated tag, скачивает archive/`SHA256SUMS` и сверяет hashes; рукописный файл каталога так не публикуется.

prepublication proof без чтения draft API (read-only токен):

```text
bun scripts/release-actions.ts prepublish-source --tag v<version> --repository <owner/repo> --checkout .
gh run download <releaseRunId> --repo <owner/repo> --name <artifactName> --dir <download-dir>
bun scripts/release-actions.ts prepublish --tag v<version> --repository <owner/repo> --checkout . --assets <download-dir> --run-id <releaseRunId> --run-attempt <releaseRunAttempt> --artifact-name <artifactName> --output <absolute-dir> --timeout-ms 1800000
```

`prepublish-source` печатает JSON `{tag, releaseRunId, releaseRunAttempt, tagSha, artifactName, hostVersion}` и пишет те же значения в `GITHUB_OUTPUT`; `releaseRunAttempt` — attempt, вписанный в имя artifact (не обязательно текущий attempt run). `prepublish` требует, чтобы `--run-attempt` совпал с именем artifact, и без `--assets` из этого artifact публикация не продвигается.

переход уже установленных пользователей со старого каталога — `plugin marketplace remove <name>`, затем `add <новый URL>` и `plugin marketplace update <name>`: состояние (enabled, features, settings, install record) сохраняется. Повторный `add` того же имени отклоняется, а `uninstall` ради перехода стирает собственные settings/features и потому не годится.

`bun run smoke:distribution --catalog <verified-catalog.json>` ставит настоящий выпуск нативным marketplace-каналом, проверяет русскую панель и отказ по неверному SHA с сохранением установленной identity/state; legacy npm-копия создаётся только как предусловие отказа от коллизии и одностороннего перехода npm → marketplace с сохранением `null` и `[]` features, после чего прогоняет `off/notify/auto` на stale каталоге с двумя настоящими выпусками и вторым fixture-плагином. `bun run smoke:source` проверяет именно текущий checkout: собирает package allowlist в реальный локальный Git-репозиторий, ставит его нативным marketplace-каналом и сверяет content hash, затем открывает русскую панель. Оба — channel proof, отдельный от старого link-based `smoke:installed`; сетевые ошибки git-транспорта сообщаются как `network-transport-failed` с сохранённым backup, а не как дефект канала.

## обновление источников и rolling-окно

1. Зафиксируй точную стабильную upstream-версию и commit. `bun scripts/upgrade-host.ts <version> --dry-run` не меняет checkout; без `--dry-run` это ручной maintainer-инструмент. Hosted pipeline работает от принятого `main` и выбирает следующую отсутствующую версию из трёх последних stable npm-версий.
2. `versions` в `supported-hosts.json` — ровно активное окно (не более трёх версий, числовой порядок); `historical` — неизменяемый архив прежних rows и snapshots. История не входит в devDependencies, peer range или native CI jobs, но участвует в проверке marker/catalog identity. Не удаляй historical snapshots и не меняй их bytes, hashes или translation identities.
3. Поддержка догоняется последовательно: один upstream-кандидат за цикл, без перескока через отсутствующую версию и без публикации будущего окна в README. `completeSupport` добавляет кандидата, оставляет три последних active rows, переносит точный overflow в `historical` и удаляет только соответствующие exact aliases. `upgrade-host.ts` подготавливает pin/snapshots, но не выполняет ротацию.
4. просмотри пины разработки, lockfile, снимки в `test/fixtures/host-snapshots/` и `upgrade-report.md`. скрипт использует сеть; peer-диапазон и исторические алиасы автоматически не расширяет. снимки пишутся в канонический каталог `test/fixtures/host-snapshots/`; `baseline/` в checkout — локальная копия, которую Git игнорирует, и обновлять её вместо канонической нельзя.
5. экспортируй точную пару версии/платформы из матрицы. `--output` записывает снимок без полей происхождения, поэтому отдельно сохрани stdout экспорта:

```text
bun run source:export 18.8.4 win32
bun run source:export 18.8.4 win32 --output test/fixtures/host-snapshots/18.8.4-win32.json
```

6. сравни источник с предыдущим снимком до принятия экспорта: added/removed/changed требуют ручного ревью. перезапись снимка не должна скрывать изменение английского текста; `sha256` в `supported-hosts.json` обновляется тем же шагом.

7. повтори проверку для каждой active записи матрицы. `native-package-registry` означает реестр пакета на текущей ОС; `source-derived` — извлечённые платформенные ветки. оба статуса отличаются от установленной панели.

### экспорт матрицы из исходников

Перед переключением `process.platform` worker заранее загружает реальные экземпляры `@oh-my-pi/pi-utils`, разрешённые из каталога реестра и каталога worker: модуль `env` вычисляет каталог проекта при инициализации и на Windows может вызывать нативный helper длинных путей. Сохраняй статус `source-derived`; проверяй каждый экспорт версии/платформы полным сравнением с каноническим снимком, включая `sourceHash`. Это не доказательство работы установленной панели.

## автоматизация сопровождения

`.github/workflows/upstream-watch.yml` выполняет hosted pipeline: discover, prepare, translate, verify, publish-candidate и finalize. Prepare/verify работают на свежих secret-free runners; model secret доступен только translate, scoped maintenance PAT — только publish/finalize.

Prepare создаёт disposable worktree от точного accepted base, запускает trusted upgrade/export и сохраняет snapshots, bounded JSON manifest и hashes. Verify принимает только allowlisted data, создаёт candidate commit, ancestry-bound git bundle и patch. Publish повторно проверяет origin, run/attempt, schema, paths, hashes и ancestry перед созданием или возобновлением owned `upgrade/omp-<version>` PR.

Активное окно измеряется только по `versions` после ротации; historical snapshots остаются для identity, marker provenance и catalog delta, но не расширяют CI. Verify пишет управляемый README-блок только из измеренных active pairs, без live registry queue. Последовательная догонка описывает цель окна отдельно от уже доказанной поддержки.

Finalize ждёт exact-head checks полной active-матрицы, `shared` и `hygiene`, блокирует base drift, выполняет merge с match-head и создаёт `v<releaseVersion>` на проверенном merge SHA. После merge требуется новый успешный push `check.yml` на exact merge SHA; check кандидата не заменяет merge proof. `check.yml` не имеет tag trigger, поэтому release/catalog не требуют отдельного tag check.

Recovery publisher-run принимает `workflow_run` и manual dispatch на `main` только по prepublish artifact: неизменяемое имя задаёт производящий attempt, успешный `prepublish` job этого attempt и sealed receipt связывают репозиторий, tag и SHA с успешным release run. Promote-only rerun использует прежний artifact, но лимит повторов остаётся на текущем `run_attempt` того же run id. REST inputs не требуются; exact display title — лишь запрет дублирующего dispatch (включая pending/requested), не publication proof. Неизвестная привязка ожидается до deadline, а не заменяется новым run.

Для failed/cancelled check допускается только `gh run rerun <id> --failed`, максимум два повтора одного run (attempt 3 — блокировка). Required set берётся только из выбранного exact run id, ветки и текущего workflow attempt; authoritative `jobs?filter=latest` может включать успешные jobs прежнего attempt, чей собственный attempt сохраняется отдельно. Job-набор не собирается из разных runs одного SHA. Каждый фактически наблюдённый новый run/attempt получает свой 40-минутный deadline; отправка POST его не продлевает. Принятый POST и already-running отказ одинаково ожидают новый attempt до 60 секунд, без второго POST; отсутствие attempt блокирует. Action-required, permissions, missing workflow и skipped/neutral required job не обходятся. Это повтор неизменных bytes, не обход semantic/content gates.

Каждый цикл после выбора точной версии сохраняет `maintenance-selection-<version>-<runId>-<attempt>` и bounded `maintenance-outcome-<runId>-<attempt>` (90 дней). Discover читает только completed attempts `upstream-watch.yml` того же репозитория, accepted base и `main`, проверяет exact имя, origin, срок хранения и JSON; prepared/translated bundles не скачиваются для этой проверки. Отсутствующий или истёкший outcome выбранного цикла — `maintenance-outcome-unavailable`, не разрешение повторить модель. При сбое загрузки selection факт выбора восстанавливается из имени шага jobs API.

Nonretryable failure блокирует новую подготовку сразу; два подтверждённых retryable failed cycles — тоже блокировка. Retryable — только typed timeout/HTTP 429/5xx либо доказанное отсутствие companion/native asset, не произвольный `trusted-command-failed`. Ручной `workflow_dispatch` с `retry_blocked=true` явно начинает новый durable preparation budget (`retryBlocked:true` в outcome); schedule его не задаёт, CI `run_attempt` budget не сбрасывается. Новый accepted base начинает отдельную историю. Сборщик outcome работает `always()` на trusted main без model/write secrets, получает только sanitized CLI reason/retryable и job results: cancellation/timeouts — blocked, retirement не выдаётся за release. Raw stderr translate не копируется в artifacts.

`scripts/maintenance.ts` — ручной pinned updater, не orchestration path.

`.github/dependabot.yml` держит `open-pull-requests-limit: 0`, поэтому обновления запиненных actions вносятся руками и `dependabot/*` ветки не появляются.

`scripts/maintenance.ts` — ручной pinned updater, а не PR-контроллер. Он принимает подготовленный pin и архив, проверяет активацию и возвращает receipt:

```text
bun scripts/maintenance.ts --pin <release-pin.json> --package <archive.tgz> --state-dir <dir> --executable <omp> [--activate --accepted --profile <name>]
```

`--activate` ручного обновлятора требует явного `--accepted` и named `--profile`; иначе отказ до действий. Обновлятор не создаёт веток и не пишет ref. Секция `controller` в `maintenance.config.json` сохраняет identity/base/branch/allowlist/check/deadline policy; trusted команды читают её из принятого `origin/main`.

### настройка hosted pipeline

Владелец задаёт Secrets `MAINTENANCE_API_KEY`, `MAINTENANCE_GH_TOKEN` и Variables `MAINTENANCE_BASE_URL`, `MAINTENANCE_MODEL`. API — OpenAI-compatible HTTPS root (включая `/v1`, если нужен провайдеру). Translation step делает только stateless translator-запросы, не запускает subprocess и не получает GitHub token. Independent reviewer не вызывается вовсе: второй модели, verdict и comparison в pipeline нет. Ни один другой step не получает model key. Verify получает read-only `GITHUB_TOKEN` только для metadata публичного OMP release; candidate subprocess запускаются через `secretFreeEnvironment` и этого токена не видят.

Fine-grained PAT принадлежит закреплённому `controllerLogin` типа User и ограничен этим репозиторием: Contents RW, Pull requests RW, Actions RW, Checks Read. Он доступен только publish/finalize; git использует временный askpass вне checkout, gh получает token только в собственном env. Checkout всегда `persist-credentials: false`.

Cron `17 6 * * *` и manual dispatch без `version` запускают read-only `discover`, который выбирает очередного отсутствующего участника целевого окна. Явный `version` разрешён только если он равен следующему кандидату; иначе возвращается `requested-version-not-next`. Manual ref не main не допускается к secret jobs. `discover` сначала ищет незавершённый собственный выпуск, затем registry window и возвращает `no-work|prepare|resume|blocked`. `no-work` не вызывает модель и не мутирует GitHub. Артефакт `maintenance-<hostVersion>-<runId>-<runAttempt>` проверяется по originating workflow/run/attempt; собственные hashes не являются аутентификацией.

Production dispatch требует отдельного разрешения. Локальные тесты не подтверждают настройку secrets или публичный выпуск. Внешний Orca в `smoke-installed-host.ts` — отдельный ручной PTY smoke, не orchestration path.

Измерители выполняются из временного доверенного корня: код/конфигурация — принятые байты, зависимости — независимо пересчитанный lock с `--frozen-lockfile --ignore-scripts`. Из candidate читаются только JSON-данные и snapshots; исторические identity/translation hashes сохраняются и вся матрица измеряется заново.

### локальная почасовая проверка (Windows)

`scripts/maintenance-watch.ps1` — необязательный локальный инициатор: он не выпускает и не публикует, а решает, есть ли у hosted pipeline работа, и один раз вызывает `gh workflow run upstream-watch.yml --repo <owner/repo> --ref main` **без** input версии. Выбор версии, prepare/translate/verify/publish остаются hosted: локальный тик не пишет releaseVersion, не делает rerun/merge/tag и не читает модель.

Тик (`-Once`, режим по умолчанию) по порядку: named mutex `Local\omp-settings-ru-maintenance` (занят — выход 0, abandoned принимается), `gh auth status` из credential store текущего пользователя, состояние workflow и repository variable `MAINTENANCE_PAUSED` (отсутствие = `false`, `true` = пауза, иное значение — `maintenance-pause-invalid`, недоступный список — `maintenance-pause-unreadable`), активный run (queued/in_progress/waiting/pending/requested), затем `main`, `package.json`, `supported-hosts.json` и npm packument. Окно считается теми же правилами, что hosted selector (три максимальные stable, prerelease исключён, `dist-tags.latest` не расширяет окно). `no-work` требует одновременно: ни одного незавершённого owned `upgrade/omp-*` (включая merged-unreleased), active `versions` совпадают с окном реестра, pin `devDependencies["@oh-my-pi/pi-coding-agent"]` равен старшей версии окна. Иначе — один dispatch.

Повторные POST запрещены: перед dispatch атомарно пишется intent, 60-минутный cooldown применяется к последнему run, intent и dispatch, а при неопределённом ответе (`dispatch-uncertain`) второй POST в этом тике не отправляется. `MAINTENANCE_GH_TOKEN` в окружении отвергается: локальный тик использует только пользовательский credential store. `-DryRun` делает лишь GET и не пишет state/log/task; `-Status` печатает локальный state и состояние задачи без сетевых записей. Любая ошибка чтения GitHub/registry — код ошибки и exit 1, а не пустой список и не `no-work`.

Runtime-копия, `config.json`, `state.json` и JSONL-журнал живут в `%LOCALAPPDATA%\omp-settings-ru\maintenance`; журнал ротируется при 1 MiB в один backup. Изменяемый checkout из задачи не исполняется, git pull/reset в рабочем дереве не выполняется, Bun для тика не нужен.

`scripts/install-maintenance-watch.ps1` регистрирует задачу `omp-settings-ru-upstream-watch` только если принятый `main` содержит те же байты watcher: absolute пути `gh`/`powershell` разрешаются при установке, runtime-копия обновляется только установщиком. Задача работает от текущего пользователя (Interactive/Limited, без пароля и SYSTEM), hourly repetition 1h, `StartWhenAvailable`, `MultipleInstances=IgnoreNew`, лимит 10 минут, без пробуждения ПК и без изменения ExecutionPolicy. Задача с тем же именем, но другим action/account/run level — `scheduled-task-ownership-conflict`, а не перезапись. `-Uninstall` удаляет только задачу и сохраняет state/журнал; `-WhatIf` печатает план и ничего не меняет.

Один локальный тик и ежедневный GitHub schedule не заменяют друг друга: при выключенном компьютере работает cron `17 6 * * *`, а общий выключатель обоих инициаторов — `MAINTENANCE_PAUSED`, не локальный файл. Параллельные тики ограничены mutex-ом, гонка с hosted concurrency разрешается hosted `discover` (no-work/resume), поэтому дублирующий dispatch безопасен, но не создаёт второго кандидата.


### смысловое ревью отключено

`semanticReview: "disabled"` фиксируется в `candidate.json`, `proof.json` и `src/translations/variant-review.json`: independent reviewer не вызывается, поэтому для новых identity и platform extension нет reviewer verdict, `comparison` и response bytes.

Для новых вариантов строка ревью не создаётся: в режиме `disabled` `verifyVariantReviews` пропускает только `unreviewed-*` для новых вариантов, а остальные проверки сохраняются — строгая схема `variant-review.json`, `translationFieldsHash`, platform/`observedIn` provenance, исторические identity и точные hashes. Исторические строки `independently-confirmed` не переписываются: они сверяются с неизменяемой историей и сохраняют `comparison`, `reviewTask` и `evidence`. Смысловая ошибка нового перевода автоматическим gate не ловится — это принятое ограничение; технические литералы, strict JSON, hashes и native smoke остаются обязательными.

## выпуск

1. Версия плагина увеличивается отдельно от версии хоста: hosted pipeline готовит следующий minor через проверенный PR; ручной выпуск остаётся maintainer-операцией.
2. Перед фиксацией номера проверь, что версия `package.json`, соответствующий заголовок `CHANGELOG.md`, установочная команда и незанятый Git tag согласованы. release.yml берёт release notes из заголовка `## <version>` в `CHANGELOG.md`.
3. Получи независимое ревью выпуска человеком или отдельным агентом (semantic reviewer отключён); на финальном состоянии пройди `bun run check`, `npm pack --dry-run --json --ignore-scripts`, `bun run release:check` и полный exact-SHA GitHub CI.
4. Проверь публичные тексты, release notes, reachable Git history, PNG и итоговый пакет pinned secret scanner-ом; ограниченный поиск паттернов не гарантирует обнаружение любого секрета.
5. Убедись, что smoke проверил установку и удаление точного выпускаемого артефакта в одноразовом профиле; никогда не меняй произвольный личный профиль.
6. Не переписывай существующие теги и не применяй force push. Тег `v<version>` на `main` создаёт draft release; канал продвигается только workflow-ом после успешного exact-commit `check`, и вручную ничего пушить не нужно. Повторный запуск release workflow догружает только отсутствующие ассеты того же draft; совпавшие не перезаписываются, а несовпавшие или уже опубликованные блокируют выпуск. Незавершённый marketplace-index повторяется через `gh run rerun <id> --failed`; если прогона нет, dispatch идёт на `main` с input `tag`, а release — только на tag ref (`gh workflow run release.yml --ref v<version>`), без input версии.
7. После продвижения проверь GitHub Release, три ассета (архив, `SHA256SUMS`, `marketplace.json`), SHA-256 и доступность точной install-команды; отдельно проверь, что URL каталога отдаёт `marketplace.json`. Сумма рядом с архивом подтверждает совпадение, не независимую подпись.

внешние инструменты сопровождения используют сеть; runtime перевода — нет.
не переносить в runtime Stats, PATH-установщики, autocomplete или чтение сессий.
уязвимости — по [SECURITY.md](../SECURITY.md).
