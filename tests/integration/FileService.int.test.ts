import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import { describe, beforeAll, afterAll, it, expect } from "vitest";

import type { FileServiceOptions } from "../../src/config/StorageConfig";
import type { MulterFile } from "../../src/types/MulterFile";
import { FileService } from "../../src/services/FileService";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

class IntegrationEnvironment {
  public readonly projectId: string;
  public readonly bucketName: string;
  public readonly keyFilePath: string;
  public readonly defaultUserId?: string;
  public readonly dataFilePaths: string[];

  private constructor(
    projectId: string,
    bucketName: string,
    keyFilePath: string,
    dataFilePaths: string[],
    defaultUserId?: string
  ) {
    this.projectId = projectId;
    this.bucketName = bucketName;
    this.keyFilePath = keyFilePath;
    this.dataFilePaths = dataFilePaths;
    this.defaultUserId = defaultUserId;
  }

  public static tryCreate(): IntegrationEnvironment | null {
    const keyFileCandidate = process.env.GCP_KEY_FILE_PATH ?? "key_gcp.json";
    const keyFilePath = path.isAbsolute(keyFileCandidate)
      ? keyFileCandidate
      : path.resolve(process.cwd(), keyFileCandidate);

    if (!fs.existsSync(keyFilePath)) {
      console.warn(
        `[IntegrationEnvironment] File di credenziali non trovato: ${keyFilePath}`
      );
      return null;
    }

    let projectId =
      process.env.GCP_PROJECT_ID ?? process.env.TEST_PROJECT_ID ?? undefined;

    if (!projectId) {
      try {
        const keyFileContent = fs.readFileSync(keyFilePath, "utf-8");
        const parsedKey = JSON.parse(keyFileContent) as { project_id?: string };
        projectId = parsedKey.project_id;
      } catch (error) {
        console.warn(
          "[IntegrationEnvironment] Impossibile leggere il projectId dal key file:",
          error
        );
      }
    }

    const bucketName =
      process.env.GCP_BUCKET_NAME ??
      process.env.TEST_BUCKET_NAME ??
      process.env.BUCKET_NAME ??
      undefined;

    if (!projectId) {
      console.warn(
        "[IntegrationEnvironment] Variabile GCP_PROJECT_ID assente e non ricavabile dal key file."
      );
      return null;
    }

    if (!bucketName) {
      console.warn(
        "[IntegrationEnvironment] Variabile GCP_BUCKET_NAME assente. Configurala nel file .env."
      );
      return null;
    }

    const dataDir = path.resolve(process.cwd(), "data_to_test");
    if (!fs.existsSync(dataDir)) {
      console.warn(
        `[IntegrationEnvironment] Cartella dati non trovata: ${dataDir}`
      );
      return null;
    }

    const dataFilePaths = fs
      .readdirSync(dataDir)
      .map((entry) => path.join(dataDir, entry))
      .filter((entryPath) => fs.statSync(entryPath).isFile());

    if (dataFilePaths.length === 0) {
      console.warn(
        "[IntegrationEnvironment] Nessun file di test trovato in /data_to_test."
      );
      return null;
    }

    const defaultUserId =
      process.env.GCP_DEFAULT_USER_ID ?? process.env.TEST_USER_ID ?? undefined;

    return new IntegrationEnvironment(
      projectId,
      bucketName,
      keyFilePath,
      dataFilePaths,
      defaultUserId
    );
  }
}

class MulterFileFactory {
  public static async fromPath(
    filePath: string,
    fieldName = "file"
  ): Promise<MulterFile> {
    const buffer = await fsPromises.readFile(filePath);
    const fileName = path.basename(filePath);

    return {
      fieldname: fieldName,
      originalname: fileName,
      encoding: "7bit",
      mimetype: MimeResolver.resolve(filePath),
      size: buffer.byteLength,
      destination: path.dirname(filePath),
      filename: fileName,
      path: filePath,
      buffer,
      stream: Readable.from(buffer),
    };
  }
}

class MimeResolver {
  public static resolve(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();

    switch (extension) {
      case ".pdf":
        return "application/pdf";
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".txt":
        return "text/plain";
      case ".json":
        return "application/json";
      default:
        return "application/octet-stream";
    }
  }
}

class FileServiceIntegrationContext {
  public readonly service: FileService;
  public readonly testUserId: string;
  public readonly testDirectory: string;
  private readonly uploads: Set<string> = new Set();

  constructor(environment: IntegrationEnvironment) {
    this.testUserId =
      environment.defaultUserId ?? `integration-user-${Date.now()}`;
    this.testDirectory = `integration-tests-${Date.now()}`;

    const options: FileServiceOptions = {
      projectId: environment.projectId,
      bucketName: environment.bucketName,
      keyFilePath: environment.keyFilePath,
      defaultUserId: environment.defaultUserId,
    };

    this.service = new FileService(options);
  }

  public async ensureReady(): Promise<void> {
    await this.service.ready();
  }

  public buildUploadOptions(mimeType: string) {
    return {
      userId: this.testUserId,
      directory: this.testDirectory,
      type: mimeType,
      makePublic: true,
    };
  }

  public registerUpload(url: string): void {
    this.uploads.add(url);
  }

  public unregisterUpload(url: string): void {
    this.uploads.delete(url);
  }

  public async cleanup(): Promise<void> {
    for (const url of this.uploads) {
      try {
        await this.service.deleteFile(url);
      } catch (error) {
        console.warn("[FileService integration] Pulizia fallita:", error);
      }
    }

    this.uploads.clear();
  }
}

const environment = IntegrationEnvironment.tryCreate();

if (!environment) {
  describe.skip("FileService integration", () => {
    it("salta i test per mancanza di configurazione", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("FileService integration", () => {
    const context = new FileServiceIntegrationContext(environment);

    beforeAll(async () => {
      await context.ensureReady();
    });

    afterAll(async () => {
      await context.cleanup();
    });

    it("carica, recupera ed elimina tutti i file disponibili", async () => {
      expect(environment.dataFilePaths.length).toBeGreaterThan(0);

      for (const filePath of environment.dataFilePaths) {
        const multerFile = await MulterFileFactory.fromPath(filePath);
        const uploadOptions = context.buildUploadOptions(multerFile.mimetype);

        const uploadedUrl = await context.service.uploadFile(
          multerFile,
          uploadOptions
        );
        context.registerUpload(uploadedUrl);

        expect(uploadedUrl).toContain(environment.bucketName);

        const downloadedFile = await context.service.getFileFromUrl(
          uploadedUrl
        );
        expect(downloadedFile.buffer.byteLength).toBeGreaterThan(0);
        expect(downloadedFile.mimetype).toBe(multerFile.mimetype);

        const userFiles = await context.service.getUserFiles(
          uploadOptions.directory,
          uploadOptions.userId
        );
        const matchingEntry = userFiles.find(
          (fileInfo) => fileInfo.url === uploadedUrl
        );
        expect(matchingEntry).toBeTruthy();

        await context.service.deleteFile(uploadedUrl);
        context.unregisterUpload(uploadedUrl);

        await expect(
          context.service.getFileFromUrl(uploadedUrl)
        ).rejects.toThrow();

        const userFilesAfterDelete = await context.service.getUserFiles(
          uploadOptions.directory,
          uploadOptions.userId
        );
        const stillPresent = userFilesAfterDelete.some(
          (fileInfo) => fileInfo.url === uploadedUrl
        );
        expect(stillPresent).toBe(false);
      }
    });
  });
}
