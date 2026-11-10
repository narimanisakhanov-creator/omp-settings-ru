# OMP 18.18.6 → 18.18.7

Релиз 0.24.0. Сводка собрана из принятого каталога базы, каталога кандидата и снимков трёх платформ новой версии; исторические переводы сохранены и не перечисляются.

## Новые настройки на русском (5)

| настройка | путь | sourceHash | платформы |
| --- | --- | --- | --- |
| Автоматическое использование сохранённых сбросов Claude \(5h\) | `claudeResets.autoRedeem5h` | `ea7f3ae8d3c5d6996d504d7a10b917a6eafe1b46ade0fc90c4c4568399e47b73` | win32, linux, darwin |
| Автоматическое использование сбросов Fable в Claude | `claudeResets.autoRedeemFable` | `382c0f97d50b5bfa97963c54955f21f192b504d10722b9702d7b2817e521f463` | win32, linux, darwin |
| Claude: автоматическое использование сохранённых сбросов \(еженедельные\) | `claudeResets.autoRedeemWeekly` | `70053e1e5cead287bbe7cbba679a2e3357b730b6f1861270eb723b2b992e3bae` | win32, linux, darwin |
| Автоматическое использование сохранённых сбросов Codex \(5h\) | `codexResets.autoRedeem5h` | `7b0952ce3dbd2f0f95f986ec654034843cb09071fb3ae3b3f8caf0a422a1c221` | win32, linux, darwin |
| Автоматическое использование сохранённых сбросов Codex \(еженедельно\) | `codexResets.autoRedeemWeekly` | `9a795d3b2c9c5366ad6d11ab13af1456ac6deb003913286581b32b25f284eb13` | win32, linux, darwin |

## Больше не доступны в OMP 18.18.7 (2)

| настройка в OMP | путь | платформы старого хоста |
| --- | --- | --- |
| Claude Auto-Redeem Resets | `claudeResets.autoRedeem` | win32, linux, darwin |
| Codex Auto-Redeem Saved Resets | `codexResets.autoRedeem` | win32, linux, darwin |

## Покрытие каталога

| OMP | платформа | настройки |
| --- | --- | --- |
| 18.18.5 | win32 | 450/450 |
| 18.18.5 | linux | 450/450 |
| 18.18.5 | darwin | 450/450 |
| 18.18.6 | win32 | 450/450 |
| 18.18.6 | linux | 450/450 |
| 18.18.6 | darwin | 450/450 |
| 18.18.7 | win32 | 453/453 |
| 18.18.7 | linux | 453/453 |
| 18.18.7 | darwin | 453/453 |
