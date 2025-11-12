export interface StorageConfig {
  projectId: string;
  keyFilePath: string;
  bucketName: string;
}

export interface FileServiceOptions extends StorageConfig {
  defaultUserId?: string;
  allowPublicAccess?: boolean;
  validateBucketOnStartup?: boolean;
}
