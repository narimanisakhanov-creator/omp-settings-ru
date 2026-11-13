# OMP 18.18.9 → 18.19.0

Релиз 0.27.0. Сводка собрана из принятого каталога базы, каталога кандидата и снимков трёх платформ новой версии; исторические переводы сохранены и не перечисляются.

## Новые настройки на русском (4)

| настройка | путь | sourceHash | платформы |
| --- | --- | --- | --- |
| Браузер WebKit | `browser.webkit` | `7761d75fc241971ae7dba9e3a678a9b097bf10dfa957420d4a5c864501dbcbb4` | win32, linux, darwin |
| Путь WebKit браузера | `browser.webkitPath` | `82356332f8826291f095a81bd47f0ed738bf8e8723837e9667e22775dde4dc3d` | win32, linux, darwin |
| Автоматический параллелизм | `task.autoParallel` | `0fb34b979b697036b529ae3d76380c2e4c24d7831563d715b7ad885cb28d4431` | win32, linux, darwin |
| Последовательные шаги задачи | `task.steps` | `891403c96af8b009531bdbfbf41a00d815fd8502ce69cecce17f28251a6511d4` | win32, linux, darwin |

## Обновлены переводы изменившихся настроек (6)

| настройка | путь | новый sourceHash | платформы |
| --- | --- | --- | --- |
| Тайм-аут ask | `ask.timeout` | `fb87367040e8448530267967ea829cea67c3369a9ce7cd2bf1d9a4e13f5c8478` | win32, linux, darwin |
| URL CDP браузера | `browser.cdpUrl` | `75cf424c4f0f7abc69f4be83bbdff334e239eb51f608c441f69d65a10ef8b597` | win32, linux, darwin |
| Браузер | `browser.enabled` | `42099c4cdbb16d6dd7829cd4d1293a255681c7e9f13c2463f9e9ddc3f24ba53e` | win32, linux, darwin |
| Замораживать вкладки браузера при завершении хода | `browser.freezeOnTurnEnd` | `faf563f57bc4280dfdc60e7d53e60a4ecc7a8194e4c9e23c545c94cf43e9979a` | win32, linux, darwin |
| Безголовый браузер | `browser.headless` | `4b735e1d1b2c2368ece07015505bc3a2a11f1f6645e7e8fa6a3202bea64d5c7c` | win32, linux, darwin |
| Браузер Tern | `browser.tern` | `d6a7963663e581f3d27c909c760a62630c331227812e9f7691d185134364075b` | win32, linux, darwin |

## Больше не доступны в OMP 18.19.0 (1)

| настройка в OMP | путь | платформы старого хоста |
| --- | --- | --- |
| Task Instructions from Files | `task.file` | win32, linux, darwin |

## Покрытие каталога

| OMP | платформа | настройки |
| --- | --- | --- |
| 18.18.8 | win32 | 453/453 |
| 18.18.8 | linux | 453/453 |
| 18.18.8 | darwin | 453/453 |
| 18.18.9 | win32 | 453/453 |
| 18.18.9 | linux | 453/453 |
| 18.18.9 | darwin | 453/453 |
| 18.19.0 | win32 | 456/456 |
| 18.19.0 | linux | 456/456 |
| 18.19.0 | darwin | 456/456 |
