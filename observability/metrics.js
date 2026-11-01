import promClient from "prom-client";


const httpTotalRequests = new promClient.Counter({
  name: "storageapp_http_requests_total",
  help: "Total request processed.",
  labelNames: ["method", "path", "status"]
});

const httpRequestsInFlight = new promClient.Gauge({
  name: "storageapp_http_requests_in_flight",
  help: "Request is being processed.",
  labelNames: ["method"]
});

const httpRequestsFailure = new promClient.Counter({
  name: "storageapp_http_request_failures_total",
  help: "Request which got failed while processed.",
  labelNames: ["method", "path", "status"]
});

const httpReqDuration = new promClient.Histogram({
  name: "storageapp_http_request_duration_seconds",
  help: "Http request duration in seconds.",
  labelNames: ["method", "path", "status"],
  buckets: [0.1, 0.25, 0.5, 0.75, 1, 2, 5]
});

promClient.collectDefaultMetrics();

export function trackHttpMetrics(req, res, next) {
  const { method } = req;

  if (req.path === "/metrics" || method === "OPTIONS") {
    return next();
  }

  const start = process.hrtime.bigint();

  httpRequestsInFlight.labels(method).inc();

  let requestFinished = false;

  const finishRequest = () => {
    if (requestFinished) return;
    requestFinished = true;

    httpRequestsInFlight.labels(method).dec();
  };

  res.on("finish", () => {
    finishRequest();

    const route = req.route
      ? `${req.baseUrl}${req.route.path}`
      : req.path;

    const duration =
      Number(process.hrtime.bigint() - start) / 1e9;

    httpTotalRequests
      .labels(method, route, res.statusCode)
      .inc();

    if (res.statusCode >= 400) {
      httpRequestsFailure
        .labels(method, route, res.statusCode)
        .inc();
    }

    httpReqDuration
      .labels(method, route, res.statusCode)
      .observe(duration);
  });

  req.on("aborted", () => {
    finishRequest();
  });

  next();
}

export async function serveHttpMetrics(req, res) {
  const metrics = await promClient.register.metrics();
  res.set("Content-Type", promClient.register.contentType);
  res.end(metrics);
};
