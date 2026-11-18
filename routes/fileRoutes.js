import express from "express";
import validateIdMiddleware from "../middleWares/validateIdMiddleware.js";
import { rateLimiter, throttle } from "../middleWares/limiterMiddleware.js";
import { sanitizeInputs } from "../middleWares/sanitizeMiddleware.js";
import {
  getFile,
  renameFile,
  deleteFile,
  uploadInitiate,
  uploadComplete,
  uploadCancel,
} from "../controllers/fileController.js";


const router = express.Router();

router.param("fileId", validateIdMiddleware);
router.param("uploadId", validateIdMiddleware);

router.get("/:fileId", getFile);
router.post("/uploads/initiate", rateLimiter(60 * 1000, 30, "files-upload-initiate"), throttle({
  waitTime: 500,
  delayAfter: 5,
  maxDelay: 5000,
}), uploadInitiate)
router.post("/uploads/:uploadId/complete", rateLimiter(60 * 1000, 100, "files-upload-complete"), uploadComplete)
router.post("/uploads/:uploadId/cancel", rateLimiter(60 * 1000, 50, "files-upload-cancel"), uploadCancel)
router.patch("/:fileId", sanitizeInputs(["newFilename"]), renameFile);
router.delete("/:fileId", deleteFile);

export default router;
