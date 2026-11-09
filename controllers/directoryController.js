import File from "../models/fileModel.js";
import Directory from "../models/directoryModel.js";
import { updateDirectorySize } from "../services/storageAccountingService.js";
import { deleteR2Files } from "../services/cloudflareR2Service.js";
import { createDirectorySchema, renameDirectorySchema } from "../validators/directorySchema.js";
import { getDirectoryContent } from "../utils/directoryTree.js";

export const readDirectory = async (req, res) => {
  const user = req.user;
  const _id = req.params.directoryId || user.rootDirId;

  // Find the directory and verify ownership
  const directoryData = await Directory.findOne({
    _id,
    userId: user._id,
  }).lean();
  if (!directoryData) {
    return res.status(404).json({
      error: "Directory not found or you do not have access to it!",
    });
  }

  const files = await File.find({ parentDirId: directoryData._id }).lean();
  const directories = await Directory.find({ parentDirId: _id }).lean();

  return res.status(200).json({
    ...directoryData,
    files: files.map((dir) => ({ ...dir, id: dir._id })),
    directories: directories.map((dir) => ({ ...dir, id: dir._id })),
  });
};

export const createDirectory = async (req, res) => {
  const user = req.user;
  const parentDirId = req.params.parentDirId || user.rootDirId;
  
  const { success, data, error } = createDirectorySchema.safeParse(req.body)
  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }
  const dirname = data.dirname || "New Folder";

  const parentDir = await Directory.findOne({
    _id: parentDirId,
    userId: user._id,
  }).lean();

  if (!parentDir) {
    return res.status(403).json({
      error: "Invalid parent directory or access denied!",
    });
  }

  const path =
    parentDir._id.toString() === user.rootDirId.toString()
      ? []
      : [...parentDir.path, parentDir._id];

  const insertedDir = await Directory.create({
    name: dirname,
    parentDirId,
    userId: user._id,
    path,
  });
  return res.status(200).json({ message: "Directory Created!" });
};

export const getDirectoryPath = async (req, res) => {
  const { directoryId: _id } = req.params;
  const dir = await Directory.findOne({
    _id,
    userId: req.user._id,
  }).populate("path", "name _id")
    .select("path name")
    .lean();
    
  if (!dir) {
    return res.status(404).json({ error: "Directory not found" });
  }

  return res.status(200).json({
    path: dir.path,
    current: {
      _id: dir._id,
      name: dir.name,
    },
  });
};

export const renameDirectory = async (req, res) => {
  const user = req.user;
  const { directoryId } = req.params;
  const { success, data, error } = renameDirectorySchema.safeParse(req.body)
  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }

  const dirData = await Directory.findOne({
    _id: directoryId,
    userId: user._id,
  });
  if (!dirData) {
    return res.status(404).json({
      error: "Directory not found or access denied!",
    });
  }
  dirData.name = data.newDirName;
  await dirData.save();

  res.status(200).json({ message: "Directory Renamed!" });
};

export const deleteDirectory = async (req, res) => {
  const user = req.user;
  const { directoryId } = req.params;

  const directoryData = await Directory.findOne({
    _id: directoryId,
    userId: user._id,
  })
    .select("_id size parentDirId")
    .lean();

  if (!directoryData) {
    return res.status(404).json({
      error: "Directory not found or Access denied!",
    });
  }

  const { files, directories } = await getDirectoryContent(directoryData._id);

  const keys = files.map(({ _id, extension }) => ({ Key: `${_id}${extension}` }))
  if (keys.length) {
    await deleteR2Files(keys, user._id)
  }

  await File.deleteMany({
    _id: { $in: files.map(({ _id }) => _id) },
  });
  await Directory.deleteMany({
    _id: { $in: [...directories.map(({ _id }) => _id), directoryData._id] },
  });

  await updateDirectorySize(directoryData.parentDirId, -directoryData.size, user.rootDirId)

  return res.status(200).json({ message: "Directory Deleted successfully!" });
};
