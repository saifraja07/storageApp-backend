import { model, Schema } from "mongoose";

const directorySchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Directory name is required!"],
    },
    size: {
      type: Number,
      required: true,
      default: 0
    },
    path: [{
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Directory",
      default: []
    }],
    parentDirId: {
      type: Schema.Types.ObjectId,
      default: null,
      ref: "Directory",
    },
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
  },
  {
    strict: "throw",
    timestamps: true
  },
);

directorySchema.index({ parentDirId: 1 });
directorySchema.index({
  userId: 1,
  parentDirId: 1,
  createdAt: -1,
  _id: -1,
});

const Directory = model("Directory", directorySchema);

export default Directory;
