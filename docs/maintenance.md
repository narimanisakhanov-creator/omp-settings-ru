# сопровождение: распространение, источники, автоматизация, выпуск

runbook для сопровождающего: эти действия могут скачивать, устанавливать и публиковать.
это не runtime плагина — код перевода работает офлайн на живых метаданных хоста.
границы runtime описаны в [SECURITY.md](../SECURITY.md); участие и проверки — в [CONTRIBUTING.md](../CONTRIBUTING.md); термины — в [glossary.md](glossary.md).

## распространение и auto

`private:true` остаётся: релиз публикуется как GitHub release с архивом и `SHA256SUMS`, публикации в npm registry нет. Каталог marketplace — ассет `marketplace.json` внутри выпуска. `main` — единственная постоянная ветвь; hosted maintenance создаёт только собственную временную `upgrade/omp-<version>` и PR. Runtime перевода сети не получает.

выпуск идёт в два шага. `.github/workflows/release.yml` принимает push тега `vX.Y.Z` и `workflow_dispatch` на tag ref: тег обязателен, annotated tag dereferences в commit, checkout идёт на этот точный SHA с `persist-credentials: false`, `package.json` этого commit обязан совпасть с версией тега. Read-only job без write token прогоняет `bun run check` на нативном хосте и складывает в один artifact архив, `SHA256SUMS`, `marketplace.json` из dereferenced commit (`bun scripts/marketplace-catalog.ts --build --version <version> --commit <sha> --output <file>`) и манифест ассетов. Отдельный privileged job на свежем runner исполняет только код принятого `main`: он проверяет originating run (репозиторий, `.github/workflows/release.yml`, событие, success, tag из `head_branch` и dereferenced SHA), неизменяемый artifact id и attempt, выведенный из самого имени artifact, хеши скачанных байтов и ancestry release commit к `main`, затем создаёт **draft** release. Draft не является `latest`, поэтому каталог нельзя увидеть в отрыве от остальных ассетов.

`.github/workflows/marketplace-index.yml` запускается после release и **дожидается** exact-commit прогона `check` для commit тега — одиночный запрос не годится, потому что тег стартует собственный прогон, а release job завершается раньше. Read-only prepublish job работает без write-capable секрета: `prepublish-source` доказывает успешный release run на точном tag SHA, успех job `draft` текущего attempt и единственный artifact `release-<tag>-<runId>-<attempt>`, причём attempt берётся из имени artifact (частичный rerun privileged job не пересоздаёт build), и для этого attempt доказывается успех job `verify`, затем этот artifact скачивается read-only токеном, а `prepublish` связывает `release.json` с репозиторием, тегом, версией, commit, run и attempt, пересчитывает SHA-256 каждого ассета, требует `archive == SHA256SUMS` и берёт `marketplace.json` из этих байтов. Draft release API в этом job не читается вообще. Нативный host готовится ровно из `package.json` commit тега, `distribution-smoke` прогоняется на proven каталоге **до** продвижения без токена. Только после этого пишется receipt с `releaseState:"draft"`, release run id/attempt, дайджестами и точной host version; отдельный privileged promote job на свежем runner, только с кодом `main` и без запуска candidate/host, проверяет происхождение и artifact, заново сверяет receipt с реальным draft (включая host version из `package.json` тега), вызывает существующий `marketplace-index.ts`, затем доказывает, что `releases/latest` и `latest/download/marketplace.json` отдают каталог этого же commit. Ручной dispatch принимает только `tag` и ref `main`. Повторный прогон после продвижения не падает на «не draft», а проверяет живой выпуск и возвращает `identical`.

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

## обновление источников

1. Зафиксируй точную стабильную upstream-версию и commit. `bun scripts/upgrade-host.ts <version> --dry-run` не меняет checkout; без `--dry-run` это ручной maintainer-инструмент. Hosted pipeline работает от принятого `main`.
2. просмотри пины разработки, lockfile, снимки в `test/fixtures/host-snapshots/` и `upgrade-report.md`. скрипт использует сеть; peer-диапазон и исторические алиасы автоматически не расширяет. снимки пишутся в канонический каталог `test/fixtures/host-snapshots/`; `baseline/` в checkout — локальная копия, которую Git игнорирует, и обновлять её вместо канонической нельзя.
3. экспортируй точную пару версии/платформы из матрицы. `--output` записывает снимок без полей происхождения, поэтому отдельно сохрани stdout экспорта:

