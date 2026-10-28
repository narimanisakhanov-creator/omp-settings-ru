# omp-settings-ru

[![лицензия MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![последний выпуск](https://img.shields.io/github/v/release/narimanisakhanov-creator/omp-settings-ru)](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases) [![проверка main](https://github.com/narimanisakhanov-creator/omp-settings-ru/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/narimanisakhanov-creator/omp-settings-ru/actions/workflows/check.yml?query=branch%3Amain)

Русская панель `/settings` для [Oh My Pi](https://github.com/can1357/oh-my-pi): отдельное marketplace-расширение, не форк OMP и не патч `omp.exe`.

🧩 Переводит интерфейс; 🔒 не меняет значения и обработчики; 🌐 при работе не обращается к сети.

**Навигация:** [Установка](#установка) · [Совместимость](#поддерживаемые-версии-omp) · [Скриншоты](docs/screenshots.md) · [Изменения](CHANGELOG.md) · [Сообщить об ошибке](https://github.com/narimanisakhanov-creator/omp-settings-ru/issues)

![OMP 18.13.3 / Windows — русская панель Settings](docs/screenshots/settings-ru.png)

[О снимке и его происхождении](docs/screenshots.md).

Плагин переводит названия, описания, предупреждения и статические подписи вариантов. Значения, пути, идентификаторы моделей и обработчики не меняются; вкладки, группы, динамические списки и остальная TUI остаются у хоста.

<details>
<summary>Поиск и английское сравнение</summary>

![Поиск «скорость» в русской панели](docs/screenshots/settings-ru-search.png)

![Та же панель на английском](docs/screenshots/settings-en.png)

</details>

## Установка

Штатный путь один — marketplace OMP с каталогом из выпуска:

```text
omp plugin marketplace add https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/latest/download/marketplace.json
omp plugin install omp-settings-ru@omp-settings-ru
```

<details>
<summary>Технические детали сборки и безопасности</summary>

Не добавляй вторую копию через `-e`, `--plugin-dir` или расширения, прописанные в настройках.

Каталог закрепляет коммит выпуска полным `source.sha` и тегом `source.ref`; архив и `SHA256SUMS` лежат в том же выпуске. Отдельной ветки каталога нет. `private:true`, `omp.extensions` и `npm pack` относятся к упаковке и происхождению релиза, а не являются вторым способом установки; запуск `-e` из рабочей копии репозитория нужен только для разработки.

</details>

> [!WARNING]
> Следующая команда — `omp config set marketplace.autoUpdate auto` — включает общий режим `marketplace.autoUpdate=auto` для **всех** marketplace-плагинов пользователя и активного проекта, а не только для перевода.

После установки начни новую сессию. Плагин не меняет конфигурацию сам, а при работе по-прежнему не обращается к сети.

### Переход со старого каталога

Старый URL каталога (`raw.githubusercontent.com/.../marketplace/...`) больше не обслуживается. Повторное `marketplace add` того же имени с новым URL будет отклонено: сначала удали старое имя, затем добавь новое. Состояние плагина сохранится:

```text
omp plugin marketplace remove omp-settings-ru
omp plugin marketplace add https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/latest/download/marketplace.json
omp plugin marketplace update omp-settings-ru
```

> [!WARNING]
> Не удаляй плагин ради перехода: `uninstall` стирает собственные настройки и функции плагина, а `remove` каталога их сохраняет.

Старая установка через npm из GitHub больше не поддерживается и не описывается как способ установки. Одноразовый переход из одной прежней пользовательской установки через npm, без потери состояния, описан в [CONTRIBUTING](CONTRIBUTING.md#переход-на-marketplace); обратный переход на npm отклоняется.

## Язык и удаление

Команды вводятся из основного промпта, а не из поиска панели:

- `/settings-language ru` — русский;
- `/settings-language en` — исходный английский;
- `/settings-language` — выбор языка.

После переключения закрой и заново открой `/settings`. Язык относится к текущей сессии и не записывается в конфигурацию. Следующая основная сессия с плагином начинает с русского.

Для возврата в текущей сессии сначала выполни `/settings-language en`, затем удали плагин:

```text
omp plugin uninstall omp-settings-ru@omp-settings-ru
```

Новая сессия без плагина использует исходные тексты; если задавал явные каталоги расширений, убери и их.

`uninstall` удаляет собственные настройки и функции плагина. Чтобы отключить плагин без потери состояния, выполни `omp plugin disable omp-settings-ru@omp-settings-ru`; обратный переход на npm не поддерживается.

## Обновление

`notify` — штатный режим без установки; `off` — без проверки; `auto` — установка обновлений на старте, когда каталог устарел. **Это общая настройка OMP для всех marketplace-плагинов пользователя и активного проекта, а не только для перевода.**

По результатам анализа исходного кода OMP 18.8.7 каталог обновляется после 24 часов, а ошибки обновлятора при запуске (startup updater) хост подавляет: `auto` не проверяет обновления при каждом запуске и не гарантирует установку при сетевой ошибке. Настройку задаёт только пользователь — плагин не меняет конфигурацию сам.

```text
omp config get marketplace.autoUpdate
omp config set marketplace.autoUpdate auto
```

Немедленная проверка — отдельный шаг, затем новая сессия:

```text
omp plugin marketplace update omp-settings-ru
omp plugin upgrade omp-settings-ru@omp-settings-ru
```

`auto` не проходит собственный release gate проекта; [SECURITY](SECURITY.md) описывает границы.

<!-- omp-supported:start -->
## Поддерживаемые версии OMP

Поддержка в этой копии репозитория: OMP 18.13.1, 18.13.2, 18.13.3.

Целевое окно — три последние стабильные npm-версии OMP. Новые версии проходят проверки и добавляются последовательно; таблица показывает только уже измеренную поддержку, а не будущую очередь.

| OMP | Windows | Linux | macOS |
| --- | ---: | ---: | ---: |
| 18.13.1 | 421/421 | 421/421 | 421/421 |
| 18.13.2 | 423/423 | 423/423 | 423/423 |
| 18.13.3 | 426/426 | 426/426 | 426/426 |

В ячейке — измеренное покрытие каталога для точной пары «версия × платформа» (`bun scripts/check-coverage.ts <версия> <платформа>`); другое число в ячейке означает другое измерение, а не округление.
Список относится к текущей копии репозитория: совместимость опубликованного пакета определяется тегом его выпуска, а не этим файлом.
Источники — [манифест поддержанных хостов](test/fixtures/host-snapshots/supported-hosts.json) и CI на точный коммит [check.yml](.github/workflows/check.yml). Для платформ, которых нет на CI-раннере, покрытие проверяется статически по исходникам пакета (без запуска нативной панели TUI).

Если версия OMP не входит в список проверенных, плагин не гарантирует полную совместимость, даже при частичном совпадении строк. Неизвестный путь или изменившийся источник остаётся английским. Определения уровней доказательств — в [CONTRIBUTING](CONTRIBUTING.md#матрица-и-peer-диапазон).
<!-- omp-supported:end -->

## Подробнее

[FAQ](docs/faq.md) · [Глоссарий](docs/glossary.md) · [Архитектура](docs/architecture.md) · [Сопровождение](CONTRIBUTING.md) · [Изменения](CHANGELOG.md) · [Безопасность](SECURITY.md).

[MIT](LICENSE).
[Ошибки и предложения](https://github.com/narimanisakhanov-creator/omp-settings-ru/issues) · [Нормы поведения](CODE_OF_CONDUCT.md).
