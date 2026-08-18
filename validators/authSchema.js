import z from "zod";

const emailSchema = z
  .email("Please enter a valid email.")
  .trim()
  .toLowerCase();

export const loginSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(4, "Password must be at least 4 characters"),
});

export const registerSchema = loginSchema.extend({
  name: z
    .string()
    .trim()
    .min(3, "Name must be at least 3 characters")
    .max(50, "Name cannot exceed 50 characters"),
  otp: z
    .string()
    .regex(/^\d{4}$/, "Please enter a valid 4 digit OTP"),
});

export const verifyOtpSchema = registerSchema.pick({
  email: true,
  otp: true,
});

export const sendOtpSchema = registerSchema.pick({
  email: true,
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().optional(),

    newPassword: z
      .string()
      .min(4, "Password must be at least 4 characters"),

    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match.",
  });

export const updateProfileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3, "Name must be at least 3 characters")
      .max(50, "Name cannot exceed 50 characters")
      .optional(),
  })
  .strict();

export const roleSchema = z.object({
  role: z.enum(["User", "Manager", "Admin"], {
    error: "Please enter valid role!",
  }),
});