```text
bun run source:export 18.8.4 win32
bun run source:export 18.8.4 win32 --output test/fixtures/host-snapshots/18.8.4-win32.json
```

4. сравни источник с предыдущим снимком до принятия экспорта: added/removed/changed требуют ревью. перезапись снимка не должна скрывать изменение английского текста; `sha256` в `supported-hosts.json` обновляется тем же шагом.

5. повтори проверку для каждой записи матрицы. `native-package-registry` означает реестр пакета на текущей ОС; `source-derived` — извлечённые платформенные ветки. оба статуса отличаются от установленной панели.

### экспорт матрицы из исходников

Перед переключением `process.platform` worker заранее загружает реальные экземпляры `@oh-my-pi/pi-utils`, разрешённые из каталога реестра и каталога worker: модуль `env` вычисляет каталог проекта при инициализации и на Windows может вызывать нативный helper длинных путей. Сохраняй статус `source-derived`; проверяй каждый экспорт версии/платформы полным сравнением с каноническим снимком, включая `sourceHash`. Это не доказательство работы установленной панели.

## автоматизация сопровождения

`.github/workflows/upstream-watch.yml` выполняет hosted pipeline: discover, prepare, translate, verify, publish-candidate и finalize. Prepare/verify работают на свежих secret-free runners; model secret доступен только translate, scoped maintenance PAT — только publish/finalize.

Prepare создаёт disposable worktree от точного accepted base, запускает trusted upgrade/export и сохраняет snapshots, bounded JSON manifest и hashes. Verify принимает только allowlisted data, создаёт candidate commit, ancestry-bound git bundle и patch. Publish повторно проверяет origin, run/attempt, schema, paths, hashes и ancestry перед созданием или возобновлением owned `upgrade/omp-<version>` PR.

Finalize ждёт exact-head checks полной матрицы и hygiene, блокирует base drift, выполняет merge с match-head и создаёт `v<releaseVersion>` на проверенном merge SHA. Версия плагина — следующий minor с patch=0, не upstream version. Existing owned PR/branch/tag/release возобновляются после проверки identity; force push и исполнение candidate-кода в privileged jobs запрещены.

Recovery publisher-run требует точный release SHA и успешный release-run на exact tag/SHA. Manual `marketplace-index` dispatch на `main` сопоставляется по workflow/event/SHA, а доступные tag input или version-bearing display title дополнительно сверяются; pending/failed run наблюдается или повторяется, а не создаёт новый dispatch.

`scripts/maintenance.ts` — ручной pinned updater, не orchestration path.

`.github/dependabot.yml` держит `open-pull-requests-limit: 0`, поэтому обновления запиненных actions вносятся руками и `dependabot/*` ветки не появляются.

`scripts/maintenance.ts` — ручной pinned updater, а не PR-контроллер. Он принимает подготовленный pin и архив, проверяет активацию и возвращает receipt:

```text
bun scripts/maintenance.ts --pin <release-pin.json> --package <archive.tgz> --state-dir <dir> --executable <omp> [--activate --accepted --profile <name>]
```

`--activate` ручного обновлятора требует явного `--accepted` и named `--profile`; иначе отказ до действий. Обновлятор не создаёт веток и не пишет ref. Секция `controller` в `maintenance.config.json` сохраняет identity/base/branch/allowlist/check/deadline policy; trusted команды читают её из принятого `origin/main`.

### настройка hosted pipeline

Владелец задаёт Secrets `MAINTENANCE_API_KEY`, `MAINTENANCE_GH_TOKEN` и Variables `MAINTENANCE_BASE_URL`, `MAINTENANCE_MODEL`. API — OpenAI-compatible HTTPS root (включая `/v1`, если нужен провайдеру). Translation step делает отдельные stateless translator/reviewer запросы, не запускает subprocess и не получает GitHub token. Ни один другой step не получает model key.

Fine-grained PAT принадлежит закреплённому `controllerLogin` типа User и ограничен этим репозиторием: Contents RW, Pull requests RW, Actions RW, Checks Read. Он доступен только publish/finalize; git использует временный askpass вне checkout, gh получает token только в собственном env. Checkout всегда `persist-credentials: false`.

