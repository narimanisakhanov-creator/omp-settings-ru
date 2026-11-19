# OMP 18.22.2 → 19.0.0

Релиз 0.36.0. Сводка собрана из принятого каталога базы, каталога кандидата и снимков трёх платформ новой версии; исторические переводы сохранены и не перечисляются.

## Новые настройки на русском (6)

| настройка | путь | sourceHash | платформы |
| --- | --- | --- | --- |
| Встроенные преобразования MCP | `mcp.builtinTransforms` | `48fff1e8d97416a6189b47a993b199986ca748248d56af8bdb3d6fb2e9231730` | win32, linux, darwin |
| Пространства имён MCP в eval | `mcp.evalNamespaces` | `0271fcabe6f499ff6679ce667ce05f90d26824449da5afdf39ed530fa58c4b82` | win32, linux, darwin |
| Процент сжатия для моста кэша | `providers.cacheWarmingCompactPercent` | `518091892cf3a7bba501828e086354cdc56dd59bd90dc2cff54622dc97596767` | win32, linux, darwin |
| Токены сжатия для моста кэша | `providers.cacheWarmingCompactTokens` | `44c7f9ecf9806049db54123dc94b809a3e45638e2e097b66133b36ccf5049c15` | win32, linux, darwin |
| Стратегия прогрева кэша | `providers.cacheWarmingStrategy` | `55f2b60221283c367bf2b221916a6fafd57831738205111a9cd781c3820e7d67` | win32, linux, darwin |
| Обмен сообщениями агентов между экземплярами | `task.crossInstance` | `fd6dd434026b6df4e330c4fc16a17c038c8c768299f74548a433d14cd2a984b5` | win32, linux, darwin |

## Обновлены переводы изменившихся настроек (5)

| настройка | путь | новый sourceHash | платформы |
| --- | --- | --- | --- |
| Бэкенд изоляции | `isolation.backend` | `1e899fa5bdbfc31f70c50e35c1cb7e4808d540c5d10c4b555988f6f8e1721717` | win32, linux, darwin |
| Двоичный файл ovnfs | `ovnfs.path` | `726dbdbdaaa87c230644d9c1a45cf41fa130487a7758b38f9230aef0c5f16fa6` | win32, linux, darwin |
| Прогрев кэша | `providers.cacheWarming` | `5b6489151ec4344b476990d8e4aa15da3cd6eee7f8733fb6100352d0e9df3f04` | win32, linux, darwin |
| Проверка правок субагентов с помощью LSP | `task.enableLsp` | `b672e7fcd90548744b209f835b8593bbd3337ff665183ad0b72cd37219a39bcd` | win32, linux, darwin |
| Трассировка намерений | `tools.intentTracing` | `54dbe56ae74349d81a61d91ee8498e654f2660ac1df9e5c4bd5c6b86aebb0118` | win32, linux, darwin |

## Покрытие каталога

| OMP | платформа | настройки |
| --- | --- | --- |
| 18.22.1 | win32 | 471/471 |
| 18.22.1 | linux | 471/471 |
| 18.22.1 | darwin | 471/471 |
| 18.22.2 | win32 | 471/471 |
| 18.22.2 | linux | 471/471 |
| 18.22.2 | darwin | 471/471 |
| 19.0.0 | win32 | 477/477 |
| 19.0.0 | linux | 477/477 |
| 19.0.0 | darwin | 477/477 |
