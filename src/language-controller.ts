import { applyTranslations } from "./apply-translations";
import type { ApplyTranslationsResult } from "./apply-translations";
import type { HostMetadata } from "./host-types";
import type { LocalePack } from "./translations/types";

const refusalMessages: Readonly<Record<string, string>> = {
  "unsupported-host-version": "версия OMP не поддерживается; проверена только 18.8.0",
  "invalid-host-platform": "платформа хоста не определена",
  "invalid-host-schema": "структура реестра настроек несовместима",
  "invalid-setting-definition": "структура определения настройки несовместима",
  "invalid-ui-metadata": "структура отображаемых метаданных несовместима",
  "invalid-ui-options": "структура вариантов настройки несовместима",
  "host-read-failed": "метаданные хоста недоступны",
  "unsupported-locale-pack": "каталог перевода не соответствует версии хоста",
  "translation-already-active": "реестром уже владеет другой каталог перевода",
  "unsafe-property": "метаданные нельзя изменить и восстановить безопасно",
  "conflicting-translations": "общие метаданные содержат конфликтующие переводы",
  "plan-failed": "не удалось подготовить безопасный план перевода",
  "write-failed": "хост отклонил изменение; выполнен откат",
};

/** One main-session owner serializes transitions against the shared host registry. */
export class LanguageController {
  private host: HostMetadata | undefined;
  private active: Extract<ApplyTranslationsResult, { status: "applied" | "rolled-back" }> | undefined;
  private transition: Promise<string | undefined> = Promise.resolve(undefined);
  private restoreError: string | undefined;

  constructor(private readonly loadHost: () => Promise<HostMetadata>, private readonly pack: LocalePack) {}

  get language(): "ru" | "en" { return this.active?.status === "applied" ? "ru" : "en"; }
  get restorationPending(): boolean { return this.restoreError !== undefined; }

  setLanguage(language: "ru" | "en", agentKind: string): Promise<string | undefined> {
    if (agentKind !== "main") return Promise.resolve("язык настроек управляется основной сессией");
    this.transition = this.transition.then(async () => {
      if (language === "en") {
        if (!this.active) return;
        const errors = this.active.restore();
        if (errors.length) return this.restoreError = "не удалось безопасно восстановить исходные метаданные";
        this.active = undefined;
        this.restoreError = undefined;
        return;
      }
      if (this.active) return this.restoreError;
      try {
        this.host ??= await this.loadHost();
        const result = applyTranslations(this.host, this.pack);
        if (result.status !== "applied") {
          if (result.status === "rolled-back" && result.rollbackErrors.length) {
            this.active = result;
            return this.restoreError = "применение и откат метаданных не завершены; выберите en для повторного восстановления";
          }
          return refusalMessages[result.reason] ?? "перевод не применён: несовместимый интерфейс хоста";
        }
        this.active = result;
      } catch {
        // Import failures may include machine paths; never surface their raw messages.
        return "интерфейс метаданных OMP недоступен; перевод не применён";
      }
    }).catch(() => "переход языка не завершён; закройте сессию");
    return this.transition;
  }

  shutdown(agentKind: string): Promise<string | undefined> {
    return this.setLanguage("en", agentKind);
  }
}
