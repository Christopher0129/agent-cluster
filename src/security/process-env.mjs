export function applySecretMapToProcessEnv(secrets) {
  if (!secrets || typeof secrets !== "object") {
    return;
  }

  for (const [name, value] of Object.entries(secrets)) {
    if (name && typeof value === "string") {
      process.env[name] = value;
    }
  }
}
