# Implementation Plan

- [x] 1. Закрепить конечную границу каталога и падающие доменные регрессии
  - В `test/translation-lifecycle.test.ts` и `test/report.test.ts` упражнить реальное применение на metadata старого, нового и будущего структурно совместимого хоста: exact path/hash/platform, changed unknown English, malformed safe refusal, восстановление после ошибки.
  - В `src/translations/types.ts` определить один path-keyed entry с retained SourceVariant; обновить потребителей без copied per-version catalogs и без version switch.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.8_

- [x] 2. Восстановить и явно проверить исторические варианты
  - Из `v0.1.0` и `v0.2.0` восстановить все исторические русские варианты; объединить идентичные, сохранить отличающиеся десять путей, удалённые пути и darwin apple.
  - Подключить дельты `src/translations/ru-variants.ts` к `ru.ts`; compact `variant-review.json` содержит ревью changed/added/platform variants и catalog-hash invariant, unchanged variants наследуют existing baseline proofs.
  - Подключить проверку sourceHash/translationHash/provenance к принятому gate; новый hash без review не активируется.
  - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.8_

- [x] 3. Реализовать resolver и структурную совместимость без version gate
  - В `src/translations/resolve.ts` выбирать exact path + hash + platform, считать общий исходник только для допустимой платформы; ambiguity и conflicting aliases отказывать атомарно.
  - Подключить resolver к `src/apply-translations.ts` и `src/report.ts`; удалить sourceOmpVersion gate и migrated obsolete refusal messages в `language-controller.ts`, сохранив ownership/restore.
  - Проверить lazy host import failure, unsafe descriptor и repeated ru/en/ru через настоящий домен, без source-text assertions.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.8, 2.1_

- [x] 4. Сохранить шаблоны и убрать избегаемую работу отображения
  - В `src/source-templates.ts` хранить source templates всех нужных вариантов, сохранив существующий простой dynamic hint механизм без нового compiled framework.
  - В apply plan вычислять каждый distinct ui/template hash один раз, вернуть исходную readonly variant без entry/options spread; необходимые descriptor journal и реальные option copies сохранить.
  - В `test/source.test.ts` и lifecycle проверить живые hints, changed English fallback и повторное применение после restore; smoke упражняет compiled host getter.
  - _Requirements: 1.1, 1.3, 1.7, 1.8_

- [x] 5. Принять новый title.icons и кандидата 18.8.4 полностью
  - Из реального PR #4 закрепить три candidate baseline; сравнить actual English `title.icons` с 18.8.0 и создать отдельный правильный русский вариант после reviewer verdict.
  - Проверить промежуточный English при неизвестном hash и финальное 404/404 с нулём mismatches; сохранить старый вариант и все старые значения.
  - _Requirements: 1.1, 1.2, 1.5, 1.9, 2.1_

- [ ] 6. Соединить version/platform exports и pinned матрицу
  - Обновить существующие export/coverage/drift CLI и `src/report.ts` на общий resolver; добавить `scripts/check-matrix.ts` с девятью версия/платформа отчётами и отдельной source-derived/native маркировкой.
  - Закрепить единый Bun и релевантные host/tool dependencies через Bun в package/lock; frozen install и package scripts соединить с check без отдельного hygiene проекта.
  - Закрепить peers на точные испытанные package API версии; отдельно записать native installedPanel evidence по version/platform. Structural fallback не semver promise; baseline/package smoke не installed-panel proof.
  - Создать `baseline/supported-hosts.json`; candidate refresh автоматически сохраняет новые baselines, reviewers принимают delta variants, exact-SHA native matrix/smoke gate обновляет finite support set/peers без удаления исторических версий и без runtime version gate.
  - _Requirements: 1.2, 1.9, 2.1, 2.4, 2.5, 2.6_

- [ ] 7. Реализовать e2e настоящего установленного хоста и PTY evidence
  - В `scripts/smoke-installed-host.ts` запускать executable с native installed plugin в одноразовом профиле, отличая его от isolated panel worker; проверять поиск, bool/enum изменение, main ownership, ru/en/ru и новую сессию.
  - Записывать привязанные к SHA/host/artifact structured receipts и очищенные PTY captures для presentation workstream.
  - Соединить Windows/Linux/macOS и host версии с CI в уже авторизованном bootstrap; old binaries только во временном каталоге, основной installed host не заменять, отсутствие native evidence не объявлять support.
  - _Requirements: 1.8, 1.9, 2.2, 2.3, 2.5, 3.6_

