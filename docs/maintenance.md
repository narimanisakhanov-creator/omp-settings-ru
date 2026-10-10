# сопровождение: распространение, источники, автоматизация, выпуск

runbook для сопровождающего: эти действия могут скачивать, устанавливать и публиковать.
это не runtime плагина — код перевода работает офлайн на живых метаданных хоста.
границы runtime описаны в [SECURITY.md](../SECURITY.md); участие и проверки — в [CONTRIBUTING.md](../CONTRIBUTING.md); термины — в [glossary.md](glossary.md).

## распространение и auto

`private:true` остаётся: npm-managed использует GitHub release, npm registry publication отсутствует. каталог marketplace — ассет `marketplace.json` внутри выпуска, а не ветка; `main` — единственная публичная ветка, и ни один workflow не пишет ref и не открывает PR. `marketplace.autoUpdate` — штатный общий переключатель OMP; `auto` не проверяет project ReleasePin/наши receipts. Runtime перевода сети не получает.

выпуск идёт в два шага. `.github/workflows/release.yml` по тегу `v*` прогоняет `bun run check` на нативном хосте и создаёт **draft** release с архивом, `SHA256SUMS` и `marketplace.json`, собранным из dereferenced commit тега (`bun scripts/marketplace-catalog.ts --build --version <version> --commit <sha> --output <file>`). draft не является `latest`, поэтому каталог нельзя увидеть в отрыве от остальных ассетов.

`.github/workflows/marketplace-index.yml` запускается после release и **дожидается** exact-commit прогона `check` для commit тега — одиночный запрос не годится, потому что тег стартует собственный прогон, а release job завершается раньше. Затем он скачивает каждый ассет draft через authenticated API и пересчитывает digest локально, читает обслуженный канал (`releases/latest`) и применяет monotonic-правило, после чего продвигает draft и повторно проверяет уже опубликованный выпуск. Ручной dispatch принимает только `tag`. Повторный прогон после продвижения не падает на «не draft», а проверяет живой выпуск и возвращает `identical`.

проверка каталога и канала:

```text
bun scripts/marketplace-catalog.ts --validate --tag v<version> --check-run <run-id> --catalog <downloaded marketplace.json>
bun scripts/marketplace-catalog.ts --served
bun scripts/marketplace-catalog.ts --wait-check-run --tag v<version> --timeout-ms 1800000
bun scripts/marketplace-catalog.ts --generate --tag v<version> --check-run <run-id> --output <catalog.json>
```

`--validate` сверяет каталог с живым выпуском, `--served` печатает identity обслуженного канала, `--wait-check-run` ждёт прогон, `--generate` собирает каталог из живого выпуска. Команда dereferences annotated tag, скачивает archive/`SHA256SUMS` и сверяет hashes; рукописный файл каталога так не публикуется.

переход уже установленных пользователей со старого каталога — `plugin marketplace remove <name>`, затем `add <новый URL>` и `plugin marketplace update <name>`: состояние (enabled, features, settings, install record) сохраняется. Повторный `add` того же имени отклоняется, а `uninstall` ради перехода стирает собственные settings/features и потому не годится.

`bun run smoke:distribution --catalog <verified-catalog.json>` устанавливает настоящий npm-managed GitHub выпуск, добавляет owned каталог, прогоняет обе миграции канала, обычный native startup и `off/notify/auto` на stale каталоге с двумя настоящими выпусками и вторым fixture-плагином. `bun run smoke:source` проверяет именно текущий checkout: собирает package allowlist в реальный локальный Git-репозиторий, ставит его нативным marketplace-каналом и сверяет content hash, затем открывает русскую панель. Оба — channel proof, отдельный от старого link-based `smoke:installed`; сетевые ошибки git-транспорта сообщаются как `network-transport-failed` с сохранённым backup, а не как дефект канала.

## обновление источников

1. зафиксируй точную версию upstream и commit. начни с `bun scripts/upgrade-host.ts <version> --dry-run`; режим без `--dry-run` меняет рабочий checkout, поэтому выполняй его после ревью и коммить результат на `main` — отдельных веток репозиторий не держит.
2. просмотри пины разработки, lockfile, baseline и `upgrade-report.md`. скрипт использует сеть; peer-диапазон и исторические алиасы автоматически не расширяет.
3. экспортируй точную пару версии/платформы из матрицы. `--output` записывает baseline без полей происхождения, поэтому отдельно сохрани stdout экспорта:

