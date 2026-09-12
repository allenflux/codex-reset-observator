import {
  createJsonMonitorLogger,
  getSafeMonitorErrorCode,
  runCodexUsageMonitor,
} from "../../tools/codex-usage-monitor";

const controller = new AbortController();
const logger = createJsonMonitorLogger();

function emit(event: string, details: Record<string, unknown> = {}) {
  logger(event, details);
}

function requestStop() {
  controller.abort();
}

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (/stop/i.test(chunk)) requestStop();
});
process.stdin.on("end", requestStop);

emit("starting");

runCodexUsageMonitor(process.env, { signal: controller.signal, logger })
  .then(() => {
    emit("stopped");
    process.stdin.pause();
  })
  .catch((error) => {
    emit("error", { reason: getSafeMonitorErrorCode(error) });
    process.stdin.pause();
    process.exitCode = 1;
  });
