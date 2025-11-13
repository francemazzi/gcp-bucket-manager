# GCP Bucket Manager

Object-oriented TypeScript library to simplify interaction with Google Cloud Storage.
Enables uploading, retrieving, deleting, and listing files using GCP buckets with minimal configuration.

## Installation

```bash
npm install gcp-bucket-manager
```

## Quick Setup

1. Create or retrieve the credentials file `key_gcp.json` (see dedicated section below).
2. Initialize the service with your desired configuration:

```typescript
import { FileService } from "gcp-bucket-manager";
import type { MulterFile } from "gcp-bucket-manager";

const fileService = new FileService({
  projectId: "my-gcp-project-id",
  keyFilePath: "./key_gcp.json",
  bucketName: "my-public-bucket",
  defaultUserId: "user-123", // optional
});
```

## How It Works

The `FileService` class extends `BaseStorageService` and provides a high-level interface for managing files in Google Cloud Storage buckets. Here's how it works:

### File Organization

Files are organized in the bucket using a hierarchical structure:

- **Path format**: `{userId}/{directory}/{timestamp}_{random}_{filename}`
- Files are automatically sanitized to remove special characters
- Each file gets a unique name with timestamp and random suffix to prevent collisions

### Automatic Features

- **Retry Logic**: Upload operations automatically retry up to 3 times with exponential backoff
- **Public Access**: Files are automatically made publicly accessible at the object level (unless disabled)
- **Bucket Validation**: The bucket is validated on startup to ensure it exists and is accessible
- **Path Sanitization**: User IDs, directories, and filenames are sanitized to ensure valid paths

### Configuration Options

- `projectId` _(required)_: Your GCP project ID.
- `keyFilePath` _(required)_: Path to the credentials file `key_gcp.json`.
- `bucketName` _(required)_: Name of the destination bucket.
- `defaultUserId` _(optional)_: Default user prefix for path management. If set, all operations will use this user ID unless overridden.
- `allowPublicAccess` _(optional, default `true`)_: If set to `false`, prevents automatic public access permissions.
- `validateBucketOnStartup` _(optional, default `true`)_: Disable to defer bucket verification until the first operation.

## Usage Examples

### Basic File Upload

```typescript
import { FileService } from "gcp-bucket-manager";
import type { MulterFile } from "gcp-bucket-manager";

const fileService = new FileService({
  projectId: "my-gcp-project-id",
  keyFilePath: "./key_gcp.json",
  bucketName: "my-public-bucket",
});

// Upload a file with default settings
async function uploadFile(file: MulterFile) {
  const publicUrl = await fileService.uploadFile(file, {
    directory: "invoices",
    type: file.mimetype,
  });

  console.log("File published at:", publicUrl);
  // Output: https://storage.googleapis.com/my-public-bucket/invoices/1234567890_1234_invoice.pdf
}
```

### Upload with User ID

```typescript
// Upload a file for a specific user
async function uploadUserFile(file: MulterFile, userId: string) {
  const publicUrl = await fileService.uploadFile(file, {
    userId: userId,
    directory: "documents",
    type: file.mimetype,
  });

  // File will be stored at: {userId}/documents/{timestamp}_{random}_{filename}
  return publicUrl;
}
```

### Express.js Integration with Multer

```typescript
import express from "express";
import multer from "multer";
import { FileService } from "gcp-bucket-manager";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const fileService = new FileService({
  projectId: "my-gcp-project-id",
  keyFilePath: "./key_gcp.json",
  bucketName: "my-public-bucket",
  defaultUserId: "api-user",
});

// Upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided" });
    }

    const publicUrl = await fileService.uploadFile(req.file, {
      directory: "uploads",
      type: req.file.mimetype,
    });

    res.json({ url: publicUrl });
  } catch (error) {
    console.error("Upload failed:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});
```

### Retrieve File from URL

```typescript
// Get a file object from its public URL
async function downloadFile(fileUrl: string) {
  try {
    const file = await fileService.getFileFromUrl(fileUrl);

    console.log("File name:", file.originalname);
    console.log("File size:", file.size);
    console.log("MIME type:", file.mimetype);
    console.log("File buffer:", file.buffer);

    // Use the buffer or stream as needed
    return file;
  } catch (error) {
    console.error("File not found:", error);
    throw error;
  }
}
```

### Delete a File

```typescript
// Delete a file by its public URL
async function removeFile(fileUrl: string) {
  try {
    await fileService.deleteFile(fileUrl);
    console.log("File deleted successfully");
  } catch (error) {
    console.error("Delete failed:", error);
    throw error;
  }
}
```

### List User Files

```typescript
// Get all files for a user in a specific directory
async function getUserDocuments(userId: string) {
  try {
    const files = await fileService.getUserFiles("documents", userId);

    // Returns array of FileInfo objects:
    // [
    //   {
    //     url: "https://storage.googleapis.com/...",
    //     name: "document.pdf",
    //     type: "application/pdf",
    //     path: "user-123/documents/1234567890_1234_document.pdf"
    //   },
    //   ...
    // ]

    return files;
  } catch (error) {
    console.error("Failed to list files:", error);
    throw error;
  }
}

// List all files for default user
async function listDefaultUserFiles() {
  const fileService = new FileService({
    projectId: "my-gcp-project-id",
    keyFilePath: "./key_gcp.json",
    bucketName: "my-public-bucket",
    defaultUserId: "user-123",
  });

  // Lists files in root directory for default user
  const files = await fileService.getUserFiles();

  // Lists files in "invoices" directory for default user
  const invoices = await fileService.getUserFiles("invoices");
}
```

