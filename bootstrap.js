import "dotenv/config";

if (process.env.OBSERVABILITY_ENABLED === "true") {
  await import("./observability/tracing-loader.js");
  await import("./observability/tracing.js");
}

await import("./server.js");