```text
bun run source:export 18.8.4 win32
bun run source:export 18.8.4 win32 --output baseline/18.8.4-win32.json
```

4. сравни источник с предыдущим baseline до принятия экспорта: added/removed/changed требуют ревью. перезапись baseline не должна скрывать изменение английского текста.

5. повтори проверку для каждой записи матрицы. `native-package-registry` означает реестр пакета на текущей ОС; `source-derived` — извлечённые платформенные ветки. оба статуса отличаются от установленной панели.

### экспорт матрицы из исходников

Перед переключением `process.platform` worker заранее загружает реальные экземпляры `@oh-my-pi/pi-utils`, разрешённые из каталога реестра и каталога worker: модуль `env` вычисляет каталог проекта при инициализации и на Windows может вызывать нативный helper длинных путей. Сохраняй статус `source-derived`; проверяй каждый экспорт версии/платформы полным сравнением с baseline, включая `sourceHash`. Это не доказательство работы установленной панели.

## автоматизация сопровождения

`.github/workflows/upstream-watch.yml` раз в сутки читает `dist-tags.latest` реестра `@oh-my-pi/pi-coding-agent` и, если версия не совпадает с пином в `package.json`, **только осматривает** кандидата: ставит пакеты, прогоняет `bun scripts/upgrade-host.ts <version>`, готовит нативный хост и печатает отчёт в step summary. Ветки и PR он не создаёт: результат лежит в артефакте прогона `upgrade-candidate-<version>`, а применяет его сопровождающий вручную по инструкции из summary.

`.github/dependabot.yml` держит `open-pull-requests-limit: 0`, поэтому обновления запиненных actions вносятся руками и `dependabot/*` ветки не появляются.

`scripts/maintenance.ts` — ручной pinned updater, а не PR-контроллер. Он принимает подготовленный pin и архив, проверяет активацию и возвращает receipt:

```text
bun scripts/maintenance.ts --pin <release-pin.json> --package <archive.tgz> --state-dir <dir> --executable <omp> [--activate --accepted --profile <name>]
```

`--activate` требует и явного `--accepted`, и named `--profile`; без них команда отказывается работать. Модуль не создаёт веток, не открывает PR и не пишет ни в один ref. Контроллер upgrade-веток (`scripts/maintenance/github.ts`, `orca.ts`, `state.ts`, `automation.ts` и его тест) удалён вместе с PR-моделью; `maintenance.config.json` теперь содержит только `schemaVersion`, `repository` и `requiredCheckPlatforms` для `scripts/check-matrix.ts`. Проверка upstream-кандидата не заменяет ручную проверку установленной панели.

## выпуск

1. Этот проект выпускает minor-релизы вручную: автоматика только осматривает upstream-кандидата (см. выше) и не выпускает новую версию плагина.
2. Перед фиксацией номера проверь, что версия `package.json`, соответствующий заголовок `CHANGELOG.md`, установочная команда и незанятый Git tag согласованы. release.yml берёт release notes из заголовка `## <version>` в `CHANGELOG.md`.
3. Получи independent review; на финальном состоянии пройди `bun run check`, `npm pack --dry-run --json --ignore-scripts`, `bun run release:check` и полный exact-SHA GitHub CI.
4. Проверь публичные тексты, release notes, reachable Git history, PNG и итоговый пакет pinned secret scanner-ом; ограниченный поиск паттернов не гарантирует обнаружение любого секрета.
5. Убедись, что smoke проверил установку и удаление точного выпускаемого артефакта в одноразовом профиле; никогда не меняй произвольный личный профиль.
6. Не переписывай существующие теги и не применяй force push. Тег `v<version>` на `main` создаёт draft release; канал продвигается только workflow-ом после успешного exact-commit `check`, и вручную ничего пушить не нужно.
7. После продвижения проверь GitHub Release, три ассета (архив, `SHA256SUMS`, `marketplace.json`), SHA-256 и доступность точной install-команды; отдельно проверь, что URL каталога отдаёт `marketplace.json`. Сумма рядом с архивом подтверждает совпадение, не независимую подпись.

внешние инструменты сопровождения используют сеть; runtime перевода — нет.
не переносить в runtime Stats, PATH-установщики, autocomplete или чтение сессий.
уязвимости — по [SECURITY.md](../SECURITY.md).
