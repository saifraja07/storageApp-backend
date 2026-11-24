import { model, Schema } from "mongoose";

const fileSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Filename is required!"],
    },
    extension: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    parentDirId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Directory",
    },
    isUploading: {
      type: Boolean,
      required: true,
    }
  },
  {
    strict: "throw",
    timestamps: true
  },
);

fileSchema.index({ parentDirId: 1 });
fileSchema.index({ isUploading: 1 });
fileSchema.index({ createdAt: 1 });
fileSchema.index({
  userId: 1,
  parentDirId: 1,
  createdAt: -1,
  _id: -1,
});

const File = model("File", fileSchema);

export default File;
