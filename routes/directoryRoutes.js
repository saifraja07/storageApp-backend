import express from "express";
import validateIdMiddleware from "../middleWares/validateIdMiddleware.js";
import { sanitizeInputs } from "../middleWares/sanitizeMiddleware.js";
import {
  createDirectory,
  deleteDirectory,
  getDirectoryPath,
  readDirectory,
  renameDirectory,
} from "../controllers/directoryController.js";

const router = express.Router();

router.param("parentDirId", validateIdMiddleware);
router.param("directoryId", validateIdMiddleware);

router.get("/{:directoryId}", readDirectory);
router.get("/:directoryId/path", getDirectoryPath);
router.post("/", sanitizeInputs(["dirname"]), createDirectory);
router.post("/:parentDirId/children", sanitizeInputs(["dirname"]), createDirectory);
router.patch("/:directoryId", sanitizeInputs(["newDirName"]), renameDirectory);
router.delete("/:directoryId", deleteDirectory);

export default router;
