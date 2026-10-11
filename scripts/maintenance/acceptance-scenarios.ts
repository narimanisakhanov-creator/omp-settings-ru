/**
 * Единственный источник истины набора сценариев приёмки.
 *
 * Листовой модуль: у него нет импортов проекта, поэтому его могут читать и CLI контроллера, и продюсер
 * семантического доказательства. Если бы список остался объявленным в CLI, продюсер импортировал бы CLI, а
 * CLI через контроллер импортирует продюсера — получился бы цикл модулей, в котором значение списка могло бы
 * читаться до его инициализации. Здесь цикла нет, и список объявлен ровно один раз.
 */

/** Сценарий оффлайн-жизненного цикла, который обязан прогнаться до выдачи приёмки. */
export interface AcceptanceScenario {
  readonly name: string;
  readonly file: string;
}

/**
 * Обязательный набор сценариев приёмки — источник истины для продюсера доказательства.
 *
 * Приёмка не может быть выдана по сокращённому набору: продюсер обязан прогнать ровно эти файлы, а `accept`
 * сверяет их состав и число выполненных тестов. Частичный набор не «почти готов», а отказ.
 */
export const ACCEPTANCE_SCENARIOS: readonly AcceptanceScenario[] = [
  { name: "activation-acceptance", file: "test/maintenance-activation.e2e.test.ts" },
  { name: "controller-lifecycle-fixtures", file: "test/maintenance-controller-flow.e2e.test.ts" },
  { name: "controller-real-git", file: "test/maintenance-controller.e2e.test.ts" },
  { name: "controller-verdict", file: "test/maintenance-controller.test.ts" },
  { name: "reviewer-exact-artifacts", file: "test/maintenance-report.test.ts" },
  { name: "tree-invariants", file: "test/maintenance-tree.test.ts" },
  { name: "semantic-gate", file: "test/maintenance-semantic.test.ts" },
  { name: "journal-effects", file: "test/maintenance-journal.test.ts" },
  { name: "precheck-decision", file: "test/maintenance-precheck.test.ts" },
] as const;

/**
 * Файлы сценариев без имён: доказательство продюсера состоит именно из факта их прогона, поэтому их
 * содержимое — часть проверяемого дерева контроллера, а не произвольный тест кандидата.
 */
export const ACCEPTANCE_SCENARIO_FILES: readonly string[] = ACCEPTANCE_SCENARIOS.map(scenario => scenario.file);
