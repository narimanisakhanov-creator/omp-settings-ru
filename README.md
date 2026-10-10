# omp-settings-ru

[![лицензия MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![последний выпуск](https://img.shields.io/github/v/release/narimanisakhanov-creator/omp-settings-ru)](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases)

русский перевод штатной панели `/settings` в [Oh My Pi](https://github.com/can1357/oh-my-pi).
отдельное расширение — не форк OMP и не патч `omp.exe`.

переводит названия, описания, предупреждения и статические подписи вариантов.
значения, пути, идентификаторы моделей и обработчики не меняются.
вкладки, группы, динамические списки и остальная TUI остаются у хоста.

![OMP 18.8.4 / Windows](docs/screenshots/settings-ru.png)

[о снимке](docs/screenshots.md).

## установка

выбери **один** канал; не добавляй вторую копию через `-e`, `--plugin-dir` или settings extensions. после установки нужна новая сессия.

**npm-managed GitHub** — фиксированный тег [v0.4.0](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.4.0), не npm registry:

```text
omp plugin install github:narimanisakhanov-creator/omp-settings-ru#v0.4.0
```

**marketplace** — каталог в ветке `marketplace`:

```text
omp plugin marketplace add https://raw.githubusercontent.com/narimanisakhanov-creator/omp-settings-ru/marketplace/.omp-plugin/marketplace.json
omp plugin install omp-settings-ru@omp-settings-ru
```

каталог в ветке `marketplace` закрепляет release commit полным `source.sha` и тегом `source.ref`. архив и `SHA256SUMS` лежат в выпуске.

## язык и удаление

команды вводятся из основного промпта, не из поиска панели:

- `/settings-language ru` — русский;
- `/settings-language en` — исходный английский;
- `/settings-language` — выбор языка.

после переключения закрой и заново открой `/settings`.
язык относится к текущей сессии и не записывается в конфиг.
следующая основная сессия с плагином начинает с русского.

для возврата в текущей сессии сначала `/settings-language en`, затем удали свой канал — **только одну** из двух команд:

**npm-managed GitHub**

```text
omp plugin uninstall omp-settings-ru
```

**marketplace**

```text
omp plugin uninstall omp-settings-ru@omp-settings-ru
```

выполни только соответствующую своей установке команду. новая сессия без плагина использует исходные тексты; если использовались explicit extension roots, убери их тоже.

uninstall удаляет собственные plugin settings/features. для отключения без потери state — `omp plugin disable <свой-name-or-id>`; state-preserving смена канала — в [CONTRIBUTING](CONTRIBUTING.md#смена-канала).

## обновление

`notify` — штатный режим без установки; `off` — без проверки; `auto` — добровольная установка обновлений на старте.

```text
omp config get marketplace.autoUpdate
omp config set marketplace.autoUpdate auto
```

**это общая настройка OMP для всех marketplace-плагинов пользователя и активного проекта, не только перевода.**

немедленное обновление — отдельный шаг, затем новая сессия:

```text
omp plugin marketplace update omp-settings-ru
omp plugin upgrade omp-settings-ru@omp-settings-ru
```

`auto` не проходит собственный release gate проекта и не гарантирует успех при сетевой ошибке; [SECURITY](SECURITY.md) описывает границы.

## проверенная совместимость checkout

| OMP | настройки | нативная панель CI |
| --- | ---: | --- |
| 18.6.1 | 398/398 | Windows, Linux, macOS |
| 18.8.0 | 404/404 | Windows, Linux, macOS |
| 18.8.4 | 404/404 | Windows, Linux, macOS |
| 18.8.7 | 410/410 | Windows, Linux, macOS |

источник — run [38018348057](https://github.com/narimanisakhanov-creator/omp-settings-ru/actions/runs/38018348057), SHA `e70ce0e`: это проверка указанных байтов checkout, не обещание поддержки любого нового checkout или опубликованного тега.
в каждом job реально упражнялись русский поиск, изменение и возврат bool/enum, ru/en/ru и новая английская сессия без расширения.

неизвестный путь или изменившийся источник остаётся английским; неизвестная версия не становится поддержанной от совпадения строк. определения уровней доказательств — в [CONTRIBUTING](CONTRIBUTING.md#матрица-и-peer-диапазон).

## подробнее

[FAQ](docs/faq.md) · [глоссарий](docs/glossary.md) · [архитектура](docs/architecture.md) · [сопровождение](CONTRIBUTING.md) · [изменения](CHANGELOG.md) · [безопасность](SECURITY.md).

[MIT](LICENSE). механизм адаптирован из `omp-settings-zh`, Copyright (c) 2026 Elazer; [атрибуция](THIRD_PARTY_NOTICES.md).
[ошибки и предложения](https://github.com/narimanisakhanov-creator/omp-settings-ru/issues) · [нормы поведения](CODE_OF_CONDUCT.md).
