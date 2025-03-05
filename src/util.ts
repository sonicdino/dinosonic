import { stringify } from "https://deno.land/x/xml@2.0.4/mod.ts";
import { md5 } from "jsr:@takker/md5";
import { encodeHex } from "jsr:@std/encoding/hex";
import type { User } from "./zod.ts";

const SERVER_NAME = "Dinosonic";
export const SERVER_VERSION = "1.0.0";
const API_VERSION = "1.16.1";
export const ERROR_MESSAGES: Record<number, string> = {
  0: "A generic error.",
  10: "Required parameter is missing.",
  20: "Incompatible Subsonic REST protocol version. Client must upgrade.",
  30: "Incompatible Subsonic REST protocol version. Server must upgrade.",
  40: "Wrong username or password.",
  41: "Token authentication not supported for LDAP users.",
  42: "Provided authentication mechanism not supported.",
  43: "Multiple conflicting authentication mechanisms provided.",
  44: "Invalid API key.",
  50: "User is not authorized for the given operation.",
  60: "The trial period for the Subsonic server is over. Please upgrade.",
  70: "The requested data was not found.",
};

function generateTokenHash(password: string, salt: string): string {
  return encodeHex(md5(password + salt));
}

export function separatorsToRegex(separators: string[]): RegExp {
  const escaped = separators.map(sep => `\\${sep}`).join("|");

  return new RegExp(`[${escaped}]+`);
}

/**
 * Check if a directory of file exists.
 * @param path Path of the file/dir to check
 * @returns boolean
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true; // Path exists
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false; // Path does not exist
    } else {
      throw error; // Other errors (e.g., permission denied)
    }
  }
}

/**
 * Converts a file path to a unique ID using MD5.
 * @param filePath The full path to the file.
 * @returns A unique identifier for the file.
 */
export function filePathToId(filePath: string): string {
  return encodeHex(md5(filePath)).slice(0, 10);
}

/**
 * Creates a standardized OpenSubsonic response
 */
export function createResponse(
  request: Request,
  data: Record<string, unknown> = {},
  status: "ok" | "failed" = "ok",
  error?: { code: number; message: string },
): Response {
  const url = new URL(request.url);
  const format = url.searchParams.get("f") || request.headers.get("Accept") ||
    "xml";

  const responseData = {
    "subsonic-response": {
      status,
      version: API_VERSION,
      type: SERVER_NAME,
      serverVersion: SERVER_VERSION,
      openSubsonic: true,
      ...data,
      ...(error ? { error } : {}),
    },
  };

  console.log(responseData);

  if (format.includes("xml")) {
    const xmlResponse = stringify(responseData);
    return new Response(xmlResponse, {
      status: error ? 400 : 200,
      headers: { "Content-Type": "application/xml" },
    });
  }

  return new Response(JSON.stringify(responseData), {
    status: error ? 400 : 200,
    headers: { "Content-Type": "application/json" },
  });
}
/**
 * Returns an error as response.
 */
export function createErrorResponse(
  request: Request,
  code: number,
  message?: string,
): Response {
  return createResponse(request, {}, "failed", {
    code,
    message: message || ERROR_MESSAGES[code],
  });
}

export async function validateAuth(
  request: Request,
  database: Deno.Kv,
): Promise<Response | { username: string }> {
  const url = new URL(request.url);
  const username = url.searchParams.get("u");
  const password = url.searchParams.get("p"); // Plaintext or encrypted
  const token = url.searchParams.get("t"); // Token auth
  const salt = url.searchParams.get("s"); // Required for token auth

  if (!username) return createErrorResponse(request, 10); // Missing parameter

  // 🔍 Get user from the database
  const user = (await database.get(["users", username])).value as User | null;
  if (!user) return createErrorResponse(request, 40); // Invalid username/password

  // ✅ Token Authentication (Preferred)
  if (token && salt) {
    const expectedToken = generateTokenHash(user.backend.password, salt);
    if (expectedToken !== token) return createErrorResponse(request, 40);
    return { username };
  }

  // ✅ Basic Authentication (Legacy)
  if (password) {
    if (password.startsWith("enc:")) {
      // 🔓 Decode Base64-encoded password
      const decodedPassword = atob(password.slice(4));
      if (decodedPassword !== user.backend.password) {
        return createErrorResponse(request, 40);
      }
    } else {
      if (password !== user.backend.password) {
        return createErrorResponse(request, 40);
      }
    }
    return { username };
  }

  return createErrorResponse(request, 42); // Unsupported authentication mechanism
}
