# сопровождение: распространение, источники, автоматизация, выпуск

runbook для сопровождающего: эти действия могут скачивать, устанавливать и публиковать.
это не runtime плагина — код перевода работает офлайн на живых метаданных хоста.
границы runtime описаны в [SECURITY.md](../SECURITY.md); участие и проверки — в [CONTRIBUTING.md](../CONTRIBUTING.md); термины — в [glossary.md](glossary.md).

## распространение и auto

`private:true` остаётся: npm-managed использует GitHub release, npm registry publication отсутствует. `.omp-plugin/marketplace.json` публикуется отдельно в ветке `marketplace`, не внутри pin-имого release tree. `marketplace.autoUpdate` — штатный общий переключатель OMP; `auto` не проверяет project ReleasePin/наши receipts. Runtime перевода сети не получает.

После опубликованного release и успешного exact-commit `check` workflow: `bun scripts/marketplace-catalog.ts --generate --tag v<version> --check-run <workflow-run-id> --output <catalog.json>`. Команда читает живые GitHub release/tag/workflow, dereferences annotated tag, скачивает archive/SHA256SUMS и сверяет hashes. Remote операция отдельно: dispatch `.github/workflows/marketplace-index.yml` с tag/check_run; он проверяет native channels перед обычным push только index branch. Публикующий CLI (`bun scripts/marketplace-index.ts`) повторно проверяет тот же живой release через `loadVerifiedCatalog`, поэтому рукописный файл каталога им не публикуется; monotonic/idempotent/conflict-решение покрыто доменным тестом на реальном owned Git.

`bun run smoke:distribution --catalog <verified-catalog.json>` устанавливает настоящий npm-managed GitHub выпуск, добавляет owned каталог, прогоняет обе миграции канала, обычный native startup и `off/notify/auto` на stale каталоге с двумя настоящими выпусками и вторым fixture-плагином. `bun run smoke:source` проверяет именно текущий checkout: собирает package allowlist в реальный локальный Git-репозиторий, ставит его нативным marketplace-каналом и сверяет content hash, затем открывает русскую панель. Оба — channel proof, отдельный от старого link-based `smoke:installed`; сетевые ошибки git-транспорта сообщаются как `network-transport-failed` с сохранённым backup, а не как дефект канала.

## обновление источников

1. зафиксируй точную версию upstream и commit. начни с `bun scripts/upgrade-host.ts <version> --dry-run`; режим без `--dry-run` выполняй в отдельной рабочей ветке.
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

ежечасовая проверка upstream-кандидатов идёт через контроллер `scripts/maintenance.ts`; он не принимает текст PR как инструкции и не трогает рабочий checkout человека.

регистрация автоматизации привязывает доверие к трём вещам: принятой политике из `origin/main`, селектору репозитория и абсолютному пути precheck-скрипта в каноническом checkout. их хеш печатает сама политика:

```text
bun scripts/maintenance.ts --policy-digest --repo github:<owner>/<repo> --checkout "<канонический checkout>"
```

команда читает только локальный Git (`origin/main`) и печатает hex-хеш одной строкой; сеть не используется.
запускай её из свежего рабочего каталога: рецепт привязан к переданному `--checkout`, а не к текущему CWD.
агент обязан отказаться от запуска, если напечатанный хеш не совпадает с зарегистрированным в prompt.

`--precheck` обязан уложиться в 30 секунд: независимые чтения GitHub идут одной параллельной группой, а холодный `bun install` при разрешении lockfile — отдельной зависимой. внешняя задержка GitHub завершает precheck отказом, а не обходом гейта.

закрытие доверия для lockfile принимает только канонические алиасы хоста: имя обязано совпадать с `omp-host-<версия>` для версии из своего `npm:`-спецификатора, базовые алиасы берутся из принятого lockfile, алиас кандидата — только из дерева кандидата. произвольные `npm:`-алиасы остаются недоверенными.

## выпуск

1. Этот проект публикует minor-релизы вручную: текущий контроллер upgrade-веток принимает только patch-кандидаты OMP и не выпускает новую версию самого плагина.
2. Перед фиксацией номера проверь, что версия `package.json`, соответствующий заголовок `CHANGELOG.md`, установочная команда и незанятый Git tag согласованы.
3. Получи independent review; на финальном состоянии пройди `bun run check`, `npm pack --dry-run --json --ignore-scripts`, `bun run release:check` и полный exact-SHA GitHub CI.
4. Проверь публичные тексты, release notes, reachable Git history, PNG и итоговый пакет pinned secret scanner-ом; ограниченный поиск паттернов не гарантирует обнаружение любого секрета.
5. Убедись, что smoke проверил установку и удаление точного выпускаемого артефакта в одноразовом профиле; никогда не меняй произвольный личный профиль.
6. Не переписывай существующие теги, не применяй force push и продвигай `stable` только после exact-SHA review/CI и проверки ancestry.
7. После публикации проверь GitHub Release, assets, SHA-256 и доступность точной install-команды; сумма рядом с архивом подтверждает совпадение, не независимую подпись.

внешние инструменты сопровождения используют сеть; runtime перевода — нет.
не переносить в runtime Stats, PATH-установщики, autocomplete или чтение сессий.
сохраняй MIT и атрибуцию Elazer; уязвимости — по [SECURITY.md](../SECURITY.md).