- [ ] 8. Реализовать доверенный precheck и ограниченную политику
  - Добавить `maintenance.config.json`, `scripts/maintenance.ts` и `scripts/maintenance/github.ts`: read-only `--precheck`, trusted identity/origin/base/branch/SHA, field-aware paths/deps allowlist, deadline и точные exit codes.
  - Политику читать из принятого base; PR body/check-output/report не использовать как instructions. Workflow/secrets/config surprises требуют explicit human gate.
  - В `test/maintenance.test.ts` проверить domain decisions eligible/skip/blocked и отсутствие launch authority для unsafe input.
  - _Requirements: 3.1, 3.2, 3.4, 3.10, 5.1, 5.2_

- [ ] 9. Подключить serial state, locks и возобновление
  - Добавить `scripts/maintenance/state.ts` с atomic state/revision, repo lock и PR+sourceHeadSha generation, отдельными working/reviewed/merge SHA и intent/receipt reconciliation.
  - Подключить к CLI finite bounded stages, status/resume и idempotent пропуск; неизвестная liveness не даёт права снимать lock или повторять мутацию.
  - Доменно проверить crash between intent/receipt, SHA change, deadlines и две одновременные задачи без подмены работы человеческого дерева.
  - _Requirements: 3.3, 3.8, 3.10, 5.4_

- [ ] 10. Подключить isolated Orca executor и независимый reviewer
  - Добавить `scripts/maintenance/orca.ts` на обнаруженных installed CLI/providers: новые new-child/new-top-level worktrees, Run/Task/Dispatch receipts, bounded trusted prompts и штатные permission policies без auto-approval flags.
  - Ограниченный executor diff проходит semantic allowlist, commit и fast-forward push с remote-head fence; reviewer запускается отдельным read-only Dispatch на точном pushed SHA.
  - Обрабатывать вопросы, failedStage/residualResources и explicit worker outcomes; освобождать только settled worker, unknown receipt не превращать в успех или duplicate launch.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.8, 5.2_

- [ ] 11. Реализовать exact-SHA verification и privacy gate
  - Соединить reviewer verdict, непустые именованные successful CI checks, full installed-host smoke и artifact/tree/SHA hashes; stale head/base и inconclusive/missing checks блокируют публикацию.
  - Подключить реальный pinned Gitleaks offline `--redact` по reachable refs, текущим файлам и финальному пакету, без заявления полноты homemade regex; скан без завершённого verdict блокирует gate.
  - Domain regression доказывает отказ merge при каждом потребительски значимом неполном/устаревшем доказательстве; e2e receipt доказывает smoke именно исполняемого хоста.
  - _Requirements: 2.2, 2.4, 3.2, 3.6, 3.10_

- [ ] 12. Реализовать merge/tag/release reconciliation
  - В github adapter объединять только match-head-commit после повторного precheck, без admin bypass; проверить closure PR и merged SHA.
  - Создавать единственный version/tag на mergeSha, переиспользовать принятый `release.yml`, ждать successful workflow/release/asset/checksum/stable; конфликт существующего tag/hash блокировать.
  - Сохранить existing npm pack и проверить прежний allowlisted final package; resume не дублирует effects и не устанавливает плавающий stable.
  - _Requirements: 2.4, 3.5, 3.6, 3.7, 3.8, 3.10_

- [ ] 13. Реализовать native updater stage и verify
  - Добавить `scripts/maintenance/updater.ts`: фактический installed OMP/platform, ReleasePin tag/commit/asset/hash/support, safe unpack и backup previous bytes/metadata без изменений текущего install.
  - Обнаружить и испытать native manager pinned target capabilities: marketplace-only upgrade не использовать для tarball, подтверждённый install/path replacement допустим; безопасная profile isolation обязательна.
  - В isolated профиле e2e проверить native install/list/doctor и настоящую новую executable session; неподдержанный/недоступный local host возвращает safe-pending, а не Done.
  - _Requirements: 3.9, 4.1, 4.2, 4.4, 4.5, 4.7_

