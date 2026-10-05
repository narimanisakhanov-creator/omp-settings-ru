import type { SettingTranslation } from "./types";

export const ruPart3: Readonly<Record<string, SettingTranslation>> = {
  "ratchet.enabled": {
    sourceHash: "1379f22f005a4b32982187246a60be28feff0466870b97897124dedae0a92450",
    label: "Ratchet",
    description:
      "Включает преамбулу eval/hillclimb ratchet; /ratchet включает её для текущей сессии",
  },
  "archive.enabled": {
    sourceHash: "49a6eda3b78dc5bb8c78a1e13eac1fe8c4d40dcd9e54650a271af74416883467",
    label: "Archive",
    description:
      "Включает доступную только для чтения преамбулу eval archive: история промптов, недавние проекты, прошлые сессии и сводки",
  },
  "computer.display": {
    sourceHash: "14af977285f7a02466d758697e30a16b5a46a926260fb40d3c033689371f2fc2",
    label: "Дисплей компьютера",
    description: "Объединять все дисплеи или выбрать id нативного дисплея",
  },
  "computer.maxWidth": {
    sourceHash: "8383e8e3add55068a4da3a01af53a7b798068674d0deb77595f42de58fd88613",
    label: "Ширина скриншота компьютера",
    description: "Максимальная ширина составного скриншота в пикселях",
  },
  "computer.maxHeight": {
    sourceHash: "8e7a2ef0f3e68b6ac14a285b89c594229783a34b3d068dda590539a16c62ac01",
    label: "Высота скриншота компьютера",
    description: "Максимальная высота составного скриншота в пикселях",
  },
  "images.questionTimeoutMs": {
    sourceHash: "addb2c58be4eb11390500602f75075398a60ffae7ff3fe3c1ac5546ddb46b078",
    label: "Тайм-аут вопроса к изображению",
    description:
      "Тайм-аут на запрос для вызова vision-модели, лежащего в основе вопросов к изображениям через ?q= в read, в миллисекундах. Зависший провайдер быстро завершается ошибкой тайм-аута вместо блокировки до ручной отмены. Значение 0 отключает тайм-аут.",
    options: {
      "0": { label: "Отключено" },
      "60000": { label: "1 минута" },
      "120000": { label: "2 минуты" },
      "180000": { label: "3 минуты" },
      "300000": { label: "5 минут" },
    },
  },
  "checkpoint.enabled": {
    sourceHash: "c1ac2ea7e3b16f73d3847d4ca6e298385ce96356f8554060bb11e766649c187c",
    label: "Checkpoint/Rewind",
    description:
      "Включает инструменты checkpoint и rewind для создания контрольных точек контекста",
  },
  "fetch.enabled": {
    sourceHash: "a3812338aa54069707c46ae02b581ab34003887fe47b68120bc2a77291bc1ff5",
    label: "Чтение URL",
    description: "Разрешает инструменту read загружать и обрабатывать URL",
  },
  "vault.enabled": {
    sourceHash: "08664fd0c7edb12ff5687e67569ad5331c214cedbc2247ce5f0ae203e7c46069",
    label: "Хранилище Obsidian",
    description:
      "Включает внутренний URL vault:// для чтения и редактирования содержимого хранилища Obsidian через Obsidian CLI. При отключении разрешение vault:// отклоняется, а запись vault:// исключается из системного промпта.",
  },
  "github.enabled": {
    sourceHash: "9ca876b4fd6f9c7dbd61a1e40bbb90374141c3ccaf97792df786db09858ccd82",
    label: "GitHub CLI",
    description:
      "Включает инструмент github (диспетчеризация по op для рабочих процессов с репозиторием, issue, pull request, diff, поиском, checkout, push и наблюдением за Actions)",
  },
  "github.cache.enabled": {
    sourceHash: "ab160d10168af22979ebdaa5bd68d85383e821d5d1314845111850bc5fd165ce",
    label: "Кэш просмотров GitHub",
    description:
      "Кэширует отрендеренный вывод просмотра issue/PR в ~/.omp/cache/github-cache.db, чтобы повторные чтения не требовали запросов",
  },
  "github.cache.softTtlSec": {
    sourceHash: "70c3caa1ba0d5ee08a7cb269945e79de0c6e3d4679c586eb3f542a70e56035dc",
    label: "Мягкий TTL кэша GitHub",
    description:
      "В пределах этого окна кэшированные строки просмотра issue/PR возвращаются напрямую (секунды; по умолчанию 5 минут)",
  },
  "github.cache.hardTtlSec": {
    sourceHash: "45a05ceef6154243258e4078575f8bb91849a7ea8e67114b8cdcd9b47a67880b",
    label: "Жёсткий TTL кэша GitHub",
    description:
      "После мягкого TTL кэшированная строка возвращается и обновляется в фоне; после жёсткого TTL она отбрасывается (секунды; по умолчанию 7 дней)",
  },
  "web_search.enabled": {
    sourceHash: "ba066c16efd466461013095c851604a18d2ec84143dc7065952afb39f64c819c",
    label: "Веб-поиск",
    description: "Включает инструмент web_search для живых результатов из интернета",
  },
  "security.enabled": {
    sourceHash: "6553d71ea29a9008e60ac53124f547167a972e0f60ebddfa5a2e3d6f1d95c7d2",
    label: "Безопасность",
    description:
      "Включает нативное для OMP планирование и выполнение сканирования безопасности, а также доступное только для чтения пространство ресурсов security://",
  },
  "ask.enabled": {
    sourceHash: "bb8b32ffcbbf6766a59673264e610c7f99e7a23c3369fd7be16ffa0e737235cf",
    label: "Ask",
    description: "Включает инструмент ask для интерактивных вопросов пользователю",
  },
  "tools.intentTracing": {
    sourceHash: "c3bc5fc30301eb49b3cc478dbb62b7782646274d8b03d80334b189e35aa34d82",
    label: "Трассировка намерений",
    description:
      "Просит агента описывать намерение каждого вызова инструмента перед его выполнением",
  },
  "tools.abortOnFabricatedResult": {
    sourceHash: "1147a3e5a734d140cf86a651cb2306223b3d07d70c3c120e0a98fa6a4a37ffc1",
    label: "Прерывать при выдуманном результате инструмента",
    description:
      "При внутриполосных вызовах инструментов немедленно останавливает модель, когда она начинает галлюцинировать результат инструмента посреди хода. Отключите, чтобы модель завершила генерацию, а выдуманное продолжение было отброшено.",
  },
  "tools.speculativeExecution.enabled": {
    sourceHash: "1f12be3843248d818e2a96881948136db49be31aae37d0bcc45ebc68dc1eacfa",
    label: "Экспериментальное спекулятивное выполнение",
    description:
      "Включает безопасную для отбрасывания первую часть: проверенные локальные чтения через прямые вызовы read и вложенный eval. Сетевые запросы, генерации провайдеров и живые записи в файловую систему в эту базовую версию не входят.",
  },
  "tools.speculativeExecution.maxInFlight": {
    sourceHash: "769d65e3ef81d91c0623a45f5fdc1d04d31c52d58649715cdf5f5a6b4ddd6728",
    label: "Параллелизм спекулятивного выполнения",
    description:
      "Максимальное число проверенных локальных чтений, разрешённых до обычной диспетчеризации.",
    options: {
      "1": { label: "1 операция" },
      "2": { label: "2 операции" },
      "3": { label: "3 операции" },
      "4": { label: "4 операции" },
    },
  },
  "tools.maxTimeout": {
    sourceHash: "4ae951013b8cae2104bd06404f0815d540f264609dd1a8df0e1f63e4e66fb787",
    label: "Максимальный тайм-аут инструмента",
    description:
      "Максимальный тайм-аут в секундах, который агент может задать для любого инструмента (0 = без ограничения)",
    options: {
      "0": { label: "Без ограничения" },
      "30": { label: "30 секунд" },
      "60": { label: "60 секунд" },
      "120": { label: "120 секунд" },
      "300": { label: "5 минут" },
      "600": { label: "10 минут" },
    },
  },
  "async.enabled": {
    sourceHash: "0e13bc50485d1cd091849fbf92c0693937819ac5de4217dd8b87174a0d27debe",
    label: "Асинхронное выполнение",
    description: "Включает асинхронные команды bash и фоновое выполнение задач",
  },
  "tools.xdev": {
    sourceHash: "967e3918eb22bfdbe19aa8626b6592ee3414bd6d3bc7443f0e8e40d7d774340a",
    label: "Инструменты xd://",
    description:
      "Монтирует редко используемые (обнаруживаемые) инструменты под URL устройств xd://, управляемые через read/write, вместо передачи их схем в каждом запросе. Сессии, чей явный список инструментов даёт read, но не даёт write, монтируют устройства через транспорт write только для устройств (записи в файловую систему по-прежнему отклоняются). Отключите, чтобы выставить каждый включённый инструмент на верхнем уровне.",
  },
  "tools.xdevDocs": {
    sourceHash: "fc6e5da19feb97bd9399025f7981b9f82f188ba78c7584ca7067dce60849414f",
    label: "Документация промпта xd://",
    description:
      "Выберите, какие документация и схемы смонтированных устройств встраиваются в системный промпт. Built-ins оставляет основные инструменты встроенными, а инструменты MCP и расширений — по запросу.",
    options: {
      inline: {
        label: "Все устройства",
        description: "Встраивать документацию и схемы для каждого смонтированного устройства.",
      },
      builtins: {
        label: "Только встроенные",
        description:
          "Встраивать документацию встроенных инструментов; документацию MCP и расширений загружать по запросу.",
      },
      catalog: {
        label: "Только каталог",
        description: "Перечислять каждое устройство; загружать всю документацию по запросу.",
      },
    },
  },
  "tools.xdevInlineDevices": {
    sourceHash: "0279fc44afe81a76385f0de3555d15690d7477cf369022522bab6be5bd0cb847",
    label: "Встроенные устройства xd://",
    description:
      "Когда для документации промпта xd:// выбран режим «Только встроенные», встраивает динамические устройства, имена которых соответствуют этим glob-шаблонам (например, mcp__context_mode_*). Режим «Только каталог» игнорирует эту настройку.",
  },
  "dev.autoqa": {
    sourceHash: "2e0cddc4aea537ccce57783673e733efb69a641d2202909d0286b5511c973616",
    label: "Авто QA",
    description:
      "Автоматические отчёты о проблемах с инструментами (xd://report_issue). Включено по умолчанию; первый отчёт запрашивает согласие, а отказ отключает отчёты до явного повторного включения",
  },
  "dev.autoqaPush.endpoint": {
    sourceHash: "0052808da5e30bce03ee74bfce70aeb4d07528a7ad6c1d8e7cb30f0e1301d2c4",
    label: "Конечная точка отправки Auto QA",
    description:
      "Полный URL, принимающий JSON-отчёты Auto QA (по умолчанию https://qa.omp.sh/v1/grievances)",
  },
  "lsp.enabled": {
    sourceHash: "c01d690f5c32a9df560e180ced8e7f2f11f658097097e251a2576a8ada2f28e6",
    label: "LSP",
    description:
      "Включает инструмент lsp для анализа кода (определения, ссылки, диагностика, переименование)",
  },
  "lsp.lazy": {
    sourceHash: "5e5740595487c2c62b0154cba12ccd13ef68858bf8069cd509f21fc72a9eb419",
    label: "Ленивый запуск LSP",
    description:
      "Запускать языковые серверы при первом использовании (инструмент lsp или редактирование файла подходящего типа) вместо запуска в начале сессии",
  },
  "lsp.shared": {
    sourceHash: "218b9222cfe3848219373cc6045062f421cb9a23560c461df245a0460bb8e46c",
    label: "Общие языковые серверы",
    description:
      "Делить один языковой сервер на проект между экземплярами omp через брокер демона (при недоступности переключается на приватные серверы)",
  },
  "lsp.formatOnWrite": {
    sourceHash: "37df220d69eae80d57e2a2c0f38e185e41db58745eac1fe47066be3402d24388",
    label: "Форматирование при записи",
    description: "Автоматически форматировать файлы кода через LSP после записи",
  },
  "lsp.diagnosticsOnWrite": {
    sourceHash: "aa805d257b30073401ecce426d2853155f241a1d4b1205aa2cfdef99ea2edf20",
    label: "Диагностика при записи",
    description: "Возвращать диагностику LSP после записи файлов кода",
  },
  "lsp.diagnosticsOnEdit": {
    sourceHash: "47a375749cc8d0092ddae06daf69cf29b2cf3471c67fce158810bbd6b8816f52",
    label: "Диагностика при редактировании",
    description: "Возвращать диагностику LSP после редактирования файлов кода",
  },
  "lsp.diagnosticsDeduplicate": {
    sourceHash: "5867f78d2c7198fb59c1197a5fd9280179f594ffdcb73dfc0eaaabaa30d2371e",
    label: "Дедупликация диагностики",
    description:
      "Подавлять диагностику LSP после правки, уже показанную для файла; выводить только новые или изменившиеся",
  },
  "bash.enabled": {
    sourceHash: "1f63445b202b78689e32c6f33af34e0db150e3e7ee83ed874adf0d2f7bf4c1fe",
    label: "Bash",
    description: "Включает инструмент bash для выполнения команд оболочки",
  },
  "bash.allowCompoundCommands": {
    sourceHash: "1fde7f22fa33d2b89f13823aeb39413637be5d60710e95e7adb3846cb99f147a",
    label: "Разрешить составные команды",
    description:
      "Оценивать буквальные цепочки && по каждой команде; несовпавшие команды используют обычную политику и режим подтверждения bash",
  },
  "bash.autoBackground.enabled": {
    sourceHash: "c2b67b462c2209f7b053ba2f287aeeebacd8ba9f072ada978b0aee8e3febcb4e",
    label: "Автофон для Bash",
    description:
      "Автоматически переводить долго выполняющиеся команды bash в фон и доставлять результат позже",
  },
  "bash.patterns": {
    sourceHash: "b3c7393b092c5e16454ad55d3bd507a40628576ff4dcaa88ef5e959d0da6ed6b",
    label: "Шаблоны подтверждения Bash",
    description:
      "Упорядоченные правила подтверждения команд bash. Каждый элемент имеет поля match и approval; поддерживаются только подстановочные знаки '*'.",
  },
  "bashInterceptor.enabled": {
    sourceHash: "9f06ea4cf1e208ea01a55f837a5baaba9463003605a5567efa1ab12dd0e709ff",
    label: "Перехватчик Bash",
    description: "Блокировать команды оболочки, для которых есть отдельные инструменты",
  },
  "bash.direnv": {
    sourceHash: "9656ed2f308c4358e9d1f8e40cefac08b345513f3ff88947a17343b58def2872",
    label: "Автозагрузка direnv",
    description:
      "Автоматически загружать `.envrc` из direnv/devenv репозитория в сессию bash, чтобы инструменты и переменные окружения devenv были доступны без ручного `direnv exec`. Учитывает список разрешённых direnv: `.envrc`, для которого не выполнен `direnv allow`, никогда не выполняется",
  },
  "bash.direnvLoadTimeoutMs": {
    sourceHash: "f60138de40811fdfaa27de944e738ca7f22f05f98161752f7e66fec8cccfd89b",
    label: "Тайм-аут загрузки direnv (мс)",
    description:
      "Максимальное ожидание первого `direnv export` (холодная оболочка devenv может запускаться медленно); при тайм-ауте сессия работает без окружения direnv",
  },
  "shellMinimizer.enabled": {
    sourceHash: "7d1d42845464a834e003deaebb23307815ade47face9053f86ed01ebcafcfb30",
    label: "Минимизатор вывода оболочки",
    description:
      "Сжимать многословный вывод оболочки (git, npm, cargo и т. д.) перед возвратом агенту",
  },
  "shellMinimizer.sourceOutlineLevel": {
    sourceHash: "6030471b3459c8f2d696960dd824b202c2236e0f1da58680060f42e051552887",
    label: "Структура исходников минимизатора",
    description:
      "Режим структуры исходников для cat/read исходных файлов: default или aggressive",
  },
  "eval.py": {
    sourceHash: "0740fbb1dc94dc8f443f3d69914e248de9580e4d2c1c64e6d3f28609c8b67d05",
    label: "Бэкенд eval для Python",
    description: "Разрешает инструменту eval отправлять ячейки Python в ядро IPython",
  },
  "eval.js": {
    sourceHash: "a17fdd6073eae8d7798a4bb1acae60498fc8ceba1cc2f6ca72696c9c5973b060",
    label: "Бэкенд eval для JavaScript",
    description:
      "Разрешает инструменту eval отправлять ячейки JavaScript во внутрипроцессную среду выполнения",
  },
  "eval.autoProvision": {
    sourceHash: "3b6718dd13b8f1f01c6e6ec661df0a47a82a9326ea61a7c1a3fb0d130afed24b",
    label: "Подготовка окружения eval",
    description:
      "Автоматически создавать управляемое окружение пакетов JavaScript для eval при первой установке",
  },
  "eval.tools.enabled": {
    sourceHash: "2e96c57ce727cdfeecb7574f8168793d3190c77d0081cfca527e44e7a7b98653",
    label: "Инструменты, определённые в eval",
    description:
      "Позволяет ячейкам eval определять инструменты (@tool в Python, tool(fn) в JS), которые могут вызывать субагенты task, agent() и workpool()",
  },
  "eval.workpool.freshAgents": {
    sourceHash: "5cf133fe8c2932fdb481d45a2c847a85f873d1801ee92d569999a3f5ed589482",
    label: "Новые агенты для workpool",
    description:
      "Создавать нового субагента для каждого элемента workpool вместо повторного использования воркеров или пакетной обработки элементов в очереди",
  },
  "eval.autoBackground.enabled": {
    sourceHash: "d0713760429801c3e288d9352e75b925d8d1242388ca38c19a6670d00f3dc032",
    label: "Автофон для eval",
    description:
      "Автоматически переводить долго выполняющиеся ячейки eval в фон и доставлять результат позже",
  },
  "python.kernelMode": {
    sourceHash: "69392022c21bd03be4e91ab9e57071b19d0406a0a44e0f7087a1d984f722270b",
    label: "Режим ядра Python",
    description:
      "Сохранять ядро IPython между вызовами eval или запускать новое каждый раз",
  },
  "python.interpreter": {
    sourceHash: "a29d689afcc75e70919d2ac226090eb23562e9bae59e3048819c7a675242e41e",
    label: "Интерпретатор Python",
    description:
      "Необязательный путь к конкретному исполняемому файлу Python. Если задан, автоматический поиск среды выполнения Python пропускается.",
  },
  "task.isolation.enabled": {
    sourceHash: "961516429072948ae8177dacbf8f2e54c09d5487d2882af0b03161abcd0481bc",
    label: "Изолировать субагентов",
    description:
      "Запускать субагентов в изолированной копии рабочей копии и затем интегрировать их изменения",
  },
  "isolation.backend": {
    sourceHash: "a72b13a07a5e5f80c984f1d49464f393abad0fc62bee9bef516e11b314ab1003",
    label: "Бэкенд изоляции",
    description: "Бэкенд, используемый для изоляции субагентов и клонирования рабочих деревьев",
    options: {
      auto: {
        label: "Авто",
        description: "Позволить PAL выбрать лучший доступный бэкенд",
      },
      apfs: {
        label: "APFS",
        description: "clonefile-рефлинк macOS (APFS)",
      },
      btrfs: {
        label: "btrfs",
        description: "снимок подтома btrfs",
      },
      zfs: {
        label: "ZFS",
        description: "снимок + клон ZFS",
      },
      reflink: {
        label: "Reflink",
        description: "пофайловый рефлинк FICLONE в Linux",
      },
      overlayfs: {
        label: "Overlayfs",
        description: "оверлей ядра Linux (или запасной fuse-overlayfs)",
      },
      projfs: {
        label: "ProjFS",
        description: "Проецируемая файловая система Windows (Projected File System)",
      },
      "block-clone": {
        label: "Блочное клонирование",
        description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
      },
      rcopy: {
        label: "Рекурсивное копирование",
        description: "git worktree, если доступно, иначе рекурсивное копирование",
      },
    },
  },
  "worktree.clone": {
    sourceHash: "d8a9c9137dafe7fff714dbf7a5e96ebbc085844fae59f395fab97797c66cbe54",
    label: "Клонировать рабочую копию в рабочие деревья",
    description:
      "Новые рабочие деревья из `github pr_checkout` и `git worktree add` в bash создаются как клон текущей рабочей копии с копированием при записи, чтобы игнорируемые артефакты сборки (node_modules, target) переносились; если файловая система не поддерживает клонирование, используется обычная рабочая копия",
  },
  "worktree.cleanSource": {
    sourceHash: "4d35f684560894da43ae06091cb785ce2eabf253f82d0ebd7457653fdbb05f69",
    label: "Очищать исходную рабочую копию при /wt",
    description:
      "При создании рабочего дерева командой `/wt` сбрасывать отслеживаемые изменения и удалять неотслеживаемые файлы из исходной рабочей копии после их переноса",
  },
  "task.isolation.apply": {
    sourceHash: "29b0ef82b835bcb7152164aa0d30db8cb8a91bf456bf4c507491fb94d1e5a9a3",
    label: "Применять изолированные изменения",
    description:
      "Автоматически применять успешные изменения изолированных задач к родительской рабочей копии; отключите, чтобы сохранять артефакты патча или ветки",
  },
  "task.isolation.merge": {
    sourceHash: "5d6d1060c2a5cbc608e60748c3ea42ac6ed41943a711eb1e55db43792613ce33",
    label: "Стратегия слияния изоляции",
    description:
      "Как интегрируются изменения изолированных задач (применение патча или слияние ветки)",
    options: {
      patch: {
        label: "Патч",
        description: "Объединить диффы и git apply",
      },
      branch: {
        label: "Ветка",
        description: "Коммит на задачу, слияние с --no-ff",
      },
    },
  },
  "task.isolation.commits": {
    sourceHash: "cb32c805ae83830fb3a1e7161435ca2a405b14ed1bdf51ff8e0e7b848cbcc551",
    label: "Стиль коммитов изоляции",
    description:
      "Стиль сообщений коммитов для изменений во вложенных репозиториях (общий или сгенерированный ИИ)",
    options: {
      generic: {
        label: "Общий",
        description: "Статичное сообщение коммита",
      },
      ai: {
        label: "ИИ",
        description: "Сообщение коммита, сгенерированное ИИ по диффу",
      },
    },
  },
  "worktree.base": {
    sourceHash: "67235636a9eb78f6579823fd7379d25d76f743951cee9ce7c8df3c5dfa06ebf3",
    label: "Базовая папка рабочих деревьев",
    description:
      "Базовая папка для управляемых агентом рабочих деревьев — здесь находятся копии для изоляции задач, клоны PR из `github` и результаты очистки `omp worktree`. Если не задано, используется ~/.omp/wt. Должен быть абсолютным путём или путём относительно ~; относительные пути игнорируются. Переменная окружения OMP_WORKTREE_DIR переопределяет это.",
  },
  "task.eager": {
    sourceHash: "bb8fdeff73b831ee5a5ed25b4aa5696b2565a6c6c7a27ac6c5a196e1c2b367c7",
    label: "Предпочитать делегирование задачам",
    description: "Насколько настойчиво подталкивать к делегированию работы субагентам",
    options: {
      default: {
        label: "По умолчанию",
        description:
          "Использует политику выбранной модели; некоторые модели требуют явного запроса на делегирование",
      },
      preferred: {
        label: "Предпочтительно",
        description: "Добавляет указания о делегировании в системный промпт",
      },
      always: {
        label: "Всегда",
        description: "Указания в промпте плюс напоминание о делегировании в первом ходе",
      },
    },
  },
  "task.batch": {
    sourceHash: "17bcb5f41d9b1a207ef70fb90e66837f42e4d09f881b8b4aaec9d1fc9a82c791",
    label: "Пакетные вызовы task",
    description:
      "Переключает инструмент task в пакетную форму: один вызов несёт { context, tasks[] } — по одному субагенту на элемент, с необязательным полем agent для каждого элемента (по умолчанию — агент из политики spawn сессии), изоляцией для каждого элемента и обязательным общим контекстом, добавляемым перед каждым заданием. При async.enabled=true каждый spawn выполняется как независимый фоновый агент с обычным жизненным циклом idle/parked; иначе вызов блокируется до получения объединённых результатов. Отключите, чтобы вернуть плоскую схему с одним spawn.",
  },
  "task.speculativeLaunch": {
    sourceHash: "4d56c27d953d31f2b1a7b43d273f225333924f9ed1ec72e5f7b45b3ae5542de5",
    label: "Спекулятивный запуск задач",
    description:
      "Запускать каждого субагента пакета, как только его элемент tasks[] завершит потоковую передачу, вместо ожидания всего вызова task. Запущенные агенты прерываются, если завершённый вызов не проходит проверку, блокируется или его аргументы меняются. Требует автоматически разрешённого подтверждения task и отсутствия обработчиков жизненного цикла инструментов расширений.",
  },
  "task.enableEffort": {
    sourceHash: "d6d2b80e6c10272591a12b32e3300b7c3973c280ab811c1c8978d3977ba5681c",
    label: "Усилие на задачу",
    description:
      "Открывает необязательный параметр effort при запуске task, позволяя вызывающим переопределять уровень размышлений каждого субагента",
  },
  "task.maxConcurrency": {
    sourceHash: "ce17d1cc5a19a4ca6fc5aa40ba6e5a029f71a3b6134872f9bec8944af8ba2085",
    label: "Макс. одновременных задач",
    description: "Максимальное число одновременно работающих субагентов",
    options: {
      "0": { label: "Без ограничения" },
      "1": { label: "1 задача" },
      "2": { label: "2 задачи" },
      "4": { label: "4 задачи" },
      "8": { label: "8 задач" },
      "16": { label: "16 задач" },
      "32": { label: "32 задачи" },
      "64": { label: "64 задачи" },
    },
  },
  "task.enableLsp": {
    sourceHash: "8266d8ac4042f7ed00343ee380bfbfaaf546d874f1d485ee8177ecba2777d702",
    label: "LSP в субагентах",
    description:
      "Разрешает субагентам, запущенным через инструмент task, использовать инструмент lsp. По умолчанию выключено, чтобы субагенты оставались дешёвыми; включайте, когда делегирование с поддержкой LSP стоит дополнительных токенов.",
  },
  "task.maxRecursionDepth": {
    sourceHash: "d0d14939c269a02a443d715b757fe1d63925815b7d48add13466ee3b81a63f15",
    label: "Макс. рекурсия задач",
    description: "На сколько уровней вглубь субагенты могут запускать собственных субагентов",
    options: {
      "-1": { label: "Без ограничения" },
      "0": { label: "Нет" },
      "1": { label: "Одинарная" },
      "2": { label: "Двойная" },
      "3": { label: "Тройная" },
    },
  },
  "task.maxRuntimeMs": {
    sourceHash: "73bc196419f85ccb253cb09ead1c711119a80996505eb6cad39cef51d7a9baa8",
    label: "Макс. время работы субагента",
    description:
      "Жёсткий лимит астрономического времени на субагента (мс). 0 отключает его. Дополнительная защита от зависаний потока на стороне провайдера, которые не перехватывает сторожевой таймер слоя инференса; запускает обычное прерывание субагента с причиной 'timed out'.",
    options: {
      "0": { label: "Без ограничения", description: "По умолчанию" },
      "300000": { label: "5 минут" },
      "900000": { label: "15 минут" },
      "1800000": { label: "30 минут" },
      "3600000": { label: "1 час" },
    },
  },
  "task.completionProbe": {
    sourceHash: "ab0ab9a8f42b5887eb815035a739eb7e9e522b4903b28eec8434f1c8d0b0a75b",
    label: "Опрос готовности субагента",
    description:
      "Просит работающего субагента через кэшированный побочный запрос вроде /btw оценить, насколько выполнена его задача: через 2, 5, 10 и 30 минут, затем ежечасно. Оценка отображается рядом с субагентом в представлениях wait и task. Опрашиваются только субагенты, запущенные главным агентом интерактивной сессии; в запусках print, RPC, ACP и SDK опрос никогда не выполняется.",
  },
  "task.agentIdleTtlMs": {
    sourceHash: "7efe60eca2665ba425a6142bd1e079e58bc8ec54a757aef5fd375820de5adae5",
    label: "TTL простоя агента",
    description:
      "Как долго простаивающий субагент остаётся в памяти до выгрузки на диск (мс). Выгруженные агенты автоматически возобновляются при отправке сообщения или возобновлении. 0 держит простаивающих агентов в памяти до выхода.",
  },
  "task.softRequestBudget": {
    sourceHash: "5d5687ce00353539149e55ba47f459454a0dc94f262b3e9d93161fe7893ead74",
    label: "Мягкий бюджет запросов субагента",
    description:
      "Мягкий бюджет запросов на субагента (запросов ассистента за запуск). Его превышение вставляет уведомление-указание о завершении (см. task.softRequestBudgetNotice); при 1.5x бюджета запуск принудительно останавливается, и агент должен вернуть частичные результаты. 0 отключает защиту. Встроенные агенты scout/sonic ограничены более низким встроенным бюджетом, поэтому значение ниже этого предела всё равно применяется к ним.",
    options: {
      "0": { label: "Отключено" },
      "90": { label: "90 запросов" },
      "150": { label: "150 запросов" },
      "200": { label: "200 запросов", description: "По умолчанию" },
    },
  },
  "task.softRequestBudgetNotice": {
    sourceHash: "3adaf04182af3621d6c460cf0798d657ebef652c1d2e3d77adecc5038f0f9c77",
    label: "Уведомление о мягком бюджете запросов",
    description:
      "Вставляет одно уведомление-указание, когда субагент превышает свой мягкий бюджет запросов, прося его завершиться до принудительной остановки на 1.5x.",
  },
  "task.maxEffort": {
    sourceHash: "60bcb5e4c2ba6ad9559407914d34a072ed21bf640595a261e53eb2cb55c0571d",
    label: "Максимальное усилие на запуск",
    description:
      "Максимальное усилие рассуждений, разрешённое для подсказки effort при каждом запуске инструмента task. Меньшие значения не дают вызывающим поднять субагентов выше этого потолка; значение по умолчанию сохраняет полный диапазон модели.",
    options: {
      minimal: {
        label: "мин",
        description: "Очень краткие рассуждения (~1k токенов)",
      },
      low: {
        label: "низкое",
        description: "Лёгкие рассуждения (~2k токенов)",
      },
      medium: {
        label: "среднее",
        description: "Умеренные рассуждения (~8k токенов)",
      },
      high: {
        label: "высокое",
        description: "Глубокие рассуждения (~16k токенов)",
      },
      xhigh: {
        label: "очень высокое",
        description: "Расширенные рассуждения (~32k токенов)",
      },
      max: {
        label: "максимум",
        description: "Максимальные рассуждения, поддерживаемые моделью",
      },
    },
  },
  "task.prewalk": {
    sourceHash: "b43f65ff12cb93bed1674fc6b717e7a8cdac07d78ad989630c2fb2483514661d",
    label: "Prewalk для общей задачи",
    description:
      "Включает prewalk для встроенного общего субагента `task`: он стартует на своей выбранной модели, планирует и начинает реализацию, а затем при первой правке/записи передаёт работу роли 'smol'. Переопределения на уровне агента (task.agentPrewalk, настраивается в центре /agents) и frontmatter `prewalk` пользовательского агента применяются независимо от этого переключателя.",
  },
  "task.showResolvedModelBadge": {
    sourceHash: "6eb1ab3a971b693f3457fe6dccf17ce504a02bca1b50595e4e2c726ed4f29b37",
    label: "Показывать бейдж выбранной модели",
    description:
      "Отображать фактический ID модели, используемой каждым субагентом, в строке состояния виджета task",
  },
  "plan.enabled": {
    sourceHash: "3ccd9f953d421df50fea843172f59f3785b4371ea11cb93c757642da94df63cc",
    label: "Режим планирования",
    description:
      "Включает режим планирования для исследования только для чтения и планирования перед выполнением",
  },
  "plan.defaultOnStartup": {
    sourceHash: "df706732ab4a9d9bd84663495ebdc6ea12a44ca13b84899925dc8453a32f2015",
    label: "Начинать в режиме планирования",
    description: "Автоматически входить в режим планирования в начале каждой новой сессии",
  },
  "plan.autosave": {
    sourceHash: "147992d843174000afa0bd4e2a4e72a874047e4de252f5b65bfdfae69c5b5e13",
    label: "Автосохранение планов",
    description:
      "Автоматически сохранять утверждённые планы на диск по завершении режима планирования",
  },
  "plan.autosaveDir": {
    sourceHash: "251c61a6727af91357e6c9d81d63f8426f6246c83344a7632e8a5b39a21eb7ea",
    label: "Папка автосохранения",
    description:
      "Папка для автосохраняемых планов. Поддерживает пути с ~, абсолютные и относительные к текущей рабочей папке. Пустое значение использует <project>/.omp/plans/.",
  },
  "goal.enabled": {
    sourceHash: "cd2485a44d3d132e0bdd9b973d5e3b6c13e03906f325a639c5dccad4e77cd9cb",
    label: "Режим цели",
    description: "Включает режим цели для каждой сессии и скрытый инструмент goal",
  },
  "goal.statusInFooter": {
    sourceHash: "f79ee9825f6b0853c63d3384feeca79e75a60c80fa6a138ba114d037f3aaa68d",
    label: "Статус цели в нижней строке",
    description: "Показывать бюджет токенов рядом с индикатором цели в строке состояния",
  },
  "goal.continuationModes": {
    sourceHash: "f682c90f561a3724b25a7789afdf1a511a4bce73f977c9821d69365bed71c45b",
    label: "Режимы продолжения цели",
    description:
      "Режимы запуска, в которых активные цели могут автоматически продолжаться между ходами («interactive», «rpc»)",
  },
  "title.refreshOnReplan": {
    sourceHash: "c4d0ddfc9508070a1c0e61aa121c283a51f4b54655631b3b778b67bb19d2181f",
    label: "Обновлять заголовок при перепланировании",
    description:
      "Обновлять сгенерированные заголовки сессий после перепланирования при инициализации todo, если заголовок не задан пользователем",
  },
  "skills.registryUrl": {
    sourceHash: "200d719bfb211f0a94c1b7ab1091c503171445d23ea07ea7d1dd872ea03c0fe5",
    label: "Реестр навыков",
    description:
      "Реестр Skillshare, используемый `omp skill` для установки, поиска и публикации навыков (https://host[:port])",
  },
  "skills.enableSkillCommands": {
    sourceHash: "91e7a8c3ed5d25d9d3abd3ffe30abe60ea1143ac74be084920c31ca5e36ef5fb",
    label: "Команды навыков",
    description: "Регистрировать навыки как команды /skill:name",
  },
  "commands.enableClaudeUser": {
    sourceHash: "42ad62f2672993a04a1d315376a40c8dfb586ab14d1f1a3b4c379860c1b41da8",
    label: "Пользовательские команды Claude",
    description: "Загружать команды из ~/.claude/commands/",
  },
  "commands.enableClaudeProject": {
    sourceHash: "2028517c23cd4af83388b1d356dc518c338d6eb9c9ed0408ebfada79222dd6ee",
    label: "Команды проекта Claude",
    description: "Загружать команды из .claude/commands/",
  },
  "commands.enableOpencodeUser": {
    sourceHash: "1c67a4c03dbfc5cb2a5a39c384d7310a94d94b9a6724b57f0a338f69f1bc4c7a",
    label: "Пользовательские команды OpenCode",
    description: "Загружать команды из ~/.config/opencode/commands/",
  },
  "commands.enableOpencodeProject": {
    sourceHash: "8d969f229c2f64d8cbde0728ac4ce02493e8c772c97b0352ad2e774cfd89e8bd",
    label: "Команды проекта OpenCode",
    description: "Загружать команды из .opencode/commands/",
  },
  "extensionHandlers.toolCallTimeoutMs": {
    sourceHash: "551d60ebd73f65ea6878dd7f2a3f7292931a7f3ea46fea182406d2cfaf6421cb",
    label: "Тайм-аут обработчика вызова инструмента (мс)",
    description:
      "Положительный конечный тайм-аут активной работы для обработчиков tool_call расширений; недопустимые значения используют 30000 мс, а время ожидания диалогов, принадлежащих OMP, не учитывается",
  },
  "exa.enabled": {
    sourceHash: "5a66dfa0a96cf97339fd5cfd18e9eb1407acb26cac80740917120ddc7481d936",
    label: "Exa",
    description: "Включает провайдера веб-поиска Exa",
  },
  "exa.searchDelayMs": {
    sourceHash: "03b8b528a370b1d198a16cdcade9669031441eaf69f113f043dbe03704796db8",
    label: "Задержка поиска Exa",
    description:
      "Минимальная задержка между запросами веб-поиска Exa в миллисекундах; значение 0 отключает ограничение частоты",
  },
  "searxng.endpoint": {
    sourceHash: "fde08e7f87eb56f04a268c87b7e20e8fe6e223f9623dda54602f575cd85e556c",
    label: "Конечная точка SearXNG",
    description:
      "Базовый URL самостоятельно размещённого экземпляра SearXNG, используемого для веб-поиска",
  },
  "browser.enabled": {
    sourceHash: "9a40a3d49291aca625cad9b74b5cefdf7a8226e527286f22819835830e252129",
    label: "Браузер",
    description:
      "Включает преамбулу eval для браузера для сценариев автоматизации Chromium (Puppeteer)",
  },
  "browser.cdpUrl": {
    sourceHash: "941af626f521a3da139ff1a08a75fe114ac545c1435070096810f16a01a404ce",
    label: "CDP URL браузера",
    description:
      "Конечная точка обнаружения HTTP CDP по умолчанию (например, http://127.0.0.1:9222) для подключения вместо запуска браузера. Явные app.cdp_url или app.path в вызове инструмента имеют приоритет.",
  },
  "browser.relay": {
    sourceHash: "e511bad991ea61d39fbf1eaf2bad8df691c4083d87cc335fe951c481b5765988",
    label: "Ретранслятор браузера",
    description:
      "Управляйте собственными вкладками Chrome через ретранслятор браузера omp. Установите расширение один раз (`omp browser-relay install`); сервер ретрансляции запускается автоматически, когда он нужен преамбуле браузера. Имеет приоритет над CDP URL браузера; задайте PI_BROWSER_RELAY=0 или PI_BROWSER_RELAY=1 для переопределения.",
  },
  "browser.relayUrl": {
    sourceHash: "6b961b3c49b9ab178a7ee5aa2b8811ea5ee3726af557a0eb72020d573f234c27",
    label: "URL ретранслятора браузера",
    description: "Конечная точка ретранслятора браузера omp (по умолчанию http://127.0.0.1:9224).",
  },
  "browser.headless": {
    sourceHash: "70e1b1b75f1c02e3665fd018bedf6bf384da574c644913544bdef72cdd804577",
    label: "Безголовый браузер",
    description:
      "Запускать браузер в безголовом режиме (отключите, чтобы показывать интерфейс браузера)",
  },
  "browser.cmux": {
    sourceHash: "ff40bf2a738e51226c5bae4dd1744c0ae00938d77e000bb3a1c2862201901539",
    label: "Браузер cmux",
    description:
      "Использовать поверхности cmux WKWebView для автоматизации браузера, когда доступен сокет cmux. Задайте PI_BROWSER_CMUX=0 или PI_BROWSER_CMUX=1 для переопределения.",
  },
  "browser.tern": {
    sourceHash: "d47907979a3e419cc7b0946a0e51675354af6c0f07826bc46399dc1085d6c544",
    label: "Браузер Tern",
    description:
      "Внутри панели Tern открывать вкладки браузера как картинку в картинке поверх панели omp (нативное веб-представление) вместо безголового Chromium; при отсутствии окна Tern, способного их разместить, происходит возврат к Chromium. Явные параметры app, ретранслятор и CDP URL браузера имеют приоритет; headed:false или app.tern:false исключает одно открытие. Задайте PI_BROWSER_TERN=0 или PI_BROWSER_TERN=1 для переопределения.",
  },
  "browser.freezeOnTurnEnd": {
    sourceHash: "4277a2304699c39a135dfc0706b3e20347f6ffec2d72f737b055432131d1ea00",
    label: "Замораживать вкладки браузера при завершении хода",
    description:
      "Замораживать безголовые вкладки браузера, принадлежащие OMP, когда ход завершается, чтобы анимированные страницы перестали расходовать CPU/GPU в простое. Вкладки размораживаются автоматически при следующем использовании; передайте persist:true при открытии, чтобы исключить вкладку.",
  },
  "browser.idleCloseSec": {
    sourceHash: "20a877089331e6c8fc135da9a6214ea29ea256e191d577e72e61ba05c28e7ed8",
    label: "Тайм-аут закрытия простаивающего браузера",
    description:
      "Закрывать безголовые вкладки браузера, принадлежащие OMP, и картинку в картинке браузера Tern, простаивающие дольше указанного числа секунд (0 = никогда; при уничтожении сессии они всё равно закрываются). Никогда не затрагивает ретранслятор/CDP/запущенные браузеры или вкладки других сессий.",
    options: {
      "0": { label: "Никогда" },
      "900": { label: "15 минут" },
      "1800": { label: "30 минут" },
      "3600": { label: "1 час" },
    },
  },
  "browser.screenshotDir": {
    sourceHash: "849ec1d7056fb8bde68fdf6588baabc3023b45be9f188d41fff18bf115d24bd8",
    label: "Папка скриншотов",
    description:
      "Папка для сохранения скриншотов. Если не задана, скриншоты сохраняются во временный файл. Поддерживает ~. Примеры: ~/Downloads, ~/Desktop, /sdcard/Download (Android)",
  },
  "ida.enabled": {
    sourceHash: "70576a37ddc515257ce4f0609e32d041823236d0ca47ac51e0e044d7efaba4a3",
    label: "IDA Pro",
    description:
      "Открывать исполняемые файлы, прочитанные через `read`, в IDA Pro (idalib) и включает инструмент `ida`; неактивно, если установка IDA не найдена",
  },
  "ida.python": {
    sourceHash: "67c1e283db95d8cf4e481715ca889b359cf70d687dae4424069b70f3d9977950",
    label: "Python для IDA",
    description:
      "Интерпретатор Python, способный импортировать ida_domain и idapro; пустое значение определяет автоматически",
  },
  "ida.installDir": {
    sourceHash: "354c0fea904e32644cb70ca8e9c3d37c42424c7ff385b54f26933f7f4c091ef8",
    label: "Папка установки IDA",
    description:
      "Папка, содержащая libidalib, экспортируемая как IDADIR; пустое значение определяет автоматически ($IDADIR, ida-config.json, стандартные пути установки)",
  },
  "ida.maxOpen": {
    sourceHash: "42a8cc47af6a062c4622f0d32f03d86cdc8c434642fd439868d6581fb24b4c3d",
    label: "Макс. открытых баз IDA",
    description:
      "Максимум баз IDA (демоны omp.ida.* в omp ps), открытых одновременно на проект; при открытии ещё одной сохраняется и закрывается простаивающая база, к которой дольше всего не обращались",
    options: {
      "2": { label: "2" },
      "4": { label: "4" },
      "8": { label: "8" },
      "16": { label: "16" },
    },
  },
  "ida.idleCloseSec": {
    sourceHash: "a33319946dd3f20f344ee6e2d120b547d568a042e55cda96304c5506006c66eb",
    label: "Тайм-аут закрытия простаивающей IDA",
    description:
      "Сохранять и закрывать базы IDA, простаивающие дольше указанного числа секунд (0 = никогда); пространство имён exec сбрасывается при повторном открытии",
    options: {
      "0": { label: "Никогда" },
      "300": { label: "5 минут" },
      "900": { label: "15 минут" },
      "1800": { label: "30 минут" },
      "3600": { label: "1 час" },
    },
  },
  "mcp.enableProjectConfig": {
    sourceHash: "29afcf86b9eacf7a9970e2d5dffaa82de8e08bbf810fa65e3cf04db6e300acfe",
    label: "Конфигурация проекта MCP",
    description: "Загружать .mcp.json/mcp.json из корня проекта",
  },
  "mcp.startupTimeoutMs": {
    sourceHash: "036eb918786f257149807dd371cd723429f05617777ea62ee84e5e863d5ca4de",
    label: "Окно запуска MCP",
    description:
      "Ждать указанное число миллисекунд для первоначального обнаружения инструментов MCP; 0 ждёт, пока соединения не установятся",
  },
  "mcp.renderMarkdownResults": {
    sourceHash: "06ef74df28c67b5477d4523d291defcc7be0708c818b11ad4ba2db9eb2577f2b",
    label: "Markdown-результаты MCP",
    description: "Отображать не-JSON текстовые результаты MCP как Markdown в расшифровке",
  },
  "mcp.notifications": {
    sourceHash: "93c3f2ce6818235aa68adbd4565f0b100e3f326bdc6cdf33d26eeb9985723b6e",
    label: "Внедрение обновлений MCP",
    description: "Внедрять обновления ресурсов MCP в разговор агента",
  },
  "mcp.notificationDebounceMs": {
    sourceHash: "e29995ca2c17ba56e659b548eab599cc2b8fc22663caf692fd87dd7543ba4b53",
    label: "Подавление дребезга уведомлений MCP",
    description:
      "Окно подавления дребезга в миллисекундах для обновлений ресурсов MCP перед их внедрением в разговор",
  },
  "images.urls.enabled": {
    sourceHash: "6668d0fc0f483856d4f1efa6c0a8d97257cb5bb95d754844eedddf8c1ef0e6c8",
    label: "Отдавать изображения как URL",
    description:
      "Публиковать исходящие изображения через настроенную цепочку бэкендов и отправлять провайдерам, загружающим URL, короткие ссылки вместо встроенного base64. Автоматически возвращается к встроенному варианту, если все бэкенды или загрузка провайдером не удались",
  },
  "images.urls.backends": {
    sourceHash: "4f98377197314281ba2d05d43a217234aed49f599d70c6e8f646acf946591844",
    label: "Бэкенды URL изображений",
    description: "Упорядоченные назначения, испытываемые при публикации изображений для доступа провайдера",
    options: {
      imgur: {
        label: "Imgur",
        description: "Загрузка требует либо токена доступа Imgur, либо client ID.",
      },
      imageshack: {
        label: "ImageShack",
        description: "API требует платной подписки.",
      },
      flickr: {
        label: "Flickr",
        description: "хостинг изображений",
      },
      chevereto: {
        label: "Chevereto",
        description: "самостоятельный хостинг",
      },
      vgyme: {
        label: "vgy.me",
        description: "хостинг изображений",
      },
      dropbox: {
        label: "Dropbox",
        description: "облачные файлы",
      },
      ftp: {
        label: "FTP / FTPS / SFTP",
        description: "передача файлов",
      },
      onedrive: {
        label: "OneDrive",
        description: "облачные файлы",
      },
      "google-drive": {
        label: "Google Drive",
        description: "облачные файлы",
      },
      puush: {
        label: "puush-совместимая конечная точка",
        description: "Публичный сервис не работает; требуется замена конечной точки.",
      },
      box: {
        label: "Box",
        description: "облачные файлы",
      },
      "amazon-s3": {
        label: "Amazon S3",
        description: "s3",
      },
      "google-cloud-storage": {
        label: "Google Cloud Storage",
        description: "объектное хранилище",
      },
      "azure-storage": {
        label: "Azure Blob Storage",
        description: "объектное хранилище",
      },
      "backblaze-b2": {
        label: "Backblaze B2",
        description:
          "Настройте либо собственные ключи приложения B2, либо S3-совместимые ключи доступа.",
      },
      owncloud: {
        label: "ownCloud / Nextcloud",
        description: "webdav",
      },
      mediafire: {
        label: "MediaFire-совместимая конечная точка",
        description: "Публичный API устарел; требуется замена конечной точки.",
      },
      sendspace: {
        label: "SendSpace-совместимая конечная точка",
        description: "Публичный API обнаружения устарел; требуется замена конечной точки.",
      },
      localhostr: {
        label: "Hostr-совместимая конечная точка",
        description: "Публичный сервис не работает; требуется замена конечной точки.",
      },
      lambda: {
        label: "Lambda-совместимая конечная точка",
        description: "Публичный сервис не работает; требуется замена конечной точки.",
      },
      pomf: {
        label: "Pomf",
        description: "pomf",
      },
      uguu: {
        label: "Uguu",
        description: "Публичные загрузки истекают примерно через три часа.",
      },
      seafile: {
        label: "Seafile",
        description: "облачные файлы",
      },
      "s-ul": {
        label: "s-ul",
        description: "файловый хостинг",
      },
      lobfile: {
        label: "LobFile-совместимая конечная точка",
        description: "Публичный сервис не работает; требуется замена конечной точки.",
      },
      "transfer-sh": {
        label: "transfer.sh-совместимая конечная точка",
        description:
          "Не работающая публичная конечная точка заблокирована; требуется самостоятельно размещённая замена.",
      },
      plik: {
        label: "Plik",
        description: "самостоятельный хостинг",
      },
      "shared-folder": {
        label: "Общая папка",
        description: "файловая система",
      },
      catbox: {
        label: "Catbox",
        description: "анонимный хостинг",
      },
      litterbox: {
        label: "Litterbox",
        description: "Загрузки временные.",
      },
      "0x0": {
        label: "0x0.st",
        description:
          "Публичные загрузки истекают по истечении срока хранения, определяемого размером файла.",
      },
      tmpfiles: {
        label: "tmpfiles.org",
        description: "Публичные загрузки временные.",
      },
      discord: {
        label: "Discord",
        description: "обмен сообщениями",
      },
      "provider-files": {
        label: "Файлы провайдера модели",
        description:
          "Ссылки на файлы провайдера локальны для API, а не являются публичными URL изображений.",
      },
      direct: {
        label: "Прямой публичный URL",
        description: "локальная раздача",
      },
      cloudflared: {
        label: "Быстрый туннель Cloudflare",
        description: "туннель",
      },
      ngrok: {
        label: "ngrok",
        description: "туннель",
      },
      tailscale: {
        label: "Tailscale Funnel",
        description: "туннель",
      },
      ssh: {
        label: "Обратный SSH-туннель",
        description: "туннель",
      },
      command: {
        label: "Команда загрузки",
        description: "внешняя команда",
      },
      "localhost-run": {
        label: "localhost.run",
        description: "туннель",
      },
      pinggy: {
        label: "Pinggy",
        description: "туннель",
      },
      devtunnel: {
        label: "Туннель разработки Microsoft",
        description: "CLI devtunnel должен быть авторизован локально.",
      },
      zrok: {
        label: "zrok",
        description: "Локальное окружение zrok должно быть включено.",
      },
      bore: {
        label: "bore",
        description: "туннель",
      },
      "named-cloudflared": {
        label: "Именованный туннель Cloudflare",
        description: "туннель",
      },
      r2: {
        label: "Cloudflare R2",
        description: "s3",
      },
      tigris: {
        label: "Tigris",
        description: "s3",
      },
      minio: {
        label: "MinIO",
        description: "s3",
      },
      garage: {
        label: "Garage",
        description: "s3",
      },
    },
  },
  "images.urls.command": {
    sourceHash: "c7ca77425d8f96a78660ea7bd45450b48ee1796a92f8a10e22c4b57989a0bebb",
    label: "Команда загрузки изображений",
    description:
      "Шаблон argv для бэкенда command; {file} — путь к изображению, {mime}/{ext} необязательны. Используется последний URL, выведенный в stdout (например, pasta -b -f {file})",
  },
  "images.urls.publicBaseUrl": {
    sourceHash: "9ed83574cfb822a5aca4979a47fc609eb5085ee1ea1427896037e63a71ece22e",
    label: "Публичный базовый URL изображений",
    description:
      "Внешне доступный базовый URL, стоящий перед blob-сервером (обязателен для ssh, необязателен для direct)",
  },
  "images.urls.ttlHours": {
    sourceHash: "de264b0448902332f853c57882d9ffbf7d980f9d7ccef8c0dc3427397af7893d",
    label: "Время жизни URL изображений (часы)",
    description:
      "Окно раздачи для локально размещённых URL изображений, отсчитываемое от последнего отправления их разговором; при возобновлении разговора окно перезапускается по той же ссылке. 0 сохраняет ссылки живыми, пока работает брокер",
  },
  "images.urls.bindHost": {
    sourceHash: "caa3b233220decbb1886d9481d0033df0ab6d3b3f3c3a63505ef97a1d3274685",
    label: "Хост привязки URL изображений",
    description:
      "Хост, к которому привязывается blob-сервер; loopback для туннелей, 0.0.0.0 для прямой раздачи",
  },
  "images.urls.sshTarget": {
    sourceHash: "983fabfdee46a12e255af6f101e1251d3cc72253e8e0c58c8aae9dcf8797e367",
    label: "SSH-цель URL изображений",
    description: "Назначение user@host для обратного SSH-перенаправления",
  },
  "images.urls.sshRemotePort": {
    sourceHash: "af622250c1f709129de9bc3207da6079cf5fba26e5de4d651a4319f34e6c2a5b",
    label: "Удалённый SSH-порт URL изображений",
    description:
      "Удалённый порт прослушивания обратного SSH-перенаправления, на который проксирует ваш веб-сервер",
  },
  "secrets.enabled": {
    sourceHash: "c71bb5c88f9fc9754378596da29b77271914baf5379bea903ea00800716bf5e0",
    label: "Скрывать секреты",
    description:
      "Обфусцировать настроенные секреты и вырезать токены, похожие на учётные данные, перед отправкой провайдерам ИИ",
  },
  "stt.enabled": {
    sourceHash: "b9b82ee7366a472506048171907ab19ff8464381707ebbdd0c2d3a9a673acc4d",
    label: "Распознавание речи",
    description: "Включает ввод речи в текст через микрофон",
  },
  "stt.submitTrigger": {
    sourceHash: "f2fb4135bcfb40707ba420acb23431bc4f94da1f0fb66a56e9f6a3fb61a71912",
    label: "Триггер отправки распознавания речи",
    description:
      "Выберите, когда диктовка автоматически отправляется: никогда, при отпускании (2+ слова), при отпускании с законченным предложением или по слову submit.",
    options: {
      never: {
        label: "Никогда",
        description:
          "Никогда не отправлять автоматически; вставлять диктовку и оставаться в редакторе.",
      },
      release: {
        label: "При отпускании",
        description:
          "Отправлять при отпускании, если в высказывании 2+ слова, чтобы избежать случайных отправок.",
      },
      "release-complete": {
        label: "При отпускании с законченным предложением",
        description:
          "Отправлять при отпускании, если высказывание заканчивается знаком конца предложения (. ? ! и т. п.).",
      },
      "say-submit": {
        label: "По слову submit",
        description:
          "Отправлять, если высказывание заканчивается словом, содержащим 'submit' (перед отправкой это слово удаляется).",
      },
    },
  },
  "collab.relayUrl": {
    sourceHash: "507a42e5c9e5eac78f0c1c7c7646cc8b6800eb8fe15b74eeb26f29e494f9fc5e",
    label: "URL ретранслятора",
    description: "Ретранслятор, используемый /collab (wss://host[:port])",
  },
  "collab.webUrl": {
    sourceHash: "980521f1b36be66020340fd9556802c492b7358a4431e6603cc7d8477c307891",
    label: "URL веб-интерфейса",
    description:
      "Веб-интерфейс браузера, используемый ссылками /collab; пустое значение выводится из collab.relayUrl; явный http:// работает только на localhost",
  },
  "collab.displayName": {
    sourceHash: "89bef2a68721bdbe666342761933437f53783af7950ebe5ebccef2fe1f2f67b5",
    label: "Отображаемое имя",
    description: "Имя, показываемое другим участникам collab (по умолчанию: имя пользователя ОС)",
  },
  "collab.autoStart": {
    sourceHash: "31c607b239cb23c1135ac9d295cb748b09d91961d17b32c446cfdde10480733a",
    label: "Автозапуск",
    description:
      "Размещать каждую интерактивную сессию через collab.relayUrl при её запуске и публиковать её в локальном реестре (omp collab list); комнаты меняются при переключении сессии",
    options: {
      off: {
        label: "Выкл.",
        description: "Делиться только при выполнении /collab",
      },
      view: {
        label: "Просмотр",
        description:
          "Авторазмещение; реестр выдаёт ссылки только для просмотра (omp collab link --view)",
      },
      control: {
        label: "Управление",
        description:
          "Авторазмещение; реестр выдаёт ссылки с управлением, позволяющие отправлять промпты в сессию",
      },
    },
  },
  "share.serverUrl": {
    sourceHash: "2d5f4e2bac845ccb18e1cb811a71374a43cdd2cd15255db755b64340f45042b3",
    label: "Сервер обмена",
    description:
      "Базовый адрес просмотрщика/загрузки обмена, используемый /share (загрузка зашифрованного blob + просмотрщик; ссылки имеют вид <base>/<id>#<key>)",
  },
  "share.store": {
    sourceHash: "2fc43994b5468ec8c470be7f757c38d330050c4914336d6395ef5ac98609ef4f",
    label: "Хранилище обмена",
    description: "Куда /share загружает зашифрованный blob сессии",
    options: {
      blob: {
        label: "Зашифрованный blob",
        description:
          "Загружать на сервер обмена (учётная запись GitHub не нужна; позволяет обойти ограничения частоты API gist)",
      },
      gist: {
        label: "GitHub Gist",
        description:
          "Отправлять в секретный gist (требуется авторизованный gh), с возвратом на сервер обмена",
      },
    },
  },
  "share.redactSecrets": {
    sourceHash: "bf717b2155efc6c002c903822ef99b012b371981c7ad93ad75803e166ae7cb43",
    label: "Вырезание секретов при обмене",
    description:
      "Прогонять обфускатор секретов по снимкам /share перед загрузкой (использует конфигурацию secrets.*)",
  },
  "stream.serverUrl": {
    sourceHash: "e10882886e0fe7cf46f0fadb98eeff1582720fb830505b2794c0922e50a80583",
    label: "Сервер трансляции",
    description:
      "Сервер прямой трансляции, используемый `omp stream` (https://host[:port]); зрители смотрят по адресу <base>/<ваше имя пользователя Stencil>",
  },
  "stream.redactPatterns": {
    sourceHash: "7f4b864bed280004a737464a6a4474cd7ec9623a2b20aef26f78d19f4f6c0ed3",
    label: "Дополнительные шаблоны вырезания",
    description:
      "Дополнительные регулярные выражения, вырезаемые из каждой транслируемой строки, поверх значений env/secrets.yml и встроенных шаблонов учётных данных",
  },
};
