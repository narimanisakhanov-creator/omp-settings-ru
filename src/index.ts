import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { getHostMetadata } from "./host-adapter";
import { LanguageController } from "./language-controller";
import { ru } from "./translations/ru";

const extension: ExtensionFactory = pi => {
  const controller = new LanguageController(getHostMetadata, ru);

  pi.on("session_start", async (_event, context) => {
    if (context.agent.kind !== "main") return;
    const reason = await controller.setLanguage("ru", context.agent.kind);
    if (reason) context.ui.notify("omp-settings-ru: " + reason, "warning");
  });

  pi.registerCommand("settings-language", {
    description: "Язык панели /settings: ru (русский) или en (исходный английский)",
    handler: async (args, context) => {
      if (context.agent.kind !== "main") {
        context.ui.notify("Язык настроек управляется основной сессией.", "warning");
        return;
      }
      let language = args.trim();
      if (!language) {
        const choice = await context.ui.select(
          "Язык настроек — " + (controller.restorationPending ? "восстановление не завершено" : controller.language === "ru" ? "русский" : "English"),
          ["Русский", "English"],
        );
        if (!choice) return;
        language = choice === "Русский" ? "ru" : "en";
      }
      if (language !== "ru" && language !== "en") {
        context.ui.notify("Использование: /settings-language [ru|en]", "warning");
        return;
      }
      const reason = await controller.setLanguage(language, context.agent.kind);
      context.ui.notify(reason ? "omp-settings-ru: " + reason : "Язык настроек: " + (language === "ru" ? "русский" : "English") + ". Откройте /settings заново.", reason ? "warning" : "info");
    },
  });

  pi.on("session_shutdown", async (_event, context) => {
    if (context.agent.kind !== "main") return;
    const reason = await controller.shutdown(context.agent.kind);
    if (reason) context.ui.notify("omp-settings-ru: " + reason, "warning");
  });
};

export default extension;
