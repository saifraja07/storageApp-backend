import { model, Schema } from "mongoose";
import { FREE_PLAN } from "../config/plans.js";
import bcrypt from "bcrypt";

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Please choose a name."],
      minLength: [3, "Name field should be at least three characters."],
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
        "Please enter a valid email.",
      ],
    },
    password: {
      type: String,
      match: [/^.{4,}$/, "Password should be at least 4 characters."],
    },
    picture: {
      type: String,
      default: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTPQHstFutlfl8tgZAtY8nDWucSWEvFM5AETQ&s"
    },
    role: {
      type: String,
      enum: ["SuperAdmin", "Admin", "Manager", "User"],
      default: "User"
    },
    isDeleted: {
      type: Boolean,
      default: false
    },
    rootDirId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "Directory",
    },
    accessDevice: {
      type: Number,
      required: true,
      default: 1
    },
    maxStorageInBytes: {
      type: Number,
      required: true,
      default: FREE_PLAN.storage
    },
    usedStorageInBytes: {
      type: Number,
      default: 0,
    },
    reservedStorage: {
      type: Number,
      default: 0,
    },
  },
  {
    strict: "throw",
    timestamps: true
  },
);

userSchema.index({ createdAt: -1, _id: -1 });

// Hash password before saving
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Method to compare password
userSchema.methods.comparePassword = async function (password) {
  return bcrypt.compare(password, this.password);
};

const User = model("User", userSchema);


export default User;