### Wait for Initialization

```typescript
// Ensure the service is ready before using it
async function initializeService() {
  const fileService = new FileService({
    projectId: "my-gcp-project-id",
    keyFilePath: "./key_gcp.json",
    bucketName: "my-public-bucket",
    validateBucketOnStartup: true, // default
  });

  // Wait for bucket validation to complete
  await fileService.ready();

  console.log("Service is ready to use");

  // Now safe to use the service
  const files = await fileService.getUserFiles();
}
```

### Private Files (No Public Access)

```typescript
// Upload files without making them publicly accessible
const privateFileService = new FileService({
  projectId: "my-gcp-project-id",
  keyFilePath: "./key_gcp.json",
  bucketName: "my-private-bucket",
  allowPublicAccess: false,
});

async function uploadPrivateFile(file: MulterFile) {
  // Even with allowPublicAccess: false, you can override per-file
  const url = await fileService.uploadFile(file, {
    directory: "private",
    makePublic: false, // Explicitly keep file private
  });

  // Note: URL will still be returned, but file won't be publicly accessible
  return url;
}
```

### Public Access Considerations

- Object-level ACLs: when `allowPublicAccess` is `true` (default), each uploaded object is made public individually via ACLs without broadcasting bucket-wide permissions.
- Bucket listing: making individual objects public does **not** expose bucket-level listings; consumers still need the direct object URL.
- Uniform bucket-level access (UBLA): if your bucket enforces UBLA, Google Cloud disallows object ACLs; uploads will stay private and a warning is logged. Disable UBLA or manage access at the bucket policy level in that scenario.
- Security posture: review whether sharing permanent public URLs matches your compliance needs. Set `allowPublicAccess: false` or `makePublic: false` per upload to keep objects private and serve them via signed URLs or backend proxies instead.

## Main Methods

### `uploadFile(file: MulterFile, options?: UploadOptions): Promise<string>`

Uploads a file to the bucket and returns the public URL.

**Parameters:**

- `file`: A Multer-compatible file object with `buffer`, `originalname`, `mimetype`, etc.
- `options`:
  - `userId?: string` - Override default user ID
  - `directory?: string` - Subdirectory within user folder
  - `type?: string` - Custom type metadata
  - `makePublic?: boolean` - Override default public access setting

**Returns:** Public URL string

**Example:**

```typescript
const url = await fileService.uploadFile(file, {
  userId: "user-456",
  directory: "photos",
  type: "profile-picture",
});
```

### `getFileFromUrl(url: string): Promise<MulterFile>`

Retrieves a file object compatible with Multer from a public URL.

**Parameters:**

- `url`: Public URL of the file

**Returns:** Multer-compatible file object with buffer and metadata

**Example:**

```typescript
const file = await fileService.getFileFromUrl(
  "https://storage.googleapis.com/my-bucket/user-123/invoice.pdf"
);
```

### `deleteFile(url: string): Promise<void>`

Deletes the file corresponding to the provided URL.

**Parameters:**

- `url`: Public URL of the file to delete

**Example:**

```typescript
await fileService.deleteFile(
  "https://storage.googleapis.com/my-bucket/user-123/invoice.pdf"
);
```

### `getUserFiles(directory?: string, userId?: string): Promise<FileInfo[]>`

Returns a list of files for a user and folder.

**Parameters:**

- `directory?: string` - Optional subdirectory to filter by
- `userId?: string` - Optional user ID (uses default if not provided)

**Returns:** Array of `FileInfo` objects with `url`, `name`, `type`, and `path`

**Example:**

```typescript
const files = await fileService.getUserFiles("documents", "user-123");
```

### `ready(): Promise<void>`

Allows waiting for bucket validation to complete (useful on startup).

**Example:**

```typescript
await fileService.ready();
// Service is now ready
```

## How to Generate the `key_gcp.json` File

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Select the correct project in the top left (or create a new one).
3. Navigate to **IAM & Admin → Service Accounts**.
4. Create a new service account (or select an existing one) with a descriptive name.
5. Assign the minimum necessary roles, for example:
   - `Storage Object Admin`
   - `Storage Admin`
6. After creating the service account, open its details and go to the **Keys** tab.
7. Click **Add Key → Create new key** and select **JSON** format.
8. Download the generated file and save it as `key_gcp.json` in your project root (or your preferred path).
9. NEVER include this file in version control or publish it to public repositories (`key_gcp.json` is already ignored by `.gitignore` and `.npmignore`).

## Security Tips

- Store `key_gcp.json` in a secrets manager or environment variables for production environments.
- Limit service account permissions to only the necessary resources.
- Regenerate keys if compromise is suspected.

## Local Development

```bash
npm install
npm run build
```

The `npm run build` command compiles TypeScript files into the `dist/` folder and automatically applies path aliases (`@/`).

## License

[MIT](./LICENSE)
