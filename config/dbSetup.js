import mongoose from "mongoose";
import { connectDB } from "./db.js";

await connectDB();
const client = mongoose.connection.getClient();

const command = "collMod";

try {
  const db = mongoose.connection.db;
  await db.command({
    [command]: "users",
    validator: {
      $jsonSchema: {
        required: ["_id", "name", "email", "rootDirId"],
        properties: {
          _id: {
            bsonType: "objectId",
          },
          name: {
            bsonType: "string",
            minLength: 3,
            description: "Name field should be at least three characters.",
          },
          email: {
            bsonType: "string",
            pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+.[a-zA-Z]{2,}$",
            description: "Please enter a valid email.",
          },
          password: {
            bsonType: "string",
            pattern: "^.{4,}$",
            description: "Password should be at least 4 characters.",
          },
          picture: {
            bsonType: "string",
          },
          role: {
            enum: ["SuperAdmin", "Admin", "Manager", "User"],
          },
          isDeleted: {
            bsonType: "bool"
          },
          rootDirId: {
            bsonType: "objectId",
          },
          accessDevice: {
            bsonType: "int",
          },
          maxStorageInBytes: {
            bsonType: ["int", "long", "double"],
          },
          usedStorageInBytes: {
            bsonType: ["int", "long", "double"],
          },
          reservedStorage: {
            bsonType: ["int", "long", "double"],
          },
           createdAt: {
            bsonType: "date",
          },
          updatedAt: {
            bsonType: "date",
          },
          __v: {
            bsonType: "int"
          }
        },
        additionalProperties: false,
      },
    },
    validationAction: "error",
    validationLevel: "strict",
  });

  await db.command({
    [command]: "directories",
    validator: {
      $jsonSchema: {
        required: ["_id", "name", "parentDirId", "userId"],
        properties: {
          _id: {
            bsonType: "objectId",
          },
          name: {
            bsonType: "string",
          },
          size: {
            bsonType: ["int", "long", "double"]
          },
          path: {
            bsonType: "array",
            items: {
              bsonType: "objectId"
            }
          },
          parentDirId: {
            bsonType: ["objectId", "null"],
          },
          userId: {
            bsonType: "objectId",
          },
          createdAt: {
            bsonType: "date",
          },
          updatedAt: {
            bsonType: "date",
          },
          __v: {
            bsonType: "int"
          }
        },
        additionalProperties: false,
      },
    },
    validationAction: "error",
    validationLevel: "strict",
  });

  await db.command({
    [command]: "files",
    validator: {
      $jsonSchema: {
        required: ["_id", "name", "extension", "userId", "parentDirId"],
        properties: {
          _id: {
            bsonType: "objectId",
          },
          name: {
            bsonType: "string",
          },
          extension: {
            bsonType: "string",
          },
          size: {
            bsonType: ["int", "long", "double"]
          },
          userId: {
            bsonType: "objectId",
          },
          parentDirId: {
            bsonType: "objectId",
          },
          isUploading: {
            bsonType: "bool",
          },
          createdAt: {
            bsonType: "date",
          },
          updatedAt: {
            bsonType: "date",
          },
          __v: {
            bsonType: "int"
          }
        },
        additionalProperties: false,
      },
    },
    validationAction: "error",
    validationLevel: "strict",
  });
} catch (err) {
  console.log("Error setting up database: ", err);
} finally {
  await client.close();
}
