# OMP 18.16.0 → 18.17.0

Релиз 0.16.0. Сводка собрана из принятого каталога базы, каталога кандидата и снимков трёх платформ новой версии; исторические переводы сохранены и не перечисляются.

## Новые настройки на русском (12)

| настройка | путь | sourceHash | платформы |
| --- | --- | --- | --- |
| Визуализация оболочки | `display.shellVisualization` | `fe1f40ffa066586d5376250675d487f0a8b34505b7ebdd03a2ca7bf58f55a156` | win32, linux, darwin |
| Представления транскрипта расширений | `extensionRenderers.transcriptPresenters` | `7686b061705581ac688cde15289deeb9db4f1aef82adba55a18352b955026f1b` | win32, linux, darwin |
| Ключевое слово Chillax | `magicKeywords.chillax` | `95310b43da854cea70552c12220bda378ff0ec7035990fc54db12329b1e8929f` | win32, linux, darwin |
| Двоичный файл ovnfs | `ovnfs.path` | `ea3ca81909cbd39beabe1a1b4f055f15a7c7ed1fa1e8a099fb7ed17189fba631` | win32, linux, darwin |
| OpenAI Responses WebSockets | `providers.openaiResponsesWebsockets` | `dec0e0f3ec568daa9fa16b88a5ca5d4614c3aaeb00dd93f11047efa371e8a954` | win32, linux, darwin |
| Эксперимент Spotlight | `spotlight.experiment.enabled` | `c4e3f8a94ec283e177ea6457a9590e36a8cdabf1513276bbc5d368c577fd07ce` | win32, linux, darwin |
| Рабочие потоки субагентов | `task.workerThreads` | `0a7c778920109fba9b1bbdbdf361023e40995774a64077f9a973aedf244a7ebc` | win32, linux, darwin |
| Цветной Markdown | `tui.colorfulMarkdown` | `439637afe8869b8e75951bce041143133a4b81129866c4953c7e178c6d2f9708` | win32, linux, darwin |
| Максимальное количество кадров в секунду | `tui.maxFps` | `d13f2fd28ff76bc373c90fdae629b21b116391afd732250792b579ed88c3ed9d` | win32, linux, darwin |
| Анимация | `tui.motion` | `5e893d289db95e13d8dd55a40ca0dcf134eac637a514df83bff0b28cb7441211` | win32, linux, darwin |
| Интервал спиннера \(мс\) | `tui.spinnerInterval` | `2c62c7ab424c003d2339c00253033548199f694ba9e5dcf25d85fd6bfa772a16` | win32, linux, darwin |
| Автоматическое обновление | `update.auto` | `1e53034e217130beea620c1938cd41a2d37e8a00888f08e413c06497311d8e0b` | win32, linux, darwin |

## Обновлены переводы изменившихся настроек (7)

| настройка | путь | новый sourceHash | платформы |
| --- | --- | --- | --- |
| Мерцание | `display.shimmer` | `afa8a45e78e5d1ec3f9ef7a37ed03b6fe029df9d9eddd4eb14726754a8381b13` | win32, linux, darwin |
| Плавный поток | `display.smoothStreaming` | `90833099c0042b83c466ca2213c63804c82d64b7053b3e0e212ab1955dea6ce8` | win32, linux, darwin |
| Режим редактирования | `edit.mode` | `acef7da5b47435747c6584240f53b74b849b9a2d1e7ce8989d7a1a265510276b` | win32, linux, darwin |
| Бэкенд изоляции | `isolation.backend` | `0bd12fc8c9293d74a71f05feb511e2387cb1267f37a967478f2dad76a373f90f` | win32, linux, darwin |
| Магические ключевые слова | `magicKeywords.enabled` | `9ed7e192c3166d5aa5e9f82be279b080d832167b536ee9dd525987c6adade592` | win32, linux, darwin |
| OpenAI Codex WebSockets | `providers.openaiWebsockets` | `bb0c9ae976df3bf703f73027886503b0fe0ea7b80d042f21dda07180129780e8` | win32, linux, darwin |
| Многословность текста | `textVerbosity` | `1606c12e28b2d49f6166843934ef5f1296e4f99192169fd06264affdb65f9ab4` | win32, linux, darwin |

## Покрытие каталога

| OMP | платформа | настройки |
| --- | --- | --- |
| 18.15.0 | win32 | 435/435 |
| 18.15.0 | linux | 435/435 |
| 18.15.0 | darwin | 435/435 |
| 18.16.0 | win32 | 438/438 |
| 18.16.0 | linux | 438/438 |
| 18.16.0 | darwin | 438/438 |
| 18.17.0 | win32 | 450/450 |
| 18.17.0 | linux | 450/450 |
| 18.17.0 | darwin | 450/450 |