- [ ] 14. Реализовать activation-before-session и проверенный rollback
  - Под activation lock повторно сверить host/hash/support, session liveness и отсутствие human local edits; active/unknown/mismatch сохраняют previous working install и pending/deferred.
  - Только на принятой финальной стадии текущего user profile выполнить испытанный native replacement ДО новой сессии, без PATH/auth/keys/host upgrade; после активации получить реальный list/doctor/new-session smoke.
  - При failure восстановить native previous package bytes/metadata и упражнить rollback новой сессией; end-to-end Done разрешить лишь после verified activation, rollback failure честно блокирует.
  - _Requirements: 3.9, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [ ] 15. Подключить выключенную часовую Orca automation
  - Добавить `scripts/maintenance/automation.ts`: idempotent registration, installed contract hourly/precheck/timeout/new-per-run/fresh-session, trusted provider/config digest и disabled=true.
  - Встроить hard timeout precheck независимо от неопределённой единицы scheduler timeout, затем выяснить её machine-readable contract без догадок.
  - E2E через реальные disabled run receipts подтвердить no-work/unsafe/timeout без worktree, eligible с одним isolated worktree, duplicate skip и запрет enable до director acceptance.
  - _Requirements: 3.3, 3.4, 5.1, 5.2, 5.3, 5.4_

- [ ] 16. Связать весь pipeline и проверяемый финальный статус
  - Проверить controller resume от eligible PR до reviewed SHA, CI/full smoke/privacy, merge closure, fixed release, local stage/verify/activate и Done; publication effects упражнять только с отдельно принятой authority.
  - Domain/error e2e сценарии доказывают safe-pending local mismatch, partial rollback, changed head и duplicate release без ложного успеха; network остаётся только во внешнем controller.
  - Связать `scripts/check-release.ts` с pack, matrix и scanner gate, исключить external controller/config/state из runtime package; обновить affected callsites/tests без устаревших aliases.
  - _Requirements: 1.8, 1.9, 2.1, 2.2, 2.3, 2.4, 2.5, 3.2, 3.6, 3.7, 3.8, 3.9, 3.10, 4.2, 4.3, 4.5, 4.6, 4.7, 5.3, 5.4_

## Исполненное и границы доказательств

Runtime source selection/ownership восстановлены с literal RED→GREEN в `.tools/maintenance-evidence.implementation.md`; все 9 source-derived/native-package coverage пары 398/404/404, drift=0. Independent title verdict task_280171564bc3 принят ДО активации нового варианта. Исторические semantic дельты явно сравнены с version English; unchanged используют tag catalog hash. Полный runtime пакет offline, external controller/config не входит в npm dry-run.

Genuine installed Windows18.8.4 smoke использует один `scripts/installed-smoke.ts` direct import с native PTY worker; отдельный clean child env/HOME обязателен, `env:{}` native PTY наследует environment. Neutral no-model, no prompts/provider configs/inference. Startup-only НЕ полное panel support; full exercise наблюдает русский поиск, bool/enum, ru/en/ru, explicit en reset и новую --no-extensions English session ДО любого language command. Native screenshot отдельно `docs/screenshots/settings-ru-live-final.png`, receipt capture evidence. CI native steps настроены на fixed asset SHA256 download и тот же driver, но после uncommitted bootstrap ещё не исполнялись. Personal installed profile неизменён; corrected копия в owned disposable profile.

Контроллер первоначальный worker честно сообщил failed за отсутствие обязательного RED до начальных реализаций/некоторой stage wiring и incomplete field semantic validation; coordinator владеет completion task. Эти пункты не отмечены завершёнными и не заменяются зелёной suite. Candidate refresh peer preservation имеет честно записанный TDD gap (первичный RED был fixture process error); не ретроспективное доказательство. Updater actual stage/activation/rollback результаты записывает независимый поток. End-to-end publish/PR4 run запрещён до финальной authority, automation остаётся disabled.

Semantic release gate теперь исполняется `scripts/verify-variant-reviews.ts` из `check-release.ts`: exact source/platform + русский field hash + semantic comparison обязательны для delta row. Реальный disposable npm dry-run тест до реализации принял tampered title translationHash (Expected exit1, Received0); после реализации отказал, green1test2asserts. `release:check`25files0failures. Full `bun run check`600s не завершился: updater реальные activation/rollback наблюдались, но fixture cleanup EPERM/EBUSY; не заявляем full green.
