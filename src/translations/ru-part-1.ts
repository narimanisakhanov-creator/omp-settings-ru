import type { SettingTranslation } from "./types";

export const ruPart1: Readonly<Record<string, SettingTranslation>> = {
  modelRoleStorage: {
    sourceHash: "559e85e5e98b03b3e4cea23294f68541afc94696dc64bf6325e9eed7b147b38b",
    label: "Хранилище ролей моделей",
    description: "Где сохраняются назначения моделей для ролей селектора",
    options: {
      global: {
        label: "Глобально",
        description: "Сохранять модели ролей в конфиге активного профиля (текущее поведение)",
      },
      project: {
        label: "Для проекта",
        description:
          "Сохранять модели ролей проекта в .omp/config.yml; отсутствующие роли проекта берут глобальные значения по умолчанию",
      },
    },
  },
  autoResume: {
    sourceHash: "0acb3a94cdc9ddbf65f3529da5f5779ebc8ef1b1c99b7d1c29f1731edacfd300",
    label: "Автопродолжение",
    description: "Автоматически продолжать последнюю сессию в текущем каталоге",
  },
  "git.enabled": {
    sourceHash: "afd129831760ccaf6388c663de326f37d9a6001a1c19c1ebd99cc5aa47a5b5b0",
    label: "Включить интеграцию с Git",
    description:
      "Показывать ветку git, статус и информацию о PR в TUI и следить за метаданными репозитория.",
  },
  "theme.dark": {
    sourceHash: "e14e408d3c42b38c7ccd2cdf7f9eead7e708b0662589c657f390577406358f19",
    label: "Тёмная тема",
    description: "Тема, используемая когда фон терминала тёмный",
  },
  "theme.light": {
    sourceHash: "1c0ba854dfbc778ef856fb00a1b256900f6f368ec7f86e119ae35a1eb0d50fa4",
    label: "Светлая тема",
    description: "Тема, используемая когда фон терминала светлый",
  },
  symbolPreset: {
    sourceHash: "6c56e0b5117629a70f88be080084aee62635f070a2a822ad5c7c5e20511ca116",
    label: "Набор символов",
    description: "Набор глифов для иконок и символов (Unicode, Nerd Font или ASCII)",
    options: {
      unicode: {
        label: "Unicode",
        description: "Стандартные символы (по умолчанию)",
      },
      nerd: {
        label: "Nerd Font",
        description:
          "Требуется Nerd Font или терминал с поддержкой Glyph Protocol (иконки передаются в потоке)",
      },
      ascii: {
        label: "ASCII",
        description: "Максимальная совместимость",
      },
    },
  },
  colorBlindMode: {
    sourceHash: "74a96816a9d65defbb8a541a78ba31c0b2d93c8b4603571dfe25f60a791dc418",
    label: "Режим для дальтоников",
    description: "Использовать синий вместо зелёного для добавленных строк в диффе",
  },
  "composer.shape": {
    sourceHash: "5ded975b7622644a2ccdfc1850ece9ca1dfb5e57a9b49c471d67cae98fbc28c3",
    label: "Форма композера",
    description: "Визуальная компоновка редактора ввода и строки состояния",
  },
  "composer.tokenRate": {
    sourceHash: "ab82c5efedfd6a27a06bfbd0a887aa528687853951a212eba3d071fc23188b01",
    label: "Скорость генерации",
    description:
      "Показывать текущую скорость генерации (ток/с) в рабочей строке, справа рядом с названием сессии. Оценивается по потоковым дельтам и корректируется по счётчику выходных токенов от провайдера при завершении каждого сообщения.",
  },
  "statusLine.preset": {
    sourceHash: "71345ec595ee2d489a73c8db38951177f4e732fbbfe7aedd74f549571698324e",
    label: "Пресет строки состояния",
    description: "Готовые конфигурации строки состояния",
    options: {
      default: {
        label: "По умолчанию",
        description: "Модель, путь, git, контекст, токены, стоимость",
      },
      minimal: {
        label: "Минимальный",
        description: "Только путь и git",
      },
      compact: {
        label: "Компактный",
        description: "Модель, git, стоимость, контекст",
      },
      full: {
        label: "Полный",
        description: "Все сегменты, включая время",
      },
      nerd: {
        label: "Nerd",
        description: "Максимум информации с иконками Nerd Font",
      },
      ascii: {
        label: "ASCII",
        description: "Без специальных символов",
      },
      custom: {
        label: "Пользовательский",
        description: "Сегменты, заданные пользователем",
      },
    },
  },
  "statusLine.separator": {
    sourceHash: "f4b1a28fc0d46248032f7131bfbf7e874f1375c338ce63a54553ad6c0c278bb2",
    label: "Разделитель строки состояния",
    description: "Стиль разделителей между сегментами",
    options: {
      powerline: {
        label: "Powerline",
        description: "Сплошные стрелки (Nerd Font)",
      },
      "powerline-thin": {
        label: "Тонкий шеврон",
        description: "Тонкие стрелки (Nerd Font)",
      },
      slash: {
        label: "Слэш",
        description: "Прямые слэши",
      },
      pipe: {
        label: "Вертикальная черта",
        description: "Вертикальные черты",
      },
      block: {
        label: "Блок",
        description: "Сплошные блоки",
      },
      none: {
        label: "Нет",
        description: "Только пробел",
      },
      ascii: {
        label: "ASCII",
        description: "Знаки «больше»",
      },
    },
  },
  "statusLine.contextLine": {
    sourceHash: "a6e9a4fea84d8ffac2518184d97a8c5b4e1043ac191b9f9828480a440a5ab008",
    label: "Реактивная линия контекста",
    description:
      "Как линия между левым и правым сегментами отражает использование контекста (только для композера-рамки)",
    options: {
      off: {
        label: "Выкл.",
        description: "Сплошная акцентная линия без индикации контекста",
      },
      percentage: {
        label: "Проценты",
        description: "Использованная часть акцентным цветом, остаток приглушён",
      },
      annotated: {
        label: "С отметками",
        description:
          "Проценты плюс деления на границах спекулятивной и авто-компакции",
      },
      embedded: {
        label: "Встроенная",
        description:
          "Линия с отметками, проценты контекста и окно встроены в индикатор",
      },
    },
  },
  "statusLine.sessionAccent": {
    sourceHash: "f0f47454012fe3118d76071b7d55d7975f6add2c71d48fd9f9bd32571b9d6531",
    label: "Акцент сессии",
    description:
      "Использовать цвет имени сессии для рамки редактора и промежутка строки состояния",
  },
  "statusLine.transparent": {
    sourceHash: "56886c53f5598e67cdfd6053022fd23835f486abcab70edf3d6047e27800a47a",
    label: "Прозрачная строка состояния",
    description:
      "Использовать фон терминала по умолчанию для строки состояния вместо `statusLineBg` из темы. Завершающие элементы Powerline отбрасываются, так как им нужна контрастная заливка для перехода в окружающий терминал.",
  },
  "statusLine.compactThinkingLevel": {
    sourceHash: "e0a244746eda55072d4fe4c3a75f3238565ccf3857190875d8aef6b58d323927",
    label: "Компактный уровень размышления",
    description:
      "Показывать уровень размышления одной иконкой на имени модели вместо отдельного суффикса ` · <уровень>`.",
  },
  "statusLine.showHookStatus": {
    sourceHash: "bf2dc96e54c3a6a696b3679f27907eb4797dd0048663b20a447654b54b1e9ed0",
    label: "Показывать статус хуков",
    description: "Показывать сообщения о статусе хуков под строкой состояния",
  },
  "terminal.showImages": {
    sourceHash: "a159e6cd98066aaa6624c660e328461a0b9a3ae60bea4d28ba3b9a9317a567e5",
    label: "Показывать изображения в строке",
    description: "Отображать изображения прямо в терминале",
  },
  "images.autoResize": {
    sourceHash: "01763a5edf96de615ea3f2867d5548dd074eba52545bc3e8632705281405b490",
    label: "Автоматически изменять размер изображений",
    description:
      "Уменьшать большие изображения до 2000x2000 для лучшей совместимости с моделями",
  },
  "images.blockImages": {
    sourceHash: "d2475902d7b71b443595aacdb241243f4a172adac38635c6b4822576ab734534",
    label: "Блокировать изображения",
    description: "Запрещать отправку изображений провайдерам LLM",
  },
  "tui.resizeScrollback": {
    sourceHash: "0947e9d0ce42cc9045a65a5ea575577598365d0c2326a5c9629c4cd5d9fcc97a",
    label: "Обновление буфера прокрутки",
    description:
      "Как завершённое изменение размера терминала обновляет строки транскрипта, сохранённые в буфере прокрутки терминала",
    options: {
      append: {
        label: "Дописать",
        description:
          "Перерисовать транскрипт в новой ширине ниже сохранённой истории",
      },
      rebuild: {
        label: "Перестроить",
        description:
          "Очистить весь буфер прокрутки терминала и перерисовать один транскрипт текущей ширины",
      },
      preserve: {
        label: "Сохранить",
        description:
          "Перерисовать только видимую область, а история остаётся перенесённой по старой ширине",
      },
    },
  },
  "terminal.showProgress": {
    sourceHash: "b4f580d92d54db9a568da23af4f079ace787311d87580e3770512fca60269074",
    label: "Встроенный прогресс терминала",
    description:
      "Передавать неопределённый прогресс OSC 9;4, пока работает агент или обслуживание контекста (в Tern всегда включено)",
  },
  "tui.textSizing": {
    sourceHash: "cfe538cd9220b87286e586f3b1296a39a81525cee9ea21c58a4dccba9f18b803",
    label: "Крупные заголовки (Kitty)",
    description:
      "Отображать заголовки H1 Markdown в масштабе 2x, используя протокол изменения размера текста OSC 66 в Kitty. Действует только в терминалах Kitty; в остальных игнорируется. По умолчанию выключено.",
  },
  "tui.renderMermaid": {
    sourceHash: "e4514535e3a7a9dc994b0059ccd63a36c52f14789b6252cd0b28129064a90959",
    label: "Отрисовывать диаграммы Mermaid",
    description: "Отображать блоки кода Mermaid как ASCII-диаграммы",
  },
  "tui.reactions": {
    sourceHash: "049f992873a3508b160cc0f291f7b5ac0e9879ef704f83cfc486d8aa8f569ec8",
    label: "Реакции агента",
    description:
      "Предлагать агенту реагировать на ваше сообщение эмодзи-значком на его пузыре",
  },
  "tui.codexResetFireworks": {
    sourceHash: "35206daae9a4bf1e2f5e8757a5b61d97a2239eec58ef1a86a8cc9d227d9eaddc",
    label: "Фейерверк при сбросе Codex",
    description:
      "Отмечать внеплановые недельные сбросы лимитов Codex и новые сохранённые сбросы фейерверком в верхней трети экрана, который остаётся до {escape}",
    descriptionSource:
      "Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until {escape}",
  },
  "tui.titleState": {
    sourceHash: "6e0c084b462e93a191bc78e133e22a80fbb13ce5f6328fef3fe6cc8bf33b0922",
    label: "Состояние работы в заголовке терминала",
    description:
      "Показывать состояние работы агента в разделителе заголовка терминала — анимированный спиннер во время работы (статичный ':' под WSL), '>' когда ход ваш, '!' когда агент ждёт вас",
  },
  "tui.titleSpinner": {
    sourceHash: "5d6af659ad89599e4bb2d1b8d4b0d44307156238d8772c75e505861bfefeaf69",
    label: "Спиннер в заголовке терминала",
    description:
      "Набор глифов для спиннера рабочего состояния в заголовке терминала — брайлевский пробег, наполняющаяся луна, цикл из точек или ASCII-линия",
    options: {
      braille: {
        label: "Брайль",
        description: "Классический пробег ⠋⠙⠹ (по умолчанию)",
      },
      pulse: {
        label: "Пульс",
        description: "Луна наполняется ○◑● и опустошается",
      },
      dots: {
        label: "Точки",
        description: "Одиночные брайлевские точки по кругу",
      },
      line: {
        label: "Линия",
        description: "ASCII - \\ | / для шрифтов без поддержки брайля",
      },
    },
  },
  "tui.hyperlinks": {
    sourceHash: "17abb4d9a27ec0a03cf1f312514bafaea2a6d968900a58a510c0efa0702bdea8",
    label: "Гиперссылки в терминале",
    description:
      "Оборачивать пути и URL в гиперссылки OSC 8 для открытия по клику средствами терминала (auto: определять поддержку; off: никогда; always: безусловно)",
  },
  "tui.mouse": {
    sourceHash: "6ed4075bc5aecbd43da8f76dfe3cc88e96ac075bf123d1fc527548c955bf5b28",
    label: "Фокус по клику мыши",
    description:
      "Перехватывать клики мыши в основной сессии, чтобы карточки живых субагентов и строки HUD получали фокус по клику, с подсветкой цели при наведении. Нативное выделение текста становится {shift}+перетаскивание, а прокрутка колесом — {shift}+колесо, пока включено",
    descriptionSource:
      "Capture mouse clicks in the main session so live subagent cards and HUD rows focus on click, with a hover highlight on the target. Native text selection becomes {shift}+drag and wheel scroll becomes {shift}+wheel while on",
  },
  "tui.tight": {
    sourceHash: "babebba5a60583ce069f2446fa1db9b4ae0d360bbdba1fa24939eede65c85e94",
    label: "Плотная компоновка",
    description:
      "Убрать горизонтальный отступ в 1 символ слева и справа от вывода терминала",
  },
  "display.shimmer": {
    sourceHash: "2bb3bf5c3781a7e813164b5287f72b730102335c4f1ca7ba1ed4dcfe3f43a415",
    label: "Мерцание",
    description: "Стиль анимации для сообщений о работе/загрузке",
    options: {
      classic: {
        label: "Классический",
        description: "Плавная косинусная волна, пробегающая по тексту",
      },
      kitt: {
        label: "Сканер KITT",
        description: "Красный огонь из «Рыцаря дорог» 1982, бегающий влево-вправо",
      },
      disabled: {
        label: "Отключено",
        description: "Без анимации; статичный приглушённый текст",
      },
    },
  },
  "display.pinnedAgents": {
    sourceHash: "01fb7f1651c02d82ca1765bf78b136248dd7cb94fe686af3beb2451d8bf3c16c",
    label: "Закреплённые агенты",
    description:
      "Закреплённый список живых агентов для перехода над редактором (off скрывает его; collapsed показывает несколько строк с возможностью развернуть; full перечисляет всех)",
    options: {
      off: {
        label: "Выкл.",
        description: "Скрыть закреплённый список",
      },
      collapsed: {
        label: "Свёрнутый",
        description: "Показывать несколько строк с кнопкой разворачивания",
      },
      full: {
        label: "Полный",
        description: "Всегда показывать всех живых агентов",
      },
    },
  },
  "display.subagentLivePreview": {
    sourceHash: "e3d8dfcbb7365e3fea84f9af7aca32c2a7802c566b198cbc4d89626c83b6d011",
    label: "Живой предпросмотр субагента",
    description:
      "Показывать текущий (или последний) вызов инструмента каждого закреплённого субагента под его строкой",
  },
  "display.smoothStreaming": {
    sourceHash: "486ee99f103176ae2d9462988dea8a0f9438a6ef043971617093152706261425",
    label: "Плавный поток",
    description:
      "Плавно показывать текст ассистента и потоковый ввод инструментов по мере поступления фрагментов",
  },
  "display.hideToolActivity": {
    sourceHash: "02283e2dd6b172dfe14a309ab19809155f6a8bd2a37b237692cbb68bd5ff0226",
    label: "Скрыть активность инструментов",
    description:
      "Скрывать в транскрипте вызовы инструментов по инициативе модели и их результаты",
  },
  "display.showTokenUsage": {
    sourceHash: "d872624deff2642774e1da779adaf9a000f9363663830f52a239f74c2925c858",
    label: "Показывать расход токенов",
    description: "Показывать расход токенов за ход в сообщениях ассистента",
  },
  "display.showTurnTime": {
    sourceHash: "2054d1659068a18833574ff26edd6727a0f6996ad12a3f44b34f0e60f6d53756",
    label: "Показывать время хода",
    description:
      "Показывать общее время от промпта до yield (включая вызовы инструментов) в строках расхода сообщений ассистента",
  },
  "display.cacheMissMarker": {
    sourceHash: "7f30aab5c9c647abfea2a3786bad1dec56f5622f0e0d3fb31eeac61b6d08a9f7",
    label: "Маркер промаха кэша",
    description:
      "Показывать разделитель после хода ассистента, запрос которого не попал в кэш промпта",
  },
  "display.collapseCompacted": {
    sourceHash: "3d1a8035908cf0f4bd1fa97382c6c9d20e0cf5f54a472c975b8c379c163c98f3",
    label: "Сворачивать сжатую историю",
    description:
      "Сворачивать историю до сжатия за разделителем сводки в живом транскрипте; отключите, чтобы весь транскрипт оставался развёрнутым с разделителями в каждой точке сжатия",
  },
  showHardwareCursor: {
    sourceHash: "3781f88d0b421103dab3efc168d0edae91abd2109a88ac1758430ea91c204c4d",
    label: "Показывать аппаратный курсор",
    description: "Показывать курсор терминала для поддержки IME",
  },
  "tui.imeSafeCursor": {
    sourceHash: "d3e85d1d405645db7c5b1f7f6512ac911b0d06d42898dfb3c4103802d8b97767",
    label: "Безопасная для IME компоновка промпта",
    description:
      "Перенести нижнюю границу промпта в отдельную строку, чтобы предварительный ввод IME в macOS не мог её сместить",
  },
  steeringMode: {
    sourceHash: "1dbd6d37fcad0666abb98b6393f8199fde7ea5d3377e8ec377484b2ab290e7bd",
    label: "Режим управления",
    description: "Как обрабатывать сообщения в очереди, пока агент работает",
  },
  followUpMode: {
    sourceHash: "3b75e4cf3397227fde0b75fc09e633ab0551fb519e4af3e53b1eda85336b77b8",
    label: "Режим последующих сообщений",
    description: "Как обрабатывать последующие сообщения после завершения хода",
  },
  interruptMode: {
    sourceHash: "9e622569e0d0630e3c66dedc08ad030d9b023808ac484da7da240e6ddf349a7c",
    label: "Режим прерывания",
    description: "Когда управляющие сообщения прерывают выполнение инструмента",
  },
  "tui.vimMode": {
    sourceHash: "ddbbd82cc779461294da2817daec87bf65d42e5be29b0b9b2900c58b80ba5bd8",
    label: "Режим редактирования Vim",
    description:
      "Модальное редактирование промпта. {escape} выходит из режима Insert; в Normal доступны hjkl, 0, $, ^, w, b, e, gg, G, счётчики, x/D/C, dd/yy, p и u; операторы принимают перемещения или текстовые объекты (diw, ca(, dap); v/V начинают визуальное выделение, которое y копирует, а d удаляет",
    descriptionSource:
      "Modal prompt editing. {escape} leaves Insert mode; Normal mode has hjkl, 0, $, ^, w, b, e, gg, G, counts, x/D/C, dd/yy, p and u; operators take motions or text objects (diw, ca(, dap); v/V start a Visual selection that y copies and d deletes",
  },
  "tui.vimModeDisplay": {
    sourceHash: "9e287fe697790e65d7be3dfc6989cc52196cbb31654d01c350f70612f0dce4a6",
    label: "Индикатор режима Vim",
    description: "Как текущий режим Vim отображается в строке состояния",
    options: {
      text: {
        label: "Текст",
        description: "Полное имя режима — NORMAL, INSERT, VISUAL, V-LINE",
      },
      icon: {
        label: "Иконка",
        description: "Один компактный глиф на режим",
      },
      none: {
        label: "Скрыто",
        description: "Не показывать режим в строке состояния",
      },
    },
  },
  "loop.mode": {
    sourceHash: "b07cc1b459f11902c561c2e3cf55caf8abc38dcc0fdc644cff50895e2415e288",
    label: "Режим цикла",
    description:
      "Что происходит между итерациями /loop перед повторной отправкой промпта",
    options: {
      prompt: {
        label: "Промпт",
        description:
          "Повторно отправлять промпт как последующее сообщение (текущее поведение)",
      },
      compact: {
        label: "Сжатие",
        description: "Сжать контекст сессии, затем повторно отправить промпт",
      },
      reset: {
        label: "Сброс",
        description: "Начать новую сессию, затем повторно отправить промпт",
      },
    },
  },
  "loop.conditionTimeoutMs": {
    sourceHash: "0f388024842816ed0a08e04b3e9d723c3494745bb165cc2fe730ce50045daf7f",
    label: "Тайм-аут условия цикла (мс)",
    description:
      "Максимальное ожидание команды условия `/loop --while` / `--until`, после которого она считается сломанной и цикл останавливается. Значение 0 — ждать бесконечно",
    options: {
      "0": {
        label: "Без ограничения",
      },
      "10000": {
        label: "10 секунд",
      },
      "30000": {
        label: "30 секунд",
      },
      "120000": {
        label: "2 минуты",
      },
    },
  },
  "composer.recallClearedDrafts": {
    sourceHash: "279ad7ab56b782eea5ee2557cd4a37171de1dd141d47a2a2452d19b4e4f9285d",
    label: "Восстанавливать очищенные черновики",
    description:
      "Хранить черновики, очищенные с помощью {clear}, в локальной истории {history} до выхода; отключение влияет на будущие очистки",
    descriptionSource:
      "Keep drafts cleared with {clear} in local {history} history until exit; disabling affects future clears",
  },
  doubleEscapeAction: {
    sourceHash: "6dce889cef441528cc3e2cdc389093e4039e240bb2a8e612855b7c77d2054bbe",
    label: "Действие двойного нажатия Escape",
    description:
      "Что делает двойное нажатие {escape} при пустом редакторе: открыть выбор перемотки транскрипта, открыть дерево сессий или ничего",
    descriptionSource:
      "What pressing {escape} twice with an empty editor does: open the transcript rewind selector, open the session tree, or nothing",
  },
  "input.bareExitOnEmptySession": {
    sourceHash: "5143902fd8155a85a4ed148162454b47424ba5dea9c1dc56c962e5e1e245d60f",
    label: "Выход по команде в пустой сессии",
    description:
      "Отправка ровно `exit`, `quit` или `q` (в любом регистре) до первого сообщения завершает работу вместо обращения к модели",
  },
  "input.bareSlashCommands": {
    sourceHash: "22ff29c8955034cd6668a5cd1ec342c44a01b7aa5207916dfa0e9a05e5e187ef",
    label: "Слэш-команды без слэша",
    description:
      "Отправка ровно имени команды без ведущего `/` (например, `model`, `compact`) выполняет эту слэш-команду; если в сессии уже есть сообщения, для подтверждения нажмите Enter дважды",
  },
  treeFilterMode: {
    sourceHash: "336e6236bf92b823de458c000efb6bf5ff53b42bda4a88818954ecc7fa90a7c4",
    label: "Фильтр дерева сессий",
    description: "Режим фильтра по умолчанию при открытии дерева сессий",
  },
  autocompleteMaxVisible: {
    sourceHash: "955fde1d01067112cbdf5905f7ab30991108197b3de6b91b3e79701722e99063",
    label: "Элементов в автодополнении",
    description:
      "Максимум видимых элементов в выпадающем списке автодополнения (3–20)",
    options: {
      "3": {
        label: "3 элемента",
      },
      "5": {
        label: "5 элементов",
      },
      "7": {
        label: "7 элементов",
      },
      "10": {
        label: "10 элементов",
      },
      "15": {
        label: "15 элементов",
      },
      "20": {
        label: "20 элементов",
      },
    },
  },
  "spelling.typoDetection": {
    sourceHash: "41968458a03cdc4c2bf2e0781ad738b3bb7295bb6de67cd86d2132cb403a18c0",
    label: "Обнаружение опечаток (macOS)",
    description:
      "Помечать слова с опечатками в промпте с помощью активных словарей macOS",
  },
  "spelling.autocomplete": {
    sourceHash: "a46f053c3fc76db0b3b5fa6949650276cac14c5632d234e4c48e05eae0ed82ae",
    label: "Автодополнение слов",
    description:
      "Показывать предсказанные слова как встроенные подсказки: {accept} принимает с пробелом, {right} — без",
    descriptionSource:
      "Show predicted word completions as inline hints: {accept} accepts with a space, {right} without",
    options: {
      off: {
        label: "Выкл.",
        description: "Без автодополнения слов",
      },
      auto: {
        label: "Авто",
        description: "N-граммы (ничего не нужно скачивать)",
      },
      ngram: {
        label: "N-граммы",
        description: "Изучает ваш словарь по истории промптов",
      },
      smollm: {
        label: "SmolLM",
        description:
          "Небольшая локальная языковая модель в смеси с N-граммами (скачивает веса при первом использовании)",
      },
    },
  },
  "spelling.autocorrect": {
    sourceHash: "4a5b6e53dd344a0b69d7a078e42dd7023a91562c2f08d28110930e293d40ba38",
    label: "Автокоррекция (macOS)",
    description:
      "Применять уверенные исправления орфографии macOS после завершённых слов",
  },
  emojiAutocomplete: {
    sourceHash: "fe869f506add710637b1bea037a9e66da774a535fcc78fdd45d365d97b08519d",
    label: "Автодополнение эмодзи",
    description:
      "Предлагать эмодзи по шорткодам `:name:` и разворачивать текстовые смайлики вроде `:D` или `:-)`",
  },
  "paste.largeMenuThreshold": {
    sourceHash: "08d124bd27fcbcb5b77beb1481e16912a04e4ace4696e88d1b7b4e0f4ac9f51c",
    label: "Меню для больших вставок",
    description:
      "Когда вставка достигает столько строк, предлагать меню: обернуть в блок кода, обернуть в XML-теги или сохранить в файл. 0 отключает меню (большие вставки всё равно сворачиваются в маркер [Paste]).",
    options: {
      "0": {
        label: "Выкл.",
      },
      "100": {
        label: "100 строк",
      },
      "250": {
        label: "250 строк",
      },
      "500": {
        label: "500 строк",
      },
      "1000": {
        label: "1000 строк",
      },
    },
  },
  "startup.quiet": {
    sourceHash: "0f74f904bc6ca53314b6f45fbb6279cd26083a0bbd7dacc3c4c4be37141b5b2d",
    label: "Тихий запуск",
    description: "Пропускать приветственный экран и сообщения о состоянии при запуске",
  },
  "startup.showSplash": {
    sourceHash: "b6e7ad7ff9d2c6b6f721fd25f712ffe59728a7f54da5e9e8274da27134c93bec",
    label: "Показывать заставку при запуске",
    description:
      "Показывать полную анимированную заставку настройки при обычном интерактивном запуске, не повторяя настройку. Тихий запуск всё равно её подавляет.",
  },
  "startup.setupWizard": {
    sourceHash: "97226b14ea64fdd2ce3c2f937d2162e40e015b39347f675fb4fc34706eea39c8",
    label: "Мастер настройки",
    description:
      "Показывать новые шаги первичной настройки один раз на версию настройки",
  },
  "startup.checkUpdate": {
    sourceHash: "20e1bee637e83b57145c9599beaf5984ac8c7ba6afbb4fe8f84935e50bf585b5",
    label: "Проверять обновления",
    description: "Проверять обновления omp при запуске",
  },
  "update.channel": {
    sourceHash: "b8089a847c4655149744116e2744d1b3f582bea246d5b379f010efee9ebf02d7",
    label: "Канал обновлений",
    description:
      "Канал обновлений, используемый командой omp update и проверкой обновлений при запуске",
    options: {
      stable: {
        label: "Стабильный",
      },
      canary: {
        label: "Канареечный",
      },
    },
  },
  "marketplace.autoUpdate": {
    sourceHash: "f2d619eaecc2713ff1f3b70e322191862cece14d8ec774fd53eda06ad1de4861",
    label: "Автообновление маркетплейса",
    description: "Проверять обновления плагинов при запуске",
    options: {
      off: {
        label: "Выкл.",
        description: "Не проверять обновления плагинов",
      },
      notify: {
        label: "Уведомлять",
        description: "Проверять при запуске и уведомлять о доступных обновлениях",
      },
      auto: {
        label: "Авто",
        description: "Проверять при запуске и автоматически устанавливать обновления",
      },
    },
  },
  "startup.changelogMode": {
    sourceHash: "88b9b6abe641c14f09265e0cabc38d6045f530ae458d3365cd5802921dcb254d",
    label: "Журнал изменений при запуске",
    description:
      "Выберите, показывать заметки об обновлении как сводку, полностью или скрыть",
    options: {
      summary: {
        label: "Сводка",
        description: "Показывать количество релизов и изменений с подсказкой /changelog",
      },
      expanded: {
        label: "Развёрнуто",
        description: "Показывать недавние заметки о релизе полностью",
      },
      hidden: {
        label: "Скрыто",
        description: "Не показывать заметки о релизе при запуске",
      },
    },
  },
  "magicKeywords.enabled": {
    sourceHash: "562eae89d3d791c42d050ed4dea84bd066df129f1601b6694b67d16621afffac",
    label: "Магические ключевые слова",
    description:
      "Включать скрытые уведомления для отдельных ключевых слов ultrathink, orchestrate, workflowz, jevify",
  },
  "magicKeywords.ultrathink": {
    sourceHash: "051af7cad7887495172556e13ba4c799c5076cb3788219af399bd1d485699a45",
    label: "Ключевое слово ultrathink",
    description:
      "Позволять отдельному ultrathink запрашивать максимальное автоматическое размышление и добавлять своё скрытое уведомление",
  },
  "magicKeywords.orchestrate": {
    sourceHash: "68c202d555f9c46af61efbae142258cf1d9021e3a6d94c5539e8c673d6412132",
    label: "Ключевое слово orchestrate",
    description:
      "Позволять отдельному orchestrate добавлять своё скрытое уведомление о мультиагентной оркестрации",
  },
  "magicKeywords.workflow": {
    sourceHash: "af2c75c349b2a979fa04ccb6d3567bc54a2afe58e2b56d53a11f8d9fab329578",
    label: "Ключевое слово workflow",
    description:
      "Позволять отдельному workflowz добавлять своё скрытое уведомление о workflow для eval",
  },
  "magicKeywords.jevify": {
    sourceHash: "13d2e210aba3b4ad7c58860a5092298775bfeb1090b0c63cf7df540e70db332a",
    label: "Ключевое слово jevify",
    description:
      "Позволять отдельному jevify добавлять своё скрытое уведомление о массовой классификации judge",
  },
  "completion.notify": {
    sourceHash: "d7bbafdf7657307edb3701a7f72fd244443e376675a0901de9450911acbd276d",
    label: "Уведомление о завершении",
    description: "Уведомлять, когда агент завершает ход",
  },
  "error.notify": {
    sourceHash: "cb1fb099696ec586436217b93e7a988d4dcb5edacdc384bfa2b146381ea4c6c6",
    label: "Уведомление об ошибке",
    description: "Уведомлять, когда агент останавливается с ошибкой",
  },
  "ask.timeout": {
    sourceHash: "027cddc00c76b78c13fcb133b5cfc00872a7d672619b7b6f793c5229600ced2d",
    label: "Тайм-аут ask",
    description:
      "Автоматически выбирать рекомендованный вариант ask через столько секунд (0 отключает)",
    options: {
      "0": {
        label: "Отключено",
      },
      "15": {
        label: "15 секунд",
      },
      "30": {
        label: "30 секунд",
      },
      "60": {
        label: "60 секунд",
      },
      "120": {
        label: "120 секунд",
      },
    },
  },
  "ask.notify": {
    sourceHash: "94705b07d84277f0eaa1cfcb0fc129121a18fb1f4c7c6bbfefdf9675e405f99b",
    label: "Уведомление ask",
    description: "Уведомлять, когда инструмент ask ждёт ввода",
  },
  "recap.enabled": {
    sourceHash: "410f35d7ed07912876381f1ba5b01181dcb0ca67a3bf60dda31430bd432657ff",
    label: "Сводка при простое",
    description:
      "Создавать краткую сводку от LLM о текущем состоянии после простоя терминала",
  },
  "recap.idleSeconds": {
    sourceHash: "437446fada1b1da2f63a3786d5b06ae457e791a8a3e9e67bd98788f0041ae234",
    label: "Задержка сводки при простое",
    description: "Сколько секунд простоя ждать перед показом сводки",
    options: {
      "60": {
        label: "1 минута",
      },
      "120": {
        label: "2 минуты",
      },
      "240": {
        label: "4 минуты",
      },
      "300": {
        label: "5 минут",
      },
      "600": {
        label: "10 минут",
      },
    },
  },
  "power.sleepPrevention": {
    sourceHash: "f5493aa7f9bdab68b1e4d5cbb745f6c3925423f42c5e68232ea23a2d3b2f51dd",
    label: "Предотвращение сна",
    description:
      "Не давать системе засыпать во время активных сессий. Каждый уровень накопительный — он добавляет флаги всех нижних уровней.",
    options: {
      off: {
        label: "Выкл.",
        description: "Не предотвращать сон",
      },
      idle: {
        label: "Предотвращать сон при простое",
        description:
          "Держать систему активной, пока сессия открыта (macOS `caffeinate -i`)",
      },
      display: {
        label: "Предотвращать сон дисплея",
        description:
          "Также не давать дисплею засыпать при простое (macOS `caffeinate -i -d`)",
      },
      system: {
        label: "Предотвращать сон системы",
        description:
          "Также блокировать любой сон системы от сети и объявлять пользователя активным (macOS `caffeinate -i -d -s -u`)",
      },
    },
  },
  "prewalk.enabled": {
    sourceHash: "216aa6a231a0c76446686388a1c9695577c3f6a126834d97294ea8ce835360c0",
    label: "Включить prewalk",
    description:
      "Начинать на активной модели, затем переключаться на быструю/дешёвую модель (по умолчанию роль 'smol') при первой правке/записи после появления списка задач от plan nudge — сильная модель планирует, фиксирует задачи и начинает реализацию, прежде чем передать работу. Можно переопределить для сессии с помощью --prewalk / --no-prewalk.",
  },
  "providers.maxInFlightRequests": {
    sourceHash: "47cc3667d60052e8a40bef6747773c42dda7a1a855279b31cc8c96800e16b6f2",
    label: "Максимум одновременных запросов",
    description:
      "Максимум одновременных запросов LLM на идентификатор провайдера (например, \"openai\" или \"anthropic\"), общий для локальных процессов OMP с этим корнем конфигурации. Для провайдеров без записи ограничения нет.",
  },
  "providers.openai-codex.codeMode": {
    sourceHash: "596c36b70f679951fff0b98a161c980337a016fb0dcf16b81823d7f1d27d3343",
    label: "Режим Code в Codex",
    description:
      "Направлять модели Codex с code_mode_only (GPT-5.6) через eval. Прямые инструменты — eval, ask, todo, yield, think, checkpoint и rewind. Для остальных инструментов сессии используйте ячейки eval. Повторяет Code Mode из codex-rs. 'auto' следует флагу каталога моделей.",
  },
  "providers.openai-codex.codeModeDirectTools": {
    sourceHash: "21ff26a401f3283facc95e858d5ed2e4962094e914d2725d1cf4465beba42a50",
    label: "Прямые инструменты режима Code в Codex",
    description:
      "Дополнительные прямые инструменты для режима Code в Codex. Стандартные прямые инструменты — eval, ask, todo, yield, think, checkpoint и rewind.",
  },
  "images.describeForTextModels": {
    sourceHash: "ba8cd5be1b071b80de2725a5706bbe4d85bec4dbfcba44863e77f43988343ea4",
    label: "Описывать изображения для текстовых моделей",
    description:
      "Если изображение прикреплено к модели без поддержки зрения, сохранять его в local:// и подставлять описание от модели со зрением вместо того, чтобы отбрасывать его",
  },
  defaultThinkingLevel: {
    sourceHash: "9111eae304b11e100774dadf9c50ee39d2815e005c4507f102a9d1c3ba4ceeb9",
    label: "Уровень размышления",
    description: "Глубина рассуждений для моделей с поддержкой размышления",
    options: {
      auto: {
        label: "auto",
        description: "Автоопределение для каждого промпта",
      },
      minimal: {
        label: "min",
        description: "Очень краткое рассуждение (~1k токенов)",
      },
      low: {
        label: "low",
        description: "Лёгкое рассуждение (~2k токенов)",
      },
      medium: {
        label: "medium",
        description: "Умеренное рассуждение (~8k токенов)",
      },
      high: {
        label: "high",
        description: "Глубокое рассуждение (~16k токенов)",
      },
      xhigh: {
        label: "xhigh",
        description: "Расширенное рассуждение (~32k токенов)",
      },
      max: {
        label: "max",
        description: "Максимальное рассуждение, поддерживаемое моделью",
      },
    },
  },
  hideThinkingBlock: {
    sourceHash: "539f8dc3674e9f7b820d51d10006a04f5c5b73de53541a0e43c1a5cc9ac49aee",
    label: "Скрывать блоки размышления",
    description: "Скрывать блоки размышления в ответах ассистента",
  },
  proseOnlyThinking: {
    sourceHash: "d4ad65fe4ec6418163030e85e4bf7fabc7363c26af8761961ec636db1ff855d3",
    label: "Размышления только текстом",
    description:
      "Исключать блоки кода из сводок размышления и заменять их многоточием",
  },
  omitThinking: {
    sourceHash: "5ba9db1f9a3230f212d8080ac409ba01c6f49ec9b6b719ec06958eec0765fa07",
    label: "Не отправлять сводки размышления",
    description:
      "Просить вышестоящих провайдеров полностью исключать сводки размышления из ответов (где поддерживается)",
  },
  externalThinking: {
    sourceHash: "69d744e4c7b128467b73fb22e49a6ef851a6492881b32aedb73ab4e3e03f440e",
    label: "Внешнее размышление",
    description:
      "Приватный черновик; не показывается пользователю. Отключает поддерживаемые рассуждения GPT, Claude и Gemini",
    warning:
      "На ваш риск: провайдеры помечали такую форму запроса как злоупотребление, вплоть до мер на уровне аккаунта",
  },
  "model.loopGuard.enabled": {
    sourceHash: "6bd732a70f60303d37acd24e924f7cfb8d6c0dc670b1d5fc3311984ee542a467",
    label: "Защита от циклов",
    description:
      "Включить автоматическое обнаружение циклов в потоке рассуждений и текста модели",
  },
  "model.loopGuard.checkAssistantContent": {
    sourceHash: "f99cd7b8f957a1df6fafbb890f4b7a6e02301527c70b982d44274eb74ab8fd9b",
    label: "Защита от циклов: сканировать текст",
    description:
      "Применять защиту от циклов к текстовым сообщениям ассистента вдобавок к журналам размышления",
  },
  "model.loopGuard.toolCallReminder": {
    sourceHash: "90dcef4207e7de943259aba9d6a36c16f38206ab6cd86bd670e9643197aa4063",
    label: "Напоминание о вызове инструмента (защита от циклов)",
    description:
      "Когда поток рассуждений Gemini выдаёт много подряд заголовков планирования без вызова инструмента, прервать его и внедрить напоминание вызвать инструмент (требуется защита от циклов)",
  },
  "model.toolCallLoopGuard.enabled": {
    sourceHash: "7b7ae941d9a5b037917fa2d89f97cac094b4881695e659acd0cdeef612ea768e",
    label: "Защита от циклов вызовов инструментов",
    description:
      "Обнаруживать одинаковые вызовы инструментов подряд между ходами и внедрять корректирующее управляющее сообщение",
  },
  "model.toolCallLoopGuard.threshold": {
    sourceHash: "96bc9f2f0c9772a54dd648844a36648455aed76512b5e2ad4cf00cbae63079a2",
    label: "Порог циклов вызовов инструментов",
    description:
      "Сколько одинаковых вызовов инструментов подряд нужно, чтобы внедрить корректирующее сообщение",
  },
  "model.toolCallLoopGuard.exemptTools": {
    sourceHash: "1866d8c94a8995695e2ac84db7a361039111fdd8ca2323fda177228556e9b48f",
    label: "Исключения из защиты от циклов вызовов инструментов",
    description:
      "Имена инструментов, которые могут повторяться подряд, не запуская межходовую защиту от циклов",
  },
  inlineToolDescriptors: {
    sourceHash: "87ae40514d48f7d5003ca8a5711e964cfbf2fc4e4e81f620a15a78dd9d4201b6",
    label: "Встроенные описания инструментов",
    description:
      "Размещать полные описания инструментов в системном промпте и убирать описания верхнего уровня и вложенные из схем инструментов провайдера, чтобы текст описания отправлялся один раз. Auto включает это для моделей Gemini и отключает в остальных случаях",
    options: {
      auto: {
        label: "Авто",
        description:
          "Встроенные описания для моделей Gemini; иначе оставлять их в схемах инструментов",
      },
      on: {
        label: "Вкл.",
        description: "Всегда встраивать описания в системный промпт",
      },
      off: {
        label: "Выкл.",
        description: "Оставлять описания только в схемах инструментов провайдера",
      },
    },
  },
  includeModelInPrompt: {
    sourceHash: "45937695fa06b31503a51a895827f4517fdb35a24f4363fbbae01b6f1398dc33",
    label: "Указывать модель в промпте",
    description:
      "Показывать идентификатор активной модели в системном промпте, чтобы агент знал, какая это модель",
  },
  includeWorkspaceTree: {
    sourceHash: "d031ddfafddfd06218a9027babd05031004d17101d94048a3843019fa0dfe127",
    label: "Включать дерево рабочего пространства",
    description:
      "Отображать дерево каталогов рабочего пространства в системном промпте. ВНИМАНИЕ: это может ломать кэш промпта между сессиями при изменении файлов.",
  },
  skillful: {
    sourceHash: "ec1baf2583370639bf534118f525772373881dfc98f9b19a54ea336c632add50",
    label: "Перечислять навыки в промпте",
    description:
      "Перечислять доступные навыки в системном промпте; отключите, чтобы экономить контекст, и переключайте для сессии командой /skillful",
  },
  personality: {
    sourceHash: "fafcc92b52f12d1f9436f019b50268e8bca4c3ddd45bfaa69503e36ef71a3930",
    label: "Характер",
    description:
      "Стиль общения, подставляемый в блок характера системного промпта",
    options: {
      default: {
        label: "По умолчанию",
        description:
          "Немногословный инженер, опирающийся на факты; плотные, ориентированные на действие ответы",
      },
      friendly: {
        label: "Дружелюбный",
        description:
          "Тёплый, поддерживающий собеседник, нацеленный на динамику и моральный дух",
      },
      pragmatic: {
        label: "Прагматичный",
        description: "Прямой, эффективный инженер, нацеленный на ясность и строгость",
      },
      none: {
        label: "Нет",
        description: "Полностью опустить блок характера",
      },
    },
  },
  temperature: {
    sourceHash: "c7ee90beb7efad0eb74cb42537b81edc41402cc5ba8faa5cc18aebee38cd3e61",
    label: "Температура",
    description:
      "Температура сэмплирования (0 — детерминированно, 1 — креативно, -1 — по умолчанию у провайдера)",
    options: {
      "-1": {
        label: "По умолчанию",
        description: "Использовать значение провайдера по умолчанию",
      },
      "0": {
        label: "0",
        description: "Детерминированно",
      },
      "0.2": {
        label: "0.2",
        description: "Сфокусированно",
      },
      "0.5": {
        label: "0.5",
        description: "Сбалансированно",
      },
      "0.7": {
        label: "0.7",
        description: "Креативно",
      },
      "1": {
        label: "1",
        description: "Максимальное разнообразие",
      },
    },
  },
  topP: {
    sourceHash: "bfa5b2741b8c9bcedfd2990210a98e40a5ab10ccbe5334bf15a41758bf81e827",
    label: "Top P",
    description:
      "Порог нуклеусного сэмплирования (0–1, -1 — по умолчанию у провайдера)",
    options: {
      "-1": {
        label: "По умолчанию",
        description: "Использовать значение провайдера по умолчанию",
      },
      "0.1": {
        label: "0.1",
        description: "Очень сфокусированно",
      },
      "0.3": {
        label: "0.3",
        description: "Сфокусированно",
      },
      "0.5": {
        label: "0.5",
        description: "Сбалансированно",
      },
      "0.9": {
        label: "0.9",
        description: "Широко",
      },
      "1": {
        label: "1",
        description: "Без нуклеусной фильтрации",
      },
    },
  },
  topK: {
    sourceHash: "a2490c8a0543cc00b7cbaf86ca9b7b085f76a9f8c4fd2fd16f713e635b04f3ed",
    label: "Top K",
    description: "Сэмплировать из top-K токенов (-1 — по умолчанию у провайдера)",
    options: {
      "-1": {
        label: "По умолчанию",
        description: "Использовать значение провайдера по умолчанию",
      },
      "1": {
        label: "1",
        description: "Жадно брать топовый токен",
      },
      "20": {
        label: "20",
        description: "Сфокусированно",
      },
      "40": {
        label: "40",
        description: "Сбалансированно",
      },
      "100": {
        label: "100",
        description: "Широко",
      },
    },
  },
  minP: {
    sourceHash: "c73113001663413a8b5f8c5f0eb005ff7bc840559ced23593731d253a7ecc725",
    label: "Min P",
    description:
      "Минимальный порог вероятности (0–1, -1 — по умолчанию у провайдера)",
    options: {
      "-1": {
        label: "По умолчанию",
        description: "Использовать значение провайдера по умолчанию",
      },
      "0.01": {
        label: "0.01",
        description: "Очень мягко",
      },
      "0.05": {
        label: "0.05",
        description: "Сбалансированно",
      },
      "0.1": {
        label: "0.1",
        description: "Строго",
      },
    },
  },
  presencePenalty: {
    sourceHash: "5d425f9a9e07cba2c011fdb4fede5a9d7ff3f7838f5a710699ee8459dbc614e0",
    label: "Штраф за присутствие",
    description:
      "Штраф за введение уже присутствующих токенов (-1 — по умолчанию у провайдера)",
    options: {
      "-1": {
        label: "По умолчанию",
        description: "Использовать значение провайдера по умолчанию",
      },
      "0": {
        label: "0",
        description: "Без штрафа",
      },
      "0.5": {
        label: "0.5",
        description: "Умеренная новизна",
      },
      "1": {
        label: "1",
        description: "Поощрять новизну",
      },
      "2": {
        label: "2",
        description: "Сильная новизна",
      },
    },
  },
  repetitionPenalty: {
    sourceHash: "73d795947718b810c7f076ca96fa857a7be4ba8afd290362e7dc298686dfd67a",
    label: "Штраф за повторение",
    description: "Штраф за повторяющиеся токены (-1 — по умолчанию у провайдера)",
    options: {
      "-1": {
        label: "По умолчанию",
        description: "Использовать значение провайдера по умолчанию",
      },
      "0.8": {
        label: "0.8",
        description: "Разрешать повторы",
      },
      "1": {
        label: "1",
        description: "Без штрафа",
      },
      "1.1": {
        label: "1.1",
        description: "Умеренный штраф",
      },
      "1.2": {
        label: "1.2",
        description: "Сбалансированно",
      },
      "1.5": {
        label: "1.5",
        description: "Сильный штраф",
      },
    },
  },
  textVerbosity: {
    sourceHash: "7570c318bc48dd3c9727d2ae937d4d99f36a809c77f858440228f64b5273b3d8",
    label: "Многословность текста",
    description:
      "OpenAI Responses и многословность ответов Codex (low, medium или high)",
    options: {
      low: {
        label: "Низкая",
        description: "Предпочитать краткие ответы",
      },
      medium: {
        label: "Средняя",
        description: "Баланс краткости и деталей (по умолчанию)",
      },
      high: {
        label: "Высокая",
        description: "Предпочитать подробные ответы",
      },
    },
  },
  "tier.openai": {
    sourceHash: "02b486b4e7c98a2fbb784ec5e8d578036eacceabd47bc83daeb981ebf953eb44",
    label: "Уровень сервиса — OpenAI",
    description:
      "Уровень обработки для запросов OpenAI / OpenAI-Codex и моделей семейства OpenAI, маршрутизируемых через OpenRouter (none — не отправлять). Передаётся как `service_tier`.",
    options: {
      none: {
        label: "Нет",
        description: "Не отправлять service_tier (стандартная обработка)",
      },
      auto: {
        label: "Авто",
        description: "Выбор уровня провайдером по умолчанию",
      },
      default: {
        label: "По умолчанию",
        description: "Стандартная приоритетная обработка",
      },
      flex: {
        label: "Flex",
        description: "Ниже стоимость, выше задержка, когда доступно",
      },
      scale: {
        label: "Scale",
        description: "Кредиты Scale Tier, когда доступно",
      },
      priority: {
        label: "Priority",
        description: "Быстрее, дороже (премиум-запрос)",
      },
      ultrafast: {
        label: "Ultrafast",
        description:
          "Самая низкая задержка; предварительный доступ к API OpenAI или модели Codex, которые это поддерживают",
      },
    },
  },
  "tier.anthropic": {
    sourceHash: "f83145b4056743830b12cb65f657efef8f613c6bc4c4cf26a070e79ac2815c00",
    label: "Уровень сервиса — Anthropic",
    description:
      "Уровень обработки для запросов Claude. `priority` реализует быстрый режим (`speed: \"fast\"`) на поддерживаемых прямых моделях Anthropic; игнорируется для Claude на Bedrock/Vertex и через OpenRouter.",
    options: {
      none: {
        label: "Нет",
        description: "Стандартная обработка",
      },
      priority: {
        label: "Priority",
        description:
          "Быстрый режим (`speed: \"fast\"`) на поддерживаемых прямых моделях Claude; игнорируется на Bedrock/Vertex",
      },
    },
  },
  "tier.google": {
    sourceHash: "1d13f1bd0b106adb506b6c16e598cb3b44e6e4d657d001af769ca9032b0d9eb3",
    label: "Уровень сервиса — Google",
    description:
      "Уровень обработки для запросов Gemini (Google AI Studio + Vertex) и моделей семейства Google, маршрутизируемых через OpenRouter (none — не отправлять). Передаётся в поле верхнего уровня `serviceTier`.",
    options: {
      none: {
        label: "Нет",
        description: "Стандартная обработка",
      },
      flex: {
        label: "Flex",
        description: "Ниже стоимость, выше задержка (Gemini API + Vertex)",
      },
      priority: {
        label: "Priority",
        description: "Быстрее, выше надёжность (Gemini API + Vertex)",
      },
    },
  },
  "tier.subagent": {
    sourceHash: "79e696bc56bca837867ea7bb588cd2694b1b50c03b11564d8b87ff40061efad6",
    label: "Уровень сервиса — субагент",
    description:
      "Уровень сервиса для запускаемых субагентов task/eval. Inherit — соответствовать текущим уровням основного агента по семействам (следует за /fast); выберите значение, чтобы применить его к семейству, к которому относится модель субагента.",
    options: {
      inherit: {
        label: "Наследовать",
        description: "Соответствовать текущим уровням основного агента по семействам",
      },
      none: {
        label: "Нет",
        description: "Стандартная обработка",
      },
      auto: {
        label: "Авто",
        description: "Выбор уровня провайдером по умолчанию (семейство OpenAI)",
      },
      default: {
        label: "По умолчанию",
        description: "Стандартная приоритетная обработка (семейство OpenAI)",
      },
      flex: {
        label: "Flex",
        description: "Гибкий уровень ёмкости (семейства OpenAI/Google)",
      },
      scale: {
        label: "Scale",
        description: "Кредиты Scale Tier (семейство OpenAI)",
      },
      priority: {
        label: "Priority",
        description: "Приоритет во всех поддерживаемых семействах запущенной модели",
      },
      ultrafast: {
        label: "Ultrafast",
        description: "Сверхбыстрое обслуживание (семейство OpenAI, где доступно)",
      },
    },
  },
  "tier.advisor": {
    sourceHash: "cf18d10f3a9525bcb09f1b35bc178c8c2b8b2b149c58212c59f7160cd6693410",
    label: "Уровень сервиса — советник",
    description:
      "Уровень сервиса для модели-советника. None — стандартная обработка; Inherit — соответствовать текущим уровням основного агента по семействам; выберите значение, чтобы применить его к семейству модели-советника.",
    options: {
      inherit: {
        label: "Наследовать",
        description: "Соответствовать текущим уровням основного агента по семействам",
      },
      none: {
        label: "Нет",
        description: "Стандартная обработка",
      },
      auto: {
        label: "Авто",
        description: "Выбор уровня провайдером по умолчанию (семейство OpenAI)",
      },
      default: {
        label: "По умолчанию",
        description: "Стандартная приоритетная обработка (семейство OpenAI)",
      },
      flex: {
        label: "Flex",
        description: "Гибкий уровень ёмкости (семейства OpenAI/Google)",
      },
      scale: {
        label: "Scale",
        description: "Кредиты Scale Tier (семейство OpenAI)",
      },
      priority: {
        label: "Priority",
        description: "Приоритет во всех поддерживаемых семействах запущенной модели",
      },
      ultrafast: {
        label: "Ultrafast",
        description: "Сверхбыстрое обслуживание (семейство OpenAI, где доступно)",
      },
    },
  },
  "retry.maxRetries": {
    sourceHash: "9d6ab143f3c8ddda872a0883a0dc0f5ac568d44bbb60bf5559f8934a0de183da",
    label: "Попытки повтора",
    description: "Максимальное число попыток повтора при ошибках API",
    options: {
      "1": {
        label: "1 повтор",
      },
      "2": {
        label: "2 повтора",
      },
      "3": {
        label: "3 повтора",
      },
      "5": {
        label: "5 повторов",
      },
      "10": {
        label: "10 повторов",
      },
    },
  },
  "retry.maxDelayMs": {
    sourceHash: "2419687df9ba8e1133e7797d3b2cdaf73c5657bbe9b0b574c7f340329bcb71af",
    label: "Максимальная задержка повтора",
    description:
      "Максимальное ожидание между повторами, в мс. Когда провайдер просит подождать дольше, а откат по учётным данным или модели не удаётся, запрос завершается ошибкой сразу вместо ожидания (например, 3-часовые окна лимитов Anthropic). 0 отключает потолок — чтобы сессия автоматически продолжалась после указанных провайдером сбросов квоты.",
  },
  "retry.waitForUsageReset": {
    sourceHash: "278915650c3d1b4bd30da1d43227347485f2e13273c6ab3011963b8c8aaa5e02",
    label: "Ждать сброса лимита",
    description:
      "Когда провайдер сообщает об исчерпании лимита с временем сброса (5-часовые или недельные окна квоты у любого провайдера), ждать до сброса вместо быстрого отказа после retry.maxDelayMs. Ожидание можно прервать ({escape}), но оно также удерживает субагентов, поэтому для необслуживаемых запусков оставьте выключенным.",
    descriptionSource:
      "When a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), sleep until the reset instead of failing fast past retry.maxDelayMs. Waits are abortable ({escape}) but also hold subagents, so leave off for unattended runs.",
  },
  "retry.modelFallback": {
    sourceHash: "3decae223a3b1229a676877586502fa56424b2f5d819d686e6531976e7e266d2",
    label: "Откат модели при повторе",
    description:
      "Разрешать восстановлению при повторе переключаться на настроенные резервные модели",
  },
  "retry.usageAwareFallback": {
    sourceHash: "cfba9ba97c575815def45107822d74c1c411ddee22834a1a19c5b479351d04f0",
    label: "Откат с учётом расхода",
    description:
      "Использовать надёжные отчёты о квоте coding-plan, чтобы предпочитать аккаунты того же провайдера, а затем настроенные резервные модели, прежде чем упереться в жёсткий лимит. Обычные настроенные API-ключи не учитываются.",
  },
  "retry.usageReservePct": {
    sourceHash: "53493ed53bf1eee03ad0f44c57e60a012b57a0704321156ae6b6144e7f31a8d3",
    label: "Резервный запас",
    description:
      "Считать модель coding-plan близкой к лимиту, когда остаток ниже этого процента. При неизвестном или несопоставленном расходе остаётся основная модель.",
    options: {
      "5": {
        label: "5%",
        description: "Действовать только при почти полном исчерпании",
      },
      "10": {
        label: "10%",
        description: "Сбалансированный запас надёжности",
      },
      "15": {
        label: "15%",
        description: "Консервативно",
      },
      "20": {
        label: "20%",
        description: "Ранняя защита",
      },
      "25": {
        label: "25%",
        description: "Очень консервативно",
      },
    },
  },
  "retry.usageReservePolicy": {
    sourceHash: "2c1c77aa1c568f00523dc8bb037e682c76b418a0bd358c48abd01066007e1f58",
    label: "Политика резерва",
    description:
      "Что делать, когда все аккаунты coding-plan того же провайдера входят в резервный запас.",
    options: {
      confirm: {
        label: "Подтверждать интерактивно",
        description:
          "Оставлять интерактивные сессии на основной модели до подтверждения; фоновые агенты откатываются автоматически",
      },
      auto: {
        label: "Автоматический откат",
        description: "Всегда выбирать следующую подходящую настроенную резервную модель",
      },
      "fail-closed": {
        label: "Завершать с ошибкой",
        description: "Не расходовать резервную квоту и не выбирать резервную модель",
      },
    },
  },
  "retry.fallbackChains": {
    sourceHash: "b5b1d50a5e01ed5490faa0549b40cfe828a5c636b80df5bac54b60f604a7330a",
    label: "Цепочки резервных моделей при повторе",
    description:
      "JSON-объект, сопоставляющий роли моделей, селекторы моделей (\"provider/model-id\") или подстановки провайдеров (\"provider/*\") с упорядоченными резервными селекторами, например {\"default\":[\"openai/gpt-4o-mini\"],\"google-antigravity/*\":[\"google/*\",\"google-vertex/*\"]}. Ключи, ориентированные на модель, применяются, когда эта модель/провайдер активны, независимо от роли; запись \"provider/*\" сохраняет id отказавшей модели и меняет провайдера. Подстановка с префиксом id (\"openrouter/google/*\") заново добавляет префикс к голому id отказавшей модели (google-antigravity/gemini-x -> openrouter/google/gemini-x) и, будучи ключом, сопоставляется только с id этого провайдера под префиксом. Резервная запись может нести явный суффикс размышления (\"provider/model:low\", \":high\", \":max\", \":off\"); запись без суффикса наследует усилие отказавшего хода, а записи \"provider/*\" наследуют всегда.",
  },
  "retry.fallbackRevertPolicy": {
    sourceHash: "fd3ba2e96202fb1c31c06bc11270ed09ccca1608e53e09f49e7da24ff5072739",
    label: "Политика возврата после отката",
    description: "Когда возвращаться к основной модели после отката",
    options: {
      "cooldown-expiry": {
        label: "Истечение периода охлаждения",
        description:
          "Возвращаться к основной модели после окончания окна её подавления",
      },
      never: {
        label: "Никогда",
        description: "Оставаться на резервной модели до ручного изменения",
      },
    },
  },
  "providers.anthropic.serverSideFallback": {
    sourceHash: "0492267aa35076367d9c4228e3b10e2605c0a66a5f439b4c4237a7f1995baf9e",
    label: "Серверный откат Anthropic (Fable 5)",
    description:
      "Когда запрос Claude Fable 5 / Mythos 5 блокируется классификатором безопасности Anthropic, повторять его на Claude Opus 5 на стороне сервера (бета Anthropic `server-side-fallback-2026-06-01`). Включается явно — если оставить выключенным, для каждого запроса сохраняется прежнее поведение без резервного переключения.",
  },
  "providers.ollama-cloud.maxConcurrency": {
    sourceHash: "fe431d922c64280cce75789cf40cb47b4592cc7839abf3088ba7c4203e1d63f3",
    label: "Максимум параллельных запусков Ollama Cloud",
    description:
      "Максимум одновременных запусков субагентов Ollama Cloud на процесс; 0 отключает ограничение для этого провайдера",
  },
  "providers.webSearchTimeoutSeconds": {
    sourceHash: "71c8ac2e307eceb1741a498527d96c6313bed518f7cb610f0c2f3c38462dab6e",
    label: "Тайм-аут веб-поиска",
    description:
      "Жёсткий тайм-аут для поискового транспорта каждого провайдера, после которого web_search переходит к следующему резервному варианту, в секундах (максимум 300)",
    options: {
      "30": {
        label: "30 секунд",
      },
      "60": {
        label: "1 минута",
      },
      "120": {
        label: "2 минуты",
      },
      "180": {
        label: "3 минуты",
      },
      "300": {
        label: "5 минут",
      },
    },
  },
  "providers.antigravityEndpoint": {
    sourceHash: "1e318646b30303f15f8c7f45adfa8f5b50d2e143440a4b6889bd81832ef3a8b6",
    label: "Режим эндпоинта Antigravity",
    description:
      "Стратегия маршрутизации эндпоинтов для провайдеров google-antigravity (чат, поиск, изображения, обнаружение)",
    options: {
      auto: {
        label: "Авто",
        description: "Пробовать рабочий эндпоинт, при 5xx/429 переключаться на песочницу",
      },
      production: {
        label: "Только рабочий",
        description: "Принудительно использовать только рабочий эндпоинт",
      },
      sandbox: {
        label: "Только песочница",
        description: "Принудительно использовать только эндпоинт песочницы",
      },
    },
  },
  "providers.fireworksTier": {
    sourceHash: "05064ba6ba68d1f55088dfc2b96325bad814135d9809d958f53f0b400bf2af7c",
    label: "Уровень Fireworks",
    description:
      "Путь обслуживания для запросов Fireworks. Priority отправляет `service_tier: \"priority\"` для большей надёжности в часы пик по более высокой цене; Standard его не отправляет. Быстрые модели (`-fast`) это игнорируют — Fast имеет собственный путь обслуживания.",
    options: {
      standard: {
        label: "Standard",
        description: "Путь обслуживания по умолчанию (без service_tier)",
      },
      priority: {
        label: "Priority",
        description:
          "Приоритетный путь: выше надёжность, премиальная цена за токен",
      },
    },
  },
  "providers.tinyModelDevice": {
    sourceHash: "edcd3a6a11491078f10d16183da918649be9597b9354a4b8b80731538df2086b",
    label: "Устройство tiny-модели",
    description:
      "Бэкенд вывода для локальных tiny-моделей (заголовки + память): исполнитель ONNX или `mlx`, чтобы скачать веса MLX и запускать их через mlx-lm на Apple silicon. По умолчанию используется ONNX только на CPU. Переменная окружения PI_TINY_DEVICE переопределяет это.",
    options: {
      default: {
        label: "По умолчанию",
        description: "Вывод только на CPU",
      },
      gpu: {
        label: "GPU",
        description: "Ускоренный провайдер (WebGPU/Metal, CUDA или DirectML)",
      },
      cpu: {
        label: "CPU",
        description: "Вывод только на CPU",
      },
      mlx: {
        label: "MLX",
        description: "GPU Apple silicon через mlx-lm (подпроцесс Python; macOS arm64)",
      },
      metal: {
        label: "Metal",
        description: "Синоним MLX",
      },
      webgpu: {
        label: "WebGPU",
        description: "Бэкенд WebGPU/Metal",
      },
      cuda: {
        label: "CUDA",
        description: "NVIDIA CUDA (Linux x64)",
      },
      dml: {
        label: "DirectML",
        description: "Бэкенд DirectML (Windows)",
      },
      coreml: {
        label: "CoreML",
        description: "Apple CoreML (включается явно; может не загрузиться)",
      },
      auto: {
        label: "Авто",
        description: "Позволить ONNX Runtime выбрать провайдера",
      },
      wasm: {
        label: "WASM",
        description: "Бэкенд WebAssembly",
      },
      webnn: {
        label: "WebNN",
        description: "Бэкенд WebNN",
      },
      "webnn-gpu": {
        label: "WebNN GPU",
        description: "Устройство WebNN GPU",
      },
      "webnn-cpu": {
        label: "WebNN CPU",
        description: "Устройство WebNN CPU",
      },
      "webnn-npu": {
        label: "WebNN NPU",
        description: "Устройство WebNN NPU",
      },
    },
  },
  "providers.tinyModelDtype": {
    sourceHash: "b9f502c582012830474d5c7b38be3891178129c048dbc6cb0393e2efdee9166b",
    label: "Точность tiny-модели",
    description:
      "Квантование/точность ONNX для локальных tiny-моделей. По умолчанию используется поставляемый с каждой моделью dtype (q4); ниже точность — быстрее, выше — точнее. Игнорируется бэкендом MLX (его репозитории уже квантованы до 4 бит). Переменная окружения PI_TINY_DTYPE переопределяет это.",
    options: {
      default: {
        label: "По умолчанию",
        description: "Поставляемый dtype каждой модели (сейчас q4)",
      },
      q4: {
        label: "q4",
        description: "4-битные веса; самые маленькие и быстрые",
      },
      q4f16: {
        label: "q4f16",
        description: "4-битные веса с активациями fp16",
      },
      q8: {
        label: "q8",
        description: "8-битное квантование",
      },
      fp16: {
        label: "fp16",
        description: "16-битные числа с плавающей точкой; выше точность, больше размер",
      },
      fp32: {
        label: "fp32",
        description: "Полная точность; самые большие и медленные",
      },
      int8: {
        label: "int8",
        description: "Знаковое 8-битное целое",
      },
      uint8: {
        label: "uint8",
        description: "Беззнаковое 8-битное целое",
      },
      bnb4: {
        label: "bnb4",
        description: "4-битное bitsandbytes",
      },
      q2: {
        label: "q2",
        description: "2-битные веса",
      },
      q2f16: {
        label: "q2f16",
        description: "2-битные веса с активациями fp16",
      },
      q1: {
        label: "q1",
        description: "1-битные веса",
      },
      q1f16: {
        label: "q1f16",
        description: "1-битные веса с активациями fp16",
      },
      auto: {
        label: "Авто",
        description: "Позволить transformers.js выбрать для устройства",
      },
    },
  },
  "providers.autoThinkingMaxEffort": {
    sourceHash: "c3f703997d75f3b1166ffee7391d409abf61e6ebc64b117192393d8325848775",
    label: "Потолок автоматического размышления",
    description:
      "Наибольшее усилие, которое может выбрать классификатор `auto`. `xhigh` держит классификатор на уровень ниже максимума, поэтому только явный `ultrathink` доходит до `max`; `max` позволяет ходу, который классификатор счёл исключительным, использовать высший уровень на моделях, где он есть.",
    options: {
      xhigh: {
        label: "xhigh",
        description: "Классификатор останавливается на xhigh (по умолчанию)",
      },
      max: {
        label: "max",
        description: "Классификатор может выбрать max там, где модель это поддерживает",
      },
    },
  },
  "features.unexpectedStopDetection": {
    sourceHash: "331f256121ca5d7693bf7c161549415ba8c1a2c3c3e312a5832f9236834a5805",
    label: "Неожиданные остановки",
    description:
      "Автоматически восстанавливаться, когда ассистент останавливается без видимого сообщения. Smart также классифицирует остановки только с текстом с помощью небольшой модели.",
    options: {
      none: {
        label: "Нет",
        description: "Отключено",
      },
      mechanical: {
        label: "Механическое",
        description:
          "Повторять остановки без видимого сообщения ассистента; вызовы инструментов исключены (по умолчанию)",
      },
      smart: {
        label: "Умное",
        description: "Механическое + классификация остановок только с текстом небольшой моделью",
      },
    },
  },
  "providers.kimiApiFormat": {
    sourceHash: "568f40510429d29583084830145e7db533acb10fd6e608413155bcb0d5f804ca",
    label: "Формат API Kimi",
    description:
      "Формат API для провайдера Kimi Code (auto следует живым метаданным модели)",
    options: {
      auto: {
        label: "Авто",
        description: "Использовать протокол, объявленный сервером модели",
      },
      openai: {
        label: "OpenAI",
        description: "api.kimi.com",
      },
      anthropic: {
        label: "Anthropic",
        description: "api.moonshot.ai",
      },
    },
  },
  "providers.openaiWebsockets": {
    sourceHash: "e02fcda6209fff1f11571fa354f6fe499e276aad74e20c937fa4386ca7ac53dc",
    label: "OpenAI WebSockets",
    description:
      "Политика Websocket для моделей OpenAI Codex (auto использует настройки модели по умолчанию, on включает принудительно, off отключает)",
    options: {
      auto: {
        label: "Авто",
        description: "Использовать поведение websocket по умолчанию для модели/провайдера",
      },
      off: {
        label: "Выкл.",
        description: "Отключить websockets для моделей OpenAI Codex",
      },
      on: {
        label: "Вкл.",
        description: "Принудительно включить websockets для моделей OpenAI Codex",
      },
    },
  },
  "providers.openaiLiveSteering": {
    sourceHash: "bcd975ff6d66fcbddc9ba9f1b653f212c50d1d5eb56dfe96ee295c00a1c042ad",
    label: "OpenAI Live Steering",
    description:
      "Доставлять сообщения, набранные пока идёт поток ответа GPT-6, прямо в этот ответ через Codex WebSocket, а не ждать следующей границы инструмента",
  },
  "providers.cacheRetention": {
    sourceHash: "445590c5156229532581a6ce9a557ab741e165c1bf27a8f61cc2788d4a93af39",
    label: "Хранение кэша промпта",
    description:
      "Срок хранения кэша промпта, передаваемый провайдерам, которые это поддерживают (Anthropic, Bedrock, OpenRouter, OpenAI)",
    options: {
      auto: {
        label: "Авто",
        description:
          "По умолчанию у провайдера — сессии подписчиков Anthropic OAuth по умолчанию 1 ч, API-ключи используют 5 мин; PI_CACHE_RETENTION по-прежнему применяется",
      },
      short: {
        label: "Короткое (5 мин)",
        description:
          "Самые дешёвые записи в кэш; сочетайте с прогревом кэша, чтобы короткие записи оставались живыми при простое",
      },
      long: {
        label: "Длинное (1 ч)",
        description:
          "TTL 1 ч там, где провайдер это поддерживает; записи дороже, прогреваются только во время активных запусков",
      },
      none: {
        label: "Выкл.",
        description: "Отключить кэширование промпта и маршрутизацию по привязке к кэшу",
      },
    },
  },
};
