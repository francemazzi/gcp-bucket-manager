import fs from "node:fs";
import path from "node:path";
import { Storage, type Bucket } from "@google-cloud/storage";

import type { StorageConfig } from "@/config/StorageConfig";

export abstract class BaseStorageService {
  protected readonly storage: Storage;
  protected readonly bucketName: string;

  protected constructor(config: StorageConfig) {
    this.bucketName = config.bucketName;
    const resolvedKeyFilePath = this.resolveKeyFilePath(config.keyFilePath);

    this.storage = new Storage({
      projectId: config.projectId,
      keyFilename: resolvedKeyFilePath,
    });
  }

  protected getBucket(): Bucket {
    return this.storage.bucket(this.bucketName);
  }

  protected async ensureBucketExists(): Promise<void> {
    try {
      const [exists] = await this.getBucket().exists();
      if (!exists) {
        throw new Error(
          `Bucket ${this.bucketName} does not exist or is not accessible.`
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to verify bucket ${this.bucketName}: ${error.message}`
        );
      }
      throw error;
    }
  }

  private resolveKeyFilePath(keyFilePath: string): string {
    const resolvedPath = path.isAbsolute(keyFilePath)
      ? keyFilePath
      : path.resolve(process.cwd(), keyFilePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        `The provided key file was not found at path: ${resolvedPath}`
      );
    }

    return resolvedPath;
  }
}
