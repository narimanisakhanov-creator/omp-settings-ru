# OMP 19.0.1 → 19.1.0

Релиз 0.38.0. Сводка собрана из принятого каталога базы, каталога кандидата и снимков трёх платформ новой версии; исторические переводы сохранены и не перечисляются.

## Новые настройки на русском (10)

| настройка | путь | sourceHash | платформы |
| --- | --- | --- | --- |
| Каталог установки Binary Ninja | `binja.installDir` | `646ee851f668e308dfd2dbf1d9745b2888f06632266a536bf76f204476d47373` | win32, linux, darwin |
| Python для Binary Ninja | `binja.python` | `72c0f8b7f583c0cde1d36e7226c77e1e19fa94eb49b276ec11b79da9db4f98b8` | win32, linux, darwin |
| Модель магического редактирования | `edit.magic.model` | `6de8b927a695bd640de4b78031e5c452f501ac923daba6b438c2b6e4e8a357be` | win32, linux, darwin |
| Остановка MCP при простое | `mcp.idleStopMinutes` | `8d684bee937dfbac23ee24c4c3f4827f4cf027870fcacc29952e8a8cde606a19` | win32, linux, darwin |
| Общие серверы MCP | `mcp.shared` | `3c4cddb18880b0b560e0447e12fc0fc0122a539434a297ec094d04035dff90e3` | win32, linux, darwin |
| Уведомление консоли | `pty.notify` | `0086d0b6eafd1a8758073b13632d633b5cc66f18bd0b3a856657f8fad70cb86a` | win32, linux, darwin |
| Документация команд в промпте | `tools.commandDocs` | `c7db06c870f8e3668ce5986a57330b7d95152d71cdd3d102e7c1273668951882` | win32, linux, darwin |
| Встроенная справка команд | `tools.commandInline` | `5b5d25a3d0b731510bed4f09acac9fe26f5036bd5a9f08b85dd610b9dac7154e` | win32, linux, darwin |
| Уведомления о монтировании команд | `tools.commandNotices` | `6ab0b50d7c9c8929a906f5620c3c809c19cc3b4e2aac3a9e2270a2b8fb2649c3` | win32, linux, darwin |
| Команды инструментов | `tools.commands` | `fe041d402980637917c86bc873f250b4fd9e0e122ff7cc3ce9cd1260436a51a0` | win32, linux, darwin |

## Обновлены переводы изменившихся настроек (12)

| настройка | путь | новый sourceHash | платформы |
| --- | --- | --- | --- |
| Ретранслятор браузера | `browser.relay` | `84a32ee7a0ed35ce1438c5749dab73131d5d3367f6d56f8a5ab6eaa8f2422135` | win32, linux, darwin |
| URL ретранслятора браузера | `browser.relayUrl` | `ef05af4830e14e568bfb83ca329e1addac3ac9b0affa4aaca049290d0b7263e4` | win32, linux, darwin |
| Авто QA | `dev.autoqa` | `b7856e2838dce38ad71ac3d0fc65b20a31def0d6d17c7fd11fa3ec73dda5f639` | win32, linux, darwin |
| Дизассемблер | `disassembler.backend` | `bad044cd40c7f90ac2c2b6d54fc521ac01f139497a60ef099f3e2bcf1698effc` | win32, linux, darwin |
| Максимум открытых баз данных | `disassembler.maxOpen` | `e629d10d5652855b014de756a5bc03e3630b674c701df09e4e26c7937205a052` | win32, linux, darwin |
| Режим редактирования | `edit.mode` | `7866393741b2bdf8f8684d7b669e6f0092c3d21317286a8e15af2cbb26104579` | win32, linux, darwin |
| Find \(семантический grep\) | `find.enabled` | `5606348fb6573db75bbebdaf1a646af3287a1c9ce2bff65fcce25c76536bd950` | win32, linux, darwin |
| Генерация изображений | `generate_image.enabled` | `bca31aa6edc52b1dc0b38c45966254d059dca20a919a948d17adf0fabb43ef83` | win32, linux, darwin |
| Пространства имён MCP в eval | `mcp.evalNamespaces` | `a84b4cceb4d4e01305d276cc5094ce75a509754d26904675daeca3e80578df17` | win32, linux, darwin |
| Инструменты, исключённые из защиты от циклов вызовов инструментов | `model.toolCallLoopGuard.exemptTools` | `247474ee040bf7c3b2e89e0f83642ff8353739ca3fce8735cf049088812c6071` | win32, linux, darwin |
| Максимальная задержка повтора | `retry.maxDelayMs` | `83515ff59ecc1aa442c8684f00dab28757496b0395faee788c2a3cd62e997396` | win32, linux, darwin |
| Ждать сброса лимита | `retry.waitForUsageReset` | `0ac009212e8432db801b64f035b28c30a5ef82838cf3a3017d73398d786afe85` | win32, linux, darwin |

## Больше не доступны в OMP 19.1.0 (5)

| настройка в OMP | путь | платформы старого хоста |
| --- | --- | --- |
| xd:// Tools | `tools.xdev` | win32, linux, darwin |
| xd:// Prompt Docs | `tools.xdevDocs` | win32, linux, darwin |
| xd:// Inline Devices | `tools.xdevInlineDevices` | win32, linux, darwin |
| xd:// Mount Notices | `tools.xdevNotices` | win32, linux, darwin |
| Complete Scrollback | `tui.completeScrollback` | win32, linux, darwin |

## Покрытие каталога

| OMP | платформа | настройки |
| --- | --- | --- |
| 19.0.0 | win32 | 477/477 |
| 19.0.0 | linux | 477/477 |
| 19.0.0 | darwin | 477/477 |
| 19.0.1 | win32 | 477/477 |
| 19.0.1 | linux | 477/477 |
| 19.0.1 | darwin | 477/477 |
| 19.1.0 | win32 | 482/482 |
| 19.1.0 | linux | 482/482 |
| 19.1.0 | darwin | 482/482 |
