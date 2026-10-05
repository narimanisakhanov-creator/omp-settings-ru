# omp-settings-ru

[![check](https://github.com/narimanisakhanov-creator/omp-settings-ru/actions/workflows/check.yml/badge.svg)](https://github.com/narimanisakhanov-creator/omp-settings-ru/actions/workflows/check.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/narimanisakhanov-creator/omp-settings-ru)](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases)

русский перевод штатной панели `/settings` в Oh My Pi. отдельное расширение; не форк OMP и не патч `omp.exe`.

переводит названия, описания, предупреждения и подписи статических вариантов 398 настроек OMP 18.6.1. значения (`off`, `auto`, идентификаторы моделей), обработчики, пути и пользовательские данные не меняются. вкладки, группы, подсказки навигации и динамические списки хоста остаются английскими. Stats, slash-autocomplete и остальная TUI не переводятся.

## установка

для OMP **18.6.1**. используйте фиксированный тег, а не изменяемую ветку `main`:

```powershell
omp plugin install git+https://github.com/narimanisakhanov-creator/omp-settings-ru.git#v0.1.0
```

затем запустите новую сессию и откройте `/settings`. менеджеру плагинов нужен Bun в PATH его процесса. альтернативный вариант без установки менеджером — скачать исходники [v0.1.0](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases/tag/v0.1.0) и запустить расширение через `-e` из checkout, как описано ниже.

## запуск из checkout

нужен установленный OMP **18.6.1**. запуск исходного расширения через `-e` внутри OMP не требует отдельного Bun или установки зависимостей. штатный менеджер плагинов при удалении вызывает `bun`; для него нужен Bun, доступный в PATH данного процесса (глобальный PATH менять не обязательно).

```powershell
omp --no-extensions -e .\src\index.ts
```

`--no-extensions` отключает обнаружение других расширений, но сохраняет явно указанный `-e`. убери этот флаг, если нужны остальные расширения. для постоянного подключения после проверки:

```powershell
omp plugin link .
omp plugin doctor
```

команда меняет реестр плагинов выбранного профиля; здесь её не выполняли для рабочего профиля. после подключения открой новую сессию. для другого профиля используй `omp --profile <имя> plugin link .`.

`plugin link` и загрузка через обнаружение проверены в одноразовом профиле. `plugin doctor` показал 3 ok, 1 warning (`package_manifest: Not created yet`), 0 errors — у linked-профиля ещё нет npm manifest.

## язык и удаление

- при старте основной сессии включается русский;
- `/settings-language ru` — русский;
- `/settings-language en` — исходный английский;
- `/settings-language` — выбор языка;
- после переключения закрой и заново открой `/settings`;
- выбор языка не записывается в конфиг. следующая сессия опять стартует на русском;
- дочерний агент не может применить или снять перевод родителя.

```powershell
omp plugin uninstall omp-settings-ru
```

для немедленного возврата в текущей сессии сначала выполни `/settings-language en`. отключение или удаление плагина не объявляется горячим восстановлением; новая сессия без плагина всегда использует оригинальные тексты. при запуске через `-e` достаточно убрать аргумент.

## совместимость и ограничения

| хост / среда | проверка |
| --- | --- |
| установленный OMP 18.6.1, Windows x64 | реальная панель: русский поиск, сохранение безопасной настройки, статические варианты, выбор языка, возврат en/ru |
| пакеты OMP 18.6.1, Windows x64, Bun 1.3.14 | доменные тесты, 398/398, drift 0, три цикла реестра и автоматический smoke штатной панели |
| Linux / macOS | исходные платформенные ветки учтены; запуск ОС и установленной панели не проверен |

пока принимается только версия хоста 18.6.1. другие версии получают безопасный отказ, а не обещание совместимости. неизвестные настройки и изменившиеся исходные строки остаются английскими. нельзя одновременно включать другой переводчик того же реестра.

перед записью строится полный план. небезопасные дескрипторы блокируют перевод целиком. восстановление сохраняет последующие изменения другого расширения; полностью идентичную запись того же дескриптора JavaScript отличить не может. getter описания переводится только по проверенному шаблону: актуальные клавиши берутся у хоста. неожиданный текст getter остаётся английским.
если первичный откат не завершён, плагин удерживает план восстановления и показывает предупреждение. `/settings-language en` и завершение основной сессии повторяют восстановление, не затирая чужие изменения; повторное ru до этого не записывает новые данные.

## приватность

плагин не делает сетевых запросов, не собирает телеметрию, не читает ключи, содержимое сессий и текущие значения настроек для перевода. язык живёт в памяти процесса. OMP самостоятельно отвечает за свои сетевые функции и за сохранение настроек при твоих действиях в панели.

## разработка

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run check
```

если Bun отсутствует, можно установить runtime только внутри игнорируемой `.tools`, не меняя PATH:

```powershell
npm.cmd install --prefix .tools --no-save --package-lock=false --ignore-scripts @oven/bun-windows-x64-baseline@1.3.14
.\.tools\node_modules\@oven\bun-windows-x64-baseline\bin\bun.exe --version
.\.tools\node_modules\@oven\bun-windows-x64-baseline\bin\bun.exe install --frozen-lockfile --ignore-scripts
.\.tools\node_modules\@oven\bun-windows-x64-baseline\bin\bun.exe run check
```

`check` включает строгий TypeScript, доменные тесты, покрытие, drift, реальный реестр, изолированный smoke штатного компонента панели и проверку состава npm-пакета/известных признаков секретов. последняя проверка — не гарантия обнаружения любого секрета. `smoke:panel` создаёт временный HOME, исключает наследование ключей и удаляет профиль после завершения. это не заменяет ручной запуск установленного `omp.exe` перед выпуском.

обновление переводов и выпуск: [CONTRIBUTING.md](CONTRIBUTING.md). изменения: [CHANGELOG.md](CHANGELOG.md). MIT; адаптированный механизм Elazer: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

выпуски публикуются в [GitHub Releases](https://github.com/narimanisakhanov-creator/omp-settings-ru/releases). npm-публикация не используется (`private: true`). ошибки и предложения: [Issues](https://github.com/narimanisakhanov-creator/omp-settings-ru/issues). уязвимости: [SECURITY.md](SECURITY.md).
