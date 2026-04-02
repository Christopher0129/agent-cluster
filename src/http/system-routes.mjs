import { sendJson } from "./common.mjs";

export async function handleSystemExit(response, request, performShutdown) {
  sendJson(response, 200, {
    ok: true,
    shuttingDown: true
  });

  response.on("finish", () => {
    setTimeout(() => {
      void performShutdown({
        reason: "User requested application exit."
      });
    }, 20);
  });

  request.resume();
}
