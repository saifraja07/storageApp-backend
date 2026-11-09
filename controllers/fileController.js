import path from "node:path";
import File from "../models/fileModel.js";
import Directory from "../models/directoryModel.js";
import User from "../models/userModel.js";
import { renameFileSchema } from "../validators/fileSchema.js";
import { updateDirectorySize } from "../services/storageAccountingService.js";
import { deleteR2File, createGetSignedUrl, createUploadSignedUrl, getR2FileMetaData } from "../services/cloudflareR2Service.js";


export const getFile = async (req, res) => {
  const { fileId } = req.params;

  // Check if file exists & ownership verify
  const fileData = await File.findOne({
    _id: fileId,
    userId: req.user._id,
  }).lean();
  if (!fileData) {
    return res.status(404).json({ error: "File not found!" });
  }

  if (req.query.action === "download") {
    const fileUrl = await createGetSignedUrl({
      key: `${fileId}${fileData.extension}`,
      download: true,
      filename: fileData.name,
      userId: req.user._id
    });
    return res.redirect(fileUrl);
  }

  const fileUrl = await createGetSignedUrl({
    key: `${fileId}${fileData.extension}`,
    filename: fileData.name,
    userId: req.user._id
  });
  return res.redirect(fileUrl);
};

export const renameFile = async (req, res, next) => {
  const { fileId } = req.params;
  const { success, data, error } = renameFileSchema.safeParse(req.body)

  if (!success) {
    return res.status(400).json({ error: error.issues[0].message });
  }
  const { newFilename } = data;

  const fileData = await File.findOne({
    _id: fileId,
    userId: req.user._id,
  });
  if (!fileData) {
    return res.status(404).json({ error: "File does not exist!" });
  }
  fileData.name = newFilename;
  await fileData.save();
  return res.status(200).json({ message: "File Renamed." });
};

export const deleteFile = async (req, res, next) => {
  const { fileId } = req.params;
  const fileData = await File.findOne({
    _id: fileId,
    userId: req.user._id,
  }).lean();
  if (!fileData) {
    return res.status(404).json({ error: "File not found!" });
  }

  await Promise.all([
    File.findByIdAndDelete(fileId),
    deleteR2File({
      key: `${fileId}${fileData.extension}`,
      userId: req.user._id
    })
  ]);
  await updateDirectorySize(
    fileData.parentDirId,
    -fileData.size,
    req.user.rootDirId
  );
  return res.status(200).json({ message: "File Deleted Successfully" });
};

export const uploadInitiate = async (req, res) => {
  const parentDirId = req.body.parentDirId || req.user.rootDirId;

  const parentDir = await Directory.findOne({
    _id: parentDirId,
    userId: req.user._id,
  }).lean();

  if (!parentDir) {
    return res.status(404).json({
      error: "Parent directory not found or permission denied.",
    });
  }

  const filesize = Number(req.body.size);

  if (!Number.isFinite(filesize) || filesize < 0) {
    return res.status(400).json({
      error: "Invalid filesize!",
    });
  }

  const filename = path.basename(
    decodeURIComponent(
      req.body.name || "untitled"
    )
  );

  const extension = path.extname(filename);

  const user = await User.findOneAndUpdate(
    {
      _id: req.user._id,
      $expr: {
        $lte: [
          {
            $add: [
              "$usedStorageInBytes",
              "$reservedStorage",
              filesize,
            ],
          },
          "$maxStorageInBytes",
        ],
      },
    },
    {
      $inc: {
        reservedStorage: filesize,
      },
    },
    {
      returnDocument: "after"
    }
  ).lean();

  if (!user) {
    return res.status(507).json({
      error: "Not enough storage!",
    });
  }
  let file;
  try {
    file = await File.insertOne({
      name: filename,
      extension,
      size: filesize,
      userId: req.user._id,
      parentDirId: parentDir._id,
      isUploading: true
    });

    const signedUrl = await createUploadSignedUrl({
      key: `${file.id}${extension}`,
      contentType: req.body.contentType,
      userId: req.user._id
    })

    return res.json({ fileId: file.id, signedUrl })
  } catch (err) {

    if (file) {
      await File.deleteOne({ _id: file.id });
    }

    await User.updateOne(
      { _id: req.user._id },
      {
        $inc: {
          reservedStorage: -filesize,
        },
      }
    );
    return res.status(500).json({ error: "Couldn't generate url!" })
  }
}

export const uploadComplete = async (req, res) => {
  // The upload id is the pending File's _id (returned as `fileId` by uploadInitiate).
  const { uploadId: fileId } = req.params;
  const file = await File.findOne({
    _id: fileId,
    userId: req.user._id,
  });
  if (!file) {
    return res.status(404).json({ error: "File not found!" });
  } else if (!file.isUploading) {
    return res.status(400).json({
      error: "Upload already completed",
    });
  }

  try {
    const fileMetaData = await getR2FileMetaData({ key: `${fileId}${file.extension}`, userId: req.user._id })

    if (file.size !== fileMetaData.ContentLength) {
      await Promise.all([
        file.deleteOne(),

        User.updateOne(
          { _id: req.user._id },
          {
            $inc: {
              reservedStorage: -file.size,
            },
          }
        ),

        deleteR2File({
          key: `${fileId}${file.extension}`,
          userId: req.user._id,
        }),
      ]);
      return res.status(400).json({ error: "File size does not match!" })
    };
    file.isUploading = false;
    await Promise.all([
      file.save(),

      User.updateOne(
        { _id: req.user._id },
        {
          $inc: {
            reservedStorage: -file.size,
          },
        }
      ),

      updateDirectorySize(
        file.parentDirId,
        file.size,
        req.user.rootDirId
      ),
    ]);
    return res.json({ message: "Upload completed" });
  } catch (err) {

    await Promise.all([
      file.deleteOne(),

      User.updateOne(
        { _id: req.user._id },
        {
          $inc: {
            reservedStorage: -file.size,
          },
        }
      ),

      deleteR2File({
        key: `${fileId}${file.extension}`,
        userId: req.user._id,
      }),
    ]);
    return res.status(400).json({ error: "File could not be uploaded properly" })
  }
}

export const uploadCancel = async (req, res) => {
  try {
    const file = await File.findOneAndDelete({
      _id: req.params.uploadId,
      userId: req.user._id,
      isUploading: true
    })
      .lean()
      .select("extension size");

    if (!file) {
      return res.status(404).json({
        error: "File not found!",
      });
    }

    await Promise.all([
      User.updateOne(
        { _id: req.user._id },
        {
          $inc: {
            reservedStorage: -file.size,
          },
        }
      ),

      deleteR2File({
        key: `${req.params.uploadId}${file.extension}`,
        userId: req.user._id,
      }),
    ]);

    return res.json({
      message: "Upload cancelled",
    });
  } catch (err) {
    return res.status(500).json({
      error: "Failed to cancel upload!",
    });
  }
};