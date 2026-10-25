# OMP 18.8.7 → 18.12.6

Релиз 0.7.1. Сводка собрана из принятого каталога базы, каталога кандидата и снимков трёх платформ новой версии; исторические переводы сохранены и не перечисляются.

## Новые настройки на русском (11)

| настройка | путь | sourceHash | платформы |
| --- | --- | --- | --- |
| Минимальная важность заметки советника для продолжения | `advisor.continueSeverity` | `415c9cbc35cf87fd211146ff4450189001028336b3403a2b31fc430289c58032` | win32, linux, darwin |
| Виджеты выполняющихся заданий в реальном времени | `async.widgets` | `5ec5f39435cb287e86bdeb5e77efb303cd65a70d7a6ef3a3acedd2caf9c2ef0b` | win32, linux, darwin |
| Предсказания Composer | `composer.predictions` | `8689fd38c712097bdb7b4c4bbed0e9d9365f2473204f973eb12ca4a6a65c3854` | win32, linux, darwin |
| Резервный режим фонового ввода компьютера | `computer.backgroundFallback` | `aeb2e32863bb5f8c4b5aa59722a7b9fca07368eea0b7ffaaea5bad30a5541c97` | win32, linux, darwin |
| Дополнительные файлы контекста | `contextFiles.extra` | `51ede8645a8fd95f0b1fe86536b126b48beab068c72d652c8179f13b6c2dd7ec` | win32, linux, darwin |
| Тайм-аут запроса | `lsp.requestTimeout` | `d5b85279f9793785f1f3e279c4d98c033ac065314f03a3365da6f34bbb5ddc67` | win32, linux, darwin |
| Автоматический prewalk | `prewalk.auto` | `54269b1af40b805a6183d75f94c36b39d92ec6a3a5bda5e05c648e4a988a0d5a` | win32, linux, darwin |
| Цель автоматического prewalk | `prewalk.autoTarget` | `76e910dce826950b9375a9ff4f803788a80d0a905098688946f216aae17f7218` | win32, linux, darwin |
| Триггер отката | `retry.fallbackOn` | `21672a381f63c7cdcbc2e26b11894af699f21bf1a0a56e61b626814acc2415bc` | win32, linux, darwin |
| Структурированные результаты задачи | `task.structured` | `3ec811e3e67ce6ad912560be364f9c7b5b0c6070d9827b0a4f355537dc2d2e1f` | win32, linux, darwin |
| Полный буфер прокрутки | `tui.completeScrollback` | `4296d59fe8213d9cef796c7f8cbbd7b045697c0f4250b1b616375b2164c8f8bb` | win32, linux, darwin |

## Обновлены переводы изменившихся настроек (15)

| настройка | путь | новый sourceHash | платформы |
| --- | --- | --- | --- |
| Тайм-аут ask | `ask.timeout` | `e16a82b7fe37223e0adc327cb067cce1c7c5c759972cff7cce430176eda6ecf3` | win32, linux, darwin |
| Автоматическое использование сбросов Claude | `claudeResets.autoRedeem` | `7c0055eae35d897d65a88b24b8a9a88f5116153828bbf0cdee7d4a051cfc0c05` | win32, linux, darwin |
| Автоматическое использование сохранённых сбросов Codex | `codexResets.autoRedeem` | `f7e97012bc893e8b2601d4a96a14e3683e3ff34a8320e0ca5217558785f2243f` | win32, linux, darwin |
| Задержка уплотнения в простое | `compaction.idleTimeoutSeconds` | `217ce7e1ff22e70fb1544e875584d05ea031debe3cb47697732705aa32c36e69` | win32, linux, darwin |
| Порядок методов уплотнения | `compaction.methodOrder` | `93e3fe578c8e2f1d440f6bd89c22a6207e568ab02373da20c6be5363f2724e46` | win32, linux, darwin |
| Автоповышение контекста | `contextPromotion.enabled` | `dae2705bbc87172199eb650e1553585a8f9dc210b20ebf1138e6748a0ff1e4df` | win32, linux, darwin |
| Общие языковые серверы | `lsp.shared` | `0dd224c3bb142aa2ff60767668701ae683a39874bc649d6b41189cc4fc97599e` | win32, linux, darwin |
| Хранение кэша промпта | `providers.cacheRetention` | `c86b4a3e6ea2688f2f69e506707bfe5940e57f098d7bbcbb8c630f008ae3149c` | win32, linux, darwin |
| Откат модели при повторе | `retry.modelFallback` | `ee7e6e73c25e498f297b9fcd6da6310692057847f6cdb77b4a466904c1712be5` | win32, linux, darwin |
| Результаты инструментов Snapcompact | `snapcompact.toolResults` | `d3f040ce4321e0fc8002e7f144b6181a1fc4db04b138dc17f0b52fe9640d2e4e` | win32, linux, darwin |
| Разрешить изоляцию субагентов | `task.isolation.enabled` | `5db54873c25a1bfb17303686081e7eefa87429640ea4a55c3c1ec0a2b4451e95` | win32, linux, darwin |
| Мягкий бюджет запросов субагента | `task.softRequestBudget` | `d3a5073c64d2c3f0b0c1ae7eb20eaf88f7d0d63cedd0e06b75b4cb17a3d9dbdd` | win32, linux, darwin |
| Подтверждение инструментов | `tools.approvalMode` | `d0e5f00f79f1df379aa266ff4e32e59089ee62343a9506d5adbf2f9b39bf9b1c` | win32, linux, darwin |
| Автографики таблиц | `tui.autoGraph` | `e6a3b5a7655fa4a0b15546195b29a084d33d0f0629ff0d737619783928b35e6b` | win32, linux, darwin |
| Индикатор режима Vim | `tui.vimModeDisplay` | `51448aa4314628b0c112961938de31a8854d1285c63d3ed26488d70a17a5ebca` | win32, linux, darwin |

## Больше не доступны в OMP 18.12.6 (2)

| настройка в OMP | путь | платформы старого хоста |
| --- | --- | --- |
| Codex Code Mode | `providers.openai-codex.codeMode` | win32, linux, darwin |
| Codex Code Mode Direct Tools | `providers.openai-codex.codeModeDirectTools` | win32, linux, darwin |

## Покрытие каталога

| OMP | платформа | настройки |
| --- | --- | --- |
| 18.6.1 | win32 | 398/398 |
| 18.6.1 | linux | 398/398 |
| 18.6.1 | darwin | 398/398 |
| 18.8.0 | win32 | 404/404 |
| 18.8.0 | linux | 404/404 |
| 18.8.0 | darwin | 404/404 |
| 18.8.4 | win32 | 404/404 |
| 18.8.4 | linux | 404/404 |
| 18.8.4 | darwin | 404/404 |
| 18.8.7 | win32 | 410/410 |
| 18.8.7 | linux | 410/410 |
| 18.8.7 | darwin | 410/410 |
| 18.12.6 | win32 | 419/419 |
| 18.12.6 | linux | 419/419 |
| 18.12.6 | darwin | 419/419 |