Cron `17 6 * * *` и manual dispatch принимают только точную стабильную версию. Manual ref не main не допускается к secret jobs. `discover` read-only сначала ищет незавершённый собственный выпуск, затем registry latest и возвращает `no-work|prepare|resume|blocked`. `no-work` не вызывает модель и не мутирует GitHub. Артефакт `maintenance-<hostVersion>-<runId>-<runAttempt>` проверяется по originating workflow/run/attempt; собственные hashes не являются аутентификацией.

Production dispatch требует отдельного разрешения. Локальные тесты не подтверждают настройку secrets или публичный выпуск. Внешний Orca в `smoke-installed-host.ts` — отдельный ручной PTY smoke, не orchestration path.

Измерители выполняются из временного доверенного корня: код/конфигурация — принятые байты, зависимости — независимо пересчитанный lock с `--frozen-lockfile --ignore-scripts`. Из candidate читаются только JSON-данные и snapshots; исторические identity/translation hashes сохраняются и вся матрица измеряется заново.


### привязка смыслового ревью

`validateSemantic(evidence, policy, proof?)` принимает доверенный `ReviewProofContext` отдельно от каталога и отчёта: `runId`, `runAttempt` и `artifacts: ReadonlyMap<string, ReviewContentArtifact>`. Ключ — точный `${path}:${sourceHash}`. Значение содержит точную строку sanitized reviewer content в `bytes` (хешируются UTF-8 байты без нормализации) либо `sha256`, независимо вычисленный доверенным загрузчиком по этим байтам. Если переданы оба поля, они обязаны совпасть. Нельзя получать artifact digest из `ReviewRow.evidence` или хешировать содержащий эту строку report JSON.

Для новой identity или platform extension `reviewTask` точно равен `${runId}:${runAttempt}`, `evidence` — SHA-256 фактического reviewer content. Hosted verify/publish заново хешируют response bytes и передают `ReviewProofContext` отдельно от candidate rows. Неполный context, чужой run/attempt или изменённые bytes блокируют gate; исторические исключения не расширяются.

## выпуск

1. Версия плагина увеличивается отдельно от версии хоста: hosted pipeline готовит следующий minor через проверенный PR; ручной выпуск остаётся maintainer-операцией.
2. Перед фиксацией номера проверь, что версия `package.json`, соответствующий заголовок `CHANGELOG.md`, установочная команда и незанятый Git tag согласованы. release.yml берёт release notes из заголовка `## <version>` в `CHANGELOG.md`.
3. Получи independent review; на финальном состоянии пройди `bun run check`, `npm pack --dry-run --json --ignore-scripts`, `bun run release:check` и полный exact-SHA GitHub CI.
4. Проверь публичные тексты, release notes, reachable Git history, PNG и итоговый пакет pinned secret scanner-ом; ограниченный поиск паттернов не гарантирует обнаружение любого секрета.
5. Убедись, что smoke проверил установку и удаление точного выпускаемого артефакта в одноразовом профиле; никогда не меняй произвольный личный профиль.
6. Не переписывай существующие теги и не применяй force push. Тег `v<version>` на `main` создаёт draft release; канал продвигается только workflow-ом после успешного exact-commit `check`, и вручную ничего пушить не нужно. Повторный запуск release workflow догружает только отсутствующие ассеты того же draft; совпавшие не перезаписываются, а несовпавшие или уже опубликованные блокируют выпуск. Незавершённый marketplace-index повторяется через `gh run rerun <id> --failed`; если прогона нет, dispatch идёт на `main` с input `tag`, а release — только на tag ref (`gh workflow run release.yml --ref v<version>`), без input версии.
7. После продвижения проверь GitHub Release, три ассета (архив, `SHA256SUMS`, `marketplace.json`), SHA-256 и доступность точной install-команды; отдельно проверь, что URL каталога отдаёт `marketplace.json`. Сумма рядом с архивом подтверждает совпадение, не независимую подпись.

внешние инструменты сопровождения используют сеть; runtime перевода — нет.
не переносить в runtime Stats, PATH-установщики, autocomplete или чтение сессий.
уязвимости — по [SECURITY.md](../SECURITY.md).
