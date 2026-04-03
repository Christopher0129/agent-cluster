export function interpolate(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

export function resolveRuntimeLocale(root = typeof document !== "undefined" ? document : null) {
  const lang = String(root?.documentElement?.lang || "").toLowerCase();
  return lang.startsWith("en") ? "en-US" : "zh-CN";
}

export function createCatalogTranslator(catalog, options = {}) {
  const fallbackLocale = options.fallbackLocale || "zh-CN";
  const resolveLocale =
    typeof options.resolveLocale === "function"
      ? options.resolveLocale
      : () => resolveRuntimeLocale();

  return (key, values = {}) => {
    const locale = resolveLocale();
    return interpolate(catalog?.[locale]?.[key] ?? catalog?.[fallbackLocale]?.[key] ?? key, values);
  };
}
