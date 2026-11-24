import File from "../models/fileModel.js";
import Directory from "../models/directoryModel.js";
import { deleteDirectoryTree } from "../services/deleteService.js";
import { buildPagination, escapeRegex, parsePagination, parseSearch } from "../utils/pagination.js";
import { createDirectorySchema, renameDirectorySchema } from "../validators/directorySchema.js";
import { CASE_INSENSITIVE_COLLATION, getDirectorySort, isValidDirectorySort, } from "../utils/directoryUtils.js";

export const readDirectory = async (req, res) => {
  const user = req.user;
  const _id = req.params.directoryId || user.rootDirId;

  const sortBy = req.query.sortBy || undefined;
  const sortDir = req.query.sortDir || undefined;

  if (!isValidDirectorySort(sortBy, sortDir)) {
    return res.status(400).json({
      error: "Invalid sort option!",
    });
  }

  const { page, limit } = parsePagination(req.query);
  const search = parseSearch(req.query.search);

  const filter = { parentDirId: _id, userId: user._id };
  if (search) {
    filter.name = { $regex: escapeRegex(search), $options: "i" };
  }

  // Unfinished uploads aren't real files yet (nothing to open, and the client
  // already shows its own progress item), so they are left out of the list
  // and of the counts.
  const fileFilter = { ...filter, isUploading: { $ne: true } };

  const [directoryData, totalDirs, totalFiles] = await Promise.all([
    Directory.findOne({ _id, userId: user._id }).lean(),
    Directory.countDocuments(filter),
    File.countDocuments(fileFilter),
  ]);

  if (!directoryData) {
    return res.status(404).json({
      error: "Directory not found or you do not have access to it!",
    });
  }

  const pagination = buildPagination({
    page,
    limit,
    totalItems: totalDirs + totalFiles,
  });

  const skip = (pagination.currentPage - 1) * limit;

  // Calculate the page's window over [folders..., files...].
  const directoryLimit = Math.max(0, Math.min(limit, totalDirs - skip));
  const fileOffset = Math.max(0, skip - totalDirs);
  const fileLimit = Math.min(
    limit - directoryLimit,
    Math.max(0, totalFiles - fileOffset)
  );

  const fetchPageItems = (Model, isDirectory, offset, pageLimit) => {
    // MongoDB treats limit(0) as unlimited, so skip empty queries.
    if (pageLimit <= 0) return [];

    const query = Model.find(isDirectory ? filter : fileFilter)
      .sort(getDirectorySort(sortBy, sortDir, isDirectory))
      .skip(offset)
      .limit(pageLimit);

    const sortsText =
      sortBy === "name" || (sortBy === "type" && !isDirectory);

    return (sortsText
      ? query.collation(CASE_INSENSITIVE_COLLATION)
      : query
    ).lean();
  };

  const [directories, files] = await Promise.all([
    fetchPageItems(Directory, true, skip, directoryLimit),
    fetchPageItems(File, false, fileOffset, fileLimit),
  ]);

  return res.status(200).json({
    ...directoryData,
    files: files.map((dir) => ({ ...dir, id: dir._id })),
    directories: directories.map((dir) => ({ ...dir, id: dir._id })),
    pagination,
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

  await Directory.create({
    name: dirname,
    parentDirId,
    userId: user._id,
    path,
  });
  return res.status(201).json({ message: "Directory Created!" });
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
  if (String(dirData._id) === String(user.rootDirId)) {
    return res.status(403).json({ error: "The root folder cannot be renamed." });
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

  if (String(directoryData._id) === String(user.rootDirId)) {
    return res.status(403).json({ error: "The root folder cannot be deleted." });
  }

  const deleted = await deleteDirectoryTree(directoryData, user);
  if (!deleted) {
    return res.status(404).json({
      error: "Directory not found or Access denied!",
    });
  }

  return res.status(200).json({ message: "Directory Deleted successfully!" });
};
