# OMP 18.21.0 → 18.22.0

Релиз 0.33.0. Сводка собрана из принятого каталога базы, каталога кандидата и снимков трёх платформ новой версии; исторические переводы сохранены и не перечисляются.

## Новые настройки на русском (5)

| настройка | путь | sourceHash | платформы |
| --- | --- | --- | --- |
| Дизассемблер | `disassembler.backend` | `0ec47bf44d307a1c73fd46fc472f291ee99d110ceb03b5b376f0dd4c0548eaa0` | win32, linux, darwin |
| Тайм-аут закрытия при простое | `disassembler.idleCloseSec` | `75a40e3f44ed2f16e7b77da9802d62a416635ecd8702d6d6561f7520ff604e85` | win32, linux, darwin |
| Максимум открытых баз данных | `disassembler.maxOpen` | `982d01717f01430af285dd2e8f1e6fe3061e4ed1de58363a315dbf6fd0b04326` | win32, linux, darwin |
| Каталог установки Ghidra | `ghidra.installDir` | `e24292cd4139da1dd384047b3c4439e4a307b2c6331bcfd1698e19912fc55160` | win32, linux, darwin |
| Ghidra Python | `ghidra.python` | `4d64b0f7a742459b7a9205594dffe21da49416041880ed34bd462234ee281652` | win32, linux, darwin |

## Обновлены переводы изменившихся настроек (1)

| настройка | путь | новый sourceHash | платформы |
| --- | --- | --- | --- |
| Worktree при выходе | `worktree.onExit` | `3480f2a332a7e09525d809a96e9fbdc2bc09de89fecbe9df0bccd68579a3c718` | win32, linux, darwin |

## Больше не доступны в OMP 18.22.0 (3)

| настройка в OMP | путь | платформы старого хоста |
| --- | --- | --- |
| IDA Pro | `ida.enabled` | win32, linux, darwin |
| IDA Idle Close Timeout | `ida.idleCloseSec` | win32, linux, darwin |
| IDA Max Open Databases | `ida.maxOpen` | win32, linux, darwin |

## Покрытие каталога

| OMP | платформа | настройки |
| --- | --- | --- |
| 18.20.3 | win32 | 465/465 |
| 18.20.3 | linux | 465/465 |
| 18.20.3 | darwin | 465/465 |
| 18.21.0 | win32 | 466/466 |
| 18.21.0 | linux | 466/466 |
| 18.21.0 | darwin | 466/466 |
| 18.22.0 | win32 | 468/468 |
| 18.22.0 | linux | 468/468 |
| 18.22.0 | darwin | 468/468 |
