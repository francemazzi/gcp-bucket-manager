import { Readable } from "node:stream";
import type { File } from "@google-cloud/storage";

import type { FileServiceOptions } from "@/config/StorageConfig";
import type { MulterFile } from "@/types/MulterFile";
import { BaseStorageService } from "@/services/BaseStorageService";

export interface FileInfo {
  url: string;
  name: string;
  type: string;
  path?: string;
}

export interface UploadOptions {
  userId?: string;
  directory?: string;
  type?: string;
  makePublic?: boolean;
}

export class FileService extends BaseStorageService {
  private readonly defaultUserId?: string;
  private readonly allowPublicAccess: boolean;
  private readonly initializationPromise?: Promise<void>;

  constructor(options: FileServiceOptions) {
    super(options);

    this.defaultUserId = options.defaultUserId;
    this.allowPublicAccess = options.allowPublicAccess ?? true;

    if (options.validateBucketOnStartup !== false) {
      this.initializationPromise = this.ensureBucketExists().catch((error) => {
        if (error instanceof Error) {
          console.error(
            `[FileService] Bucket validation failed: ${error.message}`
          );
        } else {
          console.error(
            "[FileService] Bucket validation failed with an unknown error."
          );
        }
        throw error;
      });
    }
  }

  public async ready(): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    await this.ensureBucketExists();
  }

  public async uploadFile(
    file: MulterFile,
    options: UploadOptions = {}
  ): Promise<string> {
    await this.ready();

    const targetUserId = options.userId ?? this.defaultUserId;
    const sanitizedPath = this.composeObjectPath(
      targetUserId,
      options.directory
    );
    const objectName = this.buildObjectName(sanitizedPath, file.originalname);

    const bucket = this.getBucket();
    const blob = bucket.file(objectName);

    const maxRetries = 3;
    let attempt = 0;
    let lastError: unknown = undefined;

    while (attempt < maxRetries) {
      try {
        await this.writeFile(blob, file, targetUserId, options.type);

        if (options.makePublic ?? this.allowPublicAccess) {
          await this.ensurePublicReadAccess(bucket, blob);
        }

        return this.buildPublicUrl(objectName);
      } catch (error) {
        lastError = error;
        attempt += 1;

        if (error instanceof Error) {
          console.warn(
            `[FileService] Upload attempt ${attempt}/${maxRetries} failed: ${error.message}`
          );
        }

        if (attempt < maxRetries) {
          const waitTime = Math.pow(2, attempt) * 100;
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }

    if (lastError instanceof Error) {
      throw new Error(
        `Unable to upload file after ${maxRetries} attempts: ${lastError.message}`
      );
    }

    throw new Error(
      `Unable to upload file after ${maxRetries} attempts due to an unknown error.`
    );
  }

  public async getFileFromUrl(url: string): Promise<MulterFile> {
    await this.ready();

    if (!url) {
      throw new Error("The provided URL is empty.");
    }

    const objectName = this.extractObjectName(url);
    const file = this.getBucket().file(objectName);

    const [exists] = await file.exists();
    if (!exists) {
      throw new Error(`File not found at path: ${objectName}`);
    }

    const [metadata] = await file.getMetadata();
    const stream = file.createReadStream();
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const buffer = Buffer.concat(chunks);

    return {
      fieldname: "file",
      originalname: objectName.split("/").pop() ?? objectName,
      encoding: "7bit",
      mimetype: metadata.contentType ?? "application/octet-stream",
      size: Number(metadata.size ?? buffer.byteLength),
      destination: this.bucketName,
      filename: objectName.split("/").pop() ?? objectName,
      path: objectName,
      buffer,
      stream: Readable.from(buffer),
    };
  }

  public async deleteFile(fileUrl: string): Promise<void> {
    await this.ready();

    const objectName = this.extractObjectName(fileUrl);
    await this.getBucket().file(objectName).delete();
  }

  public async getUserFiles(
    directory?: string,
    userId?: string
  ): Promise<FileInfo[]> {
    await this.ready();

    const targetUserId = userId ?? this.defaultUserId;
    const prefix = this.composeObjectPath(targetUserId, directory);

    const [files] = await this.getBucket().getFiles({
      prefix: prefix ? `${prefix}/` : undefined,
    });

    const results: FileInfo[] = [];

    for (const file of files) {
      const [metadata] = await file.getMetadata();
      const customMetadata = metadata.metadata ?? {};

      results.push({
        name: file.name.split("/").pop() ?? file.name,
        url: this.buildPublicUrl(file.name),
        type:
          (customMetadata.type as string) ??
          metadata.contentType ??
          "application/octet-stream",
        path: file.name,
      });
    }

    return results;
  }

  private async writeFile(
    blob: File,
    file: MulterFile,
    userId: string | undefined,
    type: string | undefined
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const metadata: Record<string, string> = {};

      if (userId) {
        metadata.userId = userId;
      }

      if (type) {
        metadata.type = type;
      }

      const blobStream = blob.createWriteStream({
        resumable: false,
        metadata: {
          contentType: file.mimetype,
          metadata,
        },
      });

      blobStream.on("error", (error: Error) => {
        reject(error);
      });

      blobStream.on("finish", () => {
        resolve();
      });

      blobStream.end(file.buffer);
    });
  }

  private async ensurePublicReadAccess(
    bucket = this.getBucket(),
    blob: File
  ): Promise<void> {
    try {
      const [policy] = await bucket.iam.getPolicy({
        requestedPolicyVersion: 3,
      });
      policy.version = 3;

      const alreadyPublic = policy.bindings?.some((binding) => {
        return (
          binding.role === "roles/storage.objectViewer" &&
          binding.members?.includes("allUsers")
        );
      });

      if (!alreadyPublic) {
        policy.bindings = policy.bindings ?? [];
        policy.bindings.push({
          role: "roles/storage.objectViewer",
          members: ["allUsers"],
        });

        await bucket.iam.setPolicy(policy);
      }

      await blob.makePublic();
    } catch (error) {
      if (error instanceof Error) {
        console.warn(
          `[FileService] Failed to apply public access policy: ${error.message}`
        );
      }
    }
  }

  private composeObjectPath(
    userId?: string,
    directory?: string
  ): string | undefined {
    const segments = [userId, directory]
      .filter((segment) => segment && segment.trim().length > 0)
      .map((segment) => this.sanitizePathSegment(segment!));

    if (segments.length === 0) {
      return undefined;
    }

    return segments.join("/");
  }

  private sanitizePathSegment(segment: string): string {
    return segment.replace(/[^a-zA-Z0-9/_-]/g, "_");
  }

  private buildObjectName(
    pathPrefix: string | undefined,
    originalName: string
  ): string {
    const timestamp = Date.now();
    const randomSuffix = Math.floor(Math.random() * 10_000);
    const cleanName = originalName.replace(/[^a-zA-Z0-9.]/g, "_");

    const baseName = `${timestamp}_${randomSuffix}_${cleanName}`;
    return pathPrefix ? `${pathPrefix}/${baseName}` : baseName;
  }

  private buildPublicUrl(objectName: string): string {
    return `https://storage.googleapis.com/${this.bucketName}/${objectName}`;
  }

  private extractObjectName(fileUrl: string): string {
    const prefix = `https://storage.googleapis.com/${this.bucketName}/`;
    if (fileUrl.startsWith(prefix)) {
      return fileUrl.slice(prefix.length);
    }

    return fileUrl;
  }
}
