# OMP 19.1.1 → 19.2.0

Релиз 0.40.0. Сводка собрана из принятого каталога базы, каталога кандидата и снимков трёх платформ новой версии; исторические переводы сохранены и не перечисляются.

## Новые настройки на русском (3)

| настройка | путь | sourceHash | платформы |
| --- | --- | --- | --- |
| Показ команды Vim | `tui.vimShowCommand` | `98bcf6cdae3975a7115f2ebb6ee42ed0e0a83697020b2b86ea863f324bb58708` | win32, linux, darwin |
| Начальный режим Vim | `tui.vimStartMode` | `08588f66f8da70cab6274c8eba4518acabfe4da1064fd380b1e00aa08c17c7e0` | win32, linux, darwin |
| Копирование в буфер обмена при копировании в Vim | `tui.vimYankToClipboard` | `2159824e0056b56d0cd13d5294a0905a5882143d1022666a1c96d887f40312af` | win32, linux, darwin |

## Обновлены переводы изменившихся настроек (10)

| настройка | путь | новый sourceHash | платформы |
| --- | --- | --- | --- |
| Альтернативные предсказания | `composer.predictionAlternatives` | `aa2c3f1104c98088abeb4613aece64a993cfddd59e73a5f28b733432f9a0561b` | win32, linux, darwin |
| Предсказания в поле ввода | `composer.predictions` | `4ffbf337022af48a99c32ccf9e79118817263d0d976ffc29a1ce62eef69a01bf` | win32, linux, darwin |
| Меню для больших вставок | `paste.largeMenuThreshold` | `e6f1bda82ade6a4cfd4a90d211ca79d319841dc3a26160c6dd0f709fdcf49563` | win32, linux, darwin |
| Автоматический prewalk | `prewalk.auto` | `e4f8c28e10835ac6e2d8b68c7309d7f24be680fd091eff36adc2da1701f9a9ca` | win32, linux, darwin |
| Цель автоматического prewalk | `prewalk.autoTarget` | `ca3a2964b1c39fde36c38223f5c8dcbd8b0759bcc0608d25b8f0dcc3653a9c47` | win32, linux, darwin |
| Модель планирования prewalk | `prewalk.from` | `eaa3985c32e8f294b169a1fa1974e350801a118f09ee3bc77bee7319deff61c5` | win32, linux, darwin |
| Ждать сброса лимита использования | `retry.waitForUsageReset` | `c6bf4010201b9d9c307f3cee044359d6f3749d4d3f3ac29e2aa2db4f3f7547e6` | win32, linux, darwin |
| Фокус по клику мыши | `tui.mouse` | `f3c8ed1665ef359e15d1c0fd06e48243ce52cd647c5aa8e5b88bf0f94e6e8ea9` | win32, linux, darwin |
| Плотная компоновка | `tui.tight` | `5c5a4984976ee744eae97b071753add48cd81bf676047c46ead410d1740e7dde` | win32, linux, darwin |
| Индикатор режима Vim | `tui.vimModeDisplay` | `dccc950d2bb997cb02277d145feeec8c3766aa64d593a500658b1efd92026b76` | win32, linux, darwin |

## Покрытие каталога

| OMP | платформа | настройки |
| --- | --- | --- |
| 19.1.0 | win32 | 482/482 |
| 19.1.0 | linux | 482/482 |
| 19.1.0 | darwin | 482/482 |
| 19.1.1 | win32 | 483/483 |
| 19.1.1 | linux | 483/483 |
| 19.1.1 | darwin | 483/483 |
| 19.2.0 | win32 | 486/486 |
| 19.2.0 | linux | 486/486 |
| 19.2.0 | darwin | 486/486 |
