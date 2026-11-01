import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),

  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-dns": {
        enabled: false
      },
      "@opentelemetry/instrumentation-net": {
        enabled: false
      },
      "@opentelemetry/instrumentation-redis": {
        enabled: true
      },

      "@opentelemetry/instrumentation-http": {
        ignoreIncomingRequestHook: (req) => {
          return req.url?.startsWith("/metrics") || req.method === "OPTIONS";
        },
      },

      // "@opentelemetry/instrumentation-express": {
      //   ignoreIncomingRequestHook: (req) => {
      //     return req.url?.startsWith("/metrics") || req.method === "OPTIONS";
      //   },
      // },
    }),
  ],
});

sdk.start();