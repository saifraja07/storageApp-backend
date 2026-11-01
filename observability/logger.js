import pino from "pino";
import { pinoHttp } from "pino-http";

const logger = pino({
    transport: {
        targets: [
            {
                target: "pino/file",
                options: {
                    destination: "./logs/app.log",
                    mkdir: true
                }
            }
        ]
    },
    redact: {
        paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.headers[" + "x-api-key" + "]",
            "password",
            "user.password",
            "user.email",
            "accessToken",
            "refreshToken",
            "token",
            "code",
            "id_token",
            "razorpay_signature",
        ],
        remove: true,
    }
});


const httpLogger = pinoHttp({
    logger,
    autoLogging: {
        ignore: (req) => req.path === "/metrics" || req.method === "OPTIONS",
    },
    customLogLevel: (req, res, err) => {
        if (res.statusCode >= 500 || err) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
    },
})

export { logger, httpLogger };
