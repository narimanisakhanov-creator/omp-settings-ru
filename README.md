# omp-settings-ru

[![лицензия MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![последний выпуск](https://img.shields.io/github/v/release/narimanisakhanov-creator/omp-settings-ru)](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases)

русский перевод штатной панели `/settings` в [Oh My Pi](https://github.com/can1357/oh-my-pi).
отдельное расширение — не форк OMP и не патч `omp.exe`.

переводит названия, описания, предупреждения и статические подписи вариантов.
значения, пути, идентификаторы моделей и обработчики не меняются.
вкладки, группы, динамические списки и остальная TUI остаются у хоста.

![живая русская панель /settings в OMP 18.8.4 на Windows](docs/screenshots/settings-ru.png)

нативный кадр из изолированного профиля: «Иконки заголовков» и описание на русском.
[происхождение трёх снимков и границы проверки](docs/screenshots.md).

## установка

выбери **один** канал; не добавляй вторую копию через `-e`, `--plugin-dir` или settings extensions. После установки нужна новая сессия.

**npm-managed GitHub** — фиксированный [выпуск v0.3.1](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.3.1), не npm registry:

```text
omp plugin install github:narimanisakhanov-creator/omp-settings-ru#v0.3.1
```

**marketplace** — после публикации проверенного индекса сопровождающим:

```text
omp plugin marketplace add https://raw.githubusercontent.com/narimanisakhanov-creator/omp-settings-ru/marketplace/.omp-plugin/marketplace.json
omp plugin install omp-settings-ru@omp-settings-ru
```

индекс пока не опубликован этой локальной работой. Он закрепляет release commit полным `source.sha` и тегом `source.ref`; `main` не источник пакета. Архив и `SHA256SUMS` доступны в выпуске; сверка суммы не независимая подпись.

## обновление

штатный marketplace auto включается **отдельно и добровольно**:

```text
omp config get marketplace.autoUpdate
omp config set marketplace.autoUpdate auto
```

`off` — не проверять; `notify` — проверять без установки (штатный default); `auto` — устанавливать обновления на старте. Это общая настройка OMP для всех marketplace-плагинов пользователя и активного проекта, не только перевода. Каталог обновляется после 24 часов; для немедленного обновления: `omp plugin marketplace update omp-settings-ru`, затем `omp plugin upgrade omp-settings-ru@omp-settings-ru`. Открой новую сессию; auto не является SHA256SUMS/ReleasePin gate и не гарантирует успешную установку при сетевой ошибке. Перед [сменой канала](CONTRIBUTING.md#смена-канала) сохрани состояние: uninstall удаляет plugin settings/features; см. [совместимость](#проверенная-совместимость-checkout).

## язык и удаление

команды вводятся из основного промпта, не из поиска панели:

- `/settings-language ru` — русский;
- `/settings-language en` — исходный английский;
- `/settings-language` — выбор языка.

после переключения закрой и заново открой `/settings`.
язык относится к текущей сессии и не записывается в конфиг.
следующая основная сессия с плагином начинает с русского.

для возврата в текущей сессии сначала `/settings-language en`, затем удали выбранный канал:

```text
omp plugin uninstall omp-settings-ru
omp plugin uninstall omp-settings-ru@omp-settings-ru
```

выполни только соответствующую своей установке команду. Новая сессия без плагина использует исходные тексты. Если использовались explicit extension roots, убери их тоже. Для отключения без потери state — `omp plugin disable <свой-name-or-id>`; uninstall стирает собственные plugin settings/features.

## проверенная совместимость checkout

| OMP / среда | фактически проверено |
| --- | --- |
| 18.6.1 / Windows x64 | настоящий реестр пакета, 398/398 настроек; установленная панель не запускалась |
| 18.8.0 / Windows x64 | настоящий реестр пакета, 404/404 настроек; установленная панель не запускалась |
| 18.8.4 / Windows x64 | реестр 404/404; установленная панель, русский поиск, bool/enum, ru/en/ru и новая сессия без расширения |
| 18.8.7 / Windows x64 | реестр 410/410; установленная панель, русский поиск, bool/enum, ru/en/ru и новая сессия без расширения |

это не таблица поддержки опубликованного тега.
Linux/macOS проверены по извлечённым исходникам, не по установленной панели.
на неизвестной версии совпадение пути и хеша позволяет перевести известные строки,
но не обещает совместимость; изменившиеся и неизвестные строки остаются английскими.

## подробнее

[FAQ](docs/faq.md) · [глоссарий](docs/glossary.md) · [архитектура](docs/architecture.md) · [сопровождение](CONTRIBUTING.md) · [изменения](CHANGELOG.md).

runtime перевода работает с метаданными в памяти; сеть и чтение ключей/сессий в нём не предусмотрены.
это граница кода, не результат сетевой трассировки. [безопасность](SECURITY.md).

[MIT](LICENSE). механизм адаптирован из `omp-settings-zh`, Copyright (c) 2026 Elazer; [атрибуция](THIRD_PARTY_NOTICES.md).
[ошибки и предложения](https://github.com/narimanisakhanov-creator/omp-settings-ru/issues) · [нормы поведения](CODE_OF_CONDUCT.md).